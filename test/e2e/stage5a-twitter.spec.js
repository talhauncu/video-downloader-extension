// Stage 5a (second plan): X (Twitter). The extractor reads the post data the
// web client fetches (video_info.variants): one complete MP4 per video, the
// HLS master when there is no MP4, GIFs as their MP4. The player's own HLS
// chunks hide behind the entry of their media.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
  // The X extractor is registered for x.com and twitter.com; add the fixture origin.
  const ids = await ext.worker.evaluate(() =>
    globalThis.__vdl.registerSiteScripts(['*://*.x.com/*', '*://*.twitter.com/*', 'http://127.0.0.1/*'], 'twitter'),
  );
  expect(ids).toEqual(['twitter-main', 'twitter-bridge']);
  await ext.worker.evaluate(() => globalThis.__vdl.addSiteHost('127.0.0.1', 'twitter'));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const stored = (tabId) => ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);

/** Opens the X-like page at `route` and lets it "fetch its API" once the extractor is in place. */
async function openX(route) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/x.html${route}`);
  await expect(page.locator('body')).toHaveAttribute('data-player-loaded', 'true');
  expect(await page.evaluate(() => Boolean(window.__vdlTwitterHooked))).toBe(true);
  await page.evaluate(() => window.loadApi());
  await expect(page.locator('body')).toHaveAttribute('data-api-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  await expect.poll(async () => (await stored(tabId)).filter((it) => it.site === 'twitter').length).toBe(3);
  return { page, tabId };
}

test('a status page: one complete entry per video; the player chunks hide behind it; the MP4 downloads byte-exact', async () => {
  const { page, tabId } = await openX('/someone/status/185000000000000001');
  // The player's HLS master was captured and belongs to media 111.
  await expect.poll(async () => (await stored(tabId)).find((it) => it.url.includes('/ext_tw_video/111/'))?.coveredBy).toBe('twitter:111');
  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('#site-note')).toBeHidden();

  // Önerilen: the open post only; the other two posts are neighbours in Diğer.
  const main = popup.locator('#media-list > .item');
  await expect(main).toHaveCount(1);
  await expect(main.locator('.kind')).toHaveText('X (Twitter)');
  await expect(main.locator('.badge.here')).toBeVisible();
  await expect(main.locator('.name')).toHaveText('@someone Bir video');
  await expect(popup.locator('#others-list > .item[data-reason="neighbour"]')).toHaveCount(2);
  // The chunk of media 111 and the GIF's <video> copy are not listed as their own cards.
  await expect(popup.locator('.item[data-kind="hls"]:not([data-site])')).toHaveCount(0);
  await expect(popup.locator('#others-list > .item[data-site="twitter"][data-kind="hls"] .name')).toHaveText('@other Yalnızca akış');

  // The best variant is the highest bitrate, a complete file with audio.
  const entry = (await stored(tabId)).find((it) => it.key === 'twitter:111');
  expect(entry.url).toBe(`${server.url}/media/sample.mp4?v=best`);
  const before = await ext.existingDownloadIds();
  await main.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: 127\.0\.0\.1-@someone Bir video-\d{8}-\d{4}\.mp4$/);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);

  // Debug info names the extractor and what it found.
  const debug = await popup.evaluate(
    (id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'debug:info', payload: { tabId: id } }, resolve)),
    tabId,
  );
  expect(debug.ok).toBe(true);
  expect(debug.result.mainWorldProbe.hooked).toBe(true);
  expect(debug.result.mainWorldProbe.stats.found).toBe(3);
  expect(debug.result.items.find((it) => it.coveredBy === 'twitter:111')).toBeTruthy();
  await popup.close();
  await page.close();
});

test('a timeline: each post badge downloads its own post (HLS-only post merged); the GIF badge downloads the GIF', async () => {
  const { page } = await openX('/home');
  const hoverPost = async (id) => {
    const video = page.locator(`video[data-id="${id}"]`);
    await video.scrollIntoViewIfNeeded();
    const box = await video.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const badge = page.locator('[data-vdl-badge][data-visible] .btn');
  // Both players are 4 s long: only the post link around each one tells them apart.
  // Post …001: its best MP4, byte-exact.
  await hoverPost('185000000000000001');
  await expect(badge).toBeVisible();
  let before = await ext.existingDownloadIds();
  await badge.click();
  const [first] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(first.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await page.mouse.move(2, 2);
  await expect(page.locator('[data-vdl-badge][data-visible]')).toHaveCount(0, { timeout: 15000 });

  // Post …002 has no MP4: its HLS master (video + separate audio) is downloaded and merged.
  await hoverPost('185000000000000002');
  await expect(badge).toBeVisible();
  before = await ext.existingDownloadIds();
  await badge.click();
  const [merged] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
  expect(moovSummary(await readFile(merged.filename)).codecs.sort()).toEqual(['avc1', 'mp4a']);
  await expect(badge).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  await page.mouse.move(2, 2);
  await expect(page.locator('[data-vdl-badge][data-visible]')).toHaveCount(0, { timeout: 15000 });

  // The GIF plays its MP4 directly; the badge takes the site entry's file.
  await hoverPost('185000000000000003');
  await expect(badge).toBeVisible();
  before = await ext.existingDownloadIds();
  await badge.click();
  const [gif] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(gif.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
