import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

let ext, pageServer, playerServer;

test.beforeAll(async () => {
  pageServer = await startServer();
  playerServer = await startServer({ txtAlias: true }); // cross-origin player host, .txt master
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await pageServer?.close();
  await playerServer?.close();
});

async function openFilmWithAds() {
  const page = await ext.context.newPage();
  await page.goto(`${pageServer.url}/pages/film-ads.html`);
  await page
    .locator('#player')
    .evaluate(
      (el, src) => (el.src = src),
      `${playerServer.url}/pages/player-mse.html?duration=4&src=${encodeURIComponent('/media/hls-audio/master.txt')}`,
    );
  await expect(page.frameLocator('#player').locator('body')).toHaveAttribute('data-playlists-loaded', '2');
  const tabId = await ext.tabIdOf(page);
  // Banners report their size once their metadata is loaded.
  await expect
    .poll(
      async () => {
        const items = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
        return items.filter((it) => it.kind === 'video' && it.width).length;
      },
      { timeout: 20000 },
    )
    .toBe(6);
  return { page, tabId };
}

test('film page: Önerilen shows one main card, ads fold into Diğer (6), Tümü lists all 10', async () => {
  const { page, tabId } = await openFilmWithAds();
  const popup = await ext.openPopup(tabId);

  // Önerilen (default): one card, the master playlist, merged with the blob player.
  const recommended = popup.locator('#media-list > .item');
  await expect(recommended).toHaveCount(1, { timeout: 20000 });
  const main = recommended.first();
  await expect(main).toHaveClass(/main/);
  await expect(main.locator('.badge.here')).toHaveText('Ana video');
  await expect(main).toHaveAttribute('data-kind', 'hls');
  await expect(main).toHaveAttribute('data-merged', '1');
  await expect(main.locator('.name')).toHaveText('master.txt');
  await expect(main.locator('.size')).toContainText('0:04'); // duration from the player
  await expect(main.locator('.quality option')).toHaveText(['180p · 0.8 Mbps']);
  await expect(main.locator('.note')).toHaveText('Ses ayrı dosya olarak iner');

  // Diğer: the six banners, collapsed.
  await expect(popup.locator('#others')).toBeVisible();
  await expect(popup.locator('#others-count')).toHaveText('6');
  await expect(popup.locator('#others')).not.toHaveAttribute('open', '');
  await expect(popup.locator('#others-list > .item[data-reason="ad"]')).toHaveCount(6);
  await expect(popup.locator('#others-list > .item').first().locator('.note')).toHaveText('Muhtemel reklam');

  // Tümü: banners + blob + master + 2 sub-playlists.
  await expect(popup.locator('#all-count')).toHaveText('10');
  await popup.locator('#view-all').click();
  await expect(popup.locator('#media-list > .item')).toHaveCount(10);
  await expect(popup.locator('#others')).toBeHidden();
  await popup.locator('#view-recommended').click();
  await expect(popup.locator('#media-list > .item')).toHaveCount(1);

  // Toolbar badge counts the recommended video only.
  await expect.poll(() => ext.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
  await popup.close();
  await page.close();
});

test('the main card downloads the film with its audio merged into one file', async () => {
  const { page, tabId } = await openFilmWithAds();
  const popup = await ext.openPopup(tabId);
  const main = popup.locator('#media-list > .item.main');
  await expect(main.locator('.download')).toBeEnabled({ timeout: 20000 });
  const before = await ext.existingDownloadIds();
  await main.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 60000 });
  const [done] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
  const summary = moovSummary(await readFile(done.filename));
  expect(summary.traks).toBe(2);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a']);
  await popup.close();
  await page.close();
});

test('the keyboard shortcut picks the main card, not a banner', async () => {
  const { page, tabId } = await openFilmWithAds();
  await expect
    .poll(
      async () => {
        const items = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
        return items.some((it) => it.kind === 'hls' && it.stream?.type === 'master');
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const res = await ext.worker.evaluate((id) => globalThis.__vdl.downloadBest(id), tabId);
  expect(res.started).toBe(true);
  expect(res.item.kind).toBe('hls');
  expect(res.item.url).toContain('master.txt');
  await page.close();
});

test('with the ad filter off the banners are recommended too (film still main)', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ hideAds: false }));
  try {
    const { page, tabId } = await openFilmWithAds();
    const popup = await ext.openPopup(tabId);
    await expect(popup.locator('#media-list > .item')).toHaveCount(7, { timeout: 20000 });
    await expect(popup.locator('#media-list > .item').first()).toHaveAttribute('data-kind', 'hls');
    await expect(popup.locator('#others')).toBeHidden();
    await popup.close();
    await page.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove('hideAds'));
  }
});

test('options page saves the ad filter switch', async () => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
  await expect(options.locator('#hideAds')).toBeChecked();
  await options.locator('#hideAds').uncheck();
  await expect.poll(() => ext.worker.evaluate(async () => (await chrome.storage.sync.get('hideAds')).hideAds)).toBe(false);
  await options.locator('#hideAds').check();
  await expect.poll(() => ext.worker.evaluate(async () => (await chrome.storage.sync.get('hideAds')).hideAds)).toBe(true);
  await options.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
