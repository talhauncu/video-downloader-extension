import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { SITES, BRIDGE_SCRIPT, siteById, siteForUrl, validateSite, validateSites } from '../../src/sites/index.js';
import instagram, { pickBestVersion } from '../../src/sites/instagram/site.js';

const ROOT = new URL('../../', import.meta.url);
const valid = () => ({
  ...instagram,
  id: 'example',
  label: 'Example',
  hosts: [/(^|\.)example\.com$/],
  matches: ['*://*.example.com/*'],
  main: 'src/sites/example/main.js',
});

test('the registered sites are valid, their files exist and versions match the extractors', () => {
  assert.deepEqual(validateSites(), []);
  assert.ok(existsSync(new URL(BRIDGE_SCRIPT, ROOT)));
  for (const site of SITES) {
    assert.ok(existsSync(new URL(site.main, ROOT)), site.main);
    const source = readFileSync(new URL(site.main, ROOT), 'utf8');
    assert.match(source, new RegExp(`const VERSION = ${site.version};`), `${site.id}: VERSION in ${site.main}`);
    for (const name of Object.values(site.globals)) assert.ok(source.includes(`window.${name}`), `${site.id}: sets window.${name}`);
  }
});

test('validateSite names every missing or malformed field', () => {
  assert.deepEqual(validateSite(valid()), []);
  const errors = validateSite({
    id: 'Bad Id',
    hosts: ['instagram.com'],
    matches: ['instagram.com'],
    main: 'src/content/x.js',
    version: 0,
    globals: {},
    fetchContext: 'tab',
  });
  for (const field of ['id', 'label', 'hosts', 'matches', 'main', 'version', 'globals', 'fetchContext', 'toItems']) {
    assert.ok(
      errors.some((e) => e.includes(field)),
      `${field}: ${errors.join(' | ')}`,
    );
  }
});

test('validateSites rejects duplicate ids and hosts claimed by two sites', () => {
  assert.ok(validateSites([valid(), valid()]).some((e) => e.includes('duplicate id: example')));
  const greedy = { ...valid(), id: 'greedy', hosts: [/instagram\.com$/], matches: ['*://*.greedy.test/*'] };
  assert.ok(validateSites([instagram, greedy]).some((e) => e.includes('greedy hosts also match instagram')));
  const twin = { ...valid(), id: 'twin', matches: ['*://*.instagram.com/*'] };
  assert.ok(validateSites([instagram, twin]).some((e) => e.includes('claimed by')));
});

test('siteForUrl picks the site by its top-frame host; test hosts can be added', () => {
  assert.equal(siteForUrl('https://www.instagram.com/reel/ABCDEFGH/')?.id, 'instagram');
  assert.equal(siteForUrl('https://instagram.com/')?.id, 'instagram');
  assert.equal(siteForUrl('https://notinstagram.com.evil.test/'), null);
  assert.equal(siteForUrl('http://127.0.0.1:8787/pages/ig.html'), null);
  assert.equal(siteForUrl('http://127.0.0.1:8787/pages/ig.html', [{ site: 'instagram', re: /^127\.0\.0\.1$/ }])?.id, 'instagram');
  assert.equal(siteForUrl('not a url'), null);
  assert.equal(siteById('instagram'), instagram);
  assert.equal(siteById('nope'), null);
});

test('instagram.toItems: the largest progressive version, else the DASH manifest, else nothing', () => {
  const versions = [
    { url: 'https://cdn.test/small.mp4', width: 360, height: 640 },
    { url: 'https://cdn.test/big.mp4', width: 720, height: 1280 },
  ];
  assert.equal(pickBestVersion(versions).url, 'https://cdn.test/big.mp4');
  const out = instagram.toItems(
    {
      items: [
        { pk: '1', code: 'REELCODE1', versions, duration: 12, username: 'user', caption: 'First line\nsecond' },
        { pk: '2', code: 'REELCODE2', versions: [], dashManifest: '<MPD/>', width: 1080, height: 1920 },
        { pk: '3', versions: [] },
      ],
    },
    { pageUrl: 'https://www.instagram.com/reel/REELCODE1/' },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(
    {
      key: out[0].entry.key,
      url: out[0].entry.url,
      kind: out[0].entry.kind,
      title: out[0].entry.title,
      site: out[0].entry.site,
      code: out[0].entry.code,
    },
    { key: 'instagram:1', url: 'https://cdn.test/big.mp4', kind: 'video', title: '@user First line', site: 'instagram', code: 'REELCODE1' },
  );
  assert.equal(out[0].sizeFrom, 'https://cdn.test/big.mp4');
  assert.equal(out[1].entry.key, 'instagram:2:dash');
  assert.equal(out[1].entry.kind, 'dash');
  assert.equal(out[1].entry.manifestText, '<MPD/>');
  assert.equal(out[1].describe, true);
});
