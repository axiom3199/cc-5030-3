'use strict';
/* global document, window, fetch, WebSocket */

const TPS = 30000;
const sec = (t) => (t / TPS).toFixed(3) + 's';
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

class Editor {
  constructor(editorId, color) {
    this.id = editorId;
    this.color = color;
    this.ws = null;
    this.state = null;
    this.snapshotDirty = false;
    this.pending = new Map(); // opId -> op
    this.conflicts = [];
    this.log = [];
    this.selectedClip = null;
    this.lastOp = null;
    this._buildDom();
    this.connect(0);
  }

  _buildDom() {
    const tpl = document.getElementById('editor-template');
    const root = document.getElementById(`panel-${this.id}`);
    root.appendChild(tpl.content.cloneNode(true));
    this.el = (sel) => root.querySelector(sel);
    this.el('h2.name').textContent = `编辑者 ${this.id.toUpperCase()}`;
    this.el('.dot').style.background = this.color;

    fetch('/api/snapshot').then((r) => r.json()).then((s) => {
      this.state = s;
      for (const src of s.sources) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = `${src.label} (${src.id}, ${src.frameCount}帧)`;
        this.el('[data-field="sourceId"]').appendChild(opt);
      }
      this._render();
    });

    this.el('[data-field="type"]').addEventListener('change', () => this._syncFormVisibility());
    this.el('[data-act="submit"]').addEventListener('click', () => this._submit(false));
    this.el('[data-act="reconnect"]').addEventListener('click', () => this.reconnect());
    this.el('[data-act="duplicate"]').addEventListener('click', () => this._resendDuplicate());
    this.el('[data-act="stale"]').addEventListener('click', () => this._submit(true));
    this.el('[data-act="preview"]').addEventListener('click', () => this._preview());
    this._syncFormVisibility();
  }

  connect(lastSeq) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', clientId: this.id, lastSeq }));
      this._setConn(true);
    };
    ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    ws.onclose = () => { this._setConn(false); };
    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  reconnect() {
    try { this.ws && this.ws.close(); } catch { /* noop */ }
    const lastSeq = this.state ? this.state.seq : 0;
    // Pending ops that never got an answer survive the disconnect: they are
    // re-sent after hello, and server-side opId dedup makes this safe.
    this.connect(lastSeq);
  }

  _setConn(online) {
    const dot = this.el('.dot');
    const badge = this.el('.conn.badge');
    dot.classList.toggle('online', online);
    badge.textContent = online ? '已连接' : '断线';
    badge.style.color = online ? 'var(--ok)' : 'var(--warn)';
  }

  _onMessage(msg) {
    if (msg.type === 'hello_ack' || msg.type === 'peer_joined' || msg.type === 'peer_left') {
      if (msg.peers) this.el('.peers.badge').textContent = `peers: ${msg.peers.filter((p) => p !== this.id).join(', ') || '（仅自己）'}`;
      if (msg.type === 'hello_ack') this.el('.ver.badge').textContent = `v${msg.serverVersion} / seq${msg.seq}`;
      return;
    }
    if (msg.type === 'snapshot') {
      this.state = msg.state;
      this.el('.ver.badge').textContent = `v${msg.state.version} / seq${msg.state.seq}`;
      this._render();
      return;
    }
    if (msg.type === 'applied' || msg.type === 'rejected') {
      this.log.push(msg);
      if (msg.type === 'applied' && this.pending.has(msg.op.opId)) this.pending.delete(msg.op.opId);
      if (msg.type === 'rejected') this.conflicts.unshift(msg);
      if (!msg.duplicate) this._scheduleSnapshot();
      this._renderLists();
    }
  }

  _scheduleSnapshot() {
    if (this.snapshotDirty) return;
    this.snapshotDirty = true;
    setTimeout(async () => {
      this.snapshotDirty = false;
      try {
        const r = await fetch('/api/snapshot');
        this.state = await r.json();
        this.el('.ver.badge').textContent = `v${this.state.version} / seq${this.state.seq}`;
        this._render();
      } catch { /* will retry on next event */ }
    }, 30);
  }

  _readForm() {
    const f = (name) => this.el(`[data-field="${name}"]`);
    const int = (name) => {
      const raw = f(name).value.trim();
      if (raw === '') return undefined;
      if (!/^-?\d+$/.test(raw)) throw new Error(`${name} 必须是整数 ticks`);
      return parseInt(raw, 10);
    };
    const type = f('type').value;
    const op = { type, opId: uid(`op-${this.id}`), clientId: this.id };
    if (type === 'insert') {
      Object.assign(op, {
        clipId: f('clipId').value.trim() || uid('clip'),
        sourceId: f('sourceId').value,
        srcIn: int('srcIn') ?? 0,
        srcOut: int('srcOut'),
        timelineIn: int('timelineIn') ?? this._nextFreeTick(),
      });
    } else if (type === 'trim') {
      Object.assign(op, { clipId: f('clipId').value.trim(), side: f('side').value, baseVersion: int('baseVersion') });
      op.value = op.side === 'in' ? int('srcIn') : int('srcOut');
    } else if (type === 'split') {
      Object.assign(op, { clipId: f('clipId').value.trim(), at: int('at'), baseVersion: int('baseVersion') });
    } else if (type === 'move') {
      Object.assign(op, { clipId: f('clipId').value.trim(), newTimelineIn: int('newTimelineIn'), baseVersion: int('baseVersion') });
    } else if (type === 'remove') {
      Object.assign(op, { clipId: f('clipId').value.trim(), baseVersion: int('baseVersion') });
    }
    return op;
  }

  _nextFreeTick() {
    if (!this.state || !this.state.clips.length) return 0;
    return Math.max(...this.state.clips.map((c) => c.timelineOut));
  }

  _submit(forceStale) {
    let op;
    try { op = this._readForm(); } catch (e) { window.alert(e.message); return; }
    if (forceStale && Number.isInteger(op.baseVersion)) op.baseVersion = Math.max(0, op.baseVersion - 2);
    this.lastOp = op;
    this.pending.set(op.opId, op);
    this.ws.send(JSON.stringify({ type: 'op', op }));
    this._renderLists();
  }

  _resendDuplicate() {
    if (!this.lastOp) { window.alert('还没有发送过操作'); return; }
    // Same opId: server must treat this as a duplicate, never apply twice.
    this.ws.send(JSON.stringify({ type: 'op', op: this.lastOp }));
    this.log.push({ type: 'rejected', reason: '(client) duplicate re-sent locally', op: this.lastOp, localNote: true });
    this._renderLists();
  }

  async _preview() {
    const tick = parseInt(this.el('.playhead').value, 10);
    const meta = this.el('.preview-meta');
    const frameBox = this.el('.preview-frame');
    try {
      const r = await fetch(`/api/preview?tick=${tick}`);
      const data = await r.json();
      if (!r.ok) {
        meta.textContent = data.error || '无片段';
        frameBox.innerHTML = '<span class="preview-empty">该 tick 落在空隙/末尾，无画面</span>';
        return;
      }
      meta.textContent = `clip=${data.clipId} src=${data.sourceId} sourceTick=${data.sourceTick} → 帧#${data.frameIndex}`;
      frameBox.innerHTML = `<img src="/api/frame?source=${encodeURIComponent(data.sourceId)}&frame=${data.frameIndex}&t=${Date.now()}" alt="frame ${data.frameIndex}" />`;
    } catch (e) { meta.textContent = String(e); }
  }

  _syncFormVisibility() {
    const type = this.el('[data-field="type"]').value;
    const groups = {
      insert: ['sourceId', 'clipId', 'srcIn', 'srcOut', 'timelineIn'],
      trim: ['side', 'clipId', 'srcIn', 'srcOut', 'baseVersion'],
      split: ['clipId', 'at', 'baseVersion'],
      move: ['clipId', 'newTimelineIn', 'timelineIn', 'baseVersion'],
      remove: ['clipId', 'baseVersion'],
    };
    const all = ['sourceId', 'side', 'clipId', 'srcIn', 'srcOut', 'timelineIn', 'baseVersion', 'at', 'newTimelineIn'];
    for (const name of all) {
      const label = this.el(`[data-field="${name}"]`).closest('label');
      label.classList.toggle('dim', !groups[type].includes(name));
    }
  }

  _fillFromClip(clip) {
    this.selectedClip = clip.id;
    const set = (name, v) => { this.el(`[data-field="${name}"]`).value = v; };
    set('clipId', clip.id);
    set('baseVersion', Math.max(clip.fieldVersion.srcIn || 0, clip.fieldVersion.srcOut || 0, clip.fieldVersion.timelineIn || 0));
    set('srcIn', clip.srcIn);
    set('srcOut', clip.srcOut);
    set('at', Math.floor((clip.srcIn + clip.srcOut) / 2 / 1000) * 1000);
    set('newTimelineIn', clip.timelineIn);
    this._render();
  }

  _render() {
    if (!this.state) return;
    this._renderTrack();
    this._renderLists();
  }

  _renderTrack() {
    const track = this.el('.track');
    const ruler = this.el('.ruler');
    track.innerHTML = '';
    ruler.innerHTML = '';
    const clips = this.state.clips;
    const maxTick = Math.max(90000, ...clips.map((c) => c.timelineOut));
    const width = track.clientWidth || 600;
    const scale = width / maxTick;
    for (let t = 0; t <= maxTick; t += 30000) {
      const s = document.createElement('span');
      s.style.left = `${t * scale}px`;
      s.textContent = `${t / TPS}s`;
      ruler.appendChild(s);
    }
    if (!clips.length) {
      track.innerHTML = '<span class="gaplabel">空时间线 — 用 insert 插入第一段素材</span>';
      return;
    }
    for (const clip of clips) {
      const div = document.createElement('div');
      div.className = `clip ${clip.sourceId}${this.selectedClip === clip.id ? ' selected' : ''}`;
      div.style.left = `${clip.timelineIn * scale}px`;
      div.style.width = `${Math.max(2, (clip.timelineOut - clip.timelineIn) * scale)}px`;
      const fv = clip.fieldVersion;
      div.innerHTML = `<div class="cid">${clip.id}</div>
        <div class="meta">${clip.sourceId} src[${sec(clip.srcIn)}→${sec(clip.srcOut)}]</div>
        <div class="meta">TL[${sec(clip.timelineIn)}→${sec(clip.timelineOut)}]</div>
        <div class="fv">v in:${fv.srcIn ?? '-'} out:${fv.srcOut ?? '-'} pos:${fv.timelineIn ?? '-'}</div>`;
      div.addEventListener('click', () => this._fillFromClip(clip));
      track.appendChild(div);
    }
  }

  _renderLists() {
    const pendingUl = this.el('.pending-list');
    pendingUl.className = `pending-list${this.pending.size ? '' : ' empty'}`;
    pendingUl.innerHTML = '';
    if (!this.pending.size) pendingUl.innerHTML = '<li class="empty-note">无待确认操作</li>';
    for (const op of this.pending.values()) {
      const li = document.createElement('li');
      li.textContent = `⏳ ${op.opId}  ${op.type} ${op.clipId || ''} ${JSON.stringify(this._opShorthand(op))}`;
      pendingUl.appendChild(li);
    }

    const confUl = this.el('.conflict-list');
    confUl.className = `conflict-list${this.conflicts.length ? '' : ' empty'}`;
    confUl.innerHTML = '';
    if (!this.conflicts.length) confUl.innerHTML = '<li class="empty-note">无冲突</li>';
    for (const rej of this.conflicts.slice(0, 8)) {
      const li = document.createElement('li');
      const detail = rej.conflict
        ? `字段冲突: ${rej.conflict.changedFields.map((c) => `${c.field}=${c.value}(v${c.version}, by ${c.editor})`).join('; ')}；你的 baseVersion=${rej.op.baseVersion}`
        : rej.reason;
      li.innerHTML = `<b>${rej.reason}</b><br/>op ${rej.op.opId} (${rej.op.type} ${rej.op.clipId || ''})<br/>${detail}`;
      if (rej.conflict) {
        const row = document.createElement('div');
        row.className = 'resolve';
        const theirs = document.createElement('button');
        theirs.textContent = '采用对方值（关闭）';
        theirs.onclick = () => { this.conflicts = this.conflicts.filter((x) => x !== rej); this._renderLists(); };
        const mine = document.createElement('button');
        mine.textContent = '用最新版本重试我的值';
        mine.onclick = () => this._retryConflict(rej);
        row.append(theirs, mine);
        li.appendChild(row);
      }
      confUl.appendChild(li);
    }

    const logOl = this.el('.log-list');
    logOl.innerHTML = '';
    for (const ev of this.log.slice(-30)) {
      const li = document.createElement('li');
      li.className = ev.type;
      const tag = ev.type === 'applied' ? '✓ 已确认' : '✗ 拒绝';
      const dup = ev.duplicate ? ' [重复消息，幂等忽略]' : '';
      li.innerHTML = `<span class="seq">seq${ev.seq ?? '-'} v${ev.version ?? ev.serverVersion ?? '-'}</span> ${tag}${dup}<br/>${ev.clientId}:${ev.op ? ev.op.type : ''} ${ev.op && ev.op.clipId ? ev.op.clipId : ''} ${ev.reason ? '— ' + ev.reason : ''}`;
      logOl.appendChild(li);
    }
  }

  _opShorthand(op) {
    const keys = ['value', 'at', 'newTimelineIn', 'baseVersion', 'side', 'timelineIn', 'srcIn', 'srcOut'];
    const out = {};
    for (const k of keys) if (op[k] !== undefined) out[k] = op[k];
    return out;
  }

  async _retryConflict(rej) {
    if (!this.state) return;
    const clip = this.state.clips.find((c) => c.id === rej.op.clipId);
    if (!clip) { window.alert('片段已不存在（可能已被删除/分割）'); return; }
    const retry = { ...rej.op, opId: uid(`op-${this.id}`), baseVersion: this.state.version };
    this.pending.set(retry.opId, retry);
    this.lastOp = retry;
    this.ws.send(JSON.stringify({ type: 'op', op: retry }));
    this._renderLists();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new Editor('alice', 'var(--alice)');
  new Editor('bob', 'var(--bob)');

  document.getElementById('btn-export').onclick = async () => {
    const r = await fetch('/api/export');
    const data = await r.json();
    const box = document.getElementById('global-render');
    box.classList.remove('hidden');
    box.textContent = JSON.stringify(data, null, 2);
  };
  document.getElementById('btn-render').onclick = async () => {
    const r = await fetch('/api/render');
    const data = await r.json();
    const box = document.getElementById('global-render');
    box.classList.remove('hidden');
    box.textContent = `最终时间线解码输出 ${data.frameCount} 帧（按时间线顺序）:\n` +
      data.plan.map((f, i) => `${String(i).padStart(3)}: clip=${f.clipId} src=${f.sourceId} frame#${f.frameIndex}`).join('\n');
  };
});
