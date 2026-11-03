// Shared helpers: launch Chromium with the unpacked extension loaded,
// find the extension id and service worker, open the popup for a tab.

import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

export const EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {{headless?:boolean, uiLanguage?:'tr'|'en', backForwardCache?:boolean}} [opts]  uiLanguage: the tests check
 *   Turkish texts by default; the browser's own language differs between machines (en in Playwright's Chromium).
 *   backForwardCache: Playwright turns the back/forward cache off; on for tests of pages restored from it.
 */
export async function launchWithExtension({ headless = true, uiLanguage = 'tr', backForwardCache = false } = {}) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'vdl-profile-'));
  const downloadsPath = await mkdtemp(path.join(os.tmpdir(), 'vdl-downloads-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    // "chromium" channel = new headless mode, which supports extensions.
    channel: 'chromium',
    headless,
    acceptDownloads: true,
    downloadsPath,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    ...(backForwardCache ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {}),
  });

  // The service worker is the reliable place to read the extension id from.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  // The 'serviceworker' event fires before the module graph has finished
  // evaluating; wait until our listeners are attached.
  for (let i = 0; i < 100; i++) {
    const ready = await worker.evaluate(() => globalThis.__vdlReady === true).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  await worker.evaluate((lang) => chrome.storage.sync.set({ uiLanguage: lang }), uiLanguage);
  for (let i = 0; i < 100 && (await worker.evaluate(() => globalThis.__vdl.language())) !== uiLanguage; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const errors = [];
  worker.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  return {
    context,
    worker,
    extensionId,
    downloadsPath,
    errors,
    /** Opens the popup page bound to a given tab id, as the toolbar click would. */
    async openPopup(tabId) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html?tabId=${tabId}`);
      return page;
    },
    /** Returns the chrome tab id for a Playwright page, via the service worker. */
    async tabIdOf(page) {
      const url = page.url();
      return worker.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url === u)?.id ?? null;
      }, url);
    },
    /** Ids of all downloads known to the profile right now. */
    async existingDownloadIds() {
      return worker.evaluate(async () => (await chrome.downloads.search({})).map((d) => d.id));
    },
    /** Waits until a download not in `excludeIds` completes; throws on timeout. */
    async waitForNewCompletedDownload(excludeIds, timeoutMs = 30000) {
      return worker.evaluate(
        async ({ exclude, timeoutMs }) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const all = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
            const done = all.find((d) => !exclude.includes(d.id) && d.state === 'complete');
            if (done) return done;
            await new Promise((r) => setTimeout(r, 100));
          }
          const all = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
          throw new Error('no new completed download; all: ' + JSON.stringify(all.map((d) => [d.id, d.state, d.error, d.url])));
        },
        { exclude: excludeIds, timeoutMs },
      );
    },
    /** Waits until `count` downloads not in `excludeIds` complete; returns them oldest first. */
    async waitForNewCompletedDownloads(excludeIds, count, timeoutMs = 30000) {
      return worker.evaluate(
        async ({ exclude, count, timeoutMs }) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const all = await chrome.downloads.search({ orderBy: ['startTime'], limit: 50 });
            const fresh = all.filter((d) => !exclude.includes(d.id));
            if (fresh.some((d) => d.state === 'interrupted')) throw new Error('a download was interrupted: ' + JSON.stringify(fresh));
            const done = fresh.filter((d) => d.state === 'complete');
            if (done.length >= count) return done;
            await new Promise((r) => setTimeout(r, 100));
          }
          const all = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 });
          throw new Error('downloads did not complete; all: ' + JSON.stringify(all.map((d) => [d.id, d.state, d.error, d.url])));
        },
        { exclude: excludeIds, count, timeoutMs },
      );
    },
    /** Runs a job in the offscreen document (creates it if needed). */
    async offscreen(job, payload = {}) {
      return worker.evaluate(({ job, payload }) => globalThis.__vdl.runOffscreenJob(job, payload), { job, payload });
    },
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
      await rm(downloadsPath, { recursive: true, force: true });
    },
  };
}
