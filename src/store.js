'use strict';

const isInt = Number.isInteger;
const {
  LOG_FORMAT, LOG_FORMAT_VERSION, OplogError,
  baseRevisionOf, clipSnapshot, buildRecord, readOplog, orderRecords,
} = require('./oplog');

// Field-level optimistic concurrency.
// Every mutable clip field carries the server version at which it last changed
// plus the editor who changed it. An op declares the fields it depends on; if
// any of them moved past the op's baseVersion the op is REJECTED as a conflict
// with full details instead of silently overwriting the other editor's work.
const FIELDS = Object.freeze({
  trimIn: ['srcIn', 'timelineIn'],
  trimOut: ['srcOut'],
  move: ['timelineIn'],
  split: ['srcIn', 'srcOut', 'timelineIn'],
  remove: ['srcIn', 'srcOut', 'timelineIn'],
});

class ConflictError extends Error {
  constructor(details) {
    super(details.reason);
    this.name = 'ConflictError';
    this.details = details;
  }
}

class ValidationError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ValidationError';
  }
}

class TimelineStore {
  constructor(sources) {
    this.sources = new Map(); // sourceId -> {id, fpsNum, fpsDen, frameCount, duration}
    for (const s of sources) this.addSource(s);
    this.clips = new Map(); // clipId -> clip
    this.version = 0;
    this.seq = 0;
    this.recNo = 0; // global record number across applied + rejected records
    this.log = []; // applied v2 records, replayable, ordered by seq === index+1
    this.rejects = []; // rejected v2 records with explicit reasons (UI + tests)
    this.opIndex = new Map(); // opId -> {seq, response}
    this.sink = null; // optional OplogSink; live writes are appended when set
    this.logFormat = Object.freeze({ format: LOG_FORMAT, formatVersion: LOG_FORMAT_VERSION });
    this._restoring = false; // when true, replayed records are journaled verbatim
  }

  addSource(s) {
    if (!s || typeof s.id !== 'string') throw new ValidationError('bad source');
    if (!isInt(s.fpsNum) || !isInt(s.fpsDen) || s.fpsNum <= 0 || s.fpsDen <= 0) {
      throw new ValidationError('source fps must be integer rational');
    }
    if (!isInt(s.frameCount) || s.frameCount <= 0) throw new ValidationError('bad frameCount');
    const { frameIndexToTick } = require('./time');
    const duration = frameIndexToTick(s.frameCount, s.fpsNum, s.fpsDen);
    this.sources.set(s.id, {
      id: s.id, label: s.label || s.id,
      fpsNum: s.fpsNum, fpsDen: s.fpsDen, frameCount: s.frameCount, duration,
    });
  }

  snapshot() {
    return {
      version: this.version,
      seq: this.seq,
      recNo: this.recNo,
      logFormat: { ...this.logFormat },
      sources: [...this.sources.values()],
      clips: [...this.clips.values()].map((c) => ({ ...c, fieldVersion: { ...c.fieldVersion }, fieldEditor: { ...c.fieldEditor } })),
    };
  }

  _nextVersion() { this.version += 1; return this.version; }

  _record(op, clipIds, targets, removed) {
    const version = this.version; // already bumped by caller
    if (this._restoring) {
      return buildRecord('applied', {
        recNo: 0, seq: 0, version,
        clientId: op.clientId, ts: Date.now(), op, clipIds, targets,
        baseRevision: baseRevisionOf(op, version - 1), removed: Boolean(removed),
      });
    }
    this.recNo += 1;
    this.seq += 1;
    const event = buildRecord('applied', {
      recNo: this.recNo, seq: this.seq, version,
      clientId: op.clientId, ts: Date.now(), op, clipIds, targets,
      baseRevision: baseRevisionOf(op, version - 1), removed: Boolean(removed),
    });
    this.log.push(event);
    this.opIndex.set(op.opId, { seq: this.seq, response: event });
    if (this.sink) this.sink.append(event);
    return event;
  }

  _reject(op, reason, extra) {
    if (this._restoring) {
      return buildRecord('rejected', {
        recNo: 0, clientId: op.clientId, ts: Date.now(), op, reason,
        conflict: extra && extra.conflict,
        baseRevision: baseRevisionOf(op, this.version), serverVersion: this.version,
      });
    }
    this.recNo += 1;
    const entry = buildRecord('rejected', {
      recNo: this.recNo, clientId: op.clientId, ts: Date.now(), op, reason,
      conflict: extra && extra.conflict,
      baseRevision: baseRevisionOf(op, this.version), serverVersion: this.version,
    });
    this.rejects.push(entry);
    this.opIndex.set(op.opId, { seq: null, response: entry });
    if (this.sink) this.sink.append(entry);
    return entry;
  }

  _checkFields(clip, op, fieldNames) {
    // An op citing a version newer than anything the server has produced is
    // out-of-order / from a diverged client. Reject explicitly instead of
    // letting an impossible baseVersion slip through the field checks.
    if (op.baseVersion > this.version) {
      throw new ConflictError({
        reason: 'base_version_ahead_of_server',
        clipId: clip.id,
        baseVersion: op.baseVersion,
        serverVersion: this.version,
        changedFields: [],
        yourOp: op,
      });
    }
    const changed = [];
    for (const f of fieldNames) {
      const fv = clip.fieldVersion[f] || 0;
      if (fv > op.baseVersion) {
        changed.push({ field: f, version: fv, editor: clip.fieldEditor[f], value: clip[f] });
      }
    }
    if (changed.length) {
      throw new ConflictError({
        reason: 'field_changed_since_base',
        clipId: clip.id,
        baseVersion: op.baseVersion,
        serverVersion: this.version,
        changedFields: changed,
        yourOp: op,
      });
    }
  }

  _noOverlap(timelineIn, timelineOut, ignoreId) {
    for (const c of this.clips.values()) {
      if (c.id === ignoreId) continue;
      if (timelineIn < c.timelineOut && c.timelineIn < timelineOut) return c;
    }
    return null;
  }

  _stamp(clip, fields, version, editor) {
    for (const f of fields) {
      clip.fieldVersion[f] = version;
      clip.fieldEditor[f] = editor;
    }
  }

  // Returns an applied event, or a rejected entry (never throws for expected
  // conflict/validation cases — the protocol layer forwards either to clients).
  apply(op) {
    if (!op || typeof op.opId !== 'string' || typeof op.clientId !== 'string') {
      throw new ValidationError('op requires opId and clientId');
    }
    const dup = this.opIndex.get(op.opId);
    if (dup) return { ...dup.response, duplicate: true };

    try {
      switch (op.type) {
        case 'insert': return this._insert(op);
        case 'trim': return this._trim(op);
        case 'split': return this._split(op);
        case 'move': return this._move(op);
        case 'remove': return this._remove(op);
        default: throw new ValidationError(`unknown op type ${op.type}`);
      }
    } catch (e) {
      if (e instanceof ConflictError || e instanceof ValidationError) {
        return this._reject(op, e.message, e instanceof ConflictError ? { conflict: e.details } : {});
      }
      throw e;
    }
  }

  _insert(op) {
    const src = this.sources.get(op.sourceId);
    if (!src) throw new ValidationError('unknown source');
    for (const k of ['srcIn', 'srcOut', 'timelineIn']) {
      if (!isInt(op[k]) || op[k] < 0) throw new ValidationError(`${k} must be non-negative integer ticks`);
    }
    if (op.srcIn >= op.srcOut) throw new ValidationError('srcIn must precede srcOut');
    if (op.srcOut > src.duration) throw new ValidationError('source range exceeds media duration');
    if (typeof op.clipId !== 'string' || !op.clipId) throw new ValidationError('clipId required');
    if (this.clips.has(op.clipId)) throw new ValidationError('clipId already exists');
    const len = op.srcOut - op.srcIn;
    const timelineOut = op.timelineIn + len;
    const hit = this._noOverlap(op.timelineIn, timelineOut, null);
    if (hit) throw new ValidationError(`timeline range overlaps clip ${hit.id}`);

    const v = this._nextVersion();
    const clip = {
      id: op.clipId,
      sourceId: src.id,
      srcIn: op.srcIn, srcOut: op.srcOut,
      timelineIn: op.timelineIn, timelineOut,
      fieldVersion: { srcIn: v, srcOut: v, timelineIn: v },
      fieldEditor: { srcIn: op.clientId, srcOut: op.clientId, timelineIn: op.clientId },
      createdBy: op.clientId, createdSeq: this.seq + 1,
    };
    this.clips.set(clip.id, clip);
    return this._record(op, [clip.id], [{ clipId: clip.id, before: null, after: clipSnapshot(clip) }]);
  }

  _trim(op) {
    const clip = this.clips.get(op.clipId);
    if (!clip) throw new ConflictError({ reason: 'clip_missing', clipId: op.clipId, baseVersion: op.baseVersion, yourOp: op });
    if (!isInt(op.baseVersion) || op.baseVersion < 0) throw new ValidationError('baseVersion required');
    const src = this.sources.get(clip.sourceId);
    const before = clipSnapshot(clip);

    if (op.side === 'in') {
      this._checkFields(clip, op, FIELDS.trimIn);
      if (!isInt(op.value) || op.value < 0 || op.value >= clip.srcOut) {
        throw new ValidationError('trim-in value must be within [0, srcOut)');
      }
      if (op.value > src.duration) throw new ValidationError('value exceeds media duration');
      const delta = op.value - clip.srcIn;
      const newIn = clip.timelineIn + delta;
      if (newIn < 0) throw new ValidationError('trim would move clip before timeline zero');
      const hit = this._noOverlap(newIn, clip.timelineOut, clip.id);
      if (hit) throw new ValidationError(`trim collides with clip ${hit.id}`);
      const v = this._nextVersion();
      clip.srcIn = op.value;
      clip.timelineIn = newIn;
      this._stamp(clip, ['srcIn', 'timelineIn'], v, op.clientId);
      return this._record(op, [clip.id], [{ clipId: clip.id, before, after: clipSnapshot(clip) }]);
    }

    if (op.side === 'out') {
      this._checkFields(clip, op, FIELDS.trimOut);
      if (!isInt(op.value) || op.value <= clip.srcIn || op.value > src.duration) {
        throw new ValidationError('trim-out value must be within (srcIn, source duration]');
      }
      const newOut = clip.timelineIn + (op.value - clip.srcIn);
      const hit = this._noOverlap(clip.timelineIn, newOut, clip.id);
      if (hit) throw new ValidationError(`trim collides with clip ${hit.id}`);
      const v = this._nextVersion();
      clip.srcOut = op.value;
      clip.timelineOut = newOut;
      clip.fieldVersion.srcOut = v;
      clip.fieldEditor.srcOut = op.clientId;
      return this._record(op, [clip.id], [{ clipId: clip.id, before, after: clipSnapshot(clip) }]);
    }
    throw new ValidationError("trim side must be 'in' or 'out'");
  }

  _move(op) {
    const clip = this.clips.get(op.clipId);
    if (!clip) throw new ConflictError({ reason: 'clip_missing', clipId: op.clipId, baseVersion: op.baseVersion, yourOp: op });
    if (!isInt(op.baseVersion) || op.baseVersion < 0) throw new ValidationError('baseVersion required');
    if (!isInt(op.newTimelineIn) || op.newTimelineIn < 0) throw new ValidationError('bad newTimelineIn');
    this._checkFields(clip, op, FIELDS.move);
    const before = clipSnapshot(clip);
    const len = clip.timelineOut - clip.timelineIn;
    const newOut = op.newTimelineIn + len;
    const hit = this._noOverlap(op.newTimelineIn, newOut, clip.id);
    if (hit) throw new ValidationError(`move collides with clip ${hit.id}`);
    const v = this._nextVersion();
    clip.timelineIn = op.newTimelineIn;
    clip.timelineOut = newOut;
    clip.fieldVersion.timelineIn = v;
    clip.fieldEditor.timelineIn = op.clientId;
    return this._record(op, [clip.id], [{ clipId: clip.id, before, after: clipSnapshot(clip) }]);
  }

  _split(op) {
    const clip = this.clips.get(op.clipId);
    if (!clip) throw new ConflictError({ reason: 'clip_missing', clipId: op.clipId, baseVersion: op.baseVersion, yourOp: op });
    if (!isInt(op.baseVersion) || op.baseVersion < 0) throw new ValidationError('baseVersion required');
    this._checkFields(clip, op, FIELDS.split);
    if (!isInt(op.at) || op.at <= clip.srcIn || op.at >= clip.srcOut) {
      throw new ValidationError('split point must be strictly inside the clip source range');
    }
    const leftId = `${op.opId}:L`;
    const rightId = `${op.opId}:R`;
    if (this.clips.has(leftId) || this.clips.has(rightId)) throw new ValidationError('split child id collision');
    const before = clipSnapshot(clip);

    const cut = clip.timelineIn + (op.at - clip.srcIn);
    const v = this._nextVersion();
    const left = {
      id: leftId, sourceId: clip.sourceId,
      srcIn: clip.srcIn, srcOut: op.at,
      timelineIn: clip.timelineIn, timelineOut: cut,
      fieldVersion: { srcIn: v, srcOut: v, timelineIn: v },
      fieldEditor: { srcIn: op.clientId, srcOut: op.clientId, timelineIn: op.clientId },
      createdBy: op.clientId, createdSeq: this.seq + 1, splitParent: clip.id,
    };
    const right = {
      id: rightId, sourceId: clip.sourceId,
      srcIn: op.at, srcOut: clip.srcOut,
      timelineIn: cut, timelineOut: clip.timelineOut,
      fieldVersion: { srcIn: v, srcOut: v, timelineIn: v },
      fieldEditor: { srcIn: op.clientId, srcOut: op.clientId, timelineIn: op.clientId },
      createdBy: op.clientId, createdSeq: this.seq + 1, splitParent: clip.id,
    };
    this.clips.delete(clip.id);
    this.clips.set(left.id, left);
    this.clips.set(right.id, right);
    const targets = [
      { clipId: clip.id, before, after: null },
      { clipId: left.id, before: null, after: clipSnapshot(left) },
      { clipId: right.id, before: null, after: clipSnapshot(right) },
    ];
    return this._record(op, [left.id, right.id], targets);
  }

  _remove(op) {
    const clip = this.clips.get(op.clipId);
    if (!clip) {
      // Idempotent remove after a confirmed remove: treat as duplicate-style no-op reject.
      throw new ConflictError({ reason: 'clip_missing', clipId: op.clipId, baseVersion: op.baseVersion, yourOp: op });
    }
    if (!isInt(op.baseVersion) || op.baseVersion < 0) throw new ValidationError('baseVersion required');
    this._checkFields(clip, op, FIELDS.remove);
    const before = clipSnapshot(clip);
    this._nextVersion();
    this.clips.delete(clip.id);
    return this._record(op, [clip.id], [{ clipId: clip.id, before, after: null }], true);
  }

  appliedAt(seq) {
    if (!isInt(seq) || seq < 1 || seq > this.log.length) return null;
    return this.log[seq - 1] || null;
  }

  // Build inverse ops that undo an applied record. Inverses are ordinary ops
  // re-applied through the normal conflict rules, so undo never bypasses the
  // concurrency contract and every inverse is itself journaled. Deterministic
  // opIds make the whole batch idempotent on retry; callers re-stamp
  // baseVersion between applies (see refreshUndoBase) so a later inverse never
  // cites a revision an earlier one already advanced. Returns [] when the
  // record cannot be inverted.
  buildUndoOps(seq, undoId) {
    const rec = this.appliedAt(seq);
    if (!rec) return [];
    const op = rec.op;
    // Include the target id so multi-op batches (split undo = two removes +
    // one insert) never mint duplicate opIds, which the server treats as
    // idempotent resends.
    const mk = (type, extra) => ({
      type,
      opId: `${undoId}-${type}-${extra.clipId || op.clipId}-${seq}`,
      clientId: op.clientId,
      baseVersion: this.version,
      ...extra,
    });
    const afterOf = (id) => {
      const t = rec.result.targets.find((x) => x.clipId === id);
      return t ? t.after : null;
    };
    const beforeOf = (id) => {
      const t = rec.result.targets.find((x) => x.clipId === id);
      return t ? t.before : null;
    };

    if (op.type === 'insert') {
      return [mk('remove', { clipId: op.clipId })];
    }
    if (op.type === 'remove') {
      const b = beforeOf(op.clipId);
      if (!b) return [];
      return [mk('insert', {
        clipId: b.clipId, sourceId: b.sourceId,
        srcIn: b.srcIn, srcOut: b.srcOut, timelineIn: b.timelineIn,
      })];
    }
    if (op.type === 'move') {
      const b = beforeOf(op.clipId);
      if (!b) return [];
      return [mk('move', { clipId: op.clipId, newTimelineIn: b.timelineIn })];
    }
    if (op.type === 'trim') {
      const b = beforeOf(op.clipId);
      if (!b) return [];
      return op.side === 'in'
        ? [mk('trim', { clipId: op.clipId, side: 'in', value: b.srcIn })]
        : [mk('trim', { clipId: op.clipId, side: 'out', value: b.srcOut })];
    }
    if (op.type === 'split') {
      const left = afterOf(rec.clipIds[0]);
      const right = afterOf(rec.clipIds[1]);
      const parent = beforeOf(op.clipId);
      if (!left || !right || !parent) return [];
      return [
        mk('remove', { clipId: left.clipId }),
        mk('remove', { clipId: right.clipId }),
        mk('insert', {
          clipId: parent.clipId, sourceId: parent.sourceId,
          srcIn: parent.srcIn, srcOut: parent.srcOut, timelineIn: parent.timelineIn,
        }),
      ];
    }
    return [];
  }

  // Re-stamp a pre-built undo batch against the current revision without
  // changing its deterministic opIds.
  refreshUndoBase(inverseOps) {
    for (const inv of inverseOps) inv.baseVersion = this.version;
    return inverseOps;
  }

  // Replay a recorded log against a fresh store — used by tests to prove the
  // event stream alone reconstructs the identical final timeline. Accepts both
  // v2 records and legacy v1 event shapes.
  static replay(sources, log) {
    const store = new TimelineStore(sources);
    for (const event of log) {
      const out = store.apply(event.op);
      if (out.type !== 'applied') throw new Error('replay of applied log must not reject');
      if (out.seq !== event.seq) throw new Error('replay seq mismatch');
    }
    return store;
  }

  // Rebuild a store from a v2 oplog file. Ordering comes from the explicit
  // seq/recNo fields — the on-disk line order is deliberately ignored.
  static fromOplog(sources, file) {
    const { records, unknown } = readOplog(file);
    if (unknown.length) {
      throw new OplogError(`refusing to restore: ${unknown.length} unknown record(s) must be handled explicitly`);
    }
    const { applied, rejected } = orderRecords(records);
    const store = new TimelineStore(sources);
    store._restoring = true;
    try {
      for (const rec of applied) {
        const out = store.apply(rec.op);
        if (out.type !== 'applied') throw new OplogError(`replay rejected at seq ${rec.seq}: ${out.reason}`);
        if (out.version !== rec.version || out.op.opId !== rec.op.opId) {
          throw new OplogError(`replay mismatch at seq ${rec.seq}`);
        }
        // Re-verify the recorded explicit result against the recomputed one.
        for (const t of rec.result.targets) {
          const liveAfter = store.clips.has(t.clipId) ? clipSnapshot(store.clips.get(t.clipId)) : null;
          if (JSON.stringify(t.after) !== JSON.stringify(liveAfter)) {
            throw new OplogError(`result snapshot mismatch for ${t.clipId} at seq ${rec.seq}`);
          }
        }
        store.log.push({ ...rec });
        store.opIndex.set(rec.op.opId, { seq: rec.seq, response: rec });
      }
      for (const rec of rejected) {
        store.rejects.push({ ...rec });
        store.opIndex.set(rec.op.opId, { seq: null, response: rec });
      }
    } finally {
      store._restoring = false;
    }
    store.seq = applied.length;
    store.version = applied.reduce((v, r) => Math.max(v, r.version), 0);
    store.recNo = records.reduce((n, r) => Math.max(n, r.recNo), 0);
    if (store.seq !== store.version) {
      throw new OplogError(`restored seq ${store.seq} != version ${store.version}`);
    }
    return store;
  }
}

module.exports = { TimelineStore, ConflictError, ValidationError, FIELDS };
