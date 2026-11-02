import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchWithExtension, EXTENSION_PATH } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { moovSummary } from './mp4-boxes.js';

const MEDIA = path.join(EXTENSION_PATH, 'test/fixtures/media');
let ext, server, playerServer;

test.beforeAll(async () => {
  server = await startServer();
  playerServer = await startServer({ txtAlias: true });
  ext = await launchWithExtension();
  // The one-time "keeps going in the background" hint is tested on its own.
  await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
  await playerServer?.close();
});

async function hoverCenter(page, selector, frame = null) {
  const target = frame ? frame.locator(selector) : page.locator(selector);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  // Frame locators report boxes in page coordinates already.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

const badgeIn = (scope) => scope.locator('[data-vdl-badge] .btn');

async function waitItems(tabId, predicate, timeout = 20000) {
  await expect
    .poll(
      async () => {
        const items = await ext.worker.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`] ?? [], tabId);
        return predicate(items);
      },
      { timeout },
    )
    .toBe(true);
}

test('hovering a plain video shows the badge; clicking downloads it byte-exact', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-mp4.html`);
  await page.evaluate(() => document.querySelector('video').load());
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'video' && it.width));

  const badge = badgeIn(page);
  await expect(badge).toBeHidden();
  await hoverCenter(page, 'video');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('İndir');
  // Top-left corner of the video.
  const v = await page.locator('video').boundingBox();
  const b = await badge.boundingBox();
  expect(b.x - v.x).toBeGreaterThanOrEqual(0);
  expect(b.x - v.x).toBeLessThan(20);
  expect(b.y - v.y).toBeLessThan(20);

  const before = await ext.existingDownloadIds();
  await badge.click();
  await expect(badge).toHaveAttribute('data-state', 'done');
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, 'sample.mp4')))).toBe(true);

  // Moving away hides it again (after the result has been shown).
  await page.mouse.move(5, 5);
  await expect(badge).toBeHidden({ timeout: 15000 });
  await page.close();
});

test('a two-quality HLS player opens a menu; the chosen variant is downloaded', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/player-mse.html?duration=4&src=${encodeURIComponent('/media/hls-fmp4/master.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlists-loaded', '2');
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.stream?.type === 'master'));

  await hoverCenter(page, 'video');
  const badge = badgeIn(page);
  await expect(badge).toBeVisible();
  await badge.click();
  const menu = page.locator('[data-vdl-badge] .menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('button')).toHaveText(['360p · 0.8 Mbps', '180p · 0.3 Mbps']);
  const before = await ext.existingDownloadIds();
  await menu.locator('button', { hasText: '180p' }).click();
  await expect(badge).toHaveAttribute('data-state', 'done', { timeout: 30000 });
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  const dir = path.join(MEDIA, 'hls-fmp4/180p');
  const expected = Buffer.concat(
    await Promise.all(['init.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s', 'seg3.m4s'].map((f) => readFile(path.join(dir, f)))),
  );
  expect((await readFile(done.filename)).equals(expected)).toBe(true);
  await page.close();
});

test('inside a cross-origin player iframe the badge works; banner ads get none', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/film-ads.html`);
  await page
    .locator('#player')
    .evaluate(
      (el, src) => (el.src = src),
      `${playerServer.url}/pages/player-mse.html?duration=4&src=${encodeURIComponent('/media/hls-audio/master.txt')}`,
    );
  const frame = page.frameLocator('#player');
  await expect(frame.locator('body')).toHaveAttribute('data-playlists-loaded', '2');
  const tabId = await ext.tabIdOf(page);
  await waitItems(
    tabId,
    (items) => items.filter((it) => it.kind === 'video' && it.width).length === 6 && items.some((it) => it.stream?.type === 'master'),
  );

  // Banner 300×250 (large enough for a badge, but an ad).
  await hoverCenter(page, 'video[src$="banner6.mp4"]');
  await page.waitForTimeout(800);
  await expect(badgeIn(page)).toHaveCount(0);

  // The film player inside the iframe.
  await hoverCenter(page, '#player');
  const badge = badgeIn(frame);
  await expect(badge).toBeVisible();
  const before = await ext.existingDownloadIds();
  await badge.click(); // one variant → no menu
  await expect(badge).toHaveAttribute('data-state', 'done', { timeout: 60000 });
  const [done] = await ext.waitForNewCompletedDownloads(before, 1, 60000);
  expect(moovSummary(await readFile(done.filename)).traks).toBe(2); // video + audio merged
  await page.close();
});

test('in a fullscreen player the badge moves into the fullscreen element and stays usable', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/player-fs.html`);
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'video'));
  await page.locator('#fs').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('wrap');
  await hoverCenter(page, '#wrap');
  const badge = badgeIn(page);
  await expect(badge).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#wrap > [data-vdl-badge]') !== null)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.documentElement.querySelector(':scope > [data-vdl-badge]') !== null)).toBe(true);
  await page.close();
});

test('an unmatched player stream shows the badge with a pointer to the list', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/blob.html`);
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'blob'));
  await page.locator('video').evaluate((v) => {
    v.style.width = '640px';
    v.style.height = '360px';
  });
  await hoverCenter(page, 'video');
  const badge = badgeIn(page);
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.locator('[data-vdl-badge] .msg')).toContainText('listeden seçin');
  await page.close();
});

test("Instagram-like feed: each post's badge downloads that post, not the longest reel", async () => {
  await ext.worker.evaluate(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*', 'http://127.0.0.1/*']));
  try {
    const page = await ext.context.newPage();
    await page.goto(`${server.url}/pages/ig-feed.html`);
    await expect(page.locator('body')).toHaveAttribute('data-feed-ready', 'true');
    const tabId = await ext.tabIdOf(page);
    await waitItems(tabId, (items) => items.filter((it) => it.site === 'instagram').length === 3);

    const cases = [
      ['FEEDPOST03', 'dash-base/DASH_180.mp4'],
      ['FEEDPOST02', 'sample.webm'],
      ['SPONSOR001', 'dash-base/DASH_360.mp4'],
    ];
    for (const [code, file] of cases) {
      await hoverCenter(page, `video[data-code="${code}"]`);
      const badge = page.locator('[data-vdl-badge][data-visible] .btn');
      await expect(badge).toBeVisible();
      const before = await ext.existingDownloadIds();
      await badge.click();
      const [done] = await ext.waitForNewCompletedDownloads(before, 1);
      expect((await readFile(done.filename)).equals(await readFile(path.join(MEDIA, file))), `${code} → ${file}`).toBe(true);
      await page.mouse.move(2, 2);
      await expect(page.locator('[data-vdl-badge][data-visible]')).toHaveCount(0, { timeout: 15000 });
    }
    await page.close();
  } finally {
    await ext.worker.evaluate(() => globalThis.__vdl.registerSiteScripts(['*://*.instagram.com/*']));
  }
});

test('"always" shows the badge without hovering; "off" never shows it; disabled sites too', async () => {
  const open = async () => {
    const page = await ext.context.newPage();
    await page.goto(`${server.url}/pages/plain-mp4.html`);
    await page.evaluate(() => document.querySelector('video').load());
    const tabId = await ext.tabIdOf(page);
    await waitItems(tabId, (items) => items.some((it) => it.kind === 'video' && it.width));
    return page;
  };
  try {
    await ext.worker.evaluate(() => chrome.storage.sync.set({ badgeMode: 'always' }));
    let page = await open();
    await page.mouse.move(5, 5);
    await expect(badgeIn(page)).toBeVisible({ timeout: 10000 });
    await page.close();

    await ext.worker.evaluate(() => chrome.storage.sync.set({ badgeMode: 'off' }));
    page = await open();
    await hoverCenter(page, 'video');
    await page.waitForTimeout(800);
    await expect(badgeIn(page)).toHaveCount(0);
    await page.close();

    await ext.worker.evaluate(() => chrome.storage.sync.set({ badgeMode: 'hover', badgeDisabledHosts: ['127.0.0.1'] }));
    page = await open();
    await hoverCenter(page, 'video');
    await page.waitForTimeout(800);
    await expect(badgeIn(page)).toHaveCount(0);
    await page.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove(['badgeMode', 'badgeDisabledHosts']));
  }
});

test('options page saves the badge mode and the disabled-site list', async () => {
  const options = await ext.context.newPage();
  await options.goto(`chrome-extension://${ext.extensionId}/src/options/options.html`);
  await expect(options.locator('#badgeMode')).toHaveValue('hover');
  await options.locator('#badgeMode').selectOption('always');
  await options.locator('#badgeDisabledHosts').fill('https://www.Example.com/x\nnews.test');
  await expect
    .poll(() => ext.worker.evaluate(() => chrome.storage.sync.get(['badgeMode', 'badgeDisabledHosts'])))
    .toEqual({ badgeMode: 'always', badgeDisabledHosts: ['example.com', 'news.test'] });
  await ext.worker.evaluate(() => chrome.storage.sync.remove(['badgeMode', 'badgeDisabledHosts']));
  await options.close();
});

async function latestStreamJob() {
  return ext.worker.evaluate(
    async () =>
      Object.values(await chrome.storage.session.get(null))
        .filter((v) => v?.jobId)
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null,
  );
}

async function openSlowStream(page) {
  await page.goto(`${server.url}/pages/player-mse.html?duration=200&src=${encodeURIComponent('/media/hls-long/playlist.m3u8')}`);
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'hls' && it.stream?.type === 'media'));
  return tabId;
}

test('while a stream downloads: hover shows details and "× İptal"; two clicks cancel it', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ concurrency: 1 })); // 200 × 40 ms ≈ 8 s
  try {
    const page = await ext.context.newPage();
    await openSlowStream(page);
    await hoverCenter(page, 'video');
    const badge = badgeIn(page);
    await expect(badge).toBeVisible();
    const before = await ext.existingDownloadIds();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'working');

    // Details panel: file name, pieces and a remaining-time estimate.
    await badge.hover();
    const info = page.locator('[data-vdl-badge] .info');
    await expect(info).toBeVisible();
    await expect(info.locator('.detail')).toContainText('/200 parça');
    await expect(info.locator('.detail')).toContainText('kalan ~', { timeout: 10000 });
    await expect(badge).toHaveText('× İptal');

    // First click asks, and the question times out back to the progress…
    await badge.click();
    await expect(badge).toHaveText('İptal edilsin mi?');
    await expect(badge).toHaveAttribute('data-state', 'confirm');
    await page.mouse.move(5, 5);
    await expect(badge).toHaveAttribute('data-state', 'working', { timeout: 6000 });

    // …Esc also backs out…
    await badge.hover();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'confirm');
    await page.keyboard.press('Escape');
    await expect(badge).toHaveAttribute('data-state', 'working');

    // …and the second click cancels.
    await badge.click();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'info', { timeout: 10000 });
    await expect(badge).toHaveText('İptal edildi');
    expect((await latestStreamJob()).status).toBe('cancelled');
    expect(await ext.existingDownloadIds()).toEqual(before);
    await page.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove('concurrency'));
  }
});

test('after a page reload the badge picks up the running download and can cancel it', async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ concurrency: 1 }));
  try {
    const page = await ext.context.newPage();
    await openSlowStream(page);
    await hoverCenter(page, 'video');
    await badgeIn(page).click();
    await expect(badgeIn(page)).toHaveAttribute('data-state', 'working');

    await page.reload();
    await waitItems(await ext.tabIdOf(page), (items) => items.some((it) => it.kind === 'blob'));
    // The job keeps running in the background; hovering the new player shows it.
    await hoverCenter(page, 'video');
    const badge = badgeIn(page);
    await expect(badge).toHaveAttribute('data-state', 'working', { timeout: 10000 });
    await expect(badge).toHaveText(/^(× İptal|%\d+)$/);
    await badge.click();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'info', { timeout: 10000 });
    expect((await latestStreamJob()).status).toBe('cancelled');
    await page.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove('concurrency'));
  }
});

test('after a reload served by another mirror host the badge still finds the download', async () => {
  // Same paths on two hosts, like a host's rotating mirrors: the
  // first load plays from A, the reloaded page from B.
  const mirrorA = await startServer();
  const mirrorB = await startServer();
  await ext.worker.evaluate(() => chrome.storage.sync.set({ concurrency: 1 }));
  try {
    const page = await ext.context.newPage();
    const playerUrl = (host) =>
      `${server.url}/pages/player-mse.html?duration=200&src=${encodeURIComponent(`${host.url}/media/hls-long/playlist.m3u8`)}`;
    await page.goto(playerUrl(mirrorA));
    const tabId = await ext.tabIdOf(page);
    await waitItems(tabId, (items) => items.some((it) => it.kind === 'hls' && it.url.startsWith(mirrorA.url) && it.stream));
    await hoverCenter(page, 'video');
    await badgeIn(page).click();
    await expect(badgeIn(page)).toHaveAttribute('data-state', 'working');

    await page.goto(playerUrl(mirrorB));
    await waitItems(tabId, (items) => items.some((it) => it.kind === 'hls' && it.url.startsWith(mirrorB.url)));
    await hoverCenter(page, 'video');
    const badge = badgeIn(page);
    await expect(badge).toHaveAttribute('data-state', 'working', { timeout: 10000 });
    await badge.click();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'info', { timeout: 10000 });
    await page.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove('concurrency'));
    await mirrorA.close();
    await mirrorB.close();
  }
});

test("while downloading, every tab shows the green progress indicator and other tabs' popups list the job", async () => {
  await ext.worker.evaluate(() => chrome.storage.sync.set({ concurrency: 1 }));
  await ext.worker.evaluate(() => chrome.storage.local.remove('badgeHintShown'));
  try {
    const page = await ext.context.newPage();
    await openSlowStream(page);
    const tabId = await ext.tabIdOf(page);
    await hoverCenter(page, 'video');
    const badge = badgeIn(page);
    await badge.click();
    // First badge download: the in-page hint explains it keeps going without the page.
    await expect(page.locator('[data-vdl-badge] .msg')).toContainText('arka planda sürer');

    const other = await ext.context.newPage();
    await other.goto(`${server.url}/pages/empty.html`);
    const otherTab = await ext.tabIdOf(other);
    for (const id of [tabId, otherTab]) {
      await expect
        .poll(() => ext.worker.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), id), { timeout: 10000 })
        .toMatch(/^%\d+$/);
    }
    expect(await ext.worker.evaluate((t) => chrome.action.getBadgeBackgroundColor({ tabId: t }), otherTab)).toEqual([26, 127, 55, 255]);
    expect(await ext.worker.evaluate(() => chrome.action.getTitle({}))).toContain('1 indirme sürüyor');

    // The other tab's popup shows the job and still says this tab has no video.
    const { jobId } = await latestStreamJob();
    const popup = await ext.openPopup(otherTab);
    const job = popup.locator(`.job[data-job-id="${jobId}"]`);
    await expect(job).toHaveAttribute('data-other-tab', 'true');
    await expect(job).toBeVisible();
    await expect(job.locator('.job-tab')).toHaveText('Başka sekme · 127.0.0.1');
    await expect(popup.locator('#empty-state')).toBeVisible();
    await popup.close();

    // Closing the page does not stop the download; cancel it from the other tab's popup.
    await page.close();
    const popup2 = await ext.openPopup(otherTab);
    const job2 = popup2.locator(`.job[data-job-id="${jobId}"]`);
    await expect(job2.locator('.job-state')).toHaveText('İndiriliyor');
    await job2.locator('.cancel').click();
    await expect(job2.locator('.job-state')).toHaveText('İptal edildi', { timeout: 10000 });
    // Indicator gone, no check mark after a cancel.
    await expect.poll(() => ext.worker.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), otherTab), { timeout: 10000 }).toBe('');
    await popup2.close();
    await other.close();
  } finally {
    await ext.worker.evaluate(() => chrome.storage.sync.remove('concurrency'));
    await ext.worker.evaluate(() => chrome.storage.local.set({ badgeHintShown: true }));
  }
});

test('a plain file shows its progress and can be cancelled from the badge', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-slow.html`);
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'video'));
  await hoverCenter(page, 'video');
  const badge = badgeIn(page);
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(badge).toHaveAttribute('data-state', 'working');
  await badge.hover();
  await expect(page.locator('[data-vdl-badge] .info .detail')).toContainText(' / ', { timeout: 5000 }); // "4 KB / 41 KB"
  await badge.click();
  await badge.click();
  await expect(badge).toHaveAttribute('data-state', 'info', { timeout: 10000 });
  const cancelled = await ext.worker.evaluate(() => chrome.downloads.search({ state: 'interrupted' }));
  expect(cancelled.some((d) => d.error === 'USER_CANCELED')).toBe(true);
  await page.close();
});

test('done: clicking the check mark shows the file in its folder', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/plain-mp4.html`);
  await page.evaluate(() => document.querySelector('video').load());
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.kind === 'video' && it.width));
  await hoverCenter(page, 'video');
  const badge = badgeIn(page);
  const before = await ext.existingDownloadIds();
  await badge.click();
  await expect(badge).toHaveAttribute('data-state', 'done');
  const [done] = await ext.waitForNewCompletedDownloads(before, 1);
  await badge.click();
  await expect.poll(() => ext.worker.evaluate(() => globalThis.__vdlLastShown)).toBe(done.id);
  await page.close();
});

test('error: clicking "Tekrar dene" retries with the same choice and completes', async () => {
  await ext.worker.evaluate(() => (globalThis.__vdlFallbackDelays = [20, 20]));
  const host = await startServer();
  try {
    host.setAlways404('hls-ts/seg2\\.ts$');
    const page = await ext.context.newPage();
    await page.goto(`${host.url}/pages/player-mse.html?duration=4&src=${encodeURIComponent('/media/hls-ts/playlist.m3u8')}`);
    const tabId = await ext.tabIdOf(page);
    await waitItems(tabId, (items) => items.some((it) => it.kind === 'hls' && it.stream));
    await hoverCenter(page, 'video');
    const badge = badgeIn(page);
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'error', { timeout: 30000 });
    await expect(badge).toHaveText('Tekrar dene');
    await expect(page.locator('[data-vdl-badge] .msg')).toContainText('Parça 3/4 alınamadı (HTTP 404)');

    host.setAlways404(null); // the host recovers
    const before = await ext.existingDownloadIds();
    await badge.click();
    await expect(badge).toHaveAttribute('data-state', 'done', { timeout: 30000 });
    await ext.waitForNewCompletedDownloads(before, 1);
    await page.close();
  } finally {
    await host.close();
    await ext.worker.evaluate(() => delete globalThis.__vdlFallbackDelays);
  }
});

test('Esc closes the quality menu', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.url}/pages/player-mse.html?duration=4&src=${encodeURIComponent('/media/hls-fmp4/master.m3u8')}`);
  const tabId = await ext.tabIdOf(page);
  await waitItems(tabId, (items) => items.some((it) => it.stream?.type === 'master'));
  await hoverCenter(page, 'video');
  await badgeIn(page).click();
  const menu = page.locator('[data-vdl-badge] .menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.close();
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
