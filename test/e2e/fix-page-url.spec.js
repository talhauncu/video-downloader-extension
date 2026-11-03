// The tab's page can change without a new page request in the tab: a page
// restored from the back/forward cache, a search result the browser had
// prerendered. The list then kept the previous page's address, and file
// names started with the previous site (e.g. "google.com-…" for an X post).
import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension({ backForwardCache: true });
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

// *.localhost reaches this machine: two site names for one fixture server.
const at = (host, route) => server.url.replace('127.0.0.1', host) + route;

test('back to a page restored from the back/forward cache: the file is named after that page, not the one left', async () => {
  const page = await ext.context.newPage();
  await page.goto(at('video.localhost', '/pages/plain-mp4.html?cacheable'));
  await page.evaluate(() => window.addEventListener('pageshow', (e) => (window.__restored = e.persisted)));
  await page.goto(at('other.localhost', '/pages/empty.html'));
  await page.goBack({ waitUntil: 'commit' }); // a restored page fires no load event
  expect(page.url()).toContain('video.localhost');
  // Restored from the cache, not reloaded: the browser made no new page request.
  await expect.poll(() => page.evaluate(() => window.__restored ?? null)).toBe(true);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  const item = popup.locator('#media-list > .item[data-kind="video"]');
  await expect(item).toHaveCount(1, { timeout: 15000 });
  await item.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: video\.localhost-Düz MP4 Test Sayfası-\d{8}-\d{4}\.mp4$/);
  const stored = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
  expect(stored.find((it) => it.kind === 'video').pageUrl).toContain('video.localhost');
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
