import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firefoxManifest, GECKO_ID, FIREFOX_MIN_VERSION } from '../../scripts/firefox.js';

const chrome = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('firefoxManifest: an event page with mux.js first, no offscreen, key or isolation', () => {
  const m = firefoxManifest(chrome);
  assert.deepEqual(m.background, { scripts: ['src/vendor/mux-mp4.min.js', 'src/background/service-worker.js'], type: 'module' });
  assert.ok(!m.permissions.includes('offscreen'));
  assert.deepEqual(
    m.permissions,
    chrome.permissions.filter((p) => p !== 'offscreen'),
  );
  for (const key of ['key', 'minimum_chrome_version', 'cross_origin_embedder_policy', 'cross_origin_opener_policy'])
    assert.equal(key in m, false, key);
  assert.deepEqual(m.browser_specific_settings, {
    gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION, data_collection_permissions: { required: ['none'] } },
  });
});

test('firefoxManifest: everything else as in the Chrome manifest', () => {
  const m = firefoxManifest(chrome);
  for (const key of [
    'manifest_version',
    'name',
    'version',
    'default_locale',
    'description',
    'host_permissions',
    'action',
    'content_scripts',
    'content_security_policy',
    'options_ui',
    'commands',
  ])
    assert.deepEqual(m[key], chrome[key], key);
  // The Chrome manifest itself is not changed.
  assert.ok(chrome.permissions.includes('offscreen'));
  assert.equal(chrome.background.service_worker, 'src/background/service-worker.js');
});
