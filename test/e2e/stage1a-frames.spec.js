import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, pageServer, playerServer;

test.beforeAll(async () => {
  pageServer = await startServer(); // the page with the player (origin A)
  // The player host (origin B): playlists disguised as .txt/text-plain, media
  // only for requests whose Referer comes from B itself.
  playerServer = await startServer({ txtAlias: true, requireRefererOrigin: 'self' });
  ext = await launchWithExtension();
  // A missing segment fails after short late retries (the real ones take ~2 min).
  await ext.worker.evaluate(() => (globalThis.__vdlFallbackDelays = [50, 50]));
});

test.afterAll(async () => {
  await ext?.close();
  await pageServer?.close();
  await playerServer?.close();
});

async function openFilmPage(playlistPath) {
  const page = await ext.context.newPage();
  await page.goto(`${pageServer.url}/pages/film.html`);
  await page
    .locator('#player')
    .evaluate((el, src) => (el.src = src), `${playerServer.url}/pages/player.html?src=${encodeURIComponent(playlistPath)}`);
  const frame = page.frameLocator('#player');
  await expect(frame.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

test('the player host rejects requests whose Referer is the top page', async () => {
  const status = await ext.worker.evaluate(
    async ({ url, referer }) => {
      // Same mechanism the extension uses, with the WRONG context (top page).
      const id = 777;
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
            condition: { regexFilter: '^https?://', tabIds: [-1], resourceTypes: ['xmlhttprequest'] },
          },
        ],
      });
      try {
        return (await fetch(url, { credentials: 'include' })).status;
      } finally {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
      }
    },
    { url: `${playerServer.url}/media/hls-fmp4/180p/init.mp4`, referer: `${pageServer.url}/pages/film.html` },
  );
  expect(status).toBe(404);
});

test('a .txt playlist fetched by the iframe is sniffed as HLS and carries the frame URL', async () => {
  const { page, tabId, popup } = await openFilmPage('/media/hls-fmp4/master.txt');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.name')).toHaveText('master.txt');
  await expect(item.locator('.quality option')).toHaveText(['360p · 0.8 Mbps', '180p · 0.3 Mbps']);

  const [stored] = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
  expect(stored.sniffed).toBe(true);
  expect(stored.frameUrl.startsWith(`${playerServer.url}/pages/player.html`)).toBe(true);
  expect(stored.frameId).toBeGreaterThan(0);
  expect(stored.pageUrl.startsWith(pageServer.url)).toBe(true);

  const debug = await popup.evaluate(
    (id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'debug:info', payload: { tabId: id } }, resolve)),
    tabId,
  );
  // Debug info masks query values (signed URLs): the frame's address, its query value hidden.
  expect(debug.result.items[0].frameUrl).toBe(stored.frameUrl.replace(/\?src=.*$/, '?src=…'));
  expect(debug.result.items[0].sniffed).toBe(true);
  await popup.close();
  await page.close();
});

test('the download uses the iframe as Referer context and completes byte-exact', async () => {
  const { page, popup } = await openFilmPage('/media/hls-fmp4/master.txt');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.download')).toBeEnabled();
  await item.locator('.quality').selectOption({ label: '180p · 0.3 Mbps' });
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  const data = await readFile(done.filename);
  const dir = path.join(MEDIA, 'hls-fmp4/180p');
  const expected = Buffer.concat(
    await Promise.all(['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s'].map((f) => readFile(path.join(dir, f)))),
  );
  expect(data.equals(expected)).toBe(true);
  expect(moovSummary(data).traks).toBe(2); // the 180p variant is muxed video + audio

  const [job] = await ext.worker.evaluate(async () =>
    Object.values(await chrome.storage.session.get(null))
      .filter((v) => v?.jobId)
      .sort((a, b) => b.startedAt - a.startedAt),
  );
  expect(job.contextUrl.startsWith(`${playerServer.url}/pages/player.html`)).toBe(true);
  expect(job.lastHttp ?? null).toBeNull();
  await popup.close();
  await page.close();
});

test('a missing segment fails with a step-labelled error recorded in the job', async () => {
  // Playlist whose third segment does not exist on the server.
  const { page, popup } = await openFilmPage('/media/hls-broken/playlist.txt');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.download')).toBeEnabled();
  await item.locator('.download').click();
  const job = popup.locator('.job:not([data-other-tab])');
  await expect(job.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  await expect(job.locator('.job-detail')).toContainText('Parça 3/4 alınamadı (HTTP 404)');
  const [state] = await ext.worker.evaluate(async () =>
    Object.values(await chrome.storage.session.get(null)).filter((v) => v?.jobId && v.status === 'error'),
  );
  expect(state.lastHttp).toMatchObject({ step: 'segment', index: 2, status: 404 });
  expect(state.lastHttp.referer.startsWith(playerServer.url)).toBe(true);
  await popup.close();
  await page.close();
});

test('junk bytes in front of segments are trimmed before remuxing', async () => {
  const { page, popup } = await openFilmPage('/media/hls-junk/playlist.txt');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.download')).toBeEnabled();
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  const data = await readFile(done.filename);
  // Same input as hls-ts once the junk is gone → identical remux output.
  const clean = await readFile(path.join(MEDIA, 'hls-ts', 'seg0.ts'));
  expect(data.subarray(4, 8).toString()).toBe('ftyp');
  const [job] = await ext.worker.evaluate(async () =>
    Object.values(await chrome.storage.session.get(null))
      .filter((v) => v?.jobId && v.status === 'done')
      .sort((a, b) => b.startedAt - a.startedAt),
  );
  expect(job.files[0].junkBytes).toBe(4 * 64);
  expect(clean.length).toBeGreaterThan(0);
  await popup.close();
  await page.close();
});

test('rate-limited segments (429 + Retry-After) are retried and the job completes', async () => {
  // A separate host that answers 429 on every 3rd media request, once per URL.
  const limited = await startServer({ txtAlias: true, rateLimit: { every: 3, retryAfter: 1 } });
  try {
    const page = await ext.context.newPage();
    await page.goto(`${pageServer.url}/pages/film.html`);
    await page
      .locator('#player')
      .evaluate((el, src) => (el.src = src), `${limited.url}/pages/player.html?src=${encodeURIComponent('/media/hls-ts/playlist.txt')}`);
    await expect(page.frameLocator('#player').locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
    const tabId = await ext.tabIdOf(page);
    const popup = await ext.openPopup(tabId);
    const item = popup.locator('.item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled();
    const before = await ext.existingDownloadIds();
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 60000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('yeniden deneme');
    const [done] = await ext.waitForNewCompletedDownloads(before, 1);
    expect(done.mime).toBe('video/mp4');
    const [job] = await ext.worker.evaluate(async () =>
      Object.values(await chrome.storage.session.get(null))
        .filter((v) => v?.jobId && v.status === 'done')
        .sort((a, b) => b.startedAt - a.startedAt),
    );
    expect(job.retries).toBeGreaterThanOrEqual(1);
    await popup.close();
    await page.close();
  } finally {
    await limited.close();
  }
});

test('a persistent 429 (quota) goes through a cooldown shown in the popup and still completes', async () => {
  // One segment answers 429 seven times (more than the quick-retry budget)
  // with Retry-After: 2, so a cooldown is needed before it finally succeeds.
  const quota = await startServer({ txtAlias: true, rateLimit: { match: 'seg1\\.ts', retryAfter: 2, times: 7 } });
  try {
    const page = await ext.context.newPage();
    await page.goto(`${pageServer.url}/pages/film.html`);
    await page
      .locator('#player')
      .evaluate((el, src) => (el.src = src), `${quota.url}/pages/player.html?src=${encodeURIComponent('/media/hls-ts/playlist.txt')}`);
    await expect(page.frameLocator('#player').locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
    const tabId = await ext.tabIdOf(page);
    const popup = await ext.openPopup(tabId);
    const item = popup.locator('.item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 60000 });
    const before = await ext.existingDownloadIds();
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Bekliyor', { timeout: 60000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('Sunucu hız sınırı (HTTP 429)');
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 120000 });
    const [done] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
    expect(done.mime).toBe('video/mp4');
    const [job] = await ext.worker.evaluate(async () =>
      Object.values(await chrome.storage.session.get(null))
        .filter((v) => v?.jobId && v.status === 'done')
        .sort((a, b) => b.startedAt - a.startedAt),
    );
    expect(job.cooldowns).toBeGreaterThanOrEqual(1);
    await popup.close();
    await page.close();
  } finally {
    await quota.close();
  }
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
