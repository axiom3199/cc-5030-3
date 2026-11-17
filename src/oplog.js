'use strict';

// Operation log, format version 2.
//
// v1 (the in-memory store.log / store.rejects arrays) mixed transport concerns
// with history and only implicitly carried identity/base/result context. A v2
// record makes all three explicit:
//   - identity:   which object(s) the op targets (result.targets[].clipId,
//                 plus the clientId/opId of the author)
//   - base:       result.baseRevision, the server revision the op was issued
//                 against
//   - result:     result.outcome ('applied'|'rejected'), the resulting
//                 revision and, for applied ops, the exact clip snapshots
//                 before/after so the effect never has to be guessed
//
// Ordering must never depend on file order: every applied record carries the
// authoritative monotonic `seq` and every record a global `recNo`. The loader
// sorts by those fields and rejects duplicates/gaps instead of trusting lines.
const fs = require('fs');
const path = require('path');

const LOG_FORMAT = 'collab-oplog';
const LOG_FORMAT_VERSION = 2;
const V1_LOG_FORMAT_VERSION = 1;
const HEADER_MARK = 'header';
const RECORD_MARK = 'v2-record';
const UNKNOWN_MARK = 'v2-unknown';
const HEADER_LINE = Object.freeze({ mark: HEADER_MARK, format: LOG_FORMAT, formatVersion: LOG_FORMAT_VERSION });

class OplogError extends Error {
  constructor(reason, extra) {
    super(reason);
    this.name = 'OplogError';
    this.reason = reason;
    Object.assign(this, extra || {});
  }
}

function headerLine() {
  return JSON.stringify(HEADER_LINE);
}

// Explicit base revision: the op's declared baseVersion when the op type
// carries one, otherwise the server revision the server evaluated against.
// Missing/non-integer baseVersion on a type that requires one is an input
// error the converter must surface — never papered over with a default.
function baseRevisionOf(op, serverVersion) {
  if (op && Number.isInteger(op.baseVersion) && op.baseVersion >= 0) return op.baseVersion;
  if (op && op.type === 'insert') return 0;
  return serverVersion;
}

function clipSnapshot(clip) {
  if (!clip) return null;
  return {
    clipId: clip.id,
    sourceId: clip.sourceId,
    srcIn: clip.srcIn,
    srcOut: clip.srcOut,
    timelineIn: clip.timelineIn,
    timelineOut: clip.timelineOut,
    fieldVersion: { ...clip.fieldVersion },
    fieldEditor: { ...clip.fieldEditor },
  };
}

// Canonical record constructor shared by the live store and by migrations, so
// the wire format and the on-disk format are the same shape.
function buildRecord(kind, fields) {
  if (kind !== 'applied' && kind !== 'rejected') throw new OplogError(`bad record kind ${kind}`);
  const base = {
    mark: RECORD_MARK,
    format: LOG_FORMAT,
    formatVersion: LOG_FORMAT_VERSION,
    type: kind,
    recNo: fields.recNo,
    clientId: fields.clientId,
    ts: fields.ts,
    op: fields.op,
    result: {
      outcome: kind,
      baseRevision: fields.baseRevision,
      serverVersion: fields.serverVersion,
    },
  };
  if (kind === 'applied') {
    base.seq = fields.seq;
    base.version = fields.version;
    base.clipIds = fields.clipIds;
    base.result.revision = fields.version;
    base.result.targets = fields.targets;
    if (fields.removed) base.removed = true;
  } else {
    base.seq = null;
    base.serverVersion = fields.serverVersion;
    base.result.reason = fields.reason;
    // v1-compatible top-level aliases so pre-migration clients/samples keep
    // reading rej.reason / rej.conflict without a protocol negotiation.
    base.reason = fields.reason;
    if (fields.conflict) {
      base.result.conflict = fields.conflict;
      base.conflict = fields.conflict;
    }
  }
  return Object.freeze(base);
}

function parseLine(line, lineNo) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    throw new OplogError('oplog line is not valid JSON', { lineNo });
  }
  if (!obj || typeof obj !== 'object') throw new OplogError('oplog line is not an object', { lineNo });
  return obj;
}

// Read an oplog file. Unknown records (mark 'v2-unknown' or anything this
// version does not understand) are returned verbatim instead of being dropped
// or reinterpreted.
function readOplog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let header = null;
  const records = [];
  const unknown = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    const lineNo = i + 1;
    const obj = parseLine(line, lineNo);
    if (obj.mark === HEADER_MARK) {
      if (header) throw new OplogError('duplicate oplog header', { lineNo });
      if (obj.format !== LOG_FORMAT || obj.formatVersion !== LOG_FORMAT_VERSION) {
        throw new OplogError('oplog header format/version mismatch', { lineNo, header: obj });
      }
      header = obj;
      continue;
    }
    if (obj.mark === RECORD_MARK) {
      if (obj.type !== 'applied' && obj.type !== 'rejected') {
        throw new OplogError(`v2 record has bad type ${String(obj.type)}`, { lineNo });
      }
      records.push(obj);
    } else {
      unknown.push({ lineNo, raw: line, parsed: obj });
    }
  }
  if (!header) throw new OplogError('oplog missing header line');
  return { header, records, unknown };
}

// Order by explicit identity fields, never by file position. Applied seqs must
// be a gapless 1..N permutation; recNos must be unique across every record.
function orderRecords(records) {
  const applied = records.filter((r) => r.type === 'applied').slice();
  const rejected = records.filter((r) => r.type === 'rejected').slice();
  applied.sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < applied.length; i += 1) {
    if (applied[i].seq !== i + 1) {
      throw new OplogError(`applied seq must be gapless 1..N, expected ${i + 1} got ${applied[i].seq}`);
    }
  }
  const recNos = new Set();
  for (const r of records) {
    if (!Number.isInteger(r.recNo) || r.recNo <= 0) throw new OplogError('record missing positive recNo');
    if (recNos.has(r.recNo)) throw new OplogError(`duplicate recNo ${r.recNo}`);
    recNos.add(r.recNo);
  }
  rejected.sort((a, b) => a.recNo - b.recNo);
  return { applied, rejected };
}

class OplogSink {
  constructor(file) {
    this.file = file;
    if (!file) return;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    if (fs.existsSync(file)) {
      // Restored journal: keep history and append new records to it.
      const text = fs.readFileSync(file, 'utf8');
      if (!text.split('\n').some((line) => line && parseLine(line).mark === HEADER_MARK)) {
        throw new OplogError('existing oplog file has no header; refusing to append');
      }
      this._needsNewline = text.length > 0 && !text.endsWith('\n');
      return;
    }
    fs.writeFileSync(file, headerLine() + '\n');
    this._needsNewline = false;
  }

  append(record) {
    if (!this.file) return;
    fs.appendFileSync(this.file, (this._needsNewline ? '\n' : '') + JSON.stringify(record) + '\n');
    this._needsNewline = false;
  }
}

module.exports = {
  LOG_FORMAT,
  LOG_FORMAT_VERSION,
  V1_LOG_FORMAT_VERSION,
  HEADER_LINE,
  HEADER_MARK,
  RECORD_MARK,
  UNKNOWN_MARK,
  OplogError,
  OplogSink,
  headerLine,
  baseRevisionOf,
  clipSnapshot,
  buildRecord,
  readOplog,
  orderRecords,
};
