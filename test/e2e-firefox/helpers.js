// Firefox counterpart of test/e2e/helpers.js: builds dist/firefox, starts
// Playwright's Firefox with its remote debugging server, installs the build
// as a temporary add-on and gives the tests its background page and popups
// through the Remote Debugging Protocol (rdp.js). Web pages are Playwright
// pages as usual.
import { firefox } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_PATH } from '../e2e/helpers.js';
import { buildFirefox } from '../../scripts/firefox.js';
import { connectRdp, installAddon } from './rdp.js';

async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * @param {{uiLanguage?:'tr'|'en', idleTimeoutMs?:number}} [opts]
 *   idleTimeoutMs: Firefox suspends an idle background page after this (default 30 s)
 */
export async function launchFirefoxWithExtension({ uiLanguage = 'tr', idleTimeoutMs } = {}) {
  const addonPath = buildFirefox(EXTENSION_PATH);
  const downloadsPath = await mkdtemp(path.join(os.tmpdir(), 'vdl-ff-downloads-'));
  const port = await freePort();
  const browser = await firefox.launch({
    headless: true,
    args: ['--start-debugger-server', String(port)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true,
      'devtools.debugger.prompt-connection': false,
      // Extension downloads go here, without a dialog.
      'browser.download.dir': downloadsPath,
      'browser.download.folderList': 2,
      'browser.download.useDownloadDir': true,
      'browser.download.always_ask_before_handling_new_types': false,
      ...(idleTimeoutMs ? { 'extensions.background.idle.timeout': idleTimeoutMs } : {}),
    },
  });
  const client = await connectRdp(port);
  const addon = await installAddon(client, addonPath);
  let background = await addon.target(/_generated_background_page\.html$/);
  const bg = async (fn, arg) => {
    // A suspended and restarted background page is a new document.
    background = await addon.target(/_generated_background_page\.html$/);
    return addon.evaluate(background, String(fn), arg, 45_000);
  };
  for (let i = 0; i < 100 && !(await bg(() => globalThis.__vdlReady === true).catch(() => false)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await bg((lang) => chrome.storage.sync.set({ uiLanguage: lang }), uiLanguage);
  for (let i = 0; i < 100 && (await bg(() => globalThis.__vdl.language())) !== uiLanguage; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const context = await browser.newContext();

  return {
    browser,
    context,
    downloadsPath,
    /** Errors the add-on's documents logged. */
    errors: addon.errors,
    /** Runs a function in the background page (the counterpart of worker.evaluate). */
    bg,
    /** The browser's tab id of a Playwright page. */
    async tabIdOf(page) {
      return bg(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, page.url());
    },
    /**
     * Opens the popup for a tab in a tab of its own; returns a handle whose
     * `eval(fn, arg)` runs in the popup's document.
     */
    async openPopup(tabId) {
      const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const popupTab = await bg(
        async ({ tabId, marker }) =>
          (await chrome.tabs.create({ url: chrome.runtime.getURL(`src/popup/popup.html?tabId=${tabId}&t=${marker}`) })).id,
        { tabId, marker },
      );
      const form = await addon.target(new RegExp(`popup\\.html\\?tabId=${tabId}&t=${marker}`));
      const popup = {
        eval: (fn, arg) => addon.evaluate(form, String(fn), arg, 20_000),
        /** Waits until fn(arg) returns something truthy in the popup; returns it. */
        async waitFor(fn, arg, timeoutMs = 15_000) {
          const started = Date.now();
          let last;
          for (;;) {
            last = await popup.eval(fn, arg).catch((e) => e);
            if (last && !(last instanceof Error)) return last;
            if (Date.now() - started > timeoutMs) throw new Error(`popup condition not met: ${String(fn)} → ${String(last)}`);
            await new Promise((r) => setTimeout(r, 100));
          }
        },
        close: () => bg((id) => chrome.tabs.remove(id), popupTab),
      };
      await popup.waitFor(() => document.readyState === 'complete');
      return popup;
    },
    async existingDownloadIds() {
      return bg(async () => (await chrome.downloads.search({})).map((d) => d.id));
    },
    /** Waits until `count` downloads not in `excludeIds` complete; returns them oldest first. */
    async waitForNewCompletedDownloads(excludeIds, count = 1, timeoutMs = 30_000) {
      return bg(
        async ({ exclude, count, timeoutMs }) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const all = await chrome.downloads.search({});
            const fresh = all.filter((d) => !exclude.includes(d.id)).sort((a, b) => a.id - b.id);
            if (fresh.some((d) => d.state === 'interrupted')) throw new Error('a download was interrupted: ' + JSON.stringify(fresh));
            const done = fresh.filter((d) => d.state === 'complete');
            if (done.length >= count) return done;
            await new Promise((r) => setTimeout(r, 100));
          }
          const all = await chrome.downloads.search({});
          throw new Error('downloads did not complete; all: ' + JSON.stringify(all.map((d) => [d.id, d.state, d.error, d.url])));
        },
        { exclude: excludeIds, count, timeoutMs },
      );
    },
    /** Runs an offscreen job (in Firefox: in the background page itself). */
    async offscreen(job, payload = {}) {
      return bg(({ job, payload }) => globalThis.__vdl.runOffscreenJob(job, payload), { job, payload });
    },
    async close() {
      client.close();
      await browser.close();
      await rm(downloadsPath, { recursive: true, force: true });
    },
  };
}
