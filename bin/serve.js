'use strict';

const fs = require('fs');
const path = require('path');
const { createServer } = require('../src/server');
const { MEDIA_DIR } = require('../scripts/gen_media');

const PORT = parseInt(process.env.PORT || '8080', 10);

if (!fs.existsSync(path.join(MEDIA_DIR, 'manifest.json'))) {
  require('../scripts/gen_media').generate();
}
const manifest = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, 'manifest.json'), 'utf8'));
const app = createServer({ mediaDir: MEDIA_DIR, sources: manifest.sources });

app.listen(PORT, () => {
  console.log(`collab edit server on http://localhost:${PORT}`);
  console.log(`two editors:     http://localhost:${PORT}/?editor=alice  and  ?editor=bob`);
  console.log(`export timeline: http://localhost:${PORT}/api/export`);
});
