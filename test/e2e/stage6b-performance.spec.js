// Stage 6b: the multi-threaded ffmpeg core (cross-origin isolated offscreen
// document) and plain files the extension downloads itself, in byte ranges,
// when ffmpeg has work on them: converting to H.264, embedding the page's
// subtitles.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
const CHUNK = 16 * 1024; // sample.webm (74 415 bytes) in 5 pieces
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate((chunk) => {
    globalThis.__vdlFallbackDelays = [20, 20];
    globalThis.__vdlFileChunkBytes = chunk;
  }, CHUNK);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const settings = (patch) => ext.worker.evaluate((p) => chrome.storage.sync.set(p), patch);
const ffmpegCore = (mode) => ext.worker.evaluate((m) => (globalThis.__vdlFfmpegCore = m ?? undefined), mode);
/** The extension's range requests for a file from now on (closed ranges; the page's player asks "bytes=0-"). */
function rangesSince(file) {
  const base = server.rangeRequests().length;
  return () =>
    server
      .rangeRequests()
      .slice(base)
      .filter((r) => r.startsWith(`${file} `))
      .map((r) => r.slice(file.length + 1))
      .filter((r) => /^bytes=\d+-\d+$/.test(r));
}
/** The newest job of a tab, as the service worker keeps it. */
const jobOf = (tabId) =>
  ext.worker.evaluate(async (id) => {
    const jobs = Object.values(await chrome.storage.session.get(null)).filter((v) => v?.jobId && v.tabId === id);
    return jobs.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }, tabId);

async function openPage(name) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/${name}`);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

/** Downloads the page's only video from the popup; returns the saved file and the job. */
async function download({ popup, tabId }, files = 1) {
  const item = popup.locator('.item[data-kind="video"]');
  await expect(item).toHaveCount(1);
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 60000 });
  const done = await ext.waitForNewCompletedDownloads(before, files, 60000);
  return { done, data: await readFile(done[0].filename), job: await jobOf(tabId) };
}

const expectedRanges = (size) => Array.from({ length: Math.ceil(size / CHUNK) }, (_, i) => i * CHUNK);
const startsOf = (ranges) => ranges.filter((r) => r !== 'bytes=0-0').map((r) => Number(/^bytes=(\d+)-/.exec(r)[1]));

test('the offscreen document is cross-origin isolated', async () => {
  expect((await ext.offscreen('ping')).isolated).toBe(true);
});

test('plain WebM, "convert to H.264" on: one MP4 from the multi-threaded core, fetched in byte ranges', async () => {
  await settings({ transcodeToH264: true, embedSubtitles: false });
  const ranges = rangesSince('/media/sample.webm');
  const p = await openPage('plain-webm.html');
  const { data, job, done } = await download(p);
  expect(moovSummary(data).codecs.sort()).toEqual(['avc1', 'mp4a']);
  expect(done[0].mime).toBe('video/mp4');
  expect(job.files).toHaveLength(1);
  expect(job.files[0]).toMatchObject({ role: 'merged', ext: 'mp4', transcoded: true, ffmpeg: { core: 'mt', fellBack: false } });
  expect(job.files[0].ffmpeg.threads).toBeGreaterThanOrEqual(1);
  expect(job.files[0].ffmpeg.threads).toBeLessThanOrEqual(4);
  expect(job.files[0].filename).toMatch(/^127\.0\.0\.1-WebM Test Sayfası-.*\.mp4$/);
  // The size first (one byte), then each piece once.
  const size = (await readFile(path.join(MEDIA, 'sample.webm'))).length;
  expect(ranges()[0]).toBe('bytes=0-0');
  expect(startsOf(ranges())).toEqual(expectedRanges(size));
  expect(job.total).toBe(expectedRanges(size).length);
  await p.popup.close();
  await p.page.close();
});

test('when the multi-threaded core fails, the single-threaded one converts the file', async () => {
  await settings({ transcodeToH264: true, embedSubtitles: false });
  await ffmpegCore('mt-fail');
  const p = await openPage('plain-webm.html?again');
  const { data, job } = await download(p);
  expect(moovSummary(data).codecs.sort()).toEqual(['avc1', 'mp4a']);
  expect(job.files[0]).toMatchObject({ transcoded: true, ffmpeg: { core: 'single', threads: null, fellBack: true } });
  await ffmpegCore(null);
  await p.popup.close();
  await p.page.close();
});

test('an H.264 MP4 with conversion on is downloaded by the extension and saved unchanged', async () => {
  await settings({ transcodeToH264: true, embedSubtitles: false });
  const p = await openPage('plain-mp4.html');
  const { data, job, done } = await download(p);
  expect(data.equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);
  expect(done[0].mime).toBe('video/mp4');
  expect(job.files).toEqual([expect.objectContaining({ role: 'video', ext: 'mp4', transcoded: false })]);
  await p.popup.close();
  await p.page.close();
});

test('a plain MP4 with page subtitles, "embed subtitles" on: one MP4 with a text track', async () => {
  await settings({ transcodeToH264: false, embedSubtitles: true, subtitleLangs: ['tr'] });
  const p = await openPage('subs-track.html');
  await expect(p.popup.locator('.item[data-kind="video"] .sub-chip input:checked')).toHaveCount(1);
  const { data, job } = await download(p);
  const summary = moovSummary(data);
  expect(summary.codecs.sort()).toEqual(['avc1', 'mp4a', 'tx3g']);
  expect(summary.languages).toContain('tur');
  // Embedded: no separate subtitle file.
  expect(job.files).toEqual([expect.objectContaining({ role: 'merged', ext: 'mp4', embeddedSubtitles: ['tr'], transcoded: false })]);
  await p.popup.close();
  await p.page.close();
});

test('a failed plain-file job keeps its pieces; downloading again continues it', async () => {
  test.setTimeout(90000);
  await settings({ transcodeToH264: true, embedSubtitles: false });
  server.setRangeFail('^/media/sample\\.webm$', 2 * CHUNK);
  const ranges = rangesSince('/media/sample.webm');
  const p = await openPage('plain-webm.html?resume');
  const item = p.popup.locator('.item[data-kind="video"]');
  const job = p.popup.locator('.job:not([data-other-tab])');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(job.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  await expect(job.locator('.job-detail')).toContainText('Yeniden indirince kaldığı yerden sürer');
  const jobId = await job.getAttribute('data-job-id');
  expect((await ext.offscreen('opfs-list')).stalledJobs).toEqual([jobId]);

  server.setRangeFail(null);
  await item.locator('.download').click();
  await expect(job).toHaveCount(1);
  await expect(job.locator('.job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  expect(await job.getAttribute('data-job-id')).toBe(jobId);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect(moovSummary(await readFile(done.filename)).codecs.sort()).toEqual(['avc1', 'mp4a']);
  // The first two pieces were fetched once.
  const starts = startsOf(ranges());
  expect(starts.filter((s) => s === 0)).toHaveLength(1);
  expect(starts.filter((s) => s === CHUNK)).toHaveLength(1);
  await p.popup.close();
  await p.page.close();
});

test('with conversion and embedding off, plain files still go straight to Chrome', async () => {
  await settings({ transcodeToH264: false, embedSubtitles: false });
  const ranges = rangesSince('/media/sample.webm');
  const p = await openPage('plain-webm.html?direct');
  const item = p.popup.locator('.item[data-kind="video"]');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.webm')))).toBe(true);
  expect(await jobOf(p.tabId)).toBeNull();
  expect(ranges()).toEqual([]);
  await p.popup.close();
  await p.page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
