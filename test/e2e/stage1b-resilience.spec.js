import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, pageServer;

test.beforeAll(async () => {
  pageServer = await startServer();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await pageServer?.close();
});

async function openPlayer(host, playlistPath) {
  const page = await ext.context.newPage();
  await page.goto(`${pageServer.url}/pages/film.html`);
  await page
    .locator('#player')
    .evaluate((el, src) => (el.src = src), `${host.url}/pages/player.html?src=${encodeURIComponent(playlistPath)}`);
  await expect(page.frameLocator('#player').locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

async function latestJob(status) {
  return ext.worker.evaluate(
    async (st) =>
      Object.values(await chrome.storage.session.get(null))
        .filter((v) => v?.jobId && (!st || v.status === st))
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null,
    status,
  );
}

test('expired signed segment URLs are recovered by re-reading the playlist (HLS)', async () => {
  // Tokens rotate after every 8 segment requests (realistic: minutes, not per request); stale tokens get 403.
  const host = await startServer({ txtAlias: true, tokenRotate: { every: 8 } });
  try {
    // 200 entries → the token rotates many times during the download.
    const { page, popup } = await openPlayer(host, '/media/hls-long/playlist.txt');
    const item = popup.locator('.item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 30000 });
    const before = await ext.existingDownloadIds();
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 120000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('playlist yenileme');
    const [done] = await ext.waitForNewCompletedDownloads(before, 1);
    expect(done.mime).toBe('video/mp4');
    const job = await latestJob('done');
    expect(job.refreshes).toBeGreaterThanOrEqual(1);
    await popup.close();
    await page.close();
  } finally {
    await host.close();
  }
});

test('expired signed segment URLs are recovered by re-reading the MPD (DASH)', async () => {
  const host = await startServer({ tokenRotate: { every: 8 } });
  try {
    const page = await ext.context.newPage();
    await page.goto(`${pageServer.url}/pages/film.html`);
    await page
      .locator('#player')
      .evaluate((el, src) => (el.src = src), `${host.url}/pages/player.html?src=${encodeURIComponent('/media/dash/manifest.mpd')}`);
    await expect(page.frameLocator('#player').locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
    const tabId = await ext.tabIdOf(page);
    const popup = await ext.openPopup(tabId);
    const item = popup.locator('.item[data-kind="dash"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 30000 });
    const before = await ext.existingDownloadIds();
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 90000 });
    await ext.waitForNewCompletedDownloads(before, 1, 60000);
    const job = await latestJob('done');
    expect(job.refreshes).toBeGreaterThanOrEqual(1);
    await popup.close();
    await page.close();
  } finally {
    await host.close();
  }
});

test('after a 429 the job paces its requests (spacing shown) and finishes with few retries', async () => {
  // Every 4th media request is limited once (Retry-After 0): spacing should kick in.
  const host = await startServer({ txtAlias: true, rateLimit: { every: 4, retryAfter: 0, times: 1 } });
  try {
    const { page, popup } = await openPlayer(host, '/media/hls-long/playlist.txt');
    const item = popup.locator('.item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 30000 });
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('aralık', { timeout: 30000 });
    // Cancel: the long fixture is only there to observe pacing.
    await popup.locator('.job:not([data-other-tab]) .cancel').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('İptal edildi', { timeout: 30000 });
    const job = await latestJob('cancelled');
    expect(job.spacingMs).toBeGreaterThan(0);
    await popup.close();
    await page.close();
  } finally {
    await host.close();
  }
});

test('maxCooldownMinutes = 0 fails fast on a persistent 429 instead of waiting', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ maxCooldownMinutes: 0 }));
  const host = await startServer({ txtAlias: true, rateLimit: { match: 'seg1\\.ts', retryAfter: 0, times: 20 } });
  try {
    const { page, popup } = await openPlayer(host, '/media/hls-ts/playlist.txt');
    const item = popup.locator('.item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 30000 });
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Hata', { timeout: 60000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('HTTP 429');
    const job = await latestJob('error');
    expect(job.lastHttp.cooldowns).toBe(0);
    await popup.close();
    await page.close();
  } finally {
    await host.close();
    await ext.worker.evaluate(() => chrome.storage.sync.remove('maxCooldownMinutes'));
  }
});

test('an expired playlist URL yields a clear message', async () => {
  // The player read the playlist once; by the time the popup asks, the signed URL is dead (403).
  const host = await startServer({ onceThenForbid: 'playlist\\.m3u8$' });
  try {
    const { page, popup } = await openPlayer(host, '/media/hls-ts/playlist.m3u8');
    await expect(popup.locator('#error-state')).toContainText('süresi doldu', { timeout: 60000 });
    await popup.close();
    await page.close();
  } finally {
    await host.close();
  }
});

test('options page shows and saves the cooldown budget', async () => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
  await expect(options.locator('#maxCooldownMinutes')).toHaveValue('10');
  await options.locator('#maxCooldownMinutes').fill('30');
  await expect
    .poll(() => ext.worker.evaluate(async () => (await chrome.storage.sync.get('maxCooldownMinutes')).maxCooldownMinutes))
    .toBe(30);
  await options.locator('#maxCooldownMinutes').fill('999');
  await expect
    .poll(() => ext.worker.evaluate(async () => (await chrome.storage.sync.get('maxCooldownMinutes')).maxCooldownMinutes))
    .toBe(30);
  await ext.worker.evaluate(() => chrome.storage.sync.remove('maxCooldownMinutes'));
  await options.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
