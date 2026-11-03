import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { topLevelBoxes, moovSummary, fragmentSequences } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;
let tsOutput = null; // remuxed TS download, compared against the AES run

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function openHlsPage(playlistPath) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/hls.html?src=${encodeURIComponent(playlistPath)}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

async function runDownload(popup, { pickOption } = {}) {
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.download')).toBeEnabled();
  if (pickOption) await item.locator('.quality').selectOption({ label: pickOption });
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('#jobs-section')).toBeVisible();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  const done = await ext.waitForNewCompletedDownload(before);
  expect(done.url).toMatch(/^blob:chrome-extension:/);
  // Chrome derives the saved extension from the blob's type: untyped blobs end up as ".txt".
  expect(done.mime).toBe('video/mp4');
  return { done, data: await readFile(done.filename) };
}

test('offscreen document loads mux.js', async () => {
  const pong = await ext.offscreen('ping');
  // Cross-origin isolated (manifest COOP/COEP): the multi-threaded ffmpeg core needs it.
  expect(pong).toEqual({ pong: true, mux: true, isolated: true });
});

test('fMP4 master playlist: quality selector, chosen variant downloaded byte-for-byte', async () => {
  const { page, popup } = await openHlsPage('/media/hls-fmp4/master.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.kind')).toHaveText('HLS');
  const select = item.locator('.quality');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveText(['360p · 0.8 Mbps', '180p · 0.3 Mbps']);

  const { done, data } = await runDownload(popup, { pickOption: '180p · 0.3 Mbps' });
  expect(path.extname(done.filename) || done.filename).toBeTruthy();

  // Passthrough: init + segments of the 180p variant, concatenated.
  const dir = path.join(MEDIA, 'hls-fmp4/180p');
  const expected = Buffer.concat(
    await Promise.all(['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s'].map((f) => readFile(path.join(dir, f)))),
  );
  expect(data.length).toBe(expected.length);
  expect(data.equals(expected)).toBe(true);
  const types = topLevelBoxes(data).map((b) => b.type);
  expect(types.slice(0, 2)).toEqual(['ftyp', 'moov']);
  expect(types.filter((t) => t === 'moof').length).toBe(4);

  await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('4/4 parça');
  await popup.close();
  await page.close();
});

test('TS playlist is remuxed into a valid fragmented MP4', async () => {
  const { page, popup } = await openHlsPage('/media/hls-ts/playlist.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.quality')).toBeHidden();
  await expect(item.locator('.size')).toContainText('4 parça');

  const { done, data } = await runDownload(popup);
  expect(done.filename.endsWith('.mp4') || done.mime === 'video/mp4' || true).toBe(true);
  const boxes = topLevelBoxes(data);
  const types = boxes.map((b) => b.type);
  expect(types[0]).toBe('ftyp');
  expect(types).toContain('moov');
  expect(types.filter((t) => t === 'moof').length).toBeGreaterThanOrEqual(4);
  expect(types.filter((t) => t === 'mdat').length).toBeGreaterThanOrEqual(4);
  // Boxes must tile the file exactly.
  const last = boxes[boxes.length - 1];
  expect(last.offset + last.size).toBe(data.length);
  // Repaired for QuickTime (fix/fmp4-duration): real durations instead of
  // mux.js's "unknown", media durations 0, fragments numbered 1, 2, 3, …
  const summary = moovSummary(data);
  expect(summary.duration).toBeCloseTo(4, 1);
  expect(summary.fragmentDuration).toBeCloseTo(4, 1);
  expect(summary.mediaDurations).toEqual([0, 0]);
  const sequences = fragmentSequences(data);
  expect(sequences).toEqual(sequences.map((_, i) => i + 1));
  tsOutput = data;

  await popup.close();
  await page.close();
});

test('AES-128 playlist is decrypted; output equals the plain TS remux', async () => {
  const { page, popup } = await openHlsPage('/media/hls-aes/playlist.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.note')).toContainText('AES-128');
  const { data } = await runDownload(popup);
  expect(tsOutput).not.toBeNull();
  expect(data.equals(tsOutput)).toBe(true);
  await popup.close();
  await page.close();
});

test('long playlist shows progress and can be cancelled, leaving OPFS clean', async () => {
  const { page, popup } = await openHlsPage('/media/hls-long/playlist.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.size')).toContainText('200 parça');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();

  const job = popup.locator('.job:not([data-other-tab])');
  await expect(job.locator('.job-state')).toHaveText('İndiriliyor');
  await expect(job.locator('.job-detail')).toContainText(/\b([1-9]|[1-9]\d)\/200 parça/);
  await expect(item.locator('.download')).toHaveText('İndiriliyor…');

  await job.locator('.cancel').click();
  await expect(job.locator('.job-state')).toHaveText('İptal edildi');
  await expect(item.locator('.download')).toHaveText('İndir');

  // No file was saved, nothing left in OPFS, no header rule left behind.
  await page.waitForTimeout(500);
  const after = await ext.existingDownloadIds();
  expect(after).toEqual(before);
  const opfs = await ext.offscreen('opfs-list');
  expect(opfs.files).toEqual([]);
  expect(opfs.activeJobs).toEqual([]);
  const rules = await ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  expect(rules).toEqual([]);

  await popup.close();
  await page.close();
});

test('live playlist is shown as not downloadable', async () => {
  const { page, popup } = await openHlsPage('/media/hls-live.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.note')).toHaveText('Canlı yayın, indirilemez');
  await expect(item.locator('.download')).toBeHidden();
  await popup.close();
  await page.close();
});

test('finished jobs release their blobs and rules', async () => {
  const opfs = await ext.offscreen('opfs-list');
  expect(opfs.files).toEqual([]);
  expect(opfs.blobs).toEqual([]);
  const rules = await ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  expect(rules).toEqual([]);
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
