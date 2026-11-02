// Stage 3 (second plan): subtitles from HLS renditions, DASH text tracks,
// page <track>s and standalone files; .srt/.vtt output; embedding (mov_text).
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchWithExtension } from './helpers.js';
import { startServer, ROT_TOKEN } from '../fixtures/server.js';
import { moovSummary, topLevelBoxes } from './mp4-boxes.js';
import { EXPECTED } from '../fixtures/subtitles.js';

let ext, server;

test.beforeAll(async () => {
  server = await startServer();
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

test.beforeEach(async () => {
  // Defaults: Turkish preselected, .srt, separate files.
  await ext.worker.evaluate(() =>
    chrome.storage.sync.set({ subtitleLangs: ['tr'], subtitleFormat: 'srt', embedSubtitles: false, mergeTracks: true }),
  );
});

async function openWithPopup(url, attr) {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}${url}`);
  if (attr) await expect(page.locator('body')).toHaveAttribute(attr, /.+/);
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  return { page, tabId, popup };
}

/**
 * Intended file names of downloads (Playwright stores them under GUIDs):
 * from the stream job that saved them, else "direct:<url>" for plain files.
 */
async function namesOf(downloads) {
  const lookup = async () => {
    const jobs = await ext.worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).filter((v) => v?.jobId));
    return downloads.map((d) => {
      for (const job of jobs) {
        const i = (job.downloadIds ?? []).indexOf(d.id);
        if (i !== -1) return job.files[i].filename;
      }
      return d.url.startsWith('blob:') ? null : `direct:${d.url}`;
    });
  };
  // A small subtitle file can finish before the job has recorded its download id.
  let names = [];
  await expect
    .poll(
      async () => {
        names = await lookup();
        return names.every(Boolean);
      },
      { timeout: 5000 },
    )
    .toBe(true);
  return names;
}

/** Clicks "İndir" on `item`, waits for `count` new downloads, returns them by file name. */
async function downloadFrom(popup, item, count, timeout = 60000) {
  await expect(item.locator('.download')).toBeEnabled();
  const before = await ext.existingDownloadIds();
  await item.locator('.download').click();
  const done = await ext.waitForNewCompletedDownloads(before, count, timeout);
  const names = await namesOf(done);
  const files = await Promise.all(done.map(async (d, i) => ({ name: names[i], mime: d.mime, data: await readFile(d.filename) })));
  return {
    files,
    one: (re) => {
      const matches = files.filter((f) => re.test(f.name));
      expect(
        matches.map((f) => f.name),
        `exactly one file matching ${re}`,
      ).toHaveLength(1);
      return matches[0];
    },
    before,
  };
}

async function newDownloadsSince(before) {
  return namesOf(await ext.worker.evaluate(async (ids) => (await chrome.downloads.search({})).filter((d) => !ids.includes(d.id)), before));
}

const chip = (scope, lang) => scope.locator(`.sub-chip[data-lang="${lang}"] input`);

test('HLS: subtitle renditions are offered, Turkish preselected; chosen ones arrive as .srt next to the video', async () => {
  const { page, popup } = await openWithPopup(
    `/pages/hls.html?src=${encodeURIComponent('/media/hls-subs/master.m3u8')}`,
    'data-playlist-loaded',
  );
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(item.locator('.sub-chip')).toHaveCount(2);
  await expect(item.locator('.sub-chip').first()).toContainText('Türkçe');
  await expect(chip(item, 'tr')).toBeChecked();
  await expect(chip(item, 'en')).not.toBeChecked();
  await chip(item, 'en').check();

  const got = await downloadFrom(popup, item, 3);
  const video = got.one(/\.mp4$/);
  expect(topLevelBoxes(video.data)[0].type).toBe('ftyp');
  // One media file: no "-video" suffix even though the job has three files.
  expect(video.name).not.toMatch(/-video\.mp4$/);
  const tr = got.one(/-tr\.srt$/);
  const en = got.one(/-en\.srt$/);
  expect(tr.data.toString('utf8')).toBe(EXPECTED.trSrt);
  expect(en.data.toString('utf8')).toBe(EXPECTED.enSrt);
  expect(tr.name.replace(/-tr\.srt$/, '')).toBe(video.name.replace(/\.mp4$/, ''));

  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı');
  await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('tr.srt + en.srt');
  await popup.close();
  await page.close();
});

test('subtitle format setting: WebVTT output; no chip ticked means no subtitle file', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ subtitleFormat: 'vtt' }));
  const { page, popup } = await openWithPopup(
    `/pages/hls.html?src=${encodeURIComponent('/media/hls-subs/master.m3u8')}`,
    'data-playlist-loaded',
  );
  const item = popup.locator('.item[data-kind="hls"]');
  await expect(chip(item, 'tr')).toBeChecked();
  const got = await downloadFrom(popup, item, 2);
  expect(got.one(/-tr\.vtt$/).data.toString('utf8')).toBe(EXPECTED.trVtt);

  // Same stream again with every chip unticked: the video only.
  await chip(item, 'tr').uncheck();
  const again = await downloadFrom(popup, item, 1);
  expect(again.files[0].name).toMatch(/\.mp4$/);
  await expect(popup.locator('.job:not([data-other-tab]) .job-state').last()).toHaveText('Tamamlandı');
  expect((await newDownloadsSince(again.before)).filter((n) => /\.(srt|vtt)$/.test(n))).toEqual([]);
  await popup.close();
  await page.close();
});

test('DASH: WebVTT and TTML text tracks become .srt; ISO-BMFF text is reported as unsupported', async () => {
  const { page, popup } = await openWithPopup(
    `/pages/dash.html?src=${encodeURIComponent('/media/dash-subs/manifest.mpd')}`,
    'data-manifest-loaded',
  );
  const item = popup.locator('.item[data-kind="dash"]');
  await expect(item.locator('.sub-chip')).toHaveCount(2);
  await expect(item.locator('.sub-chip[data-lang="en"]')).toContainText('English');
  await expect(item.locator('.note')).toContainText('1 altyazı MP4 içinde');
  await chip(item, 'en').check();

  const got = await downloadFrom(popup, item, 3, 90000);
  const video = got.one(/\.mp4$/);
  expect(moovSummary(video.data).codecs.sort()).toEqual(['avc1', 'mp4a']); // video + audio merged as before
  expect(got.one(/-tr\.srt$/).data.toString('utf8')).toBe(EXPECTED.trSrt);
  expect(got.one(/-en\.srt$/).data.toString('utf8')).toBe(EXPECTED.ttmlSrt);
  await popup.close();
  await page.close();
});

test('page <track>s attach to their video; the chosen one downloads beside the plain MP4', async () => {
  const { page, tabId, popup } = await openWithPopup('/pages/subs-track.html');
  await expect
    .poll(
      async () =>
        (await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId)).filter(
          (it) => it.kind === 'subtitle',
        ).length,
    )
    .toBe(2); // chapters are not subtitles
  await popup.reload();
  const item = popup.locator('.item.main');
  await expect(item).toHaveAttribute('data-kind', 'video');
  await expect(item.locator('.sub-chip')).toHaveCount(2);
  await expect(chip(item, 'tr')).toBeChecked();
  await expect(chip(item, 'en')).not.toBeChecked();
  await expect(popup.locator('#others')).toBeHidden(); // subtitle files are not listed on their own
  await chip(item, 'en').check();

  const got = await downloadFrom(popup, item, 3);
  got.one(/^direct:.*sample\.mp4$/); // chrome.downloads fetched the video itself
  expect(got.one(/-tr\.srt$/).data.toString('utf8')).toBe(EXPECTED.trSrt);
  expect(got.one(/-en\.srt$/).data.toString('utf8')).toBe(EXPECTED.enSrt); // SubRip in, SubRip out (CRLF normalised)
  // Same name as the video: the status line shows the video's file name.
  const stem = got.one(/-tr\.srt$/).name.replace(/-tr\.srt$/, '');
  await expect(popup.locator('#status')).toHaveText(`İndirme başladı: ${stem}.mp4 (+2 altyazı)`);
  await popup.close();
  await page.close();
});

test('a subtitle file without a video is listed under "Diğer" and downloads on its own', async () => {
  const { page, popup } = await openWithPopup('/pages/subs-lone.html', 'data-loaded');
  await expect(popup.locator('#others')).toBeVisible();
  await popup.locator('#others summary').click();
  const item = popup.locator('#others-list .item[data-kind="subtitle"]');
  await expect(item).toHaveAttribute('data-reason', 'subtitle');
  await expect(item.locator('.name')).toContainText('English');
  await expect(item.locator('.sub-chip')).toHaveCount(0);
  const got = await downloadFrom(popup, item, 1);
  expect(got.one(/-en\.srt$/).data.toString('utf8')).toBe(EXPECTED.loneSrt);
  await popup.close();
  await page.close();
});

test('embedding: chosen subtitles become mov_text tracks inside the MP4, no separate files', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ embedSubtitles: true }));
  const { page, popup } = await openWithPopup(
    `/pages/hls.html?src=${encodeURIComponent('/media/hls-subs/master.m3u8')}`,
    'data-playlist-loaded',
  );
  const item = popup.locator('.item[data-kind="hls"]');
  await chip(item, 'en').check();
  const got = await downloadFrom(popup, item, 1, 90000);
  const summary = moovSummary(got.files[0].data);
  expect(summary.codecs.filter((c) => c === 'tx3g')).toHaveLength(2);
  expect(summary.codecs).toContain('avc1');
  expect(summary.codecs).toContain('mp4a');
  // Tracks in order video, audio, tr, en; the cues end before the video does,
  // but the movie keeps its full length (no -shortest).
  expect(summary.languages.slice(-2)).toEqual(['tur', 'eng']);
  expect(summary.duration).toBeGreaterThan(3.8);
  await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('Altyazı gömüldü: tr, en');
  expect((await newDownloadsSince(got.before)).filter((n) => /\.(srt|vtt)$/.test(n))).toEqual([]);
  await popup.close();
  await page.close();
});

test('a player loading subtitle playlists and segments: they fold under the master; the badge takes Turkish along', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/player-mse.html?duration=4&deep=1&src=${encodeURIComponent('/media/hls-subs/master.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-segments-loaded', '8');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  await expect(popup.locator('#media-list .item')).toHaveCount(1);
  await expect(popup.locator('#media-list .item.main')).toHaveAttribute('data-kind', 'hls');
  await expect(popup.locator('#others')).toBeHidden();
  await expect.poll(() => ext.worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('1');
  await popup.close();

  const box = await page.locator('video').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = page.locator('[data-vdl-badge] .btn');
  await expect(badge).toBeVisible();
  const before = await ext.existingDownloadIds();
  await badge.click();
  const done = await ext.waitForNewCompletedDownloads(before, 2, 60000);
  const names = await namesOf(done);
  expect(names.filter((n) => /-tr\.srt$/.test(n))).toHaveLength(1);
  expect(names.filter((n) => /\.mp4$/.test(n))).toHaveLength(1);
  expect(names.filter((n) => /-en\.srt$/.test(n))).toHaveLength(0);
  expect(await readFile(done[names.findIndex((n) => /-tr\.srt$/.test(n))].filename, 'utf8')).toBe(EXPECTED.trSrt);
  await page.close();
});

test('rotating playlist directories: one entry with its audio; nameless subtitle files get their language from their words', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/rot-player.html?t=${ROT_TOKEN}`);
  await expect(page.locator('body')).toHaveAttribute('data-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const popup = await ext.openPopup(tabId);
  // The video and audio playlists the player asked for under other directories fold under the master.
  await expect(popup.locator('#media-list .item')).toHaveCount(1);
  const item = popup.locator('#media-list .item.main');
  await expect(item).toHaveAttribute('data-kind', 'hls');
  // 1.vtt / 2.vtt / 3.vtt: Turkish dialogue, English dialogue, a dub's Turkish signs.
  await expect(item.locator('.sub-chip[data-lang="tr"]')).toHaveCount(2, { timeout: 15000 });
  await expect(item.locator('.sub-chip[data-lang="en"]')).toHaveCount(1);
  const forced = item.locator('.sub-chip[data-lang="tr"]', { hasText: 'zorunlu' });
  await expect(forced).toHaveCount(1);
  await expect(forced.locator('input')).not.toBeChecked();
  await expect(item.locator('.sub-chip[data-lang="tr"]:not(:has-text("zorunlu")) input')).toBeChecked();

  const got = await downloadFrom(popup, item, 2, 90000);
  const video = got.one(/\.mp4$/);
  expect(moovSummary(video.data).codecs.sort()).toEqual(['avc1', 'mp4a']);
  expect(got.one(/-tr\.srt$/).data.toString('utf8')).toBe(EXPECTED.rotTrSrt);
  await popup.close();

  // The badge picks the same entry (the master, matched by the folded playlists' duration).
  const box = await page.locator('video').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = page.locator('[data-vdl-badge] .btn');
  await expect(badge).toBeVisible();
  const before = await ext.existingDownloadIds();
  await badge.click();
  const done = await ext.waitForNewCompletedDownloads(before, 2, 90000);
  const names = await namesOf(done);
  const mp4 = done[names.findIndex((n) => /\.mp4$/.test(n))];
  expect(moovSummary(await readFile(mp4.filename)).codecs.sort()).toEqual(['avc1', 'mp4a']);
  expect(names.filter((n) => /-tr\.srt$/.test(n))).toHaveLength(1);
  await page.close();
});

test("audio language: the popup menu offers dub and original, the setting picks the badge's", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/rot-player.html?t=${ROT_TOKEN}`);
  await expect(page.locator('body')).toHaveAttribute('data-loaded', 'true');
  const tabId = await ext.tabIdOf(page);
  const audioFetched = (lang) => server.rotRequests().filter((p) => p.endsWith(`l0${lang}`)).length;

  // Popup: the site's default (Turkish dub) is preselected; choose English.
  let popup = await ext.openPopup(tabId);
  let item = popup.locator('#media-list .item.main');
  const audio = item.locator('select.audio');
  await expect(audio).toBeVisible();
  await expect(audio.locator('option')).toHaveText(['Türkçe', 'English']);
  await expect(audio.locator('option:checked')).toHaveText('Türkçe');
  // The Turkish subtitle file comes along once it has been read (2 files).
  await expect(item.locator('.sub-chip[data-lang="tr"]:not(:has-text("zorunlu")) input')).toBeChecked({ timeout: 15000 });
  await audio.selectOption({ label: 'English' });
  const enBefore = audioFetched('ena2');
  await downloadFrom(popup, item, 2, 90000);
  expect(audioFetched('ena2')).toBeGreaterThan(enBefore);
  await expect(popup.locator('.job:not([data-other-tab]) .job-detail').first()).toContainText('ses: English');
  await popup.close();

  // Setting "original": the badge says so and fetches the English rendition.
  await ext.worker.evaluate(() => chrome.storage.sync.set({ audioLang: 'original' }));
  popup = await ext.openPopup(tabId);
  await expect(popup.locator('#media-list .item.main select.audio option:checked')).toHaveText('English');
  await popup.close();
  const box = await page.locator('video').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = page.locator('[data-vdl-badge] .btn');
  await expect(badge).toBeVisible();
  const trBefore = audioFetched('tra1');
  const enBadge = audioFetched('ena2');
  const before = await ext.existingDownloadIds();
  await badge.click();
  await ext.waitForNewCompletedDownloads(before, 2, 90000);
  expect(audioFetched('ena2')).toBeGreaterThan(enBadge);
  expect(audioFetched('tra1')).toBe(trBefore);
  await ext.worker.evaluate(() => chrome.storage.sync.set({ audioLang: 'default' }));
  await page.close();
});

test("popup menus are not redrawn by another download's progress (they stayed open only for a moment)", async () => {
  const { page, tabId, popup } = await openWithPopup(
    `/pages/hls.html?src=${encodeURIComponent('/media/hls-long/playlist.m3u8')}`,
    'data-playlist-loaded',
  );
  // A second stream with a quality menu on the same tab.
  await page.evaluate(() => fetch('/media/hls-fmp4/master.m3u8').then((r) => r.text()));
  const quality = popup.locator('.item select.quality:visible');
  await expect(quality).toHaveCount(1);
  const longItem = popup.locator('.item', { hasText: 'playlist.m3u8' });
  await expect(longItem.locator('.download')).toBeEnabled();
  await longItem.locator('.download').click();
  const done = () =>
    ext.worker.evaluate(
      async (id) => Object.values(await chrome.storage.session.get(null)).find((v) => v?.jobId && v.tabId === id)?.done ?? 0,
      tabId,
    );
  await expect.poll(done).toBeGreaterThan(0);

  // Not focused: progress alone leaves the list alone.
  const handle = await quality.elementHandle();
  const at = await done();
  await expect.poll(done).toBeGreaterThan(at + 3);
  expect(await handle.evaluate((el) => el.isConnected)).toBe(true);
  // Focused (an open menu): not even a list change redraws it until it loses focus.
  await quality.focus();
  const before = await popup.locator('.item[data-kind="hls"]').count();
  await page.evaluate(() => fetch('/media/hls-aes/playlist.m3u8').then((r) => r.text()));
  await expect
    .poll(() => ext.worker.evaluate(async (id) => ((await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? []).length, tabId))
    .toBe(before + 1);
  await expect(popup.locator('.item[data-kind="hls"]')).toHaveCount(before);
  expect(await handle.evaluate((el) => el.isConnected)).toBe(true);
  await quality.evaluate((el) => el.blur());
  await expect(popup.locator('.item[data-kind="hls"]')).toHaveCount(before + 1);

  await popup.locator('.job:not([data-other-tab]) .cancel').click();
  await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('İptal edildi');
  await popup.close();
  await page.close();
});

test('a download started before the master is described goes to the master: audio and the whole subtitle come along', async () => {
  // The master answers late; its video playlist (whose length matches the
  // player) and the first WebVTT segments are known first. Clicking then
  // used to download the silent video playlist with one subtitle segment.
  await ext.worker.evaluate(() => chrome.storage.sync.set({ embedSubtitles: true }));
  const page = await ext.context.newPage();
  const master = '/media/hls-subs/master-audio.m3u8?delay=4000';
  await page.goto(`${server.url}/pages/player-mse.html?duration=4&deep=1&src=${encodeURIComponent(master)}`);
  await expect(page.locator('body')).toHaveAttribute('data-segments-loaded', '4');
  const tabId = await ext.tabIdOf(page);
  const stored = () => ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
  // Precondition: the video playlist is described, the master is not yet.
  await expect.poll(async () => (await stored()).some((it) => it.url.includes('hls-audio/video') && it.stream)).toBe(true);
  expect((await stored()).find((it) => it.url.includes('master-audio'))?.stream ?? null).toBe(null);

  const box = await page.locator('video').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const badge = page.locator('[data-vdl-badge] .btn');
  await expect(badge).toBeVisible();
  const before = await ext.existingDownloadIds();
  await badge.click();
  const done = await ext.waitForNewCompletedDownloads(before, 1, 90000);
  // The badge follows the master's job to the end.
  await expect(badge).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  const summary = moovSummary(await readFile(done[0].filename));
  expect(summary.codecs.filter((c) => c !== 'tx3g').sort()).toEqual(['avc1', 'mp4a']);
  // The Turkish rendition, embedded whole (three cues), not one segment file.
  expect(summary.languages).toContain('tur');
  expect((await newDownloadsSince(before)).filter((n) => /\.(srt|vtt)$/.test(n))).toEqual([]);
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
