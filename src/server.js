'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { TimelineStore } = require('./store');
const { MediaLibrary } = require('./media');
const { upgrade, WSConnection } = require('./ws');
const { TICKS_PER_SECOND } = require('./time');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

function createServer({ mediaDir, sources, log = console }) {
  const store = new TimelineStore(sources);
  const media = new MediaLibrary(mediaDir);
  const hub = new Map(); // clientId -> WSConnection
  let connCounter = 0;

  function broadcast(event, exceptId) {
    const text = JSON.stringify(event);
    for (const [id, conn] of hub) {
      if (id === exceptId) continue;
      if (!conn.closed) conn.sendText(text);
    }
  }

  function onOp(conn, msg) {
    if (typeof msg.clientId !== 'string' || !msg.clientId) {
      conn.send({ type: 'error', reason: 'clientId required' });
      return;
    }
    if (typeof msg.opId !== 'string' || !msg.opId) {
      conn.send({ type: 'error', reason: 'opId required', clientId: msg.clientId });
      return;
    }
    const result = store.apply(msg);
    // Sender gets the authoritative result; everyone else gets a broadcast.
    conn.send(result);
    if (result.type === 'applied' && !result.duplicate) {
      broadcast(result, msg.clientId);
    } else if (result.type === 'rejected' && !result.duplicate) {
      // Rejections are also fanned out so both editors see the explicit rule
      // firing and no one believes a silent overwrite happened.
      broadcast(result, msg.clientId);
    }
  }

  function handleConnection(conn) {
    connCounter += 1;
    conn.peerLabel = `conn#${connCounter}`;
    conn.onMessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { conn.send({ type: 'error', reason: 'invalid json' }); return; }
      if (msg.type === 'hello') {
        const clientId = String(msg.clientId || '').slice(0, 64);
        if (!/^[A-Za-z0-9_-]+$/.test(clientId)) { conn.send({ type: 'error', reason: 'bad clientId' }); return; }
        const reconnecting = hub.has(clientId);
        hub.set(clientId, conn);
        conn.clientId = clientId;
        conn.send({ type: 'hello_ack', clientId, serverVersion: store.version, seq: store.seq, reconnecting });
        // Re-send everything the client may have missed, then a fresh snapshot.
        const since = Number.isInteger(msg.lastSeq) ? Math.max(0, msg.lastSeq) : 0;
        for (const ev of store.log) if (ev.seq > since) conn.send(ev);
        // A brand-new session gets the full rejection history once; a reconnect
        // only replays missed applied events (the snapshot carries the truth).
        if (!Number.isInteger(msg.lastSeq)) for (const rj of store.rejects) conn.send(rj);
        conn.send({ type: 'snapshot', state: store.snapshot(), peers: [...hub.keys()] });
        log.log(`[hub] ${clientId} connected${reconnecting ? ' (reconnect, replay since seq ' + since + ')' : ''}, peers=${[...hub.keys()].join(',')}`);
        broadcast({ type: 'peer_joined', clientId, peers: [...hub.keys()] }, clientId);
      } else if (msg.type === 'op') {
        // Transport envelope: the business operation and its type live in
        // msg.op so the wire's 'op' marker cannot be clobbered by op fields.
        if (!msg.op || typeof msg.op !== 'object') {
          conn.send({ type: 'error', reason: "envelope 'op' payload required" });
          return;
        }
        onOp(conn, msg.op);
      } else if (msg.type === 'ping') {
        conn.send({ type: 'pong', seq: msg.seq });
      } else {
        conn.send({ type: 'error', reason: `unknown message type ${msg.type}` });
      }
    };
    conn.onClose = () => {
      if (conn.clientId && hub.get(conn.clientId) === conn) {
        hub.delete(conn.clientId);
        log.log(`[hub] ${conn.clientId} disconnected`);
        broadcast({ type: 'peer_left', clientId: conn.clientId, peers: [...hub.keys()] });
      }
    };
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.searchParams;
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return; // handled below
    if (u.pathname === '/api/snapshot') return sendJson(res, 200, store.snapshot());
    if (u.pathname === '/api/log') return sendJson(res, 200, { applied: store.log, rejected: store.rejects });
    if (u.pathname === '/api/render') {
      const plan = media.renderPlan(store.snapshot());
      return sendJson(res, 200, { ticksPerSecond: TICKS_PER_SECOND, frameCount: plan.length, plan });
    }
    if (u.pathname === '/api/preview') {
      const tick = parseInt(p.get('tick') || '0', 10);
      if (!Number.isInteger(tick) || tick < 0) return sendJson(res, 400, { error: 'tick must be non-negative integer' });
      const hit = media.resolveFrame(store.snapshot(), tick);
      if (!hit) return sendJson(res, 404, { error: 'no committed clip covers this tick', tick });
      return sendJson(res, 200, hit);
    }
    if (u.pathname === '/api/frame') {
      const sourceId = p.get('source') || '';
      const frame = parseInt(p.get('frame') || '-1', 10);
      if (!/^[A-Za-z0-9_-]+$/.test(sourceId) || !Number.isInteger(frame) || frame < 0) {
        return sendJson(res, 400); res.end();
      }
      const fp = media.framePath(sourceId, frame);
      return fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('no frame'); return; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    }
    if (u.pathname === '/api/export') {
      const snap = store.snapshot();
      const plan = media.renderPlan(snap);
      const edl = snap.clips
        .slice()
        .sort((a, b) => a.timelineIn - b.timelineIn)
        .map((c) => {
          const src = snap.sources.find((s) => s.id === c.sourceId);
          const fps = `${src.fpsNum}/${src.fpsDen}`;
          const r = (t) => `${t}/${TICKS_PER_SECOND}`;
          return {
            clipId: c.id, source: c.sourceId, fps,
            sourceIn: r(c.srcIn), sourceOut: r(c.srcOut),
            timelineIn: r(c.timelineIn), timelineOut: r(c.timelineOut),
            fieldVersion: c.fieldVersion, lastEditor: c.fieldEditor,
          };
        });
      return sendJson(res, 200, {
        format: 'collab-timeline/v1',
        ticksPerSecond: TICKS_PER_SECOND,
        exportedAt: new Date().toISOString(),
        serverVersion: snap.version,
        eventSeq: snap.seq,
        clips: edl,
        renderPlan: plan,
      });
    }
    return serveStatic(req, res, u.pathname);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!req.headers['sec-websocket-key']) { socket.destroy(); return; }
    upgrade(req, socket, head, handleConnection);
  });

  return {
    server, store, media,
    listen: (port, cb) => server.listen(port, cb),
    close: () => { for (const c of hub.values()) c.close(); server.close(); },
    _hub: hub,
    WSConnection,
  };
}

module.exports = { createServer };
