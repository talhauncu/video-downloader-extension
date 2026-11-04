import { test } from 'node:test';
import assert from 'node:assert/strict';

// chrome.storage.session stand-in (the store mirrors its lists there).
const session = new Map();
globalThis.chrome = /** @type {any} */ ({
  storage: {
    session: {
      get: async () => Object.fromEntries(session),
      set: async (o) => Object.entries(o).forEach(([k, v]) => session.set(k, v)),
      remove: async (k) => [k].flat().forEach((key) => session.delete(key)),
    },
  },
});
const store = await import('../../src/background/store.js');

test('clear(tab, before) keeps what was seen at or after that time; clear(tab) empties the list', async () => {
  await store.upsert(1, { key: 'old', url: 'https://a.test/old.mp4', kind: 'video' });
  await new Promise((r) => setTimeout(r, 5));
  const navigation = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  // The new page reported before the background heard of its request (Firefox).
  await store.upsert(1, { key: 'new', url: 'https://a.test/new.mp4', kind: 'video' });
  await store.clear(1, navigation);
  assert.deepEqual(
    (await store.list(1)).map((it) => it.key),
    ['new'],
  );
  assert.deepEqual(
    session.get('tab:1').map((it) => it.key),
    ['new'],
  );
  // Seen again after the navigation: an old entry stays too.
  await store.upsert(1, { key: 'old', url: 'https://a.test/old.mp4', kind: 'video' });
  await store.clear(1, navigation);
  assert.equal((await store.list(1)).length, 2);
  await store.clear(1);
  assert.deepEqual(await store.list(1), []);
  assert.equal(session.has('tab:1'), false);
});
