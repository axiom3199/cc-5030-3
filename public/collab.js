'use strict';
/* global WebSocket, location, fetch */

// Collaborative editing kernel (transport/state only, no DOM).
// Both editor panels instantiate this; the UI layer is a thin view that
// renders kernel state and feeds user intents back in. Every accepted or
// rejected outcome comes from the server's v2 oplog records — the kernel
// never invents state locally.
class CollabSession {
  constructor(editorId) {
    this.id = editorId;
    this.ws = null;
    this.state = null;
    this.logFormat = null;
    this.connected = false;
    this.pending = new Map(); // opId -> op awaiting authoritative result
    this.conflicts = []; // rejected v2 records, newest first
    this.history = []; // applied + rejected records as observed
    this.peers = [];
    this.lastError = null;
    this.lastSeq = 0;
    this._listeners = new Set();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(kind, payload) {
    for (const fn of this._listeners) {
      try { fn(kind, payload, this); } catch (e) { /* view errors must not kill the socket */ }
    }
  }

  connect(lastSeq = 0) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', clientId: this.id, lastSeq }));
    };
    ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    ws.onclose = () => { this.connected = false; this._emit('connection', { online: false }); };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  reconnect() {
    try { this.ws && this.ws.close(); } catch { /* noop */ }
    // Pending ops survive the disconnect; server-side opId dedup makes the
    // re-send after hello safe.
    this.connect(this.state ? this.state.seq : 0);
  }

  _onMessage(msg) {
    if (msg.type === 'hello_ack') {
      this.connected = true;
      this.logFormat = msg.logFormat;
      this._emit('connection', { online: true, version: msg.serverVersion, seq: msg.seq, reconnecting: msg.reconnecting });
      return;
    }
    if (msg.type === 'peer_joined' || msg.type === 'peer_left') {
      if (Array.isArray(msg.peers)) this.peers = msg.peers;
      this._emit('peers', { peers: this.peers });
      return;
    }
    if (msg.type === 'snapshot') {
      this.state = msg.state;
      this.lastSeq = msg.state.seq;
      this.logFormat = msg.state.logFormat || this.logFormat;
      this._emit('snapshot', msg.state);
      return;
    }
    if (msg.type === 'applied' || msg.type === 'rejected') {
      this.history.push(msg);
      if (msg.type === 'applied') {
        this.pending.delete(msg.op.opId);
        this.lastSeq = msg.seq;
      } else if (!msg.duplicate) {
        this.conflicts.unshift(msg);
      }
      if (!msg.duplicate) this.refreshSnapshot();
      this._emit('record', msg);
      return;
    }
    if (msg.type === 'undo_done') {
      this._emit('undo_done', msg);
      return;
    }
    if (msg.type === 'error') {
      this.lastError = msg.reason;
      this._emit('error', msg);
    }
  }

  // Re-pull the authoritative snapshot after any committed change.
  refreshSnapshot() {
    return fetch('/api/snapshot').then((r) => r.json()).then((s) => {
      this.state = s;
      this.lastSeq = s.seq;
      this._emit('snapshot', s);
    }).catch((e) => { this.lastError = String(e); this._emit('error', { reason: String(e) }); });
  }

  // Submit a business op through the transport envelope.
  submit(op) {
    this.pending.set(op.opId, op);
    this.ws.send(JSON.stringify({ type: 'op', op }));
    this._emit('pending', op);
    return op;
  }

  resend(op) {
    this.ws.send(JSON.stringify({ type: 'op', op }));
    this._emit('resend', op);
  }

  // Kernel-driven undo: the server derives inverse ops from the v2 record's
  // explicit result and re-applies them under the normal conflict rules.
  undoSeq(seq) {
    this.ws.send(JSON.stringify({ type: 'undo', seq }));
  }

  // Build a retry from a rejected record against the freshest base revision.
  retryOp(rejectedRecord, newOpId) {
    if (!this.state) return null;
    const retry = { ...rejectedRecord.op, opId: newOpId, baseVersion: this.state.version };
    return this.submit(retry);
  }

  dismissConflict(record) {
    this.conflicts = this.conflicts.filter((x) => x !== record);
    this._emit('conflicts', this.conflicts);
  }
}

window.CollabSession = CollabSession;
