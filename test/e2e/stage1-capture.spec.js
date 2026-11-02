import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, server, protectedServer;

test.beforeAll(async () => {
  server = await startServer();
  protectedServer = await startServer({ requireReferer: true });
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
  await protectedServer?.close();
});

async function openPageAndPopup(url) {
  const page = await ext.context.newPage();
  await page.goto(url);
  // Make the <video> actually fetch its source.
  await page.evaluate(() => document.querySelector('video')?.load());
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

/** Waits for a chrome.downloads entry to complete and returns it. */
async function waitForDownload(downloadId) {
  return ext.worker.evaluate(async (id) => {
    for (let i = 0; i < 100; i++) {
      const [d] = await chrome.downloads.search({ id });
      if (d && (d.state === 'complete' || d.state === 'interrupted')) return d;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('download did not finish');
  }, downloadId);
}

test('captures a plain MP4 and lists it with its size', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  const original = await stat(path.join(EXTENSION_PATH, 'test/fixtures/media/sample.mp4'));

  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.kind')).toHaveText('Video');
  await expect(item.locator('.name')).toHaveText('sample.mp4');
  await expect(item.locator('.size')).toContainText(`${Math.round(original.size / 1024)} KB`);
  await expect(popup.locator('#empty-state')).toBeHidden();

  await popup.close();
  await page.close();
});

test('badge shows the number of captured items', async () => {
  const { page, tabId, popup } = await openPageAndPopup(`${server.url}/pages/plain-webm.html`);
  await expect(popup.locator('.item')).toHaveCount(1);
  const badge = await ext.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  expect(badge).toBe('1');
  await popup.close();
  await page.close();
});

test('downloads the MP4 byte-for-byte', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await expect(popup.locator('.item')).toHaveCount(1);

  const [downloadCreated] = await Promise.all([
    ext.worker.evaluate(() => new Promise((resolve) => chrome.downloads.onCreated.addListener((d) => resolve(d)))),
    popup.locator('.item .download').click(),
  ]);
  // Playwright stores downloads under GUID names, so the chosen file name is
  // checked through the popup status rather than on disk.
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: 127\.0\.0\.1-Düz MP4 Test Sayfası-\d{8}-\d{4}\.mp4$/);

  const done = await waitForDownload(downloadCreated.id);
  expect(done.state).toBe('complete');

  const original = await readFile(path.join(EXTENSION_PATH, 'test/fixtures/media/sample.mp4'));
  const downloaded = await readFile(done.filename);
  expect(downloaded.equals(original)).toBe(true);

  await popup.close();
  await page.close();
});

async function existingDownloadIds() {
  return ext.worker.evaluate(async () => (await chrome.downloads.search({})).map((d) => d.id));
}

/** Waits until a download not in `excludeIds` completes. */
async function waitForNewCompletedDownload(excludeIds) {
  return ext.worker.evaluate(async (exclude) => {
    for (let i = 0; i < 150; i++) {
      const all = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
      const done = all.find((d) => !exclude.includes(d.id) && d.state === 'complete');
      if (done) return done;
      await new Promise((r) => setTimeout(r, 100));
    }
    const all = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
    throw new Error('no new completed download; all: ' + JSON.stringify(all.map((d) => [d.id, d.state, d.error, d.url])));
  }, excludeIds);
}

test('downloads from a Referer-protected server', async () => {
  // The page lives on the open server; the media on the server that
  // rejects requests without a Referer, like a hotlink-protected CDN.
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/empty.html`);
  await page.evaluate((src) => {
    const v = document.createElement('video');
    v.src = src;
    v.preload = 'auto';
    document.body.appendChild(v);
    v.load();
  }, `${protectedServer.url}/media/sample.mp4`);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('.item')).toHaveCount(1);

  const before = await existingDownloadIds();
  await popup.locator('.item .download').click();
  // The direct attempt is rejected (403); the extension falls back to an
  // offscreen fetch with the page's Referer and downloads the Blob.
  const done = await waitForNewCompletedDownload(before);
  expect(done.url, JSON.stringify(done)).toMatch(/^blob:chrome-extension:/);
  expect(done.mime).toBe('video/mp4');

  const original = await readFile(path.join(EXTENSION_PATH, 'test/fixtures/media/sample.mp4'));
  expect((await readFile(done.filename)).equals(original)).toBe(true);

  // The temporary header rule and the failed first attempt must be gone.
  await expect.poll(() => ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
  const interrupted = await ext.worker.evaluate(() => chrome.downloads.search({ state: 'interrupted' }));
  expect(interrupted).toEqual([]);

  await popup.close();
  await page.close();
});

test('navigating the tab clears its list; closing the tab drops its store', async () => {
  const { page, tabId, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await expect(popup.locator('.item')).toHaveCount(1);

  await page.goto(`${server.url}/pages/empty.html`);
  await expect(popup.locator('.item')).toHaveCount(0);
  await expect(popup.locator('#empty-state')).toBeVisible();

  await page.close();
  await expect.poll(() => ext.worker.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId)).toEqual({});
  await popup.close();
});

test('"Listeyi temizle" empties the list', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await expect(popup.locator('.item')).toHaveCount(1);
  await popup.locator('#clear').click();
  await expect(popup.locator('.item')).toHaveCount(0);
  await expect(popup.locator('#clear')).toBeHidden();
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
