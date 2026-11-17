'use strict';
/* global document, window, fetch, CollabSession */

const TPS = 30000;
const sec = (t) => (t / TPS).toFixed(3) + 's';
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

// Thin UI binding: every state fact lives in the CollabSession kernel. The
// panel renders kernel state and turns gestures into kernel calls; it never
// applies local state on its own.
class Editor {
  constructor(editorId, color) {
    this.id = editorId;
    this.color = color;
    this.session = new CollabSession(editorId);
    this.selectedClip = null;
    this.lastOp = null;
    this._buildDom();
    this._bindKernel();
    this.session.connect(0);
  }

  _buildDom() {
    const tpl = document.getElementById('editor-template');
    const root = document.getElementById(`panel-${this.id}`);
    root.appendChild(tpl.content.cloneNode(true));
    this.el = (sel) => root.querySelector(sel);
    this.el('h2.name').textContent = `编辑者 ${this.id.toUpperCase()}`;
    this.el('.dot').style.background = this.color;

    fetch('/api/snapshot').then((r) => r.json()).then((s) => {
      this.session.state = s;
      this.session.logFormat = s.logFormat;
      for (const src of s.sources) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = `${src.label} (${src.id}, ${src.frameCount}帧)`;
        this.el('[data-field="sourceId"]').appendChild(opt);
      }
      this._render();
      this._renderLogBadge();
    });

    this.el('[data-field="type"]').addEventListener('change', () => this._syncFormVisibility());
    this.el('[data-act="submit"]').addEventListener('click', () => this._submit(false));
    this.el('[data-act="reconnect"]').addEventListener('click', () => this.session.reconnect());
    this.el('[data-act="duplicate"]').addEventListener('click', () => this._resendDuplicate());
    this.el('[data-act="stale"]').addEventListener('click', () => this._submit(true));
    this.el('[data-act="preview"]').addEventListener('click', () => this._preview());
    this._syncFormVisibility();
  }

  _bindKernel() {
    const s = this.session;
    s.subscribe((kind, payload) => {
      if (kind === 'connection') this._setConn(payload.online);
      if (kind === 'snapshot' || kind === 'record' || kind === 'pending' || kind === 'resend' || kind === 'conflicts') {
        this._render();
      }
      if (kind === 'error') this._flashError(payload.reason);
      if (kind === 'undo_done') this._render();
    });
  }

  _flashError(reason) {
    const badge = this.el('.ver.badge');
    const old = badge.textContent;
    badge.textContent = `内核错误: ${reason}`;
    badge.style.color = 'var(--warn)';
    setTimeout(() => { badge.textContent = old; badge.style.color = ''; }, 2500);
  }

  _setConn(online) {
    const dot = this.el('.dot');
    const badge = this.el('.conn.badge');
    dot.classList.toggle('online', online);
    badge.textContent = online ? '已连接' : '断线';
    badge.style.color = online ? 'var(--ok)' : 'var(--warn)';
    if (online && this.session.state) {
      this.el('.ver.badge').textContent = `v${this.session.state.version} / seq${this.session.state.seq}`;
    }
  }

  _renderLogBadge() {
    const lf = this.session.logFormat;
    if (lf) this.el('.logformat.badge').textContent = `${lf.format} v${lf.formatVersion}`;
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
    const st = this.session.state;
    if (!st || !st.clips.length) return 0;
    return Math.max(...st.clips.map((c) => c.timelineOut));
  }

  _submit(forceStale) {
    let op;
    try { op = this._readForm(); } catch (e) { window.alert(e.message); return; }
    if (forceStale && Number.isInteger(op.baseVersion)) op.baseVersion = Math.max(0, op.baseVersion - 2);
    this.lastOp = op;
    this.session.submit(op);
    this._render();
  }

  _resendDuplicate() {
    if (!this.lastOp) { window.alert('还没有发送过操作'); return; }
    // Same opId: server must treat this as a duplicate, never apply twice.
    this.session.resend(this.lastOp);
    this.session.history.push({ type: 'rejected', reason: '(client) duplicate re-sent locally', op: this.lastOp, localNote: true });
    this._render();
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

  // Drag a clip on the track: the gesture becomes a normal kernel move op, so
  // concurrent modifications are checked by the same conflict rules as the
  // form. A rejected drag surfaces in the conflict list instead of moving.
  _bindDrag(div, clip) {
    div.draggable = true;
    div.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', clip.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
  }

  _bindTrackDrop() {
    if (this._dropBound) return;
    this._dropBound = true;
    const track = this.el('.track');
    track.addEventListener('dragover', (ev) => ev.preventDefault());
    track.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/plain');
      if (!id) return;
      const st = this.session.state;
      const current = st.clips.find((c) => c.id === id);
      if (!current) return;
      const rect = track.getBoundingClientRect();
      const maxTick = Math.max(90000, ...st.clips.map((c) => c.timelineOut));
      const scale = rect.width / maxTick;
      const tick = Math.max(0, Math.round((ev.clientX - rect.left) / scale / 1000) * 1000);
      if (tick === current.timelineIn) return;
      const op = {
        type: 'move', opId: uid(`op-${this.id}`), clientId: this.id,
        clipId: id, newTimelineIn: tick, baseVersion: st.version,
      };
      this.lastOp = op;
      this.session.submit(op);
    });
  }

  _render() {
    const st = this.session.state;
    if (!st) return;
    this.el('.ver.badge').textContent = `v${st.version} / seq${st.seq}`;
    this._renderLogBadge();
    this._renderTrack();
    this._renderLists();
  }

  _renderTrack() {
    const st = this.session.state;
    const track = this.el('.track');
    const ruler = this.el('.ruler');
    track.innerHTML = '';
    ruler.innerHTML = '';
    this._bindTrackDrop();
    const clips = st.clips;
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
      this._bindDrag(div, clip);
      track.appendChild(div);
    }
  }

  _renderLists() {
    const s = this.session;
    const pendingUl = this.el('.pending-list');
    pendingUl.className = `pending-list${s.pending.size ? '' : ' empty'}`;
    pendingUl.innerHTML = '';
    if (!s.pending.size) pendingUl.innerHTML = '<li class="empty-note">无待确认操作</li>';
    for (const op of s.pending.values()) {
      const li = document.createElement('li');
      li.textContent = `⏳ ${op.opId}  ${op.type} ${op.clipId || ''} ${JSON.stringify(this._opShorthand(op))}`;
      pendingUl.appendChild(li);
    }

    const confUl = this.el('.conflict-list');
    confUl.className = `conflict-list${s.conflicts.length ? '' : ' empty'}`;
    confUl.innerHTML = '';
    if (!s.conflicts.length) confUl.innerHTML = '<li class="empty-note">无冲突</li>';
    for (const rej of s.conflicts.slice(0, 8)) {
      const li = document.createElement('li');
      const detail = rej.conflict
        ? `字段冲突: ${rej.conflict.changedFields.map((c) => `${c.field}=${c.value}(v${c.version}, by ${c.editor})`).join('; ')}；你的 baseRevision=${rej.op.baseVersion}`
        : rej.reason;
      li.innerHTML = `<b>${rej.reason}</b><br/>op ${rej.op.opId} (${rej.op.type} ${rej.op.clipId || ''})<br/>${detail}`;
      if (rej.conflict) {
        const row = document.createElement('div');
        row.className = 'resolve';
        const theirs = document.createElement('button');
        theirs.textContent = '采用对方值（关闭）';
        theirs.onclick = () => s.dismissConflict(rej);
        const mine = document.createElement('button');
        mine.textContent = '用最新版本重试我的值';
        mine.onclick = () => {
          s.dismissConflict(rej);
          const retry = s.retryOp(rej, uid(`op-${this.id}`));
          if (retry) this.lastOp = retry;
        };
        row.append(theirs, mine);
        li.appendChild(row);
      }
      confUl.appendChild(li);
    }

    const logOl = this.el('.log-list');
    logOl.innerHTML = '';
    for (const ev of s.history.slice(-30)) {
      const li = document.createElement('li');
      li.className = ev.type;
      const tag = ev.type === 'applied' ? '✓ 已确认' : '✗ 拒绝';
      const dup = ev.duplicate ? ' [重复消息，幂等忽略]' : '';
      const base = ev.result ? `base=${ev.result.baseRevision}` : '';
      li.innerHTML = `<span class="seq">seq${ev.seq ?? '-'} v${ev.version ?? ev.serverVersion ?? '-'} ${base}</span> ${tag}${dup}<br/>${ev.clientId}:${ev.op ? ev.op.type : ''} ${ev.op && ev.op.clipId ? ev.op.clipId : ''} ${ev.reason ? '— ' + ev.reason : ''}`;
      if (ev.type === 'applied' && !ev.localNote) {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'undo-btn';
        undoBtn.textContent = '撤销';
        undoBtn.onclick = () => s.undoSeq(ev.seq);
        li.appendChild(undoBtn);
      }
      logOl.appendChild(li);
    }
  }

  _opShorthand(op) {
    const keys = ['value', 'at', 'newTimelineIn', 'baseVersion', 'side', 'timelineIn', 'srcIn', 'srcOut'];
    const out = {};
    for (const k of keys) if (op[k] !== undefined) out[k] = op[k];
    return out;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.editors = {
    alice: new Editor('alice', 'var(--alice)'),
    bob: new Editor('bob', 'var(--bob)'),
  };

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
