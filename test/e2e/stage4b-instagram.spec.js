import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import instagram from '../../src/sites/instagram/site.js';
import { SITES } from '../../src/sites/index.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  // The Instagram extractor is registered for instagram.com; add the fixture origin.
  const ids = await ext.worker.evaluate(() =>
    globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*', 'http://127.0.0.1/*'], 'instagram'),
  );
  expect(ids).toEqual(['instagram-main', 'instagram-bridge']);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

/** On failure this shows what the extractor saw (CI has no page snapshot for extra pages). */
async function attachDiagnostics(inst, page, tabId) {
  const stats = await page.evaluate(() => window.__vdlInstagramStats ?? null).catch(() => null);
  const stored = await inst.worker
    .evaluate(
      async (id) => ((await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? []).map((it) => [it.key, it.kind, it.site ?? null]),
      tabId,
    )
    .catch(() => null);
  await test.info().attach('extractor-diagnostics', { body: JSON.stringify({ stats, stored }, null, 2), contentType: 'application/json' });
}

test('reels become one complete entry each; raw DASH chunks are hidden behind a toggle', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/ig-json.html/ABC111/`);
  await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  // Extractor (document_start) is in place; now the page "fetches its API".
  expect(await page.evaluate(() => Boolean(window.__vdlInstagramHooked))).toBe(true);
  await page.evaluate(() => window.loadApi());
  await expect(page.locator('body')).toHaveAttribute('data-api-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);

  const site = popup.locator('.item[data-site="instagram"]');
  await expect(site)
    .toHaveCount(3)
    .catch(async (e) => {
      await attachDiagnostics(ext, page, tabId);
      throw e;
    });
  // Extractor ran from document_start and found entries: no advice needed.
  await expect(popup.locator('#site-note')).toBeHidden();
  // Önerilen: only the open reel; the two neighbours sit in Diğer; raw chunks nowhere.
  await expect(popup.locator('#media-list > .item')).toHaveCount(1);
  await expect(popup.locator('#others-count')).toHaveText('2');
  await expect(popup.locator('#others-list > .item[data-reason="neighbour"]')).toHaveCount(2);
  await expect(popup.locator('.item[data-hidden="true"]')).toHaveCount(0);
  await popup.locator('#others summary').click();

  // The reel of the current page comes first with its badge, best version chosen.
  const first = site.first();
  await expect(first.locator('.kind')).toHaveText('Instagram');
  await expect(first.locator('.badge.here')).toBeVisible();
  await expect(first.locator('.name')).toHaveText('@testuser Merhaba dünya');
  const mp4Size = (await stat(path.join(MEDIA, 'sample.mp4'))).size;
  await expect(first.locator('.size')).toHaveText(`320×180 · 0:04 · ${Math.round(mp4Size / 1024)} KB`);
  const second = site.filter({ hasText: '@ikinci' });
  await expect(second).toHaveCount(1);
  await expect(second.locator('.badge.here')).toBeHidden();
  await expect(second.locator('.name')).toHaveText('@ikinci API ile gelen ikinci reel');

  const stored = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
  const reel = stored.find((it) => it.key === 'instagram:111');
  expect(reel.url).toBe(`${server.url}/media/sample.mp4?x=1`);
  expect(reel.versions.length).toBe(2);
  expect(stored.filter((it) => it.hidden).length).toBe(2);

  // Tümü shows the raw chunks too.
  await popup.locator('#view-all').click();
  await expect(popup.locator('#media-list > .item')).toHaveCount(5);
  await expect(popup.locator('.item[data-hidden="true"]')).toHaveCount(2);
  await popup.locator('#view-recommended').click();
  await expect(popup.locator('#media-list > .item')).toHaveCount(1);
  // Diğer keeps its open state across view switches.
  await expect(popup.locator('#others')).toHaveAttribute('open', '');

  // The manifest-only reel became a DASH entry with the inline manifest and a quality list.
  const dash = popup.locator('.item[data-site="instagram"][data-kind="dash"]');
  await expect(dash).toHaveCount(1);
  await expect(dash.locator('.name')).toHaveText('@ucuncu Sadece DASH manifest');
  await expect(dash.locator('.quality option')).toHaveText(['360p · 0.8 Mbps · avc1']);
  await expect(dash.locator('.note')).toHaveText('Ses ayrı dosya olarak iner');
  expect(stored.find((it) => it.key === 'instagram:333:dash').manifestText).toContain('<MPD');

  // Extractor diagnostics reached the service worker.
  const statsKey = `stats:${tabId}`;
  await expect
    .poll(async () => (await ext.worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k], statsKey))?.found)
    .toBeGreaterThanOrEqual(3);
  // The service worker cannot message itself; ask from the popup page.
  const debug = await popup.evaluate(
    (id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'debug:info', payload: { tabId: id } }, resolve)),
    tabId,
  );
  expect(debug.ok).toBe(true);
  // Every site's scripts are registered; Instagram's carry the fixture origin.
  expect(debug.result.siteScripts.map((s) => s.id).sort()).toEqual(SITES.flatMap((s) => [`${s.id}-bridge`, `${s.id}-main`]).sort());
  expect(debug.result.siteScripts.find((s) => s.id === 'instagram-main').matches).toContain('http://127.0.0.1/*');
  expect(debug.result.siteStats.hooked).toBe(true);
  expect(debug.result.mainWorldProbe.hooked).toBe(true);

  // Download the reel: the complete progressive file.
  const before = await ext.existingDownloadIds();
  await first.locator('.download').click();
  await expect(popup.locator('#status')).toHaveText(/^İndirme başladı: 127\.0\.0\.1-@testuser Merhaba dünya-\d{8}-\d{4}\.mp4$/);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);

  // Download the manifest-only reel: video + audio merged by ffmpeg into one file.
  const before2 = await ext.existingDownloadIds();
  await dash.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state').last()).toHaveText('Tamamlandı', { timeout: 60000 });
  const [merged] = await ext.waitForNewCompletedDownloads(before2, 1, 60000);
  expect(merged.mime).toBe('video/mp4');
  const { moovSummary } = await import('./mp4-boxes.js');
  expect(moovSummary(await readFile(merged.filename)).traks).toBe(2);

  await popup.close();
  await page.close();
});

test('extractor is injected on demand when the registered script did not run', async () => {
  // Unregister for the fixture origin; only instagram.com stays. Then open the
  // popup: media:list must inject both scripts into the tab.
  await ext.worker.evaluate(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*'], 'instagram'));
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/ig-json.html/ABC111/`);
  await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  await page.evaluate(() => window.loadApi()); // fetched BEFORE any hook exists
  await expect(page.locator('body')).toHaveAttribute('data-api-loaded', 'true');
  expect(await page.evaluate(() => Boolean(window.__vdlInstagramHooked))).toBe(false);
  const tabId = await ext.tabIdOf(page);
  // Only now does the fixture host count as a "site": the page-load hook did not fire for it.
  await ext.worker.evaluate(() => globalThis.__vdl.addSiteHost('127.0.0.1', 'instagram'));

  const popup = await ext.openPopup(tabId);
  // The popup injected the extractor just now; the two inline JSON blocks are
  // scanned, the API response fetched earlier is gone for good.
  await expect(popup.locator('.item[data-site="instagram"]'))
    .toHaveCount(2)
    .catch(async (e) => {
      await attachDiagnostics(ext, page, tabId);
      throw e;
    });
  await expect(popup.locator('#site-note')).toBeHidden();

  // A supported-site tab with raw chunks only (late injection, nothing found) shows the advice.
  const raw = await ext.context.newPage();
  await raw.goto(`${server.url}/pages/ig.html`);
  await expect(raw.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  const rawPopup = await ext.openPopup(await ext.tabIdOf(raw));
  await expect(rawPopup.locator('#site-note')).toContainText(/yenile/); // either variant advises a reload
  await expect(rawPopup.locator('.item')).toHaveCount(2); // raw chunks stay visible
  await rawPopup.close();
  await raw.close();
  expect(await page.evaluate(() => Boolean(window.__vdlInstagramHooked))).toBe(true);

  const debug = await popup.evaluate(
    (id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'debug:info', payload: { tabId: id } }, resolve)),
    tabId,
  );
  expect(debug.ok).toBe(true);
  expect(debug.result.mainWorldProbe.hooked).toBe(true);
  expect(debug.result.mainWorldProbe.stats.scriptsScanned).toBeGreaterThanOrEqual(2);
  expect(debug.result.mainWorldProbe.stats.sampleKeys).toEqual(expect.arrayContaining(['video_versions', 'video_dash_manifest']));
  await popup.close();
  await page.close();
});

test('a dead bridge after an extension reload is replaced and the extractor replays its findings', async () => {
  // Fresh extension instance so no site host / registration from earlier tests interferes.
  const fresh = await launchWithExtension();
  try {
    await fresh.worker.evaluate(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*'], 'instagram'));
    const page = await fresh.context.newPage();
    await page.goto(`${server.url}/pages/ig-json.html/ABC111/`);
    await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
    const tabId = await fresh.tabIdOf(page);

    // Post-reload state: an OLD extractor instance lives in the page (page
    // globals from a previous extension build, no resync support) and no
    // bridge of this instance exists.
    await fresh.worker.evaluate(
      (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          world: 'MAIN',
          func: () => {
            window.__vdlInstagramHooked = true;
            window.__vdlInstagramVersion = 1;
            window.__vdlInstagramStats = { hooked: true, found: 57 };
          },
        }),
      tabId,
    );
    const before = await fresh.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
    expect(before.some((it) => it.site)).toBe(false);

    // Now the host counts as a site; opening the popup finds no live bridge and
    // an outdated extractor, installs both, and the new extractor rescans the
    // page's inline JSON.
    await fresh.worker.evaluate(() => globalThis.__vdl.addSiteHost('127.0.0.1', 'instagram'));
    const popup = await fresh.openPopup(tabId);
    await expect(popup.locator('.item[data-site="instagram"]'))
      .toHaveCount(2)
      .catch(async (e) => {
        await attachDiagnostics(fresh, page, tabId);
        throw e;
      });
    await expect(popup.locator('#site-note')).toBeHidden();
    // Stats are reported with a short debounce after the findings.
    await expect
      .poll(async () => (await fresh.worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k], `stats:${tabId}`))?.found ?? 0)
      .toBeGreaterThanOrEqual(2);
    const debug = await popup.evaluate(
      (id) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'debug:info', payload: { tabId: id } }, resolve)),
      tabId,
    );
    expect(debug.result.mainWorldProbe.version).toBe(instagram.version);
    expect(debug.result.siteStats.found).toBeGreaterThanOrEqual(2);

    // A second popup open changes nothing: current version + live bridge.
    const again = await popup.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'media:list', payload: { tabId: Number(new URLSearchParams(location.search).get('tabId')) } },
            resolve,
          ),
        ),
    );
    expect(again.result.site).toMatchObject({ applicable: true, hooked: true, injectedNow: false });
    expect(fresh.errors).toEqual([]);
    await popup.close();
    await page.close();
  } finally {
    await fresh.close();
  }
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
