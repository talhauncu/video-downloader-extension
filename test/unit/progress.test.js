import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEta, streamProgress, fileProgress, isActive } from '../../src/lib/progress.js';

test('formatEta', () => {
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(-1), null);
  assert.equal(formatEta(0.4), '~1 sn');
  assert.equal(formatEta(45), '~45 sn');
  assert.equal(formatEta(179), '~3 dk');
  assert.equal(formatEta(3600), '~1 sa');
  assert.equal(formatEta(4800), '~1 sa 20 dk');
});

test('streamProgress: percentage, parts and ETA from the average rate (waits excluded)', () => {
  const now = 1_000_000;
  const p = streamProgress(
    {
      jobId: 'j',
      itemId: 'i',
      status: 'downloading',
      done: 934,
      total: 1682,
      bytes: 1.5 * 1024 ** 3,
      startedAt: now - 120_000 - 30_000,
      waitedMs: 30_000,
    },
    now,
  );
  assert.equal(p.pct, 56);
  assert.equal(p.label, '%56');
  // 934 pieces in 120 s → 748 left ≈ 96 s.
  assert.ok(Math.abs(p.etaSec - 96.1) < 0.5, `${p.etaSec}`);
  assert.equal(p.detail, '934/1682 parça · 1.5 GB · kalan ~2 dk');
  assert.equal(isActive(p), true);
});

test('streamProgress: merging, cooldown, saving and done labels', () => {
  const now = 50_000;
  assert.equal(
    streamProgress({ status: 'downloading', phase: 'merging', phaseProgress: 0.42, done: 10, total: 10 }, now).label,
    'Birleştiriliyor %42',
  );
  const wait = streamProgress({ status: 'downloading', phase: 'cooldown', cooldownUntil: now + 31_000, done: 3, total: 10 }, now);
  assert.equal(wait.label, 'Bekliyor…');
  assert.match(wait.detail, /^Sunucu bekletiyor: 31 sn · 3\/10 parça$/);
  assert.equal(wait.etaSec, null);
  assert.equal(streamProgress({ status: 'saving', done: 10, total: 10 }).label, 'Kaydediliyor…');
  const done = streamProgress({ status: 'done', done: 10, total: 10, files: ['a-video.mp4'], downloadIds: [7] });
  assert.equal(done.pct, 100);
  assert.equal(done.downloadId, 7);
  assert.equal(done.filename, 'a-video.mp4');
  assert.equal(isActive(done), false);
});

test('fileProgress maps chrome.downloads entries and in-memory outcomes', () => {
  const now = Date.parse('2026-11-02T10:00:00Z');
  const running = fileProgress(
    {
      id: 5,
      state: 'in_progress',
      bytesReceived: 300 * 1024 ** 2,
      totalBytes: 1024 ** 3,
      estimatedEndTime: '2026-11-02T10:02:00Z',
      filename: '/x/film.mp4',
    },
    { itemId: 'i', outcome: null },
    now,
  );
  assert.equal(running.status, 'downloading');
  assert.equal(running.pct, 29);
  assert.equal(running.detail, '300 MB / 1.0 GB · kalan ~2 dk');
  assert.equal(running.filename, 'film.mp4');
  assert.equal(fileProgress({ id: 5, state: 'complete', bytesReceived: 9, totalBytes: 9 }, null).status, 'done');
  assert.equal(fileProgress({ id: 5, state: 'interrupted', error: 'USER_CANCELED' }, null).status, 'cancelled');
  assert.equal(fileProgress({ id: 5, state: 'interrupted', error: 'NETWORK_FAILED' }, null).error, 'NETWORK_FAILED');
  // Referer fallback: the direct attempt was erased, the Blob is being fetched.
  const fb = fileProgress(null, { mode: 'fallback', outcome: null, itemId: 'i' });
  assert.equal(fb.status, 'downloading');
  assert.equal(fb.label, 'İndiriliyor…');
  assert.equal(fileProgress(null, { mode: 'fallback', outcome: { state: 'cancelled' } }).status, 'cancelled');
  assert.equal(fileProgress(null, null), null);
});
