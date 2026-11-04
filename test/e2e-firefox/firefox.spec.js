// Stage 6c: the Firefox build (dist/firefox) in Firefox. The background is an
// event page that runs the offscreen work itself; the main flows of the
// Chrome specs are checked here: capture, the popup, plain files (also from
// a Referer-protected server), HLS (fMP4 and TS through mux.js), DASH merged
// by ffmpeg, the in-page button, a site extractor, conversion to H.264 and
// the events that keep the background page awake during a job.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION_PATH } from '../e2e/helpers.js';
import { moovSummary } from '../e2e/mp4-boxes.js';
import { startServer } from '../fixtures/server.js';
import { launchFirefoxWithExtension } from './helpers.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchFirefoxWithExtension();
  await ext.bg(() => chrome.storage.local.set({ badgeHintShown: true }));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const settings = (patch) => ext.bg((p) => chrome.storage.sync.set(p), patch);

async function openPage(url) {
  const page = await ext.context.newPage();
  await page.goto(url);
  const tabId = await ext.tabIdOf(page);
  return { page, tabId };
}

/** Clicks the download button of the popup's only item of `kind`, waits for "Tamamlandı" when it is a job. */
async function downloadFromPopup(popup, kind) {
  await popup.waitFor((k) => document.querySelector(`.item[data-kind="${k}"] .download:not([disabled])`), kind);
  await popup.eval((k) => document.querySelector(`.item[data-kind="${k}"] .download`).click(), kind);
}

test('the background is an event page running the offscreen work itself', async () => {
  const info = await ext.bg(() => ({
    href: location.href,
    offscreen: typeof chrome.offscreen,
    mux: typeof globalThis.muxjs?.Transmuxer,
  }));
  expect(info).toEqual({
    href: expect.stringMatching(/^moz-extension:\/\/.+\/_generated_background_page\.html$/),
    offscreen: 'undefined',
    mux: 'function',
  });
  expect(await ext.offscreen('ping')).toEqual({ pong: true, mux: true, isolated: false });
  expect(await ext.offscreen('ffmpeg-load')).toEqual({ loaded: true });
});

test('a plain MP4: listed in the popup, downloaded byte-exact', async () => {
  const { page, tabId } = await openPage(`${server.url}/pages/plain-mp4.html`);
  const popup = await ext.openPopup(tabId);
  await popup.waitFor(() => document.querySelectorAll('.item[data-kind="video"]').length === 1);
  const before = await ext.existingDownloadIds();
  await downloadFromPopup(popup, 'video');
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  expect(path.basename(done.filename)).toMatch(/^127\.0\.0\.1-Düz MP4 Test Sayfası-.*\.mp4$/);
  await popup.close();
  await page.close();
});

test('a Referer-protected server: the direct download carries the page as Referer', async () => {
  const guarded = await startServer({ requireReferer: true });
  try {
    const { page, tabId } = await openPage(`${guarded.url}/pages/plain-mp4.html`);
    const popup = await ext.openPopup(tabId);
    const before = await ext.existingDownloadIds();
    await downloadFromPopup(popup, 'video');
    const [done] = await ext.waitForNewCompletedDownloads(before, 1);
    expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
    // Firefox applies the header rule to chrome.downloads itself: no fallback through the background page.
    expect(done.url).toMatch(/^http:/);
    await popup.close();
    await page.close();
  } finally {
    await guarded.close();
  }
});

/** Opens a stream page (hls.html / dash.html) and its popup, downloads its stream, returns the saved file. */
async function downloadStream(pageName, src, kind, attr) {
  const { page, tabId } = await openPage(`${server.url}/pages/${pageName}?src=${encodeURIComponent(src)}`);
  await expect(page.locator('body')).toHaveAttribute(attr, 'true');
  const popup = await ext.openPopup(tabId);
  const before = await ext.existingDownloadIds();
  await downloadFromPopup(popup, kind);
  await popup.waitFor(() => document.querySelector('.job:not([data-other-tab]) .job-state')?.textContent === 'Tamamlandı', null, 60_000);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  await popup.close();
  await page.close();
  return { done, data: await readFile(done.filename) };
}

test('HLS fMP4 and TS (remuxed by mux.js) become MP4s', async () => {
  const fmp4 = await downloadStream('hls.html', '/media/hls-fmp4/master.m3u8', 'hls', 'data-playlist-loaded');
  expect(fmp4.done.mime).toBe('video/mp4');
  expect(moovSummary(fmp4.data).traks).toBeGreaterThan(0);
  const ts = await downloadStream('hls.html', '/media/hls-ts/playlist.m3u8', 'hls', 'data-playlist-loaded');
  expect(moovSummary(ts.data).codecs.sort()).toEqual(['avc1', 'mp4a']);
});

test('DASH video + audio are merged by ffmpeg into one MP4', async () => {
  await settings({ mergeTracks: true, transcodeToH264: false });
  const { data } = await downloadStream('dash.html', '/media/dash/manifest.mpd', 'dash', 'data-manifest-loaded');
  const summary = moovSummary(data);
  expect(summary.traks).toBe(2);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a']);
});

test('the in-page button downloads the video it sits on', async () => {
  const { page } = await openPage(`${server.url}/pages/plain-mp4.html`);
  const video = page.locator('video');
  const box = await video.boundingBox();
  const badge = page.locator('[data-vdl-badge] .btn');
  const before = await ext.existingDownloadIds();
  // The button's listeners start once its texts arrive: move until it shows.
  await expect(async () => {
    await page.mouse.move(box.x + box.width / 2 + Math.random() * 10, box.y + box.height / 2);
    await expect(badge).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await badge.click();
  await expect(badge).toHaveAttribute('data-state', 'done');
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await page.close();
});

test('a site extractor runs in the page (MAIN world) and lists its reels', async () => {
  await ext.bg(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*', 'http://127.0.0.1/*'], 'instagram'));
  const { page, tabId } = await openPage(`${server.url}/pages/ig-json.html/ABC111/`);
  await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  expect(await page.evaluate(() => Boolean(window.__vdlInstagramHooked))).toBe(true);
  await page.evaluate(() => window.loadApi());
  await expect(page.locator('body')).toHaveAttribute('data-api-loaded', 'true');
  const popup = await ext.openPopup(tabId);
  await popup.waitFor(() => document.querySelectorAll('.item[data-site="instagram"]').length === 3);
  expect(await popup.eval(() => document.querySelector('#media-list > .item .name')?.textContent)).toBe('@testuser Merhaba dünya');
  await ext.bg(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*'], 'instagram'));
  await popup.close();
  await page.close();
});

test('"Convert to H.264": a plain WebM becomes an MP4 on the single-threaded core', async () => {
  await settings({ transcodeToH264: true, embedSubtitles: false });
  const { page, tabId } = await openPage(`${server.url}/pages/plain-webm.html`);
  const popup = await ext.openPopup(tabId);
  const before = await ext.existingDownloadIds();
  await downloadFromPopup(popup, 'video');
  await popup.waitFor(() => document.querySelector('.job:not([data-other-tab]) .job-state')?.textContent === 'Tamamlandı', null, 60_000);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect(moovSummary(await readFile(done.filename)).codecs.sort()).toEqual(['avc1', 'mp4a']);
  const job = await ext.bg(
    async (id) => Object.values(await chrome.storage.session.get(null)).find((v) => v?.jobId && v.tabId === id),
    tabId,
  );
  expect(job.files[0].ffmpeg).toMatchObject({ core: 'single', fellBack: false });
  await settings({ transcodeToH264: false });
  await popup.close();
  await page.close();
});

test('a running job keeps the background page awake with storage events; they stop when it ends', async () => {
  test.setTimeout(90_000);
  // Firefox would suspend the page after 30 s without an extension event. (With the
  // debugger attached it never does, so the tests check the events themselves.)
  await settings({ concurrency: 1 });
  const { page, tabId } = await openPage(`${server.url}/pages/hls.html?src=${encodeURIComponent('/media/hls-long/playlist.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const popup = await ext.openPopup(tabId);
  const before = await ext.existingDownloadIds();
  await ext.bg(() => {
    globalThis.__awakeWrites = 0;
    chrome.storage.session.onChanged.addListener((changes) => {
      if (changes.awake?.newValue) globalThis.__awakeWrites++;
    });
  });
  await downloadFromPopup(popup, 'hls');
  await expect.poll(() => ext.bg(() => globalThis.__awakeWrites), { timeout: 20_000 }).toBeGreaterThan(0);
  await ext.waitForNewCompletedDownloads(before, 1, 60_000);
  await expect.poll(() => ext.bg(async () => (await chrome.storage.session.get('awake')).awake ?? null)).toBeNull();
  await settings({ concurrency: 4 });
  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
