import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, server, otherOrigin;

test.beforeAll(async () => {
  server = await startServer();
  otherOrigin = await startServer(); // different port = different origin
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
  await otherOrigin?.close();
});

async function openPageAndPopup(url) {
  const page = await ext.context.newPage();
  await page.goto(url);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

test('a video added later with preload=none is found by the DOM scan', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/dynamic.html`);
  await expect(popup.locator('.item')).toHaveCount(0);
  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.kind')).toHaveText('Video');
  await expect(item.locator('.name')).toHaveText('sample.mp4');
  await expect(item.locator('.download')).toBeEnabled();
  await popup.close();
  await page.close();
});

test('a video inside an open shadow root is found', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/shadow.html`);
  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.name')).toHaveText('sample.webm');
  await popup.close();
  await page.close();
});

test('a video inside a cross-origin iframe is listed under the parent tab', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/iframe.html`);
  await page.locator('#player').evaluate((el, src) => (el.src = src), `${otherOrigin.url}/pages/iframe-inner.html`);
  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.name')).toHaveText('sample.mp4');
  const items = await ext.worker.evaluate(
    async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`],
    await ext.tabIdOf(page),
  );
  expect(items[0].url.startsWith(otherOrigin.url)).toBe(true);
  expect(items[0].pageUrl.startsWith(server.url)).toBe(true);
  await popup.close();
  await page.close();
});

test('a blob: (MediaSource) video is shown as a stream without a download button', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/blob.html`);
  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.kind')).toHaveText('Akış');
  await expect(item.locator('.name')).toHaveText('Oynatıcı akışı');
  await expect(item.locator('.note')).toContainText('HLS/DASH');
  await expect(item.locator('.download')).toBeHidden();
  await popup.close();
  await page.close();
});

test('network and DOM reports of the same video merge into one item with size and resolution', async () => {
  const { page, popup } = await openPageAndPopup(`${server.url}/pages/plain-mp4.html`);
  await page.evaluate(() => document.querySelector('video').load());
  const item = popup.locator('.item');
  await expect(item).toHaveCount(1);
  // 320×180 from the DOM scan, size from the network capture.
  await expect(item.locator('.size')).toHaveText(/^320×180 · 0:04 · \d+ KB$/);
  // Still one item after metadata arrived and rescans fired.
  await page.waitForTimeout(1000);
  await expect(item).toHaveCount(1);
  const [stored] = await ext.worker.evaluate(
    async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`],
    await ext.tabIdOf(page),
  );
  expect(stored.source).toBe('both');
  expect(stored.title).toBe('Düz MP4 Test Sayfası');
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
