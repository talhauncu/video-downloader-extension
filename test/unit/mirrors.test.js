import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorOrigins, alternateUrls } from '../../src/lib/mirrors.js';
import { fetchPieceWithFallback } from '../../src/offscreen/fallback.js';
import { Throttle } from '../../src/lib/retry.js';

const P = '/hls/film.mp4/image2_669.jpg';

test('mirrorOrigins: distinct origins in order, none for a single host', () => {
  const urls = [
    'https://a.test/x/1.jpg',
    'https://a.test/x/2.jpg',
    'https://b.test/x/3.jpg',
    'https://c.test/x/4.jpg',
    'https://b.test/x/5.jpg',
  ];
  assert.deepEqual(mirrorOrigins(urls), ['https://a.test', 'https://b.test', 'https://c.test']);
  assert.deepEqual(mirrorOrigins(['https://a.test/1', 'https://a.test/2']), []);
  assert.deepEqual(mirrorOrigins(['not a url', 'https://a.test/1']), []);
});

test('alternateUrls: same path and query on the next mirrors, own host excluded, capped', () => {
  const origins = ['https://m1.test', 'https://m2.test', 'https://m3.test', 'https://m4.test', 'https://m5.test'];
  assert.deepEqual(alternateUrls(`https://m2.test${P}?t=1`, origins, 3), [
    `https://m3.test${P}?t=1`,
    `https://m4.test${P}?t=1`,
    `https://m5.test${P}?t=1`,
  ]);
  assert.deepEqual(alternateUrls(`https://m5.test${P}`, origins, 2), [`https://m1.test${P}`, `https://m2.test${P}`]);
  assert.deepEqual(alternateUrls(`https://other.test${P}`, origins, 1), [`https://m1.test${P}`]);
  assert.deepEqual(alternateUrls(`https://m1.test${P}`, [], 3), []);
});

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url), calls.length);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const ctx = (origins, extra = {}) => ({
  signal: undefined,
  throttle: new Throttle({ concurrency: 2 }),
  origins: () => origins,
  refresh: null,
  stats: { mirrorSwitches: 0 },
  delays: [5, 5],
  ...extra,
});

test('fallback: a 404 on the own mirror is served by the next mirror', async () => {
  const origins = ['https://m1.test', 'https://m2.test', 'https://m3.test'];
  const m = mockFetch((url) =>
    url.startsWith('https://m2.test') ? new Response('', { status: 404 }) : new Response(new Uint8Array([1, 2, 3])),
  );
  try {
    const c = ctx(origins);
    const data = await fetchPieceWithFallback(() => ({ url: `https://m2.test${P}` }), { step: 'segment', index: 668, total: 841 }, c);
    assert.deepEqual([...data], [1, 2, 3]);
    assert.equal(c.stats.mirrorSwitches, 1);
    assert.ok(
      m.calls.some((u) => u.startsWith('https://m3.test')),
      'next mirror after m2 tried first',
    );
  } finally {
    m.restore();
  }
});

test('fallback: when every mirror fails, the error carries the real attempt count and mirrors tried', async () => {
  const origins = ['https://m1.test', 'https://m2.test', 'https://m3.test'];
  const m = mockFetch(() => new Response('', { status: 404 }));
  try {
    const c = ctx(origins);
    await assert.rejects(
      fetchPieceWithFallback(() => ({ url: `https://m1.test${P}` }), { step: 'segment', index: 668, total: 841 }, c),
      (error) => {
        assert.match(error.message, /Parça 669\/841 alınamadı \(HTTP 404\)/);
        assert.equal(error.detail.mirrorsTried, 2);
        assert.equal(error.detail.attempts, m.calls.length);
        assert.ok(error.detail.attempts >= 8, `${error.detail.attempts}`); // own ×2, 2 mirrors ×2, 2 late retries ×2
        return true;
      },
    );
  } finally {
    m.restore();
  }
});

test('fallback: an expired (403) URL is refreshed before mirrors are tried', async () => {
  let fresh = false;
  const m = mockFetch((url) => (url.includes('fresh') ? new Response(new Uint8Array([9])) : new Response('', { status: 403 })));
  try {
    const c = ctx([], {
      refresh: async () => {
        fresh = true;
      },
    });
    const data = await fetchPieceWithFallback(
      () => ({ url: fresh ? `https://m1.test${P}?fresh` : `https://m1.test${P}?old` }),
      { step: 'segment', index: 0, total: 1 },
      c,
    );
    assert.deepEqual([...data], [9]);
    assert.equal(c.stats.mirrorSwitches, 0);
  } finally {
    m.restore();
  }
});

test('fallback: non-retryable statuses (e.g. 401) fail at once without mirrors', async () => {
  const m = mockFetch(() => new Response('', { status: 401 }));
  try {
    const c = ctx(['https://m1.test', 'https://m2.test']);
    await assert.rejects(
      fetchPieceWithFallback(() => ({ url: `https://m1.test${P}` }), { step: 'segment', index: 0, total: 1 }, c),
      /HTTP 401/,
    );
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test('fallback: a rate limit (429) tries mirrors but no refresh or late retries', async () => {
  let refreshed = false;
  const m = mockFetch(() => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
  try {
    const c = ctx(['https://m1.test', 'https://m2.test'], {
      refresh: async () => {
        refreshed = true;
      },
      throttle: new Throttle({ concurrency: 1, cooldownSchedule: [] }),
    });
    await assert.rejects(
      fetchPieceWithFallback(() => ({ url: `https://m1.test${P}` }), { step: 'segment', index: 0, total: 1 }, c),
      (e) => {
        assert.equal(e.detail.status, 429);
        assert.equal(e.detail.mirrorsTried, 1);
        return true;
      },
    );
    assert.equal(refreshed, false);
  } finally {
    m.restore();
  }
});

test('fallback: a 404 that lasts past the mirrors is outlasted by the late retries, with a playlist refresh half way', async () => {
  let refreshed = 0;
  let calls = 0;
  // Every request fails until the 12th (own ×2, refresh, then late retries ×2 each).
  const m = mockFetch(() => (++calls >= 12 ? new Response(new Uint8Array([7])) : new Response('', { status: 404 })));
  try {
    const c = ctx([], {
      refresh: async () => {
        refreshed++;
      },
      delays: [1, 1, 1, 1, 1, 1],
    });
    const data = await fetchPieceWithFallback(() => ({ url: `https://m1.test${P}` }), { step: 'segment', index: 92, total: 881 }, c);
    assert.deepEqual([...data], [7]);
    assert.equal(refreshed, 2); // after the mirrors, and before the 4th late retry
  } finally {
    m.restore();
  }
});
