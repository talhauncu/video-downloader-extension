// Stage 6a: the download queue (at most N stream jobs at once, the rest
// "Sırada"), notifications when a job ends, a folder inside Downloads, and
// "download again" continuing a failed job from the pieces it kept.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => {
    globalThis.__vdlFallbackDelays = [20, 20];
    globalThis.__vdlNotifications = [];
  });
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const settings = (patch) => ext.worker.evaluate((p) => chrome.storage.sync.set(p), patch);
const notifications = () => ext.worker.evaluate(() => globalThis.__vdlNotifications.splice(0));
const count = (re) => server.requests().filter((p) => re.test(p)).length;
/** Requests per pattern from now on. */
function since(patterns) {
  const base = Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, count(re)]));
  return () => Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, count(re) - base[k]]));
}
const concat = async (dir, names) => Buffer.concat(await Promise.all(names.map((f) => readFile(path.join(MEDIA, dir, f)))));

async function openStream(pageName, src, attr) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/${pageName}?src=${encodeURIComponent(src)}`);
  await expect(page.locator('body')).toHaveAttribute(attr, 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}
const openHls = (src) => openStream('hls.html', src, 'data-playlist-loaded');

test('one job at a time: the second waits "Sırada", can be cancelled, and starts when the first ends', async () => {
  test.setTimeout(90000);
  // One piece at a time: the first job takes long enough for the others to queue behind it.
  await settings({ maxJobs: 1, concurrency: 1 });
  // Most stream jobs downloading at the same time, seen from the service worker.
  await ext.worker.evaluate(() => {
    globalThis.__maxRunning = 0;
    chrome.storage.session.onChanged.addListener(async () => {
      const all = Object.values(await chrome.storage.session.get(null));
      const running = all.filter((v) => v?.jobId && v.status === 'downloading' && v.kind !== 'subtitle').length;
      globalThis.__maxRunning = Math.max(globalThis.__maxRunning, running);
    });
  });
  const cPieces = since({ segs: /^\/media\/hls-fmp4\/360p\/seg/ });
  const a = await openHls('/media/hls-long/playlist.m3u8');
  const b = await openHls('/media/hls-long/playlist.m3u8?b'); // another address: tabs are found by it
  const c = await openHls('/media/hls-fmp4/master.m3u8');
  const before = await ext.existingDownloadIds();

  await a.popup.locator('.item[data-kind="hls"] .download').click();
  const jobA = a.popup.locator('.job:not([data-other-tab])');
  await expect(jobA.locator('.job-state')).toHaveText('İndiriliyor');

  await b.popup.locator('.item[data-kind="hls"] .download').click();
  const jobB = b.popup.locator('.job:not([data-other-tab])');
  await expect(jobB.locator('.job-state')).toHaveText('Sırada');
  await expect(jobB.locator('.job-detail')).toHaveText('Süren bir indirme bitince başlar');
  await expect(b.popup.locator('.item[data-kind="hls"] .download')).toHaveText('Sırada…');
  // Other tabs' jobs show the queued one too.
  await expect(a.popup.locator('.job[data-other-tab] .job-state')).toHaveText('Sırada');

  // A third one queues behind it; cancelled while waiting, it never starts.
  await c.popup.locator('.item[data-kind="hls"] .download').click();
  const jobC = c.popup.locator('.job:not([data-other-tab])');
  await expect(jobC.locator('.job-state')).toHaveText('Sırada');
  await jobC.locator('.cancel').click();
  await expect(jobC.locator('.job-state')).toHaveText('İptal edildi');

  await expect(jobA.locator('.job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  await expect(jobB.locator('.job-state')).toHaveText(/İndiriliyor|Kaydediliyor|Tamamlandı/);
  await expect(jobB.locator('.job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  const done = await ext.waitForNewCompletedDownloads(before, 2);
  expect(done.length).toBe(2);
  expect(await ext.worker.evaluate(() => globalThis.__maxRunning)).toBe(1);
  expect(cPieces()).toEqual({ segs: 0 }); // the cancelled job fetched nothing
  for (const p of [a, b, c]) {
    await p.popup.close();
    await p.page.close();
  }
  await settings({ maxJobs: 2, concurrency: 4 });
});

test('a finished job notifies (with its file name), unless notifications are off', async () => {
  notifications();
  const { page, popup } = await openHls('/media/hls-fmp4/master.m3u8');
  const before = await ext.existingDownloadIds();
  await popup.locator('.item[data-kind="hls"] .download').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  await ext.waitForNewCompletedDownloads(before, 1);
  const name = await popup.locator('.job:not([data-other-tab]) .job-name').textContent();
  await expect.poll(async () => await ext.worker.evaluate(() => globalThis.__vdlNotifications.length)).toBe(1);
  const [n] = await notifications();
  expect([n.title, n.message, n.contextMessage, n.type]).toEqual(['İndirme tamamlandı', name, 'Klasörde göstermek için tıklayın', 'basic']);
  expect(n.id).toMatch(/^vdl-job:/);
  expect(n.iconUrl).toMatch(/^chrome-extension:\/\/.+\/src\/icons\/notification\.png$/);

  await settings({ notify: false });
  const before2 = await ext.existingDownloadIds();
  await popup.locator('.item[data-kind="hls"] .download').click();
  await ext.waitForNewCompletedDownloads(before2, 1);
  await page.waitForTimeout(300);
  expect(await notifications()).toEqual([]);
  await settings({ notify: true });
  await popup.close();
  await page.close();
});

test('the folder setting puts plain files and stream jobs into Downloads/<folder>/<site>', async () => {
  await settings({ subfolder: 'VideoDownloader/{site}' });
  // The browser under test saves downloads under its own names: check the names asked for.
  await ext.worker.evaluate(() => {
    globalThis.__asked = [];
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (options) => {
      globalThis.__asked.push(options.filename);
      return download(options);
    };
  });
  const asked = () => ext.worker.evaluate(() => globalThis.__asked.splice(0));
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-mp4.html`);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  const before = await ext.existingDownloadIds();
  await popup.locator('.item[data-kind="video"] .download').first().click();
  await ext.waitForNewCompletedDownloads(before, 1);
  expect(await asked()).toEqual([expect.stringMatching(/^VideoDownloader\/127\.0\.0\.1\/127\.0\.0\.1-[^/]+\.mp4$/)]);
  await popup.close();
  await page.close();

  const hls = await openHls('/media/hls-fmp4/master.m3u8');
  const before2 = await ext.existingDownloadIds();
  await hls.popup.locator('.item[data-kind="hls"] .download').click();
  await ext.waitForNewCompletedDownloads(before2, 1);
  expect(await asked()).toEqual([expect.stringMatching(/^VideoDownloader\/127\.0\.0\.1\/127\.0\.0\.1-HLS[^/]+\.mp4$/)]);
  // The popup and history name the file, not the folder.
  await expect(hls.popup.locator('.job:not([data-other-tab]) .job-name')).not.toContainText('/');
  await settings({ subfolder: '' });
  await hls.popup.close();
  await hls.page.close();
});

test('HLS fMP4: a failed job keeps its pieces; downloading again continues it, byte-exact', async () => {
  notifications();
  server.setAlways404('/media/hls-fmp4/360p/seg2\\.m4s$');
  const pieces = since({ init: /\/360p\/init\.mp4$/, seg0: /\/360p\/seg0\.m4s$/, seg1: /\/360p\/seg1\.m4s$/ });
  const { page, popup } = await openHls('/media/hls-fmp4/master.m3u8');
  const item = popup.locator('.item[data-kind="hls"]');
  const job = popup.locator('.job:not([data-other-tab])');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(job.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  await expect(job.locator('.job-detail')).toContainText('Yeniden indirince kaldığı yerden sürer');
  const jobId = await job.getAttribute('data-job-id');
  // The written pieces wait in OPFS for the retry.
  const kept = await ext.offscreen('opfs-list');
  expect(kept.stalledJobs).toEqual([jobId]);
  expect(kept.files).toEqual([`${jobId}-video.out`]);
  const [failed] = await notifications();
  expect([failed.title, failed.contextMessage]).toEqual(['İndirme başarısız', 'Yeniden indirince kaldığı yerden sürer']);
  expect(pieces()).toEqual({ init: 1, seg0: 1, seg1: 1 });

  server.setAlways404(null);
  await item.locator('.download').click();
  // The same job continues (one entry), after the two pieces it had.
  await expect(job).toHaveCount(1);
  await expect(job.locator('.job-state')).toHaveText('Tamamlandı', { timeout: 30000 });
  expect(await job.getAttribute('data-job-id')).toBe(jobId);
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  const expected = await concat('hls-fmp4/360p', ['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s']);
  expect((await readFile(done.filename)).equals(expected)).toBe(true);
  expect(pieces()).toEqual({ init: 1, seg0: 1, seg1: 1 });
  const after = await ext.offscreen('opfs-list');
  expect(after.stalledJobs).toEqual([]);
  await popup.close();
  await page.close();
});

test('DASH: the finished video track is kept, the audio track continues after its written pieces; then merged', async () => {
  test.setTimeout(60000);
  server.setAlways404('/media/dash/chunk-2-00003\\.m4s$');
  const pieces = since({ video: /\/dash\/(init|chunk)-0/, audioInit: /\/dash\/init-2\.m4s$/, audio1: /\/dash\/chunk-2-00001\.m4s$/ });
  const { page, popup } = await openStream('dash.html', '/media/dash/manifest.mpd', 'data-manifest-loaded');
  const item = popup.locator('.item[data-kind="dash"]');
  const job = popup.locator('.job:not([data-other-tab])');
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await expect(job.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  await expect(job.locator('.job-detail')).toContainText('Yeniden indirince kaldığı yerden sürer');
  expect(pieces()).toEqual({ video: 5, audioInit: 1, audio1: 1 });

  server.setAlways404(null);
  await item.locator('.download').click();
  await expect(job.locator('.job-state')).toHaveText('Tamamlandı', { timeout: 45000 });
  const [merged] = await ext.waitForNewCompletedDownloads(before, 1, 45000);
  expect(moovSummary(await readFile(merged.filename)).traks).toBe(2);
  // Nothing of the video, nor the audio's first pieces, was fetched again.
  expect(pieces()).toEqual({ video: 5, audioInit: 1, audio1: 1 });
  await popup.close();
  await page.close();
});

test('TS starts over: nothing is kept for a failed TS track, and "Listeyi temizle" drops what a job kept', async () => {
  server.setAlways404('/media/hls-ts/seg2\\.ts$');
  const ts = await openHls('/media/hls-ts/playlist.m3u8');
  const job = ts.popup.locator('.job:not([data-other-tab])');
  await ts.popup.locator('.item[data-kind="hls"] .download').click();
  await expect(job.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  await expect(job.locator('.job-detail')).not.toContainText('kaldığı yerden');
  expect((await ext.offscreen('opfs-list')).files).toEqual([]);

  // A kept job is released with the list.
  server.setAlways404('/media/hls-fmp4/360p/seg3\\.m4s$');
  const fmp4 = await openHls('/media/hls-fmp4/master.m3u8');
  const job2 = fmp4.popup.locator('.job:not([data-other-tab])');
  await fmp4.popup.locator('.item[data-kind="hls"] .download').click();
  await expect(job2.locator('.job-state')).toHaveText('Hata', { timeout: 30000 });
  expect((await ext.offscreen('opfs-list')).stalledJobs).toHaveLength(1);
  await fmp4.popup.locator('#clear').click();
  await expect.poll(async () => (await ext.offscreen('opfs-list')).stalledJobs).toEqual([]);
  const opfs = await ext.offscreen('opfs-list');
  expect(opfs.files).toEqual([]);
  expect(opfs.blobs).toEqual([]);
  expect(await ext.worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).toEqual([]);
  server.setAlways404(null);
  for (const p of [ts, fmp4]) {
    await p.popup.close();
    await p.page.close();
  }
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
