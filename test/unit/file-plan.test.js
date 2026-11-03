import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangePlan, sizeFromContentRange, FILE_CHUNK_BYTES } from '../../src/lib/file-plan.js';

test('rangePlan: consecutive pieces cover the file exactly, the last one shorter', () => {
  const pieces = rangePlan('https://cdn.test/v.webm', 10, 4);
  assert.deepEqual(
    pieces.map((p) => p.byteRange),
    [
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ],
  );
  assert.ok(pieces.every((p) => p.url === 'https://cdn.test/v.webm'));
  assert.equal(rangePlan('u', FILE_CHUNK_BYTES * 2).length, 2);
  assert.equal(rangePlan('u', FILE_CHUNK_BYTES * 2 + 1).length, 3);
});

test('rangePlan: unknown size or no range support is one piece without a range', () => {
  assert.deepEqual(rangePlan('u', null), [{ url: 'u', byteRange: null }]);
  assert.deepEqual(rangePlan('u', 0), [{ url: 'u', byteRange: null }]);
});

test('sizeFromContentRange reads the total of a range answer', () => {
  assert.equal(sizeFromContentRange('bytes 0-0/74415'), 74415);
  assert.equal(sizeFromContentRange('BYTES 0-0/12'), 12);
  assert.equal(sizeFromContentRange('bytes 0-0/*'), null);
  assert.equal(sizeFromContentRange(null), null);
});
