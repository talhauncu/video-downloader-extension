// Stage 5c (second plan): Vimeo. The extractor reads the player's inline
// configuration (window.playerConfig): the largest progressive MP4 with audio,
// else the HLS master (H.264 first). It runs in every frame, so players
// embedded in other sites' pages are covered; their entries keep the player
// frame as their context, and the in-page button matches a player by the
// video its frame names.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server, player;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
  // vimeo.localhost stands for vimeo.com / player.vimeo.com (it reaches this machine).
  player = server.url.replace('127.0.0.1', 'vimeo.localhost');
  const ids = await ext.worker.evaluate(() =>
    globalThis.__vdl.registerSiteScripts(['*://*.vimeo.com/*', 'http://vimeo.localhost/*'], 'vimeo'),
  );
  expect(ids).toEqual(['vimeo-main', 'vimeo-bridge']);
  await ext.worker.evaluate(() => globalThis.__vdl.addSiteHost('vimeo.localhost', 'vimeo'));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const stored = (tabId) => ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);

test('players embedded in a blog: one entry per video with its frame as context; each button downloads its own video', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/vimeo-embed.html?player=${encodeURIComponent(player)}`);
  const tabId = await ext.tabIdOf(page);
  await expect.poll(async () => (await stored(tabId)).filter((it) => it.site === 'vimeo').length, { timeout: 15000 }).toBe(2);
  const items = await stored(tabId);
  const hls = items.find((it) => it.key === 'vimeo:76979871:hls');
  const mp4 = items.find((it) => it.key === 'vimeo:11111111');
  expect(hls.url).toBe(`${player}/media/hls-audio/master.m3u8?v=avc`); // the H.264 master
  expect(hls.frameUrl).toBe(`${player}/pages/vimeo-player.html/video/76979871?h=abc123`);
  expect([mp4.url, mp4.title, mp4.width]).toEqual([`${player}/media/sample.mp4?v=720`, 'Başka Kanal · Dosyalı {video}', 1280]);

  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('.item[data-site="vimeo"] .kind').first()).toHaveText('Vimeo');
  const names = popup.locator('.item[data-site="vimeo"] .name');
  await expect(names).toHaveCount(2);
  expect((await names.allTextContents()).sort()).toEqual(['Başka Kanal · Dosyalı {video}', 'Bir Stüdyo · Akış videosu']);
  await popup.close();

  // Both players are 4 s long: the frame each one sits in tells them apart.
  // The frame's badge script listens to the pointer only once its texts have
  // loaded; a single early move can go unnoticed (a real pointer keeps moving).
  // Keep moving over the player until its button shows.
  const hoverUntilBadge = async (id) => {
    const badge = page.frameLocator(`iframe[data-id="${id}"]`).locator('[data-vdl-badge][data-visible] .btn');
    const box = await page.locator(`iframe[data-id="${id}"]`).boundingBox();
    let step = 0;
    await expect(async () => {
      step = (step + 1) % 2;
      await page.mouse.move(box.x + box.width / 2 + step * 6, box.y + box.height / 2, { steps: 3 });
      await expect(badge).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 15000 });
    return badge;
  };
  const badgeB = await hoverUntilBadge('11111111');
  let before = await ext.existingDownloadIds();
  await badgeB.click();
  const [file] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(file.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);

  const badgeA = await hoverUntilBadge('76979871');
  before = await ext.existingDownloadIds();
  await badgeA.click();
  const [merged] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
  expect(moovSummary(await readFile(merged.filename)).codecs.sort()).toEqual(['avc1', 'mp4a']);
  await page.close();
});

test('a video page on the site itself: its entry is this page and downloads the largest file', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${player}/pages/vimeo-player.html/video/11111111`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  const tabId = await ext.tabIdOf(page);
  await expect.poll(async () => (await stored(tabId)).some((it) => it.key === 'vimeo:11111111')).toBe(true);
  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('#site-note')).toBeHidden();
  const main = popup.locator('#media-list > .item');
  await expect(main).toHaveCount(1);
  await expect(main.locator('.badge.here')).toBeVisible();
  const before = await ext.existingDownloadIds();
  await main.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: vimeo\.localhost-Başka Kanal · Dosyalı \{video\}-\d{8}-\d{4}\.mp4$/);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
