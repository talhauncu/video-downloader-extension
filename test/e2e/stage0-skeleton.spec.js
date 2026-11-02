import { test, expect } from '@playwright/test';
import { launchWithExtension } from './helpers.js';
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

test('extension loads and the service worker answers ping', async () => {
  expect(ext.extensionId).toMatch(/^[a-p]{32}$/);
  // Go through the real chrome.runtime message channel from an extension page.
  const popup = await ext.openPopup(0);
  const response = await popup.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'ping' }, resolve)));
  expect(response.ok).toBe(true);
  expect(response.result.pong).toBe(true);
  await popup.close();
});

test('content script is injected into pages', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/empty.html`);
  await expect(page.locator('html')).toHaveAttribute('data-vdl-scanner', 'ready');
  await page.close();
});

test('popup opens for a tab and shows the empty state', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/empty.html`);
  const tabId = await ext.tabIdOf(page);
  expect(tabId).not.toBeNull();

  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('#empty-state')).toBeVisible();
  await expect(popup.locator('#empty-state')).toHaveText('Bu sekmede video bulunamadı.');
  await expect(popup.locator('#error-state')).toBeHidden();
  await expect(popup.locator('#tab-info')).toHaveText('127.0.0.1');

  await popup.close();
  await page.close();
});

test('no console errors were logged by the service worker', async () => {
  expect(ext.errors).toEqual([]);
});
