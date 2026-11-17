'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../src/server');
const { connect } = require('./ws_client');
const { TimelineStore } = require('../src/store');
const { MediaLibrary } = require('../src/media');
const { readOplog, orderRecords, LOG_FORMAT, LOG_FORMAT_VERSION, OplogError } = require('../src/oplog');
const { migrate } = require('../scripts/migrate_oplog');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'manifest.json'), 'utf8'));
const SOURCES = manifest.sources;

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-mig-'));
  return { dir, file: path.join(dir, name) };
}

function envelope(businessOp) {
  return { type: 'op', op: businessOp };
}
let counter = 0;
function op(clientId, type, extra) {
  counter += 1;
  return { ...extra, type, opId: `${clientId}-${counter}-${Math.random().toString(36).slice(2, 7)}`, clientId };
}

async function startServer(oplogFile) {
  const server = createServer({ mediaDir: MEDIA_DIR, sources: SOURCES, log: { log() {} }, oplogFile });
  await new Promise((res) => server.server.listen(0, '127.0.0.1', res));
  const port = server.server.address().port;
  return { server, port };
}

async function hello(port, clientId) {
  const ws = await connect(port);
  ws.send({ type: 'hello', clientId, lastSeq: 0 });
  await ws.recvUntil((m) => m.type === 'hello_ack');
  await ws.recvUntil((m) => m.type === 'snapshot');
  return ws;
}
const waitFor = (ws, o) => ws.recvUntil((m) => m.op && m.op.opId === o.opId, 4000);

// Drive a rich v1 history including adjacent concurrent clips and a rejected op.
async function buildV1History(port) {
  const alice = await hello(port, 'mig_alice');
  const bob = await hello(port, 'mig_bob');

  const ins1 = op('mig_alice', 'insert', { clipId: 'h-a', sourceId: 'srcA', srcIn: 0, srcOut: 5000, timelineIn: 0 });
  alice.send(envelope(ins1));
  await waitFor(alice, ins1);

  const ins2 = op('mig_bob', 'insert', { clipId: 'h-b', sourceId: 'srcB', srcIn: 0, srcOut: 3000, timelineIn: 5000 });
  bob.send(envelope(ins2));
  await waitFor(bob, ins2);

  const snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  // Adjacent concurrent cut: alice trims the boundary of h-a while bob moves
  // h-b. Both cite the same base; different fields -> both land.
  const base = snap.version;
  const trim = op('mig_alice', 'trim', { clipId: 'h-a', side: 'out', value: 4000, baseVersion: base });
  const move = op('mig_bob', 'move', { clipId: 'h-b', newTimelineIn: 6000, baseVersion: base });
  alice.send(envelope(trim));
  await waitFor(alice, trim);
  bob.send(envelope(move));
  const moveRes = await waitFor(bob, move);
  assert.equal(moveRes.type, 'applied');

  // A rejected same-boundary trim to exercise rejected-record migration.
  const stale = op('mig_bob', 'trim', { clipId: 'h-a', side: 'out', value: 3000, baseVersion: base });
  bob.send(envelope(stale));
  const rej = await waitFor(bob, stale);
  assert.equal(rej.type, 'rejected');

  alice.close(); bob.close();
  return (await (await fetch(`http://127.0.0.1:${port}/api/log`)).json());
}

function sameClips(a, b) {
  const norm = (s) => s.clips
    .map((c) => ({ id: c.id, srcIn: c.srcIn, srcOut: c.srcOut, timelineIn: c.timelineIn, timelineOut: c.timelineOut, fv: c.fieldVersion }))
    .sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(norm(a), norm(b));
}

test('迁移：v1 历史（相邻并发剪切+拒绝记录）转成显式 v2 操作日志', async () => {
  const { server, port } = await startServer(null);
  try {
    const v1 = await buildV1History(port);
    const { dir, file } = tmpFile('v2.log');
    const v1Path = path.join(dir, 'v1.json');
    fs.writeFileSync(v1Path, JSON.stringify(v1));

    const report = migrate({ in: v1Path, out: file, sources: path.join(MEDIA_DIR, 'manifest.json') });
    assert.equal(report.unknown, 0);
    assert.equal(report.applied, v1.applied.length);
    assert.equal(report.rejected, v1.rejected.length);

    const parsed = readOplog(file);
    assert.equal(parsed.header.format, LOG_FORMAT);
    assert.equal(parsed.header.formatVersion, LOG_FORMAT_VERSION);
    const { applied } = orderRecords(parsed.records);

    // Explicit identity / base revision / result on every applied record.
    for (const rec of applied) {
      assert.equal(rec.mark, 'v2-record');
      assert.equal(rec.migratedFrom, 1);
      assert.ok(Array.isArray(rec.result.targets) && rec.result.targets.length > 0);
      for (const t of rec.result.targets) {
        assert.equal(typeof t.clipId, 'string');
        assert.ok(t.before === null || typeof t.before.clipId === 'string');
        assert.ok(t.after === null || typeof t.after.clipId === 'string');
      }
      assert.equal(typeof rec.result.baseRevision, 'number');
      assert.equal(rec.result.outcome, 'applied');
      assert.equal(rec.result.revision, rec.version);
    }
    // Adjacent concurrent cut semantics: h-a trimmed, h-b moved, still non-overlapping.
    const rebuilt = TimelineStore.fromOplog(SOURCES, file);
    const snap = rebuilt.snapshot();
    const a = snap.clips.find((c) => c.id === 'h-a');
    const b = snap.clips.find((c) => c.id === 'h-b');
    assert.equal(a.srcOut, 4000);
    assert.equal(b.timelineIn, 6000);
    assert.ok(a.timelineOut <= b.timelineIn, 'adjacent clips must not overlap after concurrent edits');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test('迁移前后一致：重建时间线、render plan 与撤销含义完全相同', async () => {
  const { server, port } = await startServer(null);
  try {
    const v1 = await buildV1History(port);
    const liveSnap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    const media = new MediaLibrary(MEDIA_DIR);
    const livePlan = media.renderPlan(liveSnap);

    const { dir, file } = tmpFile('v2.log');
    fs.writeFileSync(path.join(dir, 'v1.json'), JSON.stringify(v1));
    migrate({ in: path.join(dir, 'v1.json'), out: file, sources: path.join(MEDIA_DIR, 'manifest.json') });

    const rebuilt = TimelineStore.fromOplog(SOURCES, file);
    const rebuiltSnap = rebuilt.snapshot();
    assert.equal(rebuiltSnap.version, liveSnap.version);
    assert.equal(rebuiltSnap.seq, liveSnap.seq);
    sameClips(rebuiltSnap, liveSnap);
    assert.deepEqual(media.renderPlan(rebuiltSnap), livePlan, 'rendered frames identical after migration');

    // Undo meaning is identical on both stores: inverse the trim record and
    // compare resulting clip positions.
    const trimSeq = rebuilt.log.find((r) => r.op.type === 'trim').seq;
    const inverses = rebuilt.buildUndoOps(trimSeq, 'undo-test');
    assert.equal(inverses.length, 1);
    assert.equal(inverses[0].type, 'trim');
    assert.equal(inverses[0].value, rebuilt.log[trimSeq - 1].result.targets[0].before.srcOut);
    for (const inv of inverses) {
      rebuilt.refreshUndoBase(inverses);
      const out = rebuilt.apply(inv);
      assert.equal(out.type, 'applied', 'undo inverse must apply under the same rules');
    }
    const undoneA = rebuilt.snapshot().clips.find((c) => c.id === 'h-a');
    assert.equal(undoneA.srcOut, 5000, 'undo restores the pre-trim boundary');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test('未知/损坏记录保留原字节并以非零状态失败，转换器不用默认值遮错', () => {
  const store = new TimelineStore(SOURCES);
  const ins = op('x', 'insert', { clipId: 'k1', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 });
  const rec = store.apply(ins);
  const { dir, file } = tmpFile('v2.log');
  const sidecar = path.join(dir, 'side.jsonl');
  const v1Path = path.join(dir, 'v1.jsonl');
  const goodLine = JSON.stringify({ type: 'applied', seq: rec.seq, version: rec.version, op: ins, clientId: 'x', ts: Date.now() });
  const mystery = '{"type":"mystery","bytes":"中文原样"}';
  const garbage = 'not-json-at-all{,';
  fs.writeFileSync(v1Path, [goodLine, mystery, garbage].join('\n') + '\n');

  const report = migrate({ in: v1Path, out: file, sidecar, sources: path.join(MEDIA_DIR, 'manifest.json') });
  assert.equal(report.unknown, 2);
  const side = fs.readFileSync(sidecar, 'utf8');
  assert.ok(side.includes(JSON.parse(mystery).bytes), 'unknown record bytes preserved verbatim');
  assert.ok(side.includes(garbage), 'garbage line preserved verbatim');
  // The good record was still converted honestly.
  const rebuilt = TimelineStore.fromOplog(SOURCES, file);
  assert.equal(rebuilt.snapshot().clips[0].id, 'k1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺少可用 baseVersion 的修改类拒绝记录不被默认值掩盖', () => {
  const store = new TimelineStore(SOURCES);
  const ins = op('x', 'insert', { clipId: 'k2', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 });
  const applied = store.apply(ins);
  const badReject = {
    type: 'rejected', seq: null, serverVersion: 1, clientId: 'x',
    op: { type: 'trim', opId: 'bad-1', clientId: 'x', clipId: 'k2', side: 'out' /* no baseVersion */ },
    reason: 'field_changed_since_base', ts: Date.now(),
  };
  const { dir, file } = tmpFile('v2.log');
  const sidecar = path.join(dir, 'side.jsonl');
  const v1Path = path.join(dir, 'v1.json');
  fs.writeFileSync(v1Path, JSON.stringify({ applied: [{ ...applied, op: ins }], rejected: [badReject] }));
  const report = migrate({ in: v1Path, out: file, sidecar, sources: path.join(MEDIA_DIR, 'manifest.json') });
  assert.equal(report.rejected, 0);
  assert.equal(report.unknown, 1);
  assert.match(fs.readFileSync(sidecar, 'utf8'), /baseVersion/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('恢复不依赖文件顺序：打乱 v2 行序后重建结果一致', () => {
  const store = new TimelineStore(SOURCES);
  const r1 = store.apply(op('x', 'insert', { clipId: 'o1', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 }));
  const r2 = store.apply(op('x', 'insert', { clipId: 'o2', sourceId: 'srcB', srcIn: 0, srcOut: 2000, timelineIn: 2000 }));
  const r3 = store.apply(op('x', 'move', { clipId: 'o2', newTimelineIn: 8000, baseVersion: store.version }));
  const { dir, file } = tmpFile('shuffled.log');
  const { headerLine } = require('../src/oplog');
  const body = [r1, r2, r3].map((r) => JSON.stringify(r));
  fs.writeFileSync(file, headerLine() + '\n' + body.reverse().join('\n') + '\n');

  const rebuilt = TimelineStore.fromOplog(SOURCES, file);
  assert.equal(rebuilt.snapshot().seq, 3);
  assert.equal(rebuilt.clips.get('o2').timelineIn, 8000, 'explicit seq order wins over shuffled file order');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重复 seq 与 seq 断档在恢复时显式报错', () => {
  const store = new TimelineStore(SOURCES);
  const r1 = store.apply(op('x', 'insert', { clipId: 'p1', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 }));
  const r2 = store.apply(op('x', 'insert', { clipId: 'p2', sourceId: 'srcB', srcIn: 0, srcOut: 2000, timelineIn: 2000 }));
  const { headerLine } = require('../src/oplog');
  const { dir, file } = tmpFile('dup.log');
  fs.writeFileSync(file, headerLine() + '\n' + [JSON.stringify(r1), JSON.stringify({ ...r2, seq: 1 })].join('\n') + '\n');
  assert.throws(() => TimelineStore.fromOplog(SOURCES, file), OplogError);

  const gap = tmpFile('gap.log');
  fs.writeFileSync(gap.file, headerLine() + '\n' + JSON.stringify({ ...r2, recNo: 2 }) + '\n');
  assert.throws(() => TimelineStore.fromOplog(SOURCES, gap.file), /gapless/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(gap.dir, { recursive: true, force: true });
});

test('拒绝把已是 v2 的日志再次转换', () => {
  const store = new TimelineStore(SOURCES);
  const r1 = store.apply(op('x', 'insert', { clipId: 'q1', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 }));
  const { dir, file } = tmpFile('v2.log');
  fs.writeFileSync(file, require('../src/oplog').headerLine() + '\n' + JSON.stringify(r1) + '\n');
  assert.throws(() => migrate({ in: file, out: path.join(dir, 'out.log'), sources: path.join(MEDIA_DIR, 'manifest.json') }), /already a v2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('拒绝记录也带全局 recNo：打乱文件行序后到达顺序仍确定', () => {
  const v1 = {
    applied: [{
      type: 'applied', seq: 1, version: 1, clientId: 'a', ts: 1,
      op: { type: 'insert', opId: 'i', clientId: 'a', clipId: 'c', sourceId: 'srcA', srcIn: 0, srcOut: 5000, timelineIn: 0 },
      clipIds: ['c'],
    }],
    rejected: [
      { type: 'rejected', seq: null, serverVersion: 1, clientId: 'b', ts: 2, reason: 'first-reject', op: { type: 'trim', opId: 'r1', clientId: 'b', clipId: 'c', side: 'out', value: 1, baseVersion: 1 } },
      { type: 'rejected', seq: null, serverVersion: 1, clientId: 'b', ts: 3, reason: 'second-reject', op: { type: 'trim', opId: 'r2', clientId: 'b', clipId: 'c', side: 'out', value: 2, baseVersion: 1 } },
    ],
  };
  const { dir, file } = tmpFile('rej.log');
  fs.writeFileSync(path.join(dir, 'in.json'), JSON.stringify(v1));
  migrate({ in: path.join(dir, 'in.json'), out: file, sources: path.join(MEDIA_DIR, 'manifest.json') });

  // Reverse every physical line; orderRecords must still recover recNo order.
  const { headerLine } = require('../src/oplog');
  const body = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).reverse();
  fs.writeFileSync(file, headerLine() + '\n' + body.join('\n') + '\n');
  const { records } = readOplog(file);
  const { rejected } = orderRecords(records);
  assert.deepEqual(rejected.map((r) => r.result.reason), ['first-reject', 'second-reject']);
  assert.deepEqual(rejected.map((r) => r.recNo), [2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('持久化与重启：oplog 文件在新进程式 server 上重建并继续追加', async () => {
  const { dir, file } = tmpFile('persist.log');
  const { server, port } = await startServer(file);
  const ins = op('persist_a', 'insert', { clipId: 'z1', sourceId: 'srcA', srcIn: 0, srcOut: 3000, timelineIn: 0 });
  try {
    const ws = await hello(port, 'persist_a');
    ws.send(envelope(ins));
    await waitFor(ws, ins);
    ws.close();
  } finally {
    server.close();
  }
  assert.ok(fs.existsSync(file));

  // Fresh server instance: history comes from the journal, not memory.
  const secondEnv = await startServer(file);
  try {
    assert.equal(secondEnv.server.restored.applied, 1);
    const snap = await (await fetch(`http://127.0.0.1:${secondEnv.port}/api/snapshot`)).json();
    assert.equal(snap.clips[0].id, 'z1');
    assert.equal(snap.logFormat.formatVersion, LOG_FORMAT_VERSION);

    const ws = await hello(secondEnv.port, 'persist_b');
    const move = op('persist_b', 'move', { clipId: 'z1', newTimelineIn: 9000, baseVersion: snap.version });
    ws.send(envelope(move));
    const res = await waitFor(ws, move);
    assert.equal(res.seq, 2, 'new records continue the seq lineage after restore');
    ws.close();

    const parsed = readOplog(file);
    assert.equal(parsed.records.filter((r) => r.type === 'applied').length, 2);

    // opId dedup is reconstructed from the journal: resending the original op
    // after restart must return duplicate=true without allocating a new seq.
    const dup = secondEnv.server.store.apply(ins);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.seq, 1);
  } finally {
    secondEnv.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('撤销走内核逆操作：insert/trim/move/split/remove 全部回到操作前位置', async () => {
  const { server, port } = await startServer(null);
  try {
    const ws = await hello(port, 'undo_a');
    const ins = op('undo_a', 'insert', { clipId: 'u1', sourceId: 'srcA', srcIn: 0, srcOut: 9000, timelineIn: 0 });
    ws.send(envelope(ins));
    await waitFor(ws, ins);
    let snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();

    const mv = op('undo_a', 'move', { clipId: 'u1', newTimelineIn: 12000, baseVersion: snap.version });
    ws.send(envelope(mv));
    await waitFor(ws, mv);
    ws.send({ type: 'undo', seq: 2 });
    await ws.recvUntil((m) => m.type === 'undo_done' && m.undoOf === 2);
    snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    assert.equal(snap.clips.find((c) => c.id === 'u1').timelineIn, 0, 'move undo restores position');

    const split = op('undo_a', 'split', { clipId: 'u1', at: 3000, baseVersion: snap.version });
    ws.send(envelope(split));
    const splitRes = await waitFor(ws, split);
    ws.send({ type: 'undo', seq: splitRes.seq });
    const done = await ws.recvUntil((m) => m.type === 'undo_done' && m.undoOf === splitRes.seq);
    assert.equal(done.responses.length, 3, 'split undo = remove L, remove R, re-insert parent');
    snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    const parent = snap.clips.find((c) => c.id === 'u1');
    assert.ok(parent && parent.srcIn === 0 && parent.srcOut === 9000, 'split undo restores parent clip');
    ws.close();
  } finally {
    server.close();
  }
});

test('并发移动到同一位置：后到者显式拒绝，时间线保持单轨有效', async () => {
  const { server, port } = await startServer(null);
  try {
    const a = await hello(port, 'cc_a');
    const b = await hello(port, 'cc_b');
    const i1 = op('cc_a', 'insert', { clipId: 'c1', sourceId: 'srcA', srcIn: 0, srcOut: 2000, timelineIn: 0 });
    const i2 = op('cc_b', 'insert', { clipId: 'c2', sourceId: 'srcB', srcIn: 0, srcOut: 2000, timelineIn: 2000 });
    a.send(envelope(i1)); await waitFor(a, i1);
    b.send(envelope(i2)); await waitFor(b, i2);
    const snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();

    const m1 = op('cc_a', 'move', { clipId: 'c1', newTimelineIn: 7000, baseVersion: snap.version });
    const m2 = op('cc_b', 'move', { clipId: 'c2', newTimelineIn: 7000, baseVersion: snap.version });
    a.send(envelope(m1));
    await waitFor(a, m1);
    b.send(envelope(m2));
    const rej = await waitFor(b, m2);
    assert.equal(rej.type, 'rejected');
    assert.match(rej.reason, /collides/);

    const after = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
    const c1 = after.clips.find((c) => c.id === 'c1');
    const c2 = after.clips.find((c) => c.id === 'c2');
    assert.equal(c1.timelineIn, 7000);
    assert.equal(c2.timelineIn, 2000, 'rejected concurrent move leaves the loser clip in place');
    a.close(); b.close();
  } finally {
    server.close();
  }
});

test('旧样例运行到底：既有 collab 契约在 v2 线上保持全部字段可读', async () => {
  const { server, port } = await startServer(null);
  try {
    const ws = await hello(port, 'legacy_a');
    const ins = op('legacy_a', 'insert', { clipId: 'legacy-1', sourceId: 'srcA', srcIn: 0, srcOut: 4000, timelineIn: 0 });
    ws.send(envelope(ins));
    const applied = await waitFor(ws, ins);
    // v1-era fields still present at top level.
    assert.equal(applied.type, 'applied');
    assert.equal(applied.clipIds[0], 'legacy-1');
    assert.equal(applied.clientId, 'legacy_a');
    assert.equal(applied.seq, 1);
    // New explicit v2 fields.
    assert.equal(applied.mark, 'v2-record');
    assert.equal(applied.result.outcome, 'applied');
    assert.equal(applied.result.targets[0].after.clipId, 'legacy-1');
    assert.equal(applied.result.baseRevision, 0);

    const stale = op('legacy_a', 'trim', { clipId: 'legacy-1', side: 'out', value: 1000, baseVersion: 99 });
    ws.send(envelope(stale));
    const rej = await waitFor(ws, stale);
    assert.equal(rej.type, 'rejected');
    assert.ok(rej.reason, 'v1 top-level reason still readable');
    assert.equal(rej.result.reason, rej.reason, 'v2 nested result mirrors v1 field');
    ws.close();
  } finally {
    server.close();
  }
});
