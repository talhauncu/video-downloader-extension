// A job with several tracks (subtitle, video, separate audio) reports one
// fixed total from the start: its share never goes back and 100% is shown
// only at the end. It used to grow the total track by track (100% → 50% → …).
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

test('a subtitle + video + audio job: the total is fixed and the progress never goes back', async () => {
  await ext.worker.evaluate(() =>
    chrome.storage.sync.set({ subtitleLangs: ['tr'], embedSubtitles: false, mergeTracks: true, concurrency: 1 }),
  );
  // Every stored state of every job, in order (storage patches are serialized per job).
  await ext.worker.evaluate(() => {
    globalThis.__progressLog = [];
    chrome.storage.session.onChanged.addListener((changes) => {
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key.startsWith('job:') && newValue) {
          const { status, phase, done, total } = newValue;
          globalThis.__progressLog.push({ status, phase: phase ?? null, done: done ?? 0, total: total ?? 0 });
        }
      }
    });
  });

  const page = await ext.context.newPage();
  // Subtitle 4 pieces, video 4, audio 5.
  await page.goto(`${server.url}/pages/hls.html?src=${encodeURIComponent('/media/hls-subs/master-audio.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const popup = await ext.openPopup(await ext.tabIdOf(page));
  const item = popup.locator('#media-list > .item[data-kind="hls"]');
  await expect(item.locator('.sub-chip input:checked')).toHaveCount(1, { timeout: 20000 });
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  await ext.waitForNewCompletedDownloads(before, 2, 60000); // merged MP4 + .srt

  const log = await ext.worker.evaluate(() => globalThis.__progressLog);
  const counting = log.filter((s) => s.status === 'downloading' && s.phase !== 'merging' && s.total > 0);
  expect(counting.length).toBeGreaterThan(2);
  // One total for the whole job: video and audio pieces (subtitle pieces do not count next to media).
  expect([...new Set(counting.map((s) => s.total))]).toEqual([9]);
  for (let i = 1; i < counting.length; i++) expect(counting[i].done).toBeGreaterThanOrEqual(counting[i - 1].done);
  // 100% only once every piece is in.
  expect(counting.findIndex((s) => s.done === s.total)).toBe(counting.length - 1);

  await popup.close();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
