// README images: the extension loaded in Chromium, on the demo fixture page
// (test/fixtures/pages/demo.html, no real site), in English and Turkish.
//   npm run screenshots   → docs/images/*.png, docs/images/badge-<lang>.gif (ffmpeg)
// Not part of the test suite.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension } from '../test/e2e/helpers.js';
import { startServer } from '../test/fixtures/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(lang, server) {
  const ext = await launchWithExtension({ uiLanguage: lang });
  try {
    // One piece at a time, so the progress is visible.
    await ext.worker.evaluate(() => chrome.storage.sync.set({ concurrency: 1, subtitleLangs: ['tr'], badgeMode: 'hover' }));
    await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));

    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1100, height: 720 });
    // *.localhost reaches this machine: a neutral name in the popup and the file names.
    const site = server.url.replace('127.0.0.1', 'demo.localhost');
    await page.goto(`${site}/pages/demo.html`);
    await page.locator('body[data-loaded="true"]').waitFor();
    const tabId = await ext.tabIdOf(page);

    // 1. Popup: main card with quality, audio and subtitle choices.
    const popup = await ext.openPopup(tabId);
    await popup.setViewportSize({ width: 360, height: 640 });
    const card = popup.locator('.item.main');
    await card.locator('select.audio').waitFor({ state: 'visible' });
    await card.locator('.sub-chip').first().waitFor();
    await sleep(300);
    await popup.locator('body').screenshot({ path: path.join(OUT, `popup-${lang}.png`) });

    // 2. Popup while downloading.
    await card.locator('.download').click();
    await popup
      .locator('.job .job-detail')
      .filter({ hasText: /\d\/\d/ })
      .first()
      .waitFor();
    await sleep(1200);
    await popup.locator('body').screenshot({ path: path.join(OUT, `popup-progress-${lang}.png`) });
    await popup.locator('.job .job-state.done').first().waitFor({ timeout: 60000 });
    await popup.close();

    // 3. In-page button: hover, quality menu, progress ring, done — frames for a GIF.
    // One muxed track (video with audio), no subtitles: the progress of a single file.
    await ext.worker.evaluate(() => chrome.storage.sync.set({ subtitleLangs: [] }));
    await page.goto(`${site}/pages/demo.html?src=${encodeURIComponent('/media/demo/master-muxed.m3u8')}`);
    await page.locator('body[data-loaded="true"]').waitFor();
    await sleep(500);
    const box = await page.locator('video').boundingBox();
    const clip = { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 96), width: Math.min(box.width + 48, 760), height: 420 };
    const frames = await mkdtemp(path.join(os.tmpdir(), 'vdl-gif-'));
    let n = 0;
    const frame = async (repeat = 1) => {
      for (let i = 0; i < repeat; i++) await page.screenshot({ path: path.join(frames, `f${String(n++).padStart(3, '0')}.png`), clip });
    };
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60);
    await frame(3);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    const badge = page.locator('[data-vdl-badge] .btn');
    await badge.waitFor({ state: 'visible' });
    await frame(4);
    await page.screenshot({ path: path.join(OUT, `badge-${lang}.png`), clip });
    await badge.hover();
    await badge.click();
    await page.locator('[data-vdl-badge] .menu[data-open]').waitFor();
    await frame(5);
    await page.screenshot({ path: path.join(OUT, `badge-menu-${lang}.png`), clip });
    await page.locator('[data-vdl-badge] .menu button').first().click();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40);
    for (let i = 0; i < 40; i++) {
      await frame();
      if ((await badge.getAttribute('data-state')) === 'done') break;
      await sleep(150);
    }
    await frame(6);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      '4',
      '-i',
      path.join(frames, 'f%03d.png'),
      '-vf',
      'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      path.join(OUT, `badge-${lang}.gif`),
    ]);
    await rm(frames, { recursive: true, force: true });

    // 4. Settings page, with the defaults back.
    await ext.worker.evaluate(() => chrome.storage.sync.remove(['concurrency', 'subtitleLangs']));
    const options = await ext.context.newPage();
    await options.setViewportSize({ width: 820, height: 900 });
    await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
    await options.locator('#uiLanguage').waitFor();
    await sleep(500);
    await options.screenshot({ path: path.join(OUT, `options-${lang}.png`) });
  } finally {
    await ext.close();
  }
}

await mkdir(OUT, { recursive: true });
const server = await startServer();
try {
  for (const lang of ['en', 'tr']) {
    await shoot(lang, server);
    console.log(`${lang}: done`);
  }
} finally {
  await server.close();
}
console.log(`images in ${path.relative(ROOT, OUT)}/`);
