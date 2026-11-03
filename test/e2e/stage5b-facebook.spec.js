// Stage 5b (second plan): Facebook. The extractor reads the video data in the
// page's inline JSON and GraphQL responses: the HD (else SD) MP4 with audio,
// or the DASH manifest. The player's own tracks stay hidden; a manifest entry
// hides behind the video's MP4 once that arrives.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
const ID = (n) => `100000000000050${n}`;
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
  // The Facebook extractor is registered for facebook.com; add the fixture origin.
  const ids = await ext.worker.evaluate(() =>
    globalThis.__vdl.registerSiteScripts(['*://*.facebook.com/*', 'http://127.0.0.1/*'], 'facebook'),
  );
  expect(ids).toEqual(['facebook-main', 'facebook-bridge']);
  await ext.worker.evaluate(() => globalThis.__vdl.addSiteHost('127.0.0.1', 'facebook'));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const stored = (tabId) => ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);

/** Opens the Facebook-like page at `route`; its later data arrives once the extractor is in place. */
async function openFb(route) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/fb.html${route}`);
  await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  expect(await page.evaluate(() => Boolean(window.__vdlFacebookHooked))).toBe(true);
  await page.evaluate(() => window.loadApi());
  await expect(page.locator('body')).toHaveAttribute('data-api-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  // 501, 502, 503 (its manifest, then its MP4), 504 (manifest only) and 505 (only its manifest's address).
  await expect.poll(async () => (await stored(tabId)).filter((it) => it.site === 'facebook').length).toBe(6);
  return { page, tabId };
}

test('a watch page: one entry per video, the open one first; player tracks and a superseded manifest hide; HD downloads byte-exact', async () => {
  const { page, tabId } = await openFb(`/watch/?v=${ID(1)}`);
  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('#site-note')).toBeHidden();

  const main = popup.locator('#media-list > .item');
  await expect(main).toHaveCount(1);
  await expect(main.locator('.kind')).toHaveText('Facebook');
  await expect(main.locator('.badge.here')).toBeVisible();
  await expect(main.locator('.name')).toHaveText('Bir Sayfa · İlk video');
  // The other three videos are neighbours; the reel shows its MP4, not its manifest.
  await expect(popup.locator('#others-list > .item[data-reason="neighbour"]')).toHaveCount(4);
  // 504 and 505 (manifest only) are named by their owner.
  await expect(popup.locator('#others-list > .item[data-site="facebook"][data-kind="dash"] .name')).toHaveText([
    'Manifest Sayfası',
    'Manifest Sayfası',
  ]);
  await expect(popup.locator('.item[data-hidden="true"]')).toHaveCount(0);
  const items = await stored(tabId);
  expect(items.find((it) => it.key === `facebook:${ID(3)}`).url).toBe(`${server.url}/media/dash-base/DASH_360.mp4?fb=hd`);
  expect(items.filter((it) => it.hidden).length).toBe(1); // the player's efg-tagged track
  // Files below the video object take its id, length and owner (Reels: no post text, the owner names it).
  const reel = items.find((it) => it.key === `facebook:${ID(3)}`);
  expect([reel.duration, reel.title, reel.width]).toEqual([4, 'Reels Hesabı', 640]);
  expect(items.find((it) => it.key === `facebook:${ID(4)}:dash`).duration).toBe(4);
  // 505 names only its manifest's address: the entry is that address; its owner's name came with 504's data.
  const byUrl = items.find((it) => it.key === `facebook:${ID(5)}:dash`);
  expect([byUrl.url, byUrl.manifestText ?? null]).toEqual([`${server.url}/media/dash-base/DASHPlaylist.mpd?fb=url`, null]);
  await expect.poll(async () => (await stored(tabId)).find((it) => it.key === `facebook:${ID(5)}:dash`).title).toBe('Manifest Sayfası');

  const before = await ext.existingDownloadIds();
  await main.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: 127\.0\.0\.1-Bir Sayfa · İlk video-\d{8}-\d{4}\.mp4$/);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await popup.close();
  await page.close();
});

test("a feed: each player's button downloads the video its link names; a manifest-only video is merged", async () => {
  test.setTimeout(120000); // five downloads, three of them merged
  const { page } = await openFb('/');
  const badge = page.locator('[data-vdl-badge][data-visible] .btn');
  const hoverPost = async (id) => {
    const video = page.locator(`video[data-id="${id}"]`);
    await video.scrollIntoViewIfNeeded();
    const box = await video.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(badge).toBeVisible();
  };
  const away = async () => {
    await page.mouse.move(2, 2);
    await expect(page.locator('[data-vdl-badge][data-visible]')).toHaveCount(0, { timeout: 15000 });
  };
  // All four players are 4 s long: only the link around each one tells them apart.
  const cases = [
    [ID(2), 'dash-base/DASH_180.mp4'], // /<page>/videos/<slug>/<id>/
    [ID(3), 'dash-base/DASH_360.mp4'], // /reel/<id>
    [ID(1), 'sample.mp4'], // /watch/?v=<id>
  ];
  for (const [id, file] of cases) {
    await hoverPost(id);
    const before = await ext.existingDownloadIds();
    await badge.click();
    const [done] = await ext.waitForNewCompletedDownloads(before, 1);
    expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, file))), `${id} → ${file}`).toBe(true);
    await away();
  }
  // /watch/?v=<id>&ref=feed: a player fed through srcObject (no URL, like Facebook's),
  // and only a manifest, so video and audio are downloaded and merged.
  await expect(page.locator('body')).toHaveAttribute('data-worker-player', 'true');
  expect(await page.locator(`video[data-id="${ID(4)}"]`).evaluate((v) => [v.currentSrc, Boolean(v.srcObject)])).toEqual(['', true]);
  await hoverPost(ID(4));
  const before = await ext.existingDownloadIds();
  await badge.click();
  const [merged] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
  expect(moovSummary(await readFile(merged.filename)).traks).toBe(2);
  await away();
  // /watch/?v=<id>: the manifest is read from its address, then merged.
  await hoverPost(ID(5));
  const before5 = await ext.existingDownloadIds();
  await badge.click();
  // Two qualities in that manifest: the button opens its menu; take the first (best).
  await page.locator('[data-vdl-badge] .menu[data-open] button').first().click();
  const [fromUrl] = await ext.waitForNewCompletedDownloads(before5, 1, 60000);
  expect(moovSummary(await readFile(fromUrl.filename)).traks).toBe(2);
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
