'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createServer } = require('../src/server');
const { connect } = require('./ws_client');
const { TimelineStore } = require('../src/store');
const { MediaLibrary } = require('../src/media');
const { TICKS_PER_SECOND, rationalToTicks, tickToFrameIndex } = require('../src/time');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'manifest.json'), 'utf8'));

let server;
let port;
let base;

test.before(async () => {
  if (!fs.existsSync(path.join(MEDIA_DIR, 'manifest.json'))) require('../scripts/gen_media').generate();
  server = createServer({ mediaDir: MEDIA_DIR, sources: manifest.sources, log: { log() {} } });
  await new Promise((res) => { server.server.listen(0, '127.0.0.1', res); });
  port = server.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

test.after(() => server.close());

async function openEditor(clientId, lastSeq) {
  const ws = await connect(port);
  ws.send({ type: 'hello', clientId, lastSeq });
  const ack = await ws.recvUntil((m) => m.type === 'hello_ack');
  assert.equal(ack.clientId, clientId);
  // snapshot always follows the replay batch
  await ws.recvUntil((m) => m.type === 'snapshot');
  return ws;
}

function op(clientId, opType, extra) {
  return { ...extra, type: opType, opId: `${clientId}-${Math.random().toString(36).slice(2, 10)}`, clientId };
}

// Websocket transport envelope: business op rides in the nested `op` field so
// transport type 'op' and business type (insert/trim/...) never collide.
function envelope(businessOp) {
  return { type: 'op', op: businessOp };
}

async function snapshotHttp() {
  const r = await fetch(`${base}/api/snapshot`);
  return r.json();
}

test('精确时间单位：30fps 的一帧恰为 1000 ticks，有理数换算无浮点误差', () => {
  assert.equal(TICKS_PER_SECOND, 30000);
  assert.equal(rationalToTicks({ n: 1, d: 30 }), 1000);
  assert.equal(rationalToTicks({ n: 1, d: 24 }), 1250);
  assert.equal(tickToFrameIndex(1500, 30, 1), 1);
  assert.throws(() => rationalToTicks({ n: 1, d: 7 }), /not representable/);
});

test('插入：片段获得稳定身份，按 clipId 而非下标寻址', async () => {
  const a = await openEditor('t_insert_a');
  const insert = op('t_insert_a', 'insert', {
    clipId: 'clip-stable-1', sourceId: 'srcA',
    srcIn: 0, srcOut: 10000, timelineIn: 0,
  });
  a.send(envelope(insert));
  const applied = await a.recvUntil((m) => m.type === 'applied' && m.op.opId === insert.opId);
  assert.equal(applied.clipIds[0], 'clip-stable-1');

  const snap = await snapshotHttp();
  const clip = snap.clips.find((c) => c.id === 'clip-stable-1');
  assert.ok(clip, 'stable clip id present');
  assert.equal(clip.timelineOut - clip.timelineIn, 10000);
  a.close();
});

test('重复消息：同一 opId 重发只生效一次，返回 duplicate 标记且不产生新事件', async () => {
  const a = await openEditor('t_dup_a');
  const o = op('t_dup_a', 'insert', { clipId: 'clip-dup', sourceId: 'srcB', srcIn: 0, srcOut: 5000, timelineIn: 20000 });
  a.send(envelope(o));
  const first = await a.recvUntil((m) => m.type === 'applied' && m.op.opId === o.opId);
  assert.equal(first.duplicate, undefined);

  a.send(envelope(o)); // exact resend, same opId
  const second = await a.recvUntil((m) => m.op && m.op.opId === o.opId);
  assert.equal(second.duplicate, true);
  assert.equal(second.seq, first.seq, 'duplicate must not allocate a new seq/version');

  const snap = await snapshotHttp();
  assert.equal(snap.clips.filter((c) => c.id === 'clip-dup').length, 1);
  a.close();
});

test('乱序操作：baseVersion 领先服务端的操作被明确拒绝并给出原因，不被静默应用', async () => {
  const a = await openEditor('t_ooo_a');
  const snap = await snapshotHttp();
  const futureVersion = snap.version + 50;
  const o = op('t_ooo_a', 'trim', { clipId: 'clip-stable-1', side: 'out', value: 9000, baseVersion: futureVersion });
  a.send(envelope(o));
  const rej = await a.recvUntil((m) => m.type === 'rejected' && m.op.opId === o.opId);
  assert.ok(rej.reason.includes('field_changed_since_base') || rej.conflict, 'must surface explicit conflict');
  assert.equal(rej.conflict.baseVersion, futureVersion);

  const after = await snapshotHttp();
  const clip = after.clips.find((c) => c.id === 'clip-stable-1');
  assert.equal(clip.srcOut, 10000, 'rejected op must not mutate state');
  a.close();
});

test('互不冲突的编辑自动合并：两人同时改同一片段的不同字段', async () => {
  const a = await openEditor('t_merge_a');
  const b = await openEditor('t_merge_b');
  // Both observed the same base version.
  const snap = await snapshotHttp();
  const clipId = 'clip-stable-1';
  const baseVersion = snap.version;

  const aliceTrim = op('t_merge_a', 'trim', { clipId, side: 'out', value: 8000, baseVersion });
  const bobMove = op('t_merge_b', 'move', { clipId, newTimelineIn: 3000, baseVersion });
  a.send(envelope(aliceTrim));
  b.send(envelope(bobMove));

  const r1 = await a.recvUntil((m) => m.type === 'applied' && m.op.opId === aliceTrim.opId);
  const r2 = await b.recvUntil((m) => m.type === 'applied' && m.op.opId === bobMove.opId);
  assert.ok(r1 && r2, 'both non-conflicting edits must be accepted');

  const after = await snapshotHttp();
  const clip = after.clips.find((c) => c.id === clipId);
  assert.equal(clip.srcOut, 8000, "alice's trim landed");
  assert.equal(clip.timelineIn, 3000, "bob's move landed");
  assert.equal(clip.fieldEditor.srcOut, 't_merge_a');
  assert.equal(clip.fieldEditor.timelineIn, 't_merge_b');
  a.close(); b.close();
});

test('同一边界并发调整：显式冲突，后到者被拒并看到先到者的值，绝不静默覆盖', async () => {
  const a = await openEditor('t_conf_a');
  const b = await openEditor('t_conf_b');
  const snap = await snapshotHttp();
  const clipId = 'clip-stable-1';
  const baseVersion = snap.version;

  const alice = op('t_conf_a', 'trim', { clipId, side: 'out', value: 7000, baseVersion });
  const bob = op('t_conf_b', 'trim', { clipId, side: 'out', value: 5000, baseVersion });
  a.send(envelope(alice));
  // make sure alice's op is committed before bob's, both still cite the old base
  await a.recvUntil((m) => m.type === 'applied' && m.op.opId === alice.opId);
  b.send(envelope(bob));
  const rej = await b.recvUntil((m) => m.type === 'rejected' && m.op.opId === bob.opId);

  assert.equal(rej.conflict.reason, 'field_changed_since_base');
  const changed = rej.conflict.changedFields.find((f) => f.field === 'srcOut');
  assert.equal(changed.value, 7000, 'rejected editor sees the winner value');
  assert.equal(changed.editor, 't_conf_a');

  const after = await snapshotHttp();
  const clip = after.clips.find((c) => c.id === clipId);
  assert.equal(clip.srcOut, 7000, "first writer wins; bob's 5000 never applied");
  a.close(); b.close();
});

test('另一人插入素材后，按 clipId 的修改不会误伤错误片段', async () => {
  const a = await openEditor('t_id_a');
  const b = await openEditor('t_id_b');
  // Bob inserts a new clip BEFORE the existing one (shifting visual order).
  const insert = op('t_id_b', 'insert', { clipId: 'clip-new-head', sourceId: 'srcB', srcIn: 0, srcOut: 3000, timelineIn: 0 });
  // existing clip-stable-1 currently lives at timelineIn 3000; head needs 0..3000 -> overlap.
  // Move stable clip out of the way first using its identity.
  const snap = await snapshotHttp();
  const stable = snap.clips.find((c) => c.id === 'clip-stable-1');
  const move = op('t_id_a', 'move', { clipId: 'clip-stable-1', newTimelineIn: 6000, baseVersion: snap.version });
  a.send(envelope(move));
  await a.recvUntil((m) => m.type === 'applied' && m.op.opId === move.opId);

  b.send(envelope(insert));
  await b.recvUntil((m) => m.type === 'applied' && m.op.opId === insert.opId);

  // Alice now trims by ID. Even though array order changed, the identity-based
  // op must hit clip-stable-1, never clip-new-head.
  const snap2 = await snapshotHttp();
  const trim = op('t_id_a', 'trim', { clipId: 'clip-stable-1', side: 'out', value: 6500, baseVersion: snap2.version });
  a.send(envelope(trim));
  await a.recvUntil((m) => m.type === 'applied' && m.op.opId === trim.opId);

  const finalSnap = await snapshotHttp();
  const ordered = [...finalSnap.clips].sort((x, y) => x.timelineIn - y.timelineIn);
  assert.equal(ordered[0].id, 'clip-new-head');
  assert.equal(ordered[1].id, 'clip-stable-1', 'identity survives index shifts');
  assert.equal(ordered[1].srcOut, 6500);
  assert.equal(ordered[0].srcOut, 3000, 'head clip untouched by the id-based trim');
  a.close(); b.close();
});

test('分割产生两个带稳定身份的子片段，随后按新身份移动其中一个', async () => {
  const a = await openEditor('t_split_a');
  const snap = await snapshotHttp();
  const target = snap.clips.find((c) => c.id === 'clip-stable-1');
  const splitAt = target.srcIn + 2000;
  const split = op('t_split_a', 'split', { clipId: 'clip-stable-1', at: splitAt, baseVersion: snap.version });
  a.send(envelope(split));
  const applied = await a.recvUntil((m) => m.type === 'applied' && m.op.opId === split.opId);
  assert.equal(applied.clipIds.length, 2);

  const afterSplit = await snapshotHttp();
  assert.equal(afterSplit.clips.find((c) => c.id === 'clip-stable-1'), undefined, 'parent removed');
  const left = afterSplit.clips.find((c) => c.id === `${split.opId}:L`);
  const right = afterSplit.clips.find((c) => c.id === `${split.opId}:R`);
  assert.ok(left && right);
  assert.equal(left.srcOut, splitAt);
  assert.equal(right.srcIn, splitAt);
  assert.equal(left.timelineOut, right.timelineIn, 'split children stay adjacent');

  // Move only the right child by its new stable id.
  const move = op('t_split_a', 'move', { clipId: right.id, newTimelineIn: 40000, baseVersion: afterSplit.version });
  a.send(envelope(move));
  await a.recvUntil((m) => m.type === 'applied' && m.op.opId === move.opId);
  const finalSnap = await snapshotHttp();
  const moved = finalSnap.clips.find((c) => c.id === right.id);
  assert.equal(moved.timelineIn, 40000);
  const stayed = finalSnap.clips.find((c) => c.id === left.id);
  assert.notEqual(stayed.timelineIn, 40000, 'left child not dragged along');
  a.close();
});

test('断线重连：离线期间的事件按 seq 重放，两端最终片段结构一致', async () => {
  const a = await openEditor('t_dc_a');
  const b = await openEditor('t_dc_b');
  const before = await snapshotHttp();
  const lastSeq = before.seq;

  a.close(); // alice goes offline

  const insert = op('t_dc_b', 'insert', { clipId: 'clip-offline-1', sourceId: 'srcA', srcIn: 0, srcOut: 4000, timelineIn: 50000 });
  b.send(envelope(insert));
  await b.recvUntil((m) => m.type === 'applied' && m.op.opId === insert.opId);
  const trim = op('t_dc_b', 'trim', { clipId: 'clip-offline-1', side: 'out', value: 3500, baseVersion: (await snapshotHttp()).version });
  b.send(envelope(trim));
  await b.recvUntil((m) => m.type === 'applied' && m.op.opId === trim.opId);

  // Alice reconnects with her last seen seq and must receive the missing events.
  const a2 = await connect(port);
  a2.send({ type: 'hello', clientId: 't_dc_a', lastSeq });
  await a2.recvUntil((m) => m.type === 'hello_ack');
  const missed1 = await a2.recvUntil((m) => m.type === 'applied' && m.op.opId === insert.opId);
  const missed2 = await a2.recvUntil((m) => m.type === 'applied' && m.op.opId === trim.opId);
  assert.ok(missed1.seq > lastSeq && missed2.seq > missed1.seq);
  const snapMsg = await a2.recvUntil((m) => m.type === 'snapshot');

  const serverSnap = await snapshotHttp();
  assert.deepEqual(
    snapMsg.state.clips.map((c) => c.id).sort(),
    serverSnap.clips.map((c) => c.id).sort(),
    'reconnected client converges to identical clip structure'
  );
  a2.close(); b.close();
});

test('事件日志可重放：仅凭 applied 日志在全新 store 上重建出完全相同的时间线', async () => {
  const live = await snapshotHttp();
  const logRes = await fetch(`${base}/api/log`);
  const { applied } = await logRes.json();
  const rebuilt = TimelineStore.replay(manifest.sources, applied);
  const rebuiltSnap = rebuilt.snapshot();

  const norm = (s) => s.clips
    .map((c) => ({ id: c.id, srcIn: c.srcIn, srcOut: c.srcOut, timelineIn: c.timelineIn, timelineOut: c.timelineOut, fv: c.fieldVersion }))
    .sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(norm(rebuiltSnap), norm(live));
  assert.equal(rebuiltSnap.version, live.version);
  assert.equal(rebuiltSnap.seq, live.seq);
});

test('画面预览按最终采用时间线解码到真实素材帧文件', async () => {
  const snap = await snapshotHttp();
  const media = new MediaLibrary(MEDIA_DIR);
  const clip = snap.clips.find((c) => c.sourceId === 'srcA');
  const probeTick = clip.timelineIn + 1000; // one frame in
  const hit = media.resolveFrame(snap, probeTick);
  assert.ok(hit && hit.clipId === clip.id);
  assert.ok(fs.existsSync(hit.framePath), 'decoded frame file exists on disk');

  const r = await fetch(`${base}/api/preview?tick=${probeTick}`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.frameIndex, hit.frameIndex);

  const img = await fetch(`${base}/api/frame?source=${body.sourceId}&frame=${body.frameIndex}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  // Gap tick decodes to nothing instead of a wrong frame.
  const gap = await fetch(`${base}/api/preview?tick=29999`);
  assert.equal(gap.status, 404);
});

test('最终输出帧清单可导出且每帧可定位，两端共享同一 render plan', async () => {
  const r = await fetch(`${base}/api/render`);
  const data = await r.json();
  assert.ok(data.frameCount > 0);
  for (const f of data.plan) assert.ok(fs.existsSync(f.framePath));

  const ex = await (await fetch(`${base}/api/export`)).json();
  assert.equal(ex.format, 'collab-timeline/v1');
  assert.equal(ex.serverVersion, (await snapshotHttp()).version);
  assert.ok(ex.clips.every((c) => /^\d+\/30000$/.test(c.timelineIn)), 'exported times are exact rationals');
  assert.equal(ex.renderPlan.length, data.frameCount);
});

test('服务端拒绝越界裁切与时间线重叠，保持单轨时间线有效', async () => {
  const a = await openEditor('t_valid_a');
  const snap = await snapshotHttp();
  const badOverlap = op('t_valid_a', 'insert', { clipId: 'clip-bad-overlap', sourceId: 'srcA', srcIn: 0, srcOut: 5000, timelineIn: 0 });
  a.send(envelope(badOverlap));
  const rej1 = await a.recvUntil((m) => m.type === 'rejected' && m.op.opId === badOverlap.opId);
  assert.match(rej1.reason, /overlaps/);

  const anyClip = snap.clips[0];
  const badTrim = op('t_valid_a', 'trim', { clipId: anyClip.id, side: 'in', value: anyClip.srcOut + 5000, baseVersion: snap.version });
  a.send(envelope(badTrim));
  const rej2 = await a.recvUntil((m) => m.type === 'rejected' && m.op.opId === badTrim.opId);
  assert.ok(rej2.reason.includes('srcOut') || rej2.conflict || rej2.reason);
  a.close();
});
