import { test, expect } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { topLevelBoxes } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  // This spec checks the raw track downloads; merging is covered by stage5a-ffmpeg.spec.js.
  await ext.worker.evaluate(() => chrome.storage.sync.set({ mergeTracks: false }));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function openStreamPage(page_, src, attr) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/${page_}?src=${encodeURIComponent(src)}`);
  await expect(page.locator('body')).toHaveAttribute(attr, 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

const concat = async (dir, names) => Buffer.concat(await Promise.all(names.map((f) => readFile(path.join(MEDIA, dir, f)))));

async function runStreamDownload(popup, kind, { pickOption, expectFiles }) {
  const item = popup.locator(`.item[data-kind="${kind}"]`);
  await expect(item).toHaveCount(1);
  await expect(item.locator('.download')).toBeEnabled();
  if (pickOption) await item.locator('.quality').selectOption({ label: pickOption });
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  const done = await ext.waitForNewCompletedDownloads(before, expectFiles);
  expect(done.length).toBe(expectFiles);
  const byRole = {};
  for (const d of done) {
    expect(d.url).toMatch(/^blob:chrome-extension:/);
    byRole[d.mime.startsWith('audio/') ? 'audio' : 'video'] = { entry: d, data: await readFile(d.filename) };
  }
  return byRole;
}

test('DASH SegmentTemplate: quality selector, video + audio downloaded as two exact files', async () => {
  const { page, popup } = await openStreamPage('dash.html', '/media/dash/manifest.mpd', 'data-manifest-loaded');
  const item = popup.locator('.item[data-kind="dash"]');
  await expect(item.locator('.kind')).toHaveText('DASH');
  await expect(item.locator('.quality option')).toHaveText(['360p · 0.8 Mbps · avc1', '180p · 0.3 Mbps · avc1']);
  await expect(item.locator('.note')).toHaveText('Ses ayrı dosya olarak iner');
  await expect(item.locator('.size')).toContainText('0:04');

  const files = await runStreamDownload(popup, 'dash', { pickOption: '180p · 0.3 Mbps · avc1', expectFiles: 2 });
  expect(files.video.entry.mime).toBe('video/mp4');
  expect(files.audio.entry.mime).toBe('audio/mp4');
  expect(
    files.video.data.equals(
      await concat('dash', ['init-1.m4s', 'chunk-1-00001.m4s', 'chunk-1-00002.m4s', 'chunk-1-00003.m4s', 'chunk-1-00004.m4s']),
    ),
  ).toBe(true);
  expect(
    files.audio.data.equals(
      await concat('dash', [
        'init-2.m4s',
        'chunk-2-00001.m4s',
        'chunk-2-00002.m4s',
        'chunk-2-00003.m4s',
        'chunk-2-00004.m4s',
        'chunk-2-00005.m4s',
      ]),
    ),
  ).toBe(true);

  // Job state names the two files with -video / -ses suffixes.
  const [job] = await ext.worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).filter((v) => v?.jobId));
  expect(job.files.map((f) => f.filename.replace(/^.*-\d{8}-\d{4}/, ''))).toEqual(['-video.mp4', '-ses.m4a']);
  await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('video.mp4 + ses.m4a');
  await popup.close();
  await page.close();
});

test('Reddit-style SegmentBase: whole files downloaded unchanged', async () => {
  const { page, popup } = await openStreamPage('dash.html', '/media/dash-base/DASHPlaylist.mpd', 'data-manifest-loaded');
  const item = popup.locator('.item[data-kind="dash"]');
  await expect(item.locator('.quality option')).toHaveText(['360p · 0.8 Mbps · avc1', '180p · 0.3 Mbps · avc1']);
  const files = await runStreamDownload(popup, 'dash', { expectFiles: 2 });
  expect(files.video.data.equals(await readFile(path.join(MEDIA, 'dash-base/DASH_360.mp4')))).toBe(true);
  expect(files.audio.data.equals(await readFile(path.join(MEDIA, 'dash-base/DASH_AUDIO_48.mp4')))).toBe(true);
  expect(topLevelBoxes(files.video.data)[0].type).toBe('ftyp');
  await popup.close();
  await page.close();
});

test('HLS master with a separate audio rendition downloads video and audio files', async () => {
  const { page, popup } = await openStreamPage('hls.html', '/media/hls-audio/master.m3u8', 'data-playlist-loaded');
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.note')).toHaveText('Ses ayrı dosya olarak iner');
  const files = await runStreamDownload(popup, 'hls', { expectFiles: 2 });
  expect(files.video.data.equals(await concat('hls-audio/video', ['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s']))).toBe(true);
  expect(
    files.audio.data.equals(await concat('hls-audio/audio', ['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s', 'seg4.m4s'])),
  ).toBe(true);
  await popup.close();
  await page.close();
});

test('Instagram-style byte-range chunks collapse into whole-file video and audio entries', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/ig.html`);
  await expect(page.locator('body')).toHaveAttribute('data-chunks-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);

  // Without a site entry the raw chunks are all there is: both are recommended.
  const items = popup.locator('#media-list > .item');
  await expect(items).toHaveCount(2);
  await expect(popup.locator('#others')).toBeHidden();
  const stored0 = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
  expect(stored0.every((it) => it.hidden)).toBe(true);
  const video = popup.locator('.item[data-kind="video"]');
  const audio = popup.locator('.item[data-kind="audio"]');
  await expect(video.locator('.name')).toHaveText('sample.mp4');
  await expect(audio.locator('.name')).toHaveText('sample-audio.m4a');
  const mp4Size = (await stat(path.join(MEDIA, 'sample.mp4'))).size;
  const m4aSize = (await stat(path.join(MEDIA, 'sample-audio.m4a'))).size;
  await expect(video.locator('.size')).toContainText(`${Math.round(mp4Size / 1024)} KB`);
  await expect(audio.locator('.size')).toContainText(`${Math.round(m4aSize / 1024)} KB`);

  // Codec badge and QuickTime warning come from the efg encode tag (only on Instagram/Facebook hosts).
  const hinted = await ext.worker.evaluate(() => {
    const efg = btoa(JSON.stringify({ vencode_tag: 'dash_vp9-basic-gen2_q80' }));
    return globalThis.__vdl.cdnTrackHint(`https://scontent.cdninstagram.com/v/a.mp4?efg=${efg}`);
  });
  expect(hinted).toEqual({ track: 'video', tag: 'dash_vp9-basic-gen2_q80' });

  const stored = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
  for (const it of stored) {
    expect(it.url).not.toContain('bytestart');
    expect(it.url).toContain('efg=');
  }

  const before = await ext.existingDownloadIds();
  await video.locator('.download').click();
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  await popup.close();
  await page.close();
});

test('DRM-protected MPD is shown as not downloadable', async () => {
  const { page, popup } = await openStreamPage('dash.html', '/media/dash-drm.mpd', 'data-manifest-loaded');
  const item = popup.locator('.item[data-kind="dash"]');
  await expect(item.locator('.note')).toHaveText('DRM korumalı, indirilemez');
  await expect(item.locator('.download')).toBeHidden();
  await popup.close();
  await page.close();
});

test('nothing left behind: OPFS, blobs, rules', async () => {
  const opfs = await ext.offscreen('opfs-list');
  expect(opfs.files).toEqual([]);
  expect(opfs.blobs).toEqual([]);
  expect(opfs.activeJobs).toEqual([]);
  expect(await ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
