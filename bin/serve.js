'use strict';

const fs = require('fs');
const path = require('path');
const { createServer } = require('../src/server');
const { MEDIA_DIR } = require('../scripts/gen_media');
const { LOG_FORMAT_VERSION } = require('../src/oplog');

const PORT = parseInt(process.env.PORT || '8080', 10);
// The v2 operation log is the durable journal; pass OPLOG_FILE='' (or an
// empty value) to run with in-memory history only.
const OPLOG_FILE = process.env.OPLOG_FILE === undefined
  ? path.join(__dirname, '..', 'data', 'oplog.log')
  : process.env.OPLOG_FILE;

if (fs.existsSync(path.join(MEDIA_DIR, 'manifest.json')) === false) {
  require('../scripts/gen_media').generate();
}
const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'manifest.json'), 'utf8'));
const app = createServer({
  mediaDir: MEDIA_DIR, sources: manifest.sources,
  oplogFile: OPLOG_FILE || null,
});

app.listen(PORT, () => {
  console.log(`collab edit server on http://localhost:${PORT} (oplog format ${LOG_FORMAT_VERSION}, journal: ${OPLOG_FILE || 'in-memory'})`);
  console.log(`two editors:     http://localhost:${PORT}/?editor=alice  and  ?editor=bob`);
  console.log(`export timeline: http://localhost:${PORT}/api/export`);
});
