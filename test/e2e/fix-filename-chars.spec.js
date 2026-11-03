// Titles with characters chrome.downloads refuses ("Invalid filename"): a
// zero-width joiner inside an emoji sequence, half of an emoji left by a cut,
// a leading tilde. The download used to fail; the file name now drops them.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';

let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

test('a page title with an emoji sequence, half an emoji and a leading tilde still downloads', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-mp4.html`);
  await page.evaluate(() => (document.title = '~Aile 👨‍👩‍👧 \uD83D gezisi'));
  const tabId = await ext.tabIdOf(page);
  await expect
    .poll(async () => {
      const items = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
      return items.find((it) => it.kind === 'video')?.title ?? null;
    })
    .toContain('gezisi');
  const popup = await ext.openPopup(tabId);
  const item = popup.locator('#media-list > .item[data-kind="video"]');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: 127\.0\.0\.1-Aile 👨👩👧 gezisi-\d{8}-\d{4}\.mp4$/);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(EXTENSION_PATH, 'test/fixtures/media/sample.mp4')))).toBe(true);
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
