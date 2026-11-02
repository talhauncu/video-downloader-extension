import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, redactDeep } from '../../src/lib/redact.js';

test('redactUrl masks query values and long path tokens, keeps names and short segments', () => {
  assert.equal(
    redactUrl('https://cdn.test/hls/x/master.txt?s=SIGNEDTOKEN123&e=1793648230#frag'),
    'https://cdn.test/hls/x/master.txt?s=…&e=…',
  );
  assert.equal(
    redactUrl('https://s27.cdn.test/mt/H3IjMKWanKWfYwVjZwLhI0IPYHEZYwRjBQOjYxEIDHjhrQV2vr1b720'),
    'https://s27.cdn.test/mt/H3Ij…b720',
  );
  assert.equal(redactUrl('https://www.example.com/watch/film-name/'), 'https://www.example.com/watch/film-name/');
  assert.equal(redactUrl('blob:https://player.test/9b4c32ae-1fb6-4c55'), 'blob:https://player.test/9b4c32ae-1fb6-4c55');
  assert.equal(redactUrl('not a url'), 'not a url');
  assert.equal(redactUrl(42), 42);
});

test('redactDeep masks URLs at any depth and leaves other values alone', () => {
  const info = {
    tabUrl: 'https://site.test/page?user=me',
    items: [
      { url: 'https://cdn.test/a.mp4?token=x', size: 10, stream: { variants: [{ url: 'https://cdn.test/v.m3u8?sig=y', height: 720 }] } },
    ],
    settings: { subtitleLangs: ['tr'], mergeTracks: true },
    note: 'plain text',
    empty: null,
  };
  assert.deepEqual(redactDeep(info), {
    tabUrl: 'https://site.test/page?user=…',
    items: [
      { url: 'https://cdn.test/a.mp4?token=…', size: 10, stream: { variants: [{ url: 'https://cdn.test/v.m3u8?sig=…', height: 720 }] } },
    ],
    settings: { subtitleLangs: ['tr'], mergeTracks: true },
    note: 'plain text',
    empty: null,
  });
  assert.equal(info.tabUrl, 'https://site.test/page?user=me'); // the input is not changed
});
