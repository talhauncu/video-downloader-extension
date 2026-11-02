import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retryDelay,
  parseRetryAfter,
  Throttle,
  RETRY_STATUSES,
  THROTTLE_STATUSES,
  MAX_ATTEMPTS,
  COOLDOWN_SCHEDULE_MS,
  fetchWithRetry,
  scheduleForBudget,
  SPACING_STEP_MS,
  SPACING_MAX_MS,
  SPACING_DECAY_EVERY,
  SPACING_DECAY_MS,
} from '../../src/lib/retry.js';

test('retryDelay honours Retry-After seconds and dates, caps at 30 s', () => {
  assert.equal(retryDelay(1, '2'), 2000);
  assert.equal(retryDelay(1, '120'), 30_000);
  const now = Date.parse('2026-11-01T10:00:00Z');
  assert.equal(retryDelay(1, 'Sun, 01 Nov 2026 10:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('garbage'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('retryDelay backs off exponentially with jitter, capped at 8 s', () => {
  const d1 = retryDelay(1),
    d2 = retryDelay(2),
    d6 = retryDelay(6);
  assert.ok(d1 >= 500 && d1 < 750, d1);
  assert.ok(d2 >= 1000 && d2 < 1250, d2);
  assert.ok(d6 >= 8000 && d6 < 8250, d6);
});

test('Throttle semaphore limits parallelism and drops to 1 after a rate limit', async () => {
  const t = new Throttle({ concurrency: 3 });
  let active = 0,
    peak = 0;
  const work = async () => {
    await t.acquire();
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    t.release();
  };
  await Promise.all([work(), work(), work(), work(), work()]);
  assert.equal(peak, 3);
  t.rateLimited();
  active = 0;
  peak = 0;
  await Promise.all([work(), work(), work()]);
  assert.equal(peak, 1);
});

test('Throttle pause is shared and abortable', async () => {
  const t = new Throttle();
  await t.wait();
  t.pause(80);
  const started = Date.now();
  await Promise.all([t.wait(), t.wait()]);
  assert.ok(Date.now() - started >= 70);
  t.pause(5000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('stop')), 20);
  await assert.rejects(t.wait(ac.signal), /stop/);
});

test('fetchWithRetry enters cooldowns after quick retries on 429 and eventually succeeds', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    // 429 for the quick-retry budget, then 200 on the attempt after the first cooldown.
    if (calls <= MAX_ATTEMPTS) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    return new Response('ok', { status: 200 });
  };
  try {
    const cooldowns = [];
    const t = new Throttle({ concurrency: 4, cooldownSchedule: [5, 5], onCooldown: (c) => cooldowns.push(c) });
    const res = await fetchWithRetry('https://x.test/seg', {}, undefined, t);
    assert.equal(res.status, 200);
    assert.equal(calls, MAX_ATTEMPTS + 1);
    assert.equal(cooldowns.length, 1);
    assert.equal(t.capacity, 1);
    assert.ok(t.retries >= MAX_ATTEMPTS - 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchWithRetry gives up after the cooldown schedule and returns the last response', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'retry-after': '0' } });
  };
  try {
    const t = new Throttle({ concurrency: 2, cooldownSchedule: [1, 1] });
    const res = await fetchWithRetry('https://x.test/seg', {}, undefined, t);
    assert.equal(res.status, 429);
    assert.equal(t.cooldowns, 2);
    assert.equal(calls, MAX_ATTEMPTS + 2); // 6 quick + one try after each of the 2 cooldowns
  } finally {
    globalThis.fetch = original;
  }
});

test('403/404/410 get a single quick retry, not the full backoff budget', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('', { status: 403 });
  };
  try {
    const started = Date.now();
    const res = await fetchWithRetry('https://x.test/expired', {}, undefined, new Throttle({ concurrency: 2 }));
    assert.equal(res.status, 403);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started < 2000);
  } finally {
    globalThis.fetch = original;
  }
});

test('constants the downloaders rely on', () => {
  assert.ok(RETRY_STATUSES.has(429) && RETRY_STATUSES.has(503) && RETRY_STATUSES.has(404));
  assert.ok(THROTTLE_STATUSES.has(429) && !THROTTLE_STATUSES.has(404));
  assert.equal(MAX_ATTEMPTS, 6);
  assert.deepEqual(COOLDOWN_SCHEDULE_MS, [30_000, 60_000, 120_000, 300_000]);
});

test('scheduleForBudget fits the base steps then 5-minute steps into the budget', () => {
  assert.deepEqual(scheduleForBudget(0), []);
  assert.deepEqual(scheduleForBudget(1), [30_000]); // only the first step fits in 60 s
  assert.deepEqual(scheduleForBudget(10), [30_000, 60_000, 120_000, 300_000]); // 8.5 min
  assert.deepEqual(scheduleForBudget(20), [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]); // 18.5 min
  assert.equal(scheduleForBudget(120).reduce((a, b) => a + b, 0) <= 120 * 60_000, true);
});

test('spacing grows on each rate limit, caps, and decays after successes', async () => {
  const t = new Throttle({ concurrency: 4 });
  assert.equal(t.spacingMs, 0);
  t.rateLimited();
  assert.equal(t.spacingMs, SPACING_STEP_MS);
  for (let i = 0; i < 50; i++) t.rateLimited();
  assert.equal(t.spacingMs, SPACING_MAX_MS);
  for (let i = 0; i < SPACING_DECAY_EVERY; i++) t.succeeded();
  assert.equal(t.spacingMs, SPACING_MAX_MS - SPACING_DECAY_MS);
  // space() enforces the gap between request starts
  t.spacingMs = 60;
  const started = Date.now();
  await t.space();
  await t.space();
  await t.space();
  assert.ok(Date.now() - started >= 100, `${Date.now() - started}`);
});

test('fetchWithRetry spaces requests after a 429 and relaxes on success', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok', { status: 200 });
  };
  try {
    const t = new Throttle({ concurrency: 4, spacingStep: 30 });
    await fetchWithRetry('https://x.test/a', {}, undefined, t);
    assert.equal(t.spacingMs, 30);
    assert.equal(t.capacity, 1);
    const started = Date.now();
    await fetchWithRetry('https://x.test/b', {}, undefined, t);
    await fetchWithRetry('https://x.test/c', {}, undefined, t);
    assert.ok(Date.now() - started >= 50);
    assert.equal(t.limits, 1);
  } finally {
    globalThis.fetch = original;
  }
});
