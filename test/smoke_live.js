'use strict';

// Live end-to-end smoke test against a running server (bin/serve.js).
// Drives two real websocket editors through the headline scenarios and then
// verifies the exported timeline + decoded output frames over HTTP.
const { connect } = require('./ws_client');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.PORT || 8083;
const base = `http://127.0.0.1:${PORT}`;

async function maybeStartServer() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/snapshot`);
    if (r.ok) return null;
  } catch { /* not running — start it */ }
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'serve.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('collab edit server')) { clearTimeout(timer); resolve(); }
    });
  });
  return child;
}
let counter = 0;
const op = (clientId, type, extra) => ({
  ...extra, type, opId: `${clientId}-${(counter += 1)}-${Math.random().toString(36).slice(2, 7)}`, clientId,
});

async function hello(clientId) {
  const ws = await connect(PORT);
  ws.send({ type: 'hello', clientId, lastSeq: 0 });
  await ws.recvUntil((m) => m.type === 'hello_ack');
  await ws.recvUntil((m) => m.type === 'snapshot');
  return ws;
}
const wait = (ws, o) => ws.recvUntil((m) => m.op && m.op.opId === o.opId, 4000);
const getJson = async (p) => (await fetch(`${base}${p}`)).json();

(async () => {
  const ownedServer = await maybeStartServer();
  try {
  const alice = await hello('alice');
  const bob = await hello('bob');

  // 1. Alice inserts a clip; Bob must receive the broadcast too.
  const ins = op('alice', 'insert', { clipId: 'smoke-1', sourceId: 'srcA', srcIn: 0, srcOut: 10000, timelineIn: 0 });
  alice.send({ type: 'op', op: ins });
  const r1 = await wait(alice, ins);
  const r1b = await wait(bob, ins);
  console.log('1 insert: alice=', r1.type, ' bob-broadcast=', r1b.type);

  // 2. Duplicate resend is idempotent.
  alice.send({ type: 'op', op: ins });
  const dup = await wait(alice, ins);
  console.log('2 duplicate:', dup.type, 'duplicate=', !!dup.duplicate, 'sameSeq=', dup.seq === r1.seq);

  // 3. Both trim the same boundary on the same base version: explicit conflict.
  const snap = await getJson('/api/snapshot');
  const aTrim = op('alice', 'trim', { clipId: 'smoke-1', side: 'out', value: 8000, baseVersion: snap.version });
  const bTrim = op('bob', 'trim', { clipId: 'smoke-1', side: 'out', value: 4000, baseVersion: snap.version });
  alice.send({ type: 'op', op: aTrim });
  await wait(alice, aTrim);
  bob.send({ type: 'op', op: bTrim });
  const conflict = await wait(bob, bTrim);
  console.log('3 conflict:', conflict.type, conflict.conflict && conflict.conflict.reason,
    'winner value=', conflict.conflict && conflict.conflict.changedFields[0].value);

  // 4. Non-conflicting: Bob moves the clip while Alice's trim stands.
  const snap2 = await getJson('/api/snapshot');
  const move = op('bob', 'move', { clipId: 'smoke-1', newTimelineIn: 12000, baseVersion: snap2.version });
  bob.send({ type: 'op', op: move });
  const moved = await wait(bob, move);
  console.log('4 concurrent different-field merge:', moved.type);

  // 5. Split then move the right child by its new stable identity.
  const snap3 = await getJson('/api/snapshot');
  const clip = snap3.clips.find((c) => c.id === 'smoke-1');
  const split = op('alice', 'split', { clipId: 'smoke-1', at: clip.srcIn + 3000, baseVersion: snap3.version });
  alice.send({ type: 'op', op: split });
  const splitRes = await wait(alice, split);
  const rightId = splitRes.clipIds.find((id) => id.endsWith(':R'));
  const snap4 = await getJson('/api/snapshot');
  const moveR = op('alice', 'move', { clipId: rightId, newTimelineIn: 50000, baseVersion: snap4.version });
  alice.send({ type: 'op', op: moveR });
  await wait(alice, moveR);
  console.log('5 split children:', splitRes.clipIds.join(', '), 'then right child moved by id');

  // 6. Preview decodes a real frame from the committed timeline.
  const preview = await getJson('/api/preview?tick=13000');
  console.log('6 preview @tick13000:', preview.clipId, preview.sourceId, 'frame#', preview.frameIndex);

  // 7. Export + full render plan.
  const ex = await getJson('/api/export');
  const render = await getJson('/api/render');
  console.log('7 export version', ex.serverVersion, 'clips', ex.clips.length,
    'rational time sample', ex.clips[0].timelineIn, 'output frames', render.frameCount);

  const finalSnap = await getJson('/api/snapshot');
  console.log('FINAL clip ids:', finalSnap.clips.map((c) => c.id).sort().join(', '));
  alice.close(); bob.close();
  } finally {
    if (ownedServer) ownedServer.kill('SIGTERM');
  }
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
