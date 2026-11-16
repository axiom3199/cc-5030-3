'use strict';

// Generates REAL media: one decoded PNG per source frame, rendered with
// ImageMagick. Each frame is visually distinct and carries its source id and
// frame number, so an output frame can be identified by pixels as well as by
// the render plan. No placeholder / shared textbox stand-in.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { frameIndexToTick, TICKS_PER_SECOND } = require('../src/time');

const MEDIA_DIR = path.join(__dirname, '..', 'media');
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const SOURCES = [
  { id: 'srcA', label: 'Interview A', fpsNum: 30, fpsDen: 1, frameCount: 30, colors: ['#123c69', '#ac3b61'] },
  { id: 'srcB', label: 'B-roll B', fpsNum: 30, fpsDen: 1, frameCount: 24, colors: ['#0b6e4f', '#e8a90c'] },
];

function runConvert(args) {
  execFileSync('convert', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function generate() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const manifest = [];
  for (const src of SOURCES) {
    const dir = path.join(MEDIA_DIR, src.id);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < src.frameCount; f += 1) {
      const out = path.join(dir, `f_${String(f).padStart(5, '0')}.png`);
      const blend = f / (src.frameCount - 1);
      // Two bars shift with the frame index, making frames visually distinct.
      const bar = Math.round(40 + blend * 360);
      runConvert([
        '-font', FONT,
        '-size', '320x180',
        `xc:${src.colors[0]}`,
        '-fill', src.colors[1], '-draw', `rectangle ${Math.round(blend * 200)},0 ${Math.round(blend * 200) + 60},180`,
        '-fill', '#ffffff',
        '-gravity', 'North', '-pointsize', '22',
        '-annotate', '+0+12', `${src.label}`,
        '-gravity', 'Center', '-pointsize', '44',
        '-annotate', '+0+0', `FRAME ${f}`,
        '-gravity', 'South', '-pointsize', '16',
        '-annotate', '+0+8', `bar=${bar} src=${src.id}`,
        out,
      ]);
    }
    const duration = frameIndexToTick(src.frameCount, src.fpsNum, src.fpsDen);
    manifest.push({ ...src, duration, ticksPerSecond: TICKS_PER_SECOND, frameDir: dir });
  }
  const manifestPath = path.join(MEDIA_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ticksPerSecond: TICKS_PER_SECOND, sources: manifest }, null, 2));
  console.log(`generated ${SOURCES.reduce((n, s) => n + s.frameCount, 0)} frames in ${MEDIA_DIR}`);
  return manifest;
}

if (require.main === module) generate();
module.exports = { generate, SOURCES, MEDIA_DIR };
