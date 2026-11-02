import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function openPageAndPopup(url) {
  const page = await ext.context.newPage();
  await page.goto(url);
  await page.evaluate(() => document.querySelector('video')?.load());
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

const syncGet = () => ext.worker.evaluate(() => chrome.storage.sync.get(null));

test('options page saves settings, previews the template and resets it', async () => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
  await expect(options.locator('#mergeTracks')).toBeChecked();
  await expect(options.locator('#preferH264')).toBeChecked();
  await expect(options.locator('#preview')).toHaveText(/^ornek-site\.com-Örnek video başlığı-\d{8}-\d{4}\.mp4$/);

  await options.locator('#mergeTracks').uncheck();
  await options.locator('#concurrency').fill('2');
  await options.locator('#filenameTemplate').fill('{title} [{quality}] {site}');
  await expect(options.locator('#preview')).toHaveText('Örnek video başlığı [1080p] ornek-site.com.mp4');
  await expect(options.locator('#status')).toHaveText('Kaydedildi');
  await expect.poll(syncGet).toMatchObject({ mergeTracks: false, concurrency: 2, filenameTemplate: '{title} [{quality}] {site}' });

  // Invalid values are normalised away.
  await options.locator('#concurrency').fill('99');
  await expect.poll(async () => (await syncGet()).concurrency).toBe(2);

  await options.locator('#resetTemplate').click();
  await expect.poll(async () => (await syncGet()).filenameTemplate).toBe('{site}-{title}-{date}');
  await options.locator('#mergeTracks').check();
  await expect.poll(async () => (await syncGet()).mergeTracks).toBe(true);
  await options.close();
});

test('the filename template is applied to downloads and quality is filled for streams', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ filenameTemplate: '{quality}_{title}_{site}' }));
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await expect(popup.locator('.item')).toHaveCount(1);
  await popup.locator('.item .download').click();
  // 320×180 → "180p"
  await expect(popup.locator('#status')).toHaveText('İndirme başladı: 180p_Düz MP4 Test Sayfası_127.0.0.1.mp4');
  await popup.close();
  await page.close();

  const page2 = await ext.context.newPage();
  await page2.goto(`${server.url}/pages/hls.html?src=${encodeURIComponent('/media/hls-fmp4/master.m3u8')}`);
  await expect(page2.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const popup2 = await ext.openPopup(await ext.tabIdOf(page2));
  const item = popup2.locator('.item[data-kind="hls"]');
  await expect(item.locator('.download')).toBeEnabled();
  await item.locator('.quality').selectOption({ label: '180p · 0.3 Mbps' });
  await item.locator('.download').click();
  await expect(popup2.locator('#status')).toHaveText('Akış indiriliyor: 180p_HLS Oynatıcı Sayfası_127.0.0.1.mp4');
  await expect(popup2.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  await popup2.close();
  await page2.close();
  await ext.worker.evaluate(() => chrome.storage.sync.remove('filenameTemplate'));
});

test('completed downloads land in the history, which can be shown and cleared', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-webm.html`);
  await expect(popup.locator('.item')).toHaveCount(1);
  const before = await ext.existingDownloadIds();
  await popup.locator('.item .download').click();
  await ext.waitForNewCompletedDownloads(before, 1);

  await popup.locator('#history-toggle').click();
  const entries = popup.locator('.history-item');
  await expect(entries.first().locator('.history-name')).toHaveText(/^127\.0\.0\.1-WebM Test Sayfası-\d{8}-\d{4}\.webm$/);
  await expect(entries.first().locator('.history-meta')).toContainText('127.0.0.1');
  await expect(entries.first().locator('.history-meta')).toContainText('KB');
  // Earlier tests downloaded too: the list is ordered newest first and capped by the limit.
  const stored = await ext.worker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  expect(stored.length).toBeGreaterThanOrEqual(3);
  expect(stored[0].filename.endsWith('.webm')).toBe(true);
  expect(stored.every((e) => e.downloadId > 0 && e.url && e.at)).toBe(true);

  await popup.locator('#history-clear').click();
  await expect(popup.locator('#history-empty')).toBeVisible();
  expect(await ext.worker.evaluate(async () => (await chrome.storage.local.get('history')).history)).toBeUndefined();
  await popup.close();
  await page.close();
});

test('history limit is enforced', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ historyLimit: 2 }));
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  for (let i = 0; i < 3; i++) {
    const before = await ext.existingDownloadIds();
    await popup.locator('.item .download').click();
    await ext.waitForNewCompletedDownloads(before, 1);
    await popup.reload();
    await expect(popup.locator('.item')).toHaveCount(1);
  }
  await expect
    .poll(async () => (await ext.worker.evaluate(async () => (await chrome.storage.local.get('history')).history)).length)
    .toBe(2);
  await ext.worker.evaluate(() => chrome.storage.sync.remove('historyLimit'));
  await popup.close();
  await page.close();
});

test('keyboard shortcut handler downloads the best item of the tab', async () => {
  const { page, tabId } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await expect.poll(() => ext.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
  const before = await ext.existingDownloadIds();
  const res = await ext.worker.evaluate((id) => globalThis.__vdl.downloadBest(id), tabId);
  expect(res.started).toBe(true);
  expect(res.item.kind).toBe('video');
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await page.close();

  const empty = await ext.context.newPage();
  await empty.goto(`${server.url}/pages/empty.html`);
  const res2 = await ext.worker.evaluate((id) => globalThis.__vdl.downloadBest(id), await ext.tabIdOf(empty));
  expect(res2).toEqual({ started: false, reason: 'Bu sekmede indirilebilir video yok' });
  await empty.close();
});

test('debug info contains the tab, items, jobs and settings without secrets', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html?session=SECRET123`);
  await expect(popup.locator('.item')).toHaveCount(1);
  await popup.locator('#debug').click();
  await expect(popup.locator('#status')).toContainText(/kopyalandı|seçili/);
  const text = await popup.locator('#debug-out').inputValue();
  const info = JSON.parse(text);
  const manifestVersion = await ext.worker.evaluate(() => chrome.runtime.getManifest().version);
  expect(info.extension).toBe(manifestVersion);
  expect(info.tabUrl).toContain('/pages/plain-mp4.html');
  expect(info.items[0]).toMatchObject({ kind: 'video' });
  expect(info.items[0].url).toContain('/media/sample.mp4');
  expect(info.settings).toMatchObject({ mergeTracks: true });
  expect(Array.isArray(info.jobs)).toBe(true);
  expect(Object.keys(info.items[0])).not.toContain('id');
  // Query values (signed URLs, sessions) and the page title stay out.
  expect(text).not.toContain('SECRET123');
  expect(info.tabUrl).toMatch(/\?session=…$/);
  expect(info).not.toHaveProperty('tabTitle');
  await popup.close();
  await page.close();
});

test('manifest declares the options page and the shortcut', async () => {
  const manifest = await ext.worker.evaluate(() => chrome.runtime.getManifest());
  // The manifest key pins the id regardless of the folder the extension is loaded from.
  expect(manifest.key).toBeTruthy();
  expect(ext.extensionId).toBe('dnbedddlffjlpbmgpdmnegngpkejbbjn');
  expect(manifest.options_ui.page).toBe('src/options/options.html');
  expect(manifest.commands['download-best'].suggested_key.default).toBe('Alt+Shift+D');
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
