import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackProgress } from '../../src/lib/track-progress.js';

test('TrackProgress: the total is fixed before the first track, so the share never goes back', () => {
  // Subtitle (4 pieces), video (4), audio (5), downloaded in this order.
  const p = new TrackProgress(['subtitle', 'video', 'audio']);
  [4, 4, 5].forEach((n, i) => p.setTotal(i, n));
  const seen = [];
  const step = (i, done, total) => {
    p.update(i, done, total);
    const { done: d, total: t } = p.snapshot();
    seen.push(d / t);
  };
  for (let d = 0; d <= 4; d++) step(0, d, 4);
  for (let d = 0; d <= 4; d++) step(1, d, 4);
  for (let d = 0; d <= 5; d++) step(2, d, 5);
  assert.deepEqual(p.snapshot(), { done: 9, total: 9 });
  for (let k = 1; k < seen.length; k++) assert.ok(seen[k] >= seen[k - 1], `went back at step ${k}: ${seen[k - 1]} → ${seen[k]}`);
  // Subtitle pieces do not count next to media: the bar stays at 0 until the video starts.
  assert.equal(seen[4], 0);
  assert.equal(seen.indexOf(1), seen.length - 1);
});

test('TrackProgress: a subtitle-only job counts its subtitle pieces', () => {
  const p = new TrackProgress(['subtitle', 'subtitle']);
  p.setTotal(0, 2);
  p.setTotal(1, 3);
  p.update(0, 2, 2);
  assert.deepEqual(p.snapshot(), { done: 2, total: 5 });
});

test('TrackProgress: a track whose playlist changed since planning uses its own total; done never shrinks', () => {
  const p = new TrackProgress(['video', 'audio']);
  p.setTotal(0, 4);
  p.setTotal(1, 0); // unknown when planned
  p.update(0, 3, 4);
  p.update(0, 2, 4); // a late, out-of-order report
  assert.deepEqual(p.snapshot(), { done: 3, total: 4 });
  p.update(0, 4, 4);
  p.update(1, 0, 6);
  assert.deepEqual(p.snapshot(), { done: 4, total: 10 });
});

test('TrackProgress: a track run again after a failure starts from the pieces it kept', () => {
  const p = new TrackProgress(['video', 'audio']);
  p.setTotal(0, 10);
  p.setTotal(1, 6);
  p.update(0, 10, 10);
  p.update(1, 4, 6);
  p.reset(1, 3); // three pieces were written before the failure
  assert.deepEqual(p.snapshot(), { done: 13, total: 16 });
  p.reset(1, 0); // a TS track starts over
  assert.deepEqual(p.snapshot(), { done: 10, total: 16 });
  p.update(1, 6, 6);
  assert.deepEqual(p.snapshot(), { done: 16, total: 16 });
});
