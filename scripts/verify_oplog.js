'use strict';

// CLI auxiliary for the collaborative editor: verify a v2 oplog rebuilds the
// same timeline as a live store and print an integrity summary. The graphical
// editor (public/index.html, two panels) remains the primary entry point; this
// script only inspects logs from the shell.
//
// Usage:
//   node scripts/verify_oplog.js --oplog data/oplog.log [--sources media/manifest.json]
const fs = require('fs');
const path = require('path');
const { TimelineStore } = require('../src/store');
const { readOplog, orderRecords, LOG_FORMAT_VERSION } = require('../src/oplog');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!args.oplog) throw new Error('required: --oplog <v2-oplog>');
  return args;
}

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv); }
  catch (e) {
    console.error(`verify: ${e.message}`);
    process.exit(2);
  }
  const manifestFile = args.sources || path.join(__dirname, '..', 'media', 'manifest.json');
  const sources = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).sources;

  const parsed = readOplog(args.oplog);
  const { applied, rejected } = orderRecords(parsed.records);
  const rebuilt = TimelineStore.fromOplog(sources, args.oplog);
  const snap = rebuilt.snapshot();

  const report = {
    oplog: args.oplog,
    formatVersion: LOG_FORMAT_VERSION,
    header: parsed.header,
    appliedRecords: applied.length,
    rejectedRecords: rejected.length,
    unknownRecords: parsed.unknown.length,
    rebuiltVersion: snap.version,
    rebuiltSeq: snap.seq,
    rebuiltRecNo: snap.recNo,
    clipCount: snap.clips.length,
    clips: snap.clips.map((c) => ({
      id: c.id, timelineIn: c.timelineIn, timelineOut: c.timelineOut, srcIn: c.srcIn, srcOut: c.srcOut,
    })).sort((a, b) => a.timelineIn - b.timelineIn),
  };
  console.log(JSON.stringify(report, null, 2));
  if (parsed.unknown.length) {
    console.error(`verify: ${parsed.unknown.length} unknown record(s) present`);
    process.exit(1);
  }
}
