// Stage 4a: interface languages. The tests elsewhere run in Turkish
// (helpers set uiLanguage: 'tr'); this spec runs in English and switches.
import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, server;
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension({ uiLanguage: 'en' });
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

test('popup in English: static texts, cards, notes and job details; no Turkish left', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/hls.html?src=${encodeURIComponent('/media/hls-broken/playlist.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlist-loaded', /.+/);
  await ext.worker.evaluate(() => (globalThis.__vdlFallbackDelays = [20, 20]));
  const popup = await ext.openPopup(await ext.tabIdOf(page));
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await expect(popup.locator('#view-recommended')).toHaveText('Recommended');
  await expect(popup.locator('#history-toggle')).toHaveText('History');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.kind')).toHaveText('HLS');
  await expect(item.locator('.download')).toHaveText('Download');
  await expect(item.locator('.size')).toContainText('4 pieces');

  // An error built in the offscreen document (it has no chrome.i18n of its own).
  await item.locator('.download').click();
  const job = popup.locator('.job:not([data-other-tab])');
  await expect(job.locator('.job-state')).toHaveText('Error', { timeout: 30000 });
  await expect(job.locator('.job-detail')).toContainText('Piece 3/4 could not be fetched (HTTP 404)');
  await ext.worker.evaluate(() => delete globalThis.__vdlFallbackDelays);
  // Everything but the file names (they carry the fixture page's Turkish title).
  await expect(popup.locator('#status')).toContainText('Downloading stream:');
  const texts = await popup.evaluate(() =>
    [...document.querySelectorAll('body *:not(script):not(style)')]
      .filter((e) => e.children.length === 0 && !e.closest('.job-name, #status') && e.checkVisibility())
      .map((e) => e.textContent),
  );
  expect(texts.join('\n')).not.toMatch(TURKISH);
  await popup.close();
  await page.close();
});

test('in-page badge in English', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-mp4.html`);
  const video = page.locator('video');
  await video.scrollIntoViewIfNeeded();
  const box = await video.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = page.locator('[data-vdl-badge] .btn');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Download');
  await expect(badge).toHaveAttribute('title', 'Video Downloader');
  await page.close();
});

test('options page: English, and choosing Türkçe switches the page and the popup at once', async () => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
  await expect(options.locator('h1')).toHaveText('Video Downloader settings');
  await expect(options.locator('#uiLanguage')).toHaveValue('en');
  // Every label and hint, except the language list's own "Türkçe".
  const texts = await options.evaluate(() =>
    [...document.querySelectorAll('h1, h2, span, p, button, option')].filter((e) => e.textContent !== 'Türkçe').map((e) => e.textContent),
  );
  expect(texts.join('\n')).not.toMatch(TURKISH);

  await options.locator('#uiLanguage').selectOption('tr');
  await expect(options.locator('h1')).toHaveText('Video İndirici ayarları');
  await expect(options.locator('html')).toHaveAttribute('lang', 'tr');
  await expect.poll(() => ext.worker.evaluate(() => globalThis.__vdl.language())).toBe('tr');

  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/empty.html`);
  const popup = await ext.openPopup(await ext.tabIdOf(page));
  await expect(popup.locator('#empty-state')).toHaveText('Bu sekmede video bulunamadı.');

  await options.locator('#uiLanguage').selectOption('en');
  await expect(options.locator('h1')).toHaveText('Video Downloader settings');
  await popup.close();
  await page.close();
  await options.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
