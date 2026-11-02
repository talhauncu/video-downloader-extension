import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { launchWithExtension } from './helpers.js';
import { startServer } from '../fixtures/server.js';
import { topLevelBoxes } from './mp4-boxes.js';

let ext;

test.beforeAll(async () => {
  ext = await launchWithExtension();
  await ext.worker.evaluate(() => (globalThis.__vdlFallbackDelays = [50, 50]));
});

test.afterAll(async () => {
  await ext?.close();
});

async function mirrorsWith(failing) {
  // Three equivalent hosts; segment i of the generated playlist lives on mirrors[i % 3].
  const servers = await Promise.all([0, 1, 2].map((i) => startServer(failing[i] ? { always404: failing[i] } : {})));
  const origins = servers.map((s) => s.url);
  servers[0].setMirrors(origins);
  return { servers, close: () => Promise.all(servers.map((s) => s.close())) };
}

async function openStream(host) {
  const page = await ext.context.newPage();
  await page.goto(`${host.url}/pages/hls.html?src=${encodeURIComponent('/media/mirror/playlist.m3u8')}`);
  await expect(page.locator('body')).toHaveAttribute('data-playlist-loaded', 'true');
  const popup = await ext.openPopup(await ext.tabIdOf(page));
  return { page, popup };
}

async function latestJob() {
  return ext.worker.evaluate(
    async () =>
      Object.values(await chrome.storage.session.get(null))
        .filter((v) => v?.jobId)
        .sort((a, b) => b.startedAt - a.startedAt)[0],
  );
}

test('a segment missing on its mirror (404) is fetched from another mirror; the job completes', async () => {
  // seg1.ts is assigned to mirror B, which has lost it.
  const m = await mirrorsWith([null, 'seg1\\.ts$', null]);
  try {
    const { page, popup } = await openStream(m.servers[0]);
    const item = popup.locator('#media-list > .item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 20000 });
    const before = await ext.existingDownloadIds();
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Tamamlandı', { timeout: 60000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('1 ayna değişimi');
    const [done] = await ext.waitForNewCompletedDownloads(before, 1);
    expect(topLevelBoxes(await readFile(done.filename))[0].type).toBe('ftyp');
    const job = await latestJob();
    expect(job.mirrorSwitches).toBe(1);
    await popup.close();
    await page.close();
  } finally {
    await m.close();
  }
});

test('when every mirror has lost the segment the job fails with the real attempt count', async () => {
  const m = await mirrorsWith(['seg1\\.ts$', 'seg1\\.ts$', 'seg1\\.ts$']);
  try {
    const { page, popup } = await openStream(m.servers[0]);
    const item = popup.locator('#media-list > .item[data-kind="hls"]');
    await expect(item.locator('.download')).toBeEnabled({ timeout: 20000 });
    await item.locator('.download').click();
    await expect(popup.locator('.job:not([data-other-tab]) .job-state')).toHaveText('Hata', { timeout: 60000 });
    await expect(popup.locator('.job:not([data-other-tab]) .job-detail')).toContainText('Parça 2/4 alınamadı (HTTP 404)');
    const job = await latestJob();
    expect(job.lastHttp.status).toBe(404);
    expect(job.lastHttp.mirrorsTried).toBe(2);
    expect(job.lastHttp.attempts).toBeGreaterThanOrEqual(8);
    await popup.close();
    await page.close();
  } finally {
    await m.close();
  }
});

test('service worker logged no errors', async () => {
  expect(ext.errors).toEqual([]);
});
