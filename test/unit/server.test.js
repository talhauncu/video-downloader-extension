import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../fixtures/server.js';

test('fixture server serves media with the right content type and size', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/media/sample.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), body.length);
    // Every MP4 starts with an "ftyp" box at offset 4.
    assert.equal(new TextDecoder().decode(body.slice(4, 8)), 'ftyp');
  } finally {
    await server.close();
  }
});

test('fixture server honours Range requests', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/media/sample.mp4`, { headers: { range: 'bytes=0-7' } });
    assert.equal(res.status, 206);
    assert.match(res.headers.get('content-range'), /^bytes 0-7\/\d+$/);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.equal(body.length, 8);
  } finally {
    await server.close();
  }
});

test('fixture server returns 404 for unknown paths and blocks traversal', async () => {
  const server = await startServer();
  try {
    assert.equal((await fetch(`${server.url}/media/nope.mp4`)).status, 404);
    assert.equal((await fetch(`${server.url}/../package.json`)).status, 404);
  } finally {
    await server.close();
  }
});

test('fixture server can require a Referer for media', async () => {
  const server = await startServer({ requireReferer: true });
  try {
    assert.equal((await fetch(`${server.url}/media/sample.mp4`)).status, 403);
    const ok = await fetch(`${server.url}/media/sample.mp4`, { headers: { referer: 'http://example.test/' } });
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});
