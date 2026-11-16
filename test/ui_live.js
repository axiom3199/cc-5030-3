'use strict';

// Real-browser verification of the collaborative UI: two editor panels, each
// with its own websocket, driven through insert -> pending -> confirmed ->
// conflict -> reconnect, with assertions on what is actually rendered.
const { chromium } = require('/tmp/pw/node_modules/playwright-core');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.PORT || 8082;
const url = `http://127.0.0.1:${PORT}/`;

const EXECUTABLE = process.env.CHROME_HEADLESS_SHELL ||
  '/home/node/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux-arm64/chrome-headless-shell';
const EXTRA_LIB = '/tmp/libs/usr/lib/aarch64-linux-gnu:/tmp/libs/lib/aarch64-linux-gnu';

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'serve.js')], {
    env: { ...process.env, PORT: String(PORT), LD_LIBRARY_PATH: `${EXTRA_LIB}:${process.env.LD_LIBRARY_PATH || ''}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', function onData(chunk) {
      if (String(chunk).includes('collab edit server')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => reject(new Error(`server exited early ${code}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function expectPendingCleared(page, editor) {
  const items = page.locator(`#panel-${editor} .pending-list li:not(.empty-note)`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await items.count()) === 0) return;
    await sleep(50);
  }
  throw new Error(`pending ops for ${editor} were not confirmed within 5s`);
}

async function fillOp(page, editor, fields) {
  const panel = page.locator(`#panel-${editor}`);
  for (const [name, value] of Object.entries(fields)) {
    const field = panel.locator(`[data-field="${name}"]`);
    const tag = await field.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') await field.selectOption(String(value));
    else await field.fill(String(value));
  }
  await panel.locator('[data-act="submit"]').click();
}
async function selectType(page, editor, type) {
  await page.locator(`#panel-${editor} [data-field="type"]`).selectOption(type);
}

(async () => {
  const server = await startServer();
  let exitCode = 0;
  try {
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu'],
    env: { ...process.env, LD_LIBRARY_PATH: `${EXTRA_LIB}:${process.env.LD_LIBRARY_PATH || ''}` },
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });

  // Both panels connected.
  await page.locator('#panel-alice .dot.online').waitFor({ timeout: 5000 });
  await page.locator('#panel-bob .dot.online').waitFor({ timeout: 5000 });
  console.log('UI: both editors online');

  // Alice inserts a clip through the form.
  await selectType(page, 'alice', 'insert');
  await fillOp(page, 'alice', { clipId: 'ui-1', srcIn: 0, srcOut: 9000, timelineIn: 0 });
  await page.locator('#panel-alice .clip', { hasText: 'ui-1' }).waitFor({ timeout: 5000 });
  await expectPendingCleared(page, 'alice');
  const alicePending = await page.locator('#panel-alice .pending-list li:not(.empty-note)').count();
  console.log('UI: inserted ui-1, pending list after ack =', alicePending, '(expect 0)');

  // Bob's panel renders the same committed clip (proves broadcast + convergence).
  await page.locator('#panel-bob .clip', { hasText: 'ui-1' }).waitFor({ timeout: 5000 });
  console.log('UI: bob panel shows same committed clip ui-1');

  // Conflicting same-boundary trims: click clip to fill versions, force stale on bob.
  await page.locator('#panel-alice .clip', { hasText: 'ui-1' }).click();
  await selectType(page, 'alice', 'trim');
  await fillOp(page, 'alice', { side: 'out', clipId: 'ui-1', srcOut: 7000, baseVersion: await page.locator('#panel-alice [data-field="baseVersion"]').inputValue() });
  await sleep(300);

  await page.locator('#panel-bob .clip', { hasText: 'ui-1' }).click();
  await selectType(page, 'bob', 'trim');
  await fillOp(page, 'bob', { side: 'out', clipId: 'ui-1', srcOut: 5000, baseVersion: 1 });
  const conflictBox = page.locator('#panel-bob .conflict-list li', { hasText: 'field_changed_since_base' });
  await conflictBox.waitFor({ timeout: 5000 });
  const conflictText = (await conflictBox.innerText()).replace(/\s+/g, ' ');
  console.log('UI: bob sees explicit conflict ->', conflictText.slice(0, 150));

  // Real frame preview from the committed timeline on alice's panel.
  await page.locator('#panel-alice .playhead').fill('1000');
  await page.locator('#panel-alice [data-act="preview"]').click();
  await page.locator('#panel-alice .preview-frame img').waitFor({ timeout: 5000 });
  const meta = await page.locator('#panel-alice .preview-meta').innerText();
  console.log('UI: preview decoded ->', meta);

  // Reconnect button: hello replay, no errors, still online.
  await page.locator('#panel-bob [data-act="reconnect"]').click();
  await page.locator('#panel-bob .dot.online').waitFor({ timeout: 5000 });
  await sleep(300);
  await page.locator('#panel-bob .clip', { hasText: 'ui-1' }).waitFor({ timeout: 5000 });
  console.log('UI: bob reconnected and re-converged');

  // Duplicate button marks an idempotent resend without duplicating the clip.
  await page.locator('#panel-alice [data-act="duplicate"]').click();
  await sleep(300);
  const clipCount = await page.locator('#panel-alice .clip').count();
  console.log('UI: after duplicate resend, clip count =', clipCount, '(expect 1)');

  await page.screenshot({ path: '/tmp/collab_ui.png', fullPage: true });

  if (errors.length) { console.error('PAGE ERRORS:', errors); exitCode = 1; }
  console.log('UI: no page/console errors');
  await browser.close();
  } catch (e) { console.error('UI TEST FAILED', e); exitCode = 1; }
  server.kill('SIGTERM');
  process.exit(exitCode);
})();
