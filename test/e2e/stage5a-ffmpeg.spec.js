import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary, topLevelBoxes } from './mp4-boxes.js';

let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function setSettings(patch) {
  return ext.worker.evaluate((p) => chrome.storage.sync.set(p), patch);
}

async function openStreamPage(page_, src, attr) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/${page_}?src=${encodeURIComponent(src)}`);
  await expect(page.locator('body')).toHaveAttribute(attr, 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

async function download(popup, kind, expectFiles, timeout = 60000) {
  const item = popup.locator(`.item[data-kind="${kind}"]`);
  await expect(item).toHaveCount(1);
  await expect(item.locator('.download')).toBeEnabled();
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout });
  const done = await ext.waitForNewCompletedDownloads(before, expectFiles, timeout);
  expect(done.length).toBe(expectFiles);
  return Promise.all(done.map(async (d) => ({ entry: d, data: await readFile(d.filename) })));
}

test('ffmpeg.wasm loads in the offscreen document', async () => {
  const res = await ext.offscreen('ffmpeg-load');
  expect(res).toEqual({ loaded: true });
});

test('DASH video + audio are merged into one MP4 with two tracks', async () => {
  await setSettings({ mergeTracks: true, transcodeToH264: false });
  const { page, popup } = await openStreamPage('dash.html', '/media/dash/manifest.mpd', 'data-manifest-loaded');
  const [file] = await download(popup, 'dash', 1);
  expect(file.entry.mime).toBe('video/mp4');
  const types = topLevelBoxes(file.data).map((b) => b.type);
  expect(types[0]).toBe('ftyp');
  const summary = moovSummary(file.data);
  expect(summary.traks).toBe(2);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a']);
  // Single file: no -video/-ses suffix.
  const [job] = await ext.worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).filter((v) => v?.jobId));
  expect(job.files.length).toBe(1);
  expect(job.files[0].filename).toMatch(/-\d{8}-\d{4}\.mp4$/);
  expect(job.files[0].role).toBe('merged');
  await popup.close();
  await page.close();
});

test('HLS master with separate audio is merged too', async () => {
  const { page, popup } = await openStreamPage('hls.html', '/media/hls-audio/master.m3u8', 'data-playlist-loaded');
  const [file] = await download(popup, 'hls', 1);
  const summary = moovSummary(file.data);
  expect(summary.traks).toBe(2);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a']);
  await popup.close();
  await page.close();
});

test('merging can be turned off: two files again', async () => {
  await setSettings({ mergeTracks: false });
  const { page, popup } = await openStreamPage('dash.html', '/media/dash-base/DASHPlaylist.mpd', 'data-manifest-loaded');
  const files = await download(popup, 'dash', 2);
  expect(files.map((f) => f.entry.mime).sort()).toEqual(['audio/mp4', 'video/mp4']);
  await setSettings({ mergeTracks: true });
  await popup.close();
  await page.close();
});

test('VP9 DASH is transcoded to H.264 when enabled, kept as VP9 otherwise', async () => {
  // Default: VP9 stays VP9 (merge only).
  const first = await openStreamPage('dash.html', '/media/dash-vp9/manifest.mpd', 'data-manifest-loaded');
  const [vp9] = await download(first.popup, 'dash', 1);
  expect(moovSummary(vp9.data).codecs.sort()).toEqual(['mp4a', 'vp09']);
  await first.popup.close();
  await first.page.close();

  await setSettings({ transcodeToH264: true });
  const second = await openStreamPage('dash.html', '/media/dash-vp9/manifest.mpd', 'data-manifest-loaded');
  const [h264] = await download(second.popup, 'dash', 1, 180000);
  const summary = moovSummary(h264.data);
  expect(summary.traks).toBe(2);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a']);
  await expect(second.popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText("H.264'e dönüştürüldü");
  await setSettings({ transcodeToH264: false });
  await second.popup.close();
  await second.page.close();
});

test('transcoding with merging off keeps the separate audio file (regression)', async () => {
  // Before 0.6.0 the transcoded video replaced every track and the audio file was lost.
  await setSettings({ mergeTracks: false, transcodeToH264: true });
  const { page, popup } = await openStreamPage('dash.html', '/media/dash-vp9/manifest.mpd', 'data-manifest-loaded');
  const files = await download(popup, 'dash', 2, 180000);
  const video = files.find((f) => f.entry.mime === 'video/mp4');
  const audio = files.find((f) => f.entry.mime === 'audio/mp4');
  expect(moovSummary(video.data).codecs).toEqual(['avc1']);
  expect(moovSummary(audio.data).codecs).toEqual(['mp4a']);
  await setSettings({ mergeTracks: true, transcodeToH264: false });
  await popup.close();
  await page.close();
});

test('nothing left behind after merges', async () => {
  const opfs = await ext.offscreen('opfs-list');
  expect(opfs.files).toEqual([]);
  expect(opfs.blobs).toEqual([]);
  expect(await ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
