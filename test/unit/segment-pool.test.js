import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../../src/offscreen/segment-pool.js';

test('runPool respects the concurrency limit and writes strictly in order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const written = [];
  await runPool({
    count: 12,
    concurrency: 3,
    fetchIndex: async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ((12 - i) % 4) * 3)); // out-of-order completion
      inFlight--;
      return `seg${i}`;
    },
    write: async (i, data) => {
      written.push([i, data]);
    },
  });
  assert.equal(maxInFlight, 3);
  assert.deepEqual(
    written.map(([i]) => i),
    [...Array(12).keys()],
  );
  assert.deepEqual(
    written.map(([, d]) => d),
    [...Array(12).keys()].map((i) => `seg${i}`),
  );
});

test('runPool rejects on abort and on a failing fetch', async () => {
  const ac = new AbortController();
  ac.abort(new Error('stop'));
  await assert.rejects(
    runPool({ count: 3, concurrency: 1, signal: ac.signal, fetchIndex: async () => 'x', write: async () => {} }),
    /stop/,
  );
  await assert.rejects(
    runPool({
      count: 3,
      concurrency: 2,
      fetchIndex: async (i) => {
        if (i === 1) throw new Error('boom');
        return 'x';
      },
      write: async () => {},
    }),
    /boom/,
  );
});
