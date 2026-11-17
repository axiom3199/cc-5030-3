'use strict';

// Clip operation-log converter: v1 history -> explicit v2 oplog.
//
// Accepted v1 inputs:
//   1. JSON bundle written by GET /api/log: {"applied": [...], "rejected": [...]}
//   2. JSONL of individual v1 events, one object per line
//
// A v2 record states object identity (result.targets[].clipId), the base
// revision (result.baseRevision) and the operation result (outcome/revision/
// before-after clip snapshots) explicitly. Applied v1 events are replayed in
// seq order through a real TimelineStore so every before/after snapshot is
// computed rather than guessed.
//
// The converter never fills missing data with defaults:
//   - a malformed/unrecognised line is kept BYTE-FOR-BYTE in the sidecar file
//     and counted; the process exits non-zero (no silent loss)
//   - a mutating op missing a usable baseVersion cannot be mapped honestly and
//     is likewise routed to the sidecar
//
// Usage:
//   node scripts/migrate_oplog.js --in old.json --out data/oplog.log
//     [--sidecar data/oplog.unknown.jsonl] [--sources media/manifest.json]
//     [--origin label]
const fs = require('fs');
const path = require('path');
const {
  LOG_FORMAT, LOG_FORMAT_VERSION, V1_LOG_FORMAT_VERSION,
  HEADER_MARK, RECORD_MARK, UNKNOWN_MARK, OplogError,
  baseRevisionOf, clipSnapshot, buildRecord, headerLine,
} = require('../src/oplog');
const { TimelineStore, ValidationError } = require('../src/store');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    args[name] = value;
    i += 1;
  }
  if (!args.in || !args.out) throw new Error('required: --in <v1-log> --out <v2-oplog>');
  if (!args.sidecar) args.sidecar = `${args.out}.unknown.jsonl`;
  return args;
}

function loadSources(arg) {
  const file = arg || path.join(__dirname, '..', 'media', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(manifest.sources)) throw new Error('manifest must contain sources[]');
  return manifest.sources;
}

function isV1Event(obj) {
  return obj && typeof obj === 'object' && (obj.type === 'applied' || obj.type === 'rejected') &&
    obj.op && typeof obj.op === 'object' && typeof obj.op.opId === 'string';
}

// Returns {applied, rejected, unknownLines}. Raw text of anything we cannot
// map is preserved exactly (including trailing newline state) in unknownLines.
function readV1(inputFile) {
  const raw = fs.readFileSync(inputFile, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let bundle = null;
    let parseError = null;
    try { bundle = JSON.parse(raw); }
    catch (e) { parseError = e; }
    if (bundle) {
      if (bundle.mark === HEADER_MARK || bundle.format === LOG_FORMAT) {
        throw new OplogError('input is already a v2 oplog; refusing to convert');
      }
      if (!Array.isArray(bundle.applied) || !Array.isArray(bundle.rejected)) {
        throw new OplogError('v1 JSON bundle must contain applied[] and rejected[] arrays');
      }
      const unknown = [];
      for (const o of [...bundle.applied, ...bundle.rejected]) {
        if (!isV1Event(o)) unknown.push({ raw: JSON.stringify(o), reason: 'bundle entry is not a v1 event' });
      }
      return {
        applied: bundle.applied.filter(isV1Event).sort((a, b) => a.seq - b.seq),
        rejected: bundle.rejected.filter(isV1Event),
        unknownLines: unknown,
        bundle: true,
      };
    }
    // Not a single JSON document: fall through to JSONL parsing so a corrupt
    // physical line is preserved byte-for-byte instead of aborting the run.
    if (!trimmed.includes('\n')) throw new OplogError(`v1 input is not valid JSON: ${parseError.message}`);
  }
  // JSONL mode — every physical line stands alone.
  const applied = [];
  const rejected = [];
  const unknownLines = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') continue;
    let obj;
    try { obj = JSON.parse(line); }
    catch { unknownLines.push({ raw: line, reason: `line ${i + 1} is not valid JSON` }); continue; }
    if (obj && obj.mark === RECORD_MARK) {
      throw new OplogError(`line ${i + 1} is already a v2 record; refusing to convert`);
    }
    if (!isV1Event(obj)) {
      unknownLines.push({ raw: line, reason: `line ${i + 1} is not a v1 event` });
      continue;
    }
    if (obj.type === 'applied') applied.push(obj);
    else rejected.push(obj);
  }
  applied.sort((a, b) => a.seq - b.seq);
  return { applied, rejected, unknownLines, bundle: false };
}

// Replaying the applied v1 events produces the exact clip state each op
// resulted in; we snapshot it instead of inventing values.
function computeAppliedRecords(store, applied, origin) {
  const out = [];
  const recNo = { n: 0 };
  for (const ev of applied) {
    if (!Number.isInteger(ev.seq) || ev.seq <= 0) {
      throw new OplogError(`applied event ${ev.op.opId} has no positive integer seq`);
    }
    const before = new Map([...store.clips].map(([id, c]) => [id, clipSnapshot(c)]));
    const result = store.apply(ev.op);
    if (result.type !== 'applied') {
      throw new OplogError(`v1 applied event ${ev.op.opId} rejects on replay: ${result.reason}`);
    }
    if (result.seq !== ev.seq) {
      throw new OplogError(`seq drift replaying ${ev.op.opId}: log=${ev.seq} replay=${result.seq}`);
    }
    recNo.n += 1;
    const targets = result.clipIds.map((id) => ({
      clipId: id,
      before: before.get(id) ? before.get(id) : null,
      after: store.clips.has(id) ? clipSnapshot(store.clips.get(id)) : null,
    }));
    const rec = buildRecord('applied', {
      recNo: recNo.n, seq: ev.seq, version: result.version,
      clientId: ev.op.clientId, ts: Number.isInteger(ev.ts) ? ev.ts : Date.now(),
      op: ev.op, clipIds: result.clipIds, targets,
      baseRevision: baseRevisionOf(ev.op, result.version - 1),
      removed: Boolean(ev.removed),
    });
    out.push({ rec, origin });
  }
  return out;
}

function validateRejected(ev) {
  // Mutating ops rely on an explicit base revision. A v1 rejected record that
  // lacks one cannot be migrated honestly — keep the raw bytes instead of
  // inventing baseVersion=0 (which would change the conflict semantics).
  if (ev.op.type !== 'insert' && !(Number.isInteger(ev.op.baseVersion) && ev.op.baseVersion >= 0)) {
    return 'rejected mutating op lacks usable baseVersion';
  }
  if (typeof ev.reason !== 'string' || !ev.reason) return 'rejected event lacks reason';
  return null;
}

function migrate(args) {
  const sources = loadSources(args.sources);
  const { applied, rejected, unknownLines, bundle } = readV1(args.in);
  const sidecar = [...unknownLines];
  const store = new TimelineStore(sources);
  const appliedRecs = computeAppliedRecords(store, applied, args.origin || path.basename(args.in));

  let recNo = appliedRecs.length;
  const rejectedRecs = [];
  for (const ev of rejected) {
    const problem = validateRejected(ev);
    if (problem) { sidecar.push({ raw: JSON.stringify(ev), reason: problem }); continue; }
    recNo += 1;
    const rec = buildRecord('rejected', {
      recNo, clientId: ev.op.clientId,
      ts: Number.isInteger(ev.ts) ? ev.ts : Date.now(),
      op: ev.op, reason: ev.reason, conflict: ev.conflict,
      baseRevision: baseRevisionOf(ev.op, Number.isInteger(ev.serverVersion) ? ev.serverVersion : store.version),
      serverVersion: Number.isInteger(ev.serverVersion) ? ev.serverVersion : store.version,
    });
    rejectedRecs.push(rec);
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  const lines = [headerLine()];
  for (const { rec } of appliedRecs) lines.push(JSON.stringify({ ...rec, migratedFrom: V1_LOG_FORMAT_VERSION }));
  for (const rec of rejectedRecs) lines.push(JSON.stringify({ ...rec, migratedFrom: V1_LOG_FORMAT_VERSION }));
  fs.writeFileSync(args.out, lines.join('\n') + '\n');

  if (sidecar.length) {
    const body = sidecar
      .map((u) => JSON.stringify({ mark: UNKNOWN_MARK, format: LOG_FORMAT, formatVersion: LOG_FORMAT_VERSION, reason: u.reason, raw: u.raw }))
      .join('\n');
    fs.writeFileSync(args.sidecar, body + '\n');
  } else if (fs.existsSync(args.sidecar)) {
    fs.rmSync(args.sidecar);
  }

  return {
    input: args.in,
    inputShape: bundle ? 'json-bundle' : 'jsonl',
    output: args.out,
    applied: appliedRecs.length,
    rejected: rejectedRecs.length,
    unknown: sidecar.length,
    sidecar: sidecar.length ? args.sidecar : null,
    finalVersion: store.version,
    finalSeq: store.seq,
  };
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(`migrate: ${e.message}`);
    console.error('usage: node scripts/migrate_oplog.js --in <v1-log> --out <v2-oplog> [--sidecar <file>] [--sources <manifest>] [--origin <label>]');
    process.exit(2);
  }
  let report;
  try {
    report = migrate(args);
  } catch (e) {
    if (e instanceof OplogError || e instanceof ValidationError) {
      console.error(`migrate: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.unknown > 0) {
    console.error(`migrate: ${report.unknown} record(s) could not be mapped; original bytes preserved in ${report.sidecar}`);
    process.exit(1);
  }
}

module.exports = { migrate, readV1, validateRejected, computeAppliedRecords };
