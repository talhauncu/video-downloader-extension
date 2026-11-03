import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkVendor } from '../../scripts/check-vendor.js';

const VERSIONS = { 'mux.js': '7.1.1', '@ffmpeg/ffmpeg': '0.12.15', '@ffmpeg/core': '0.12.10', '@ffmpeg/core-mt': '0.12.10' };

/** A small repository: lock file, installed packages, vendored copies and the two version notes. */
function repo({ installed = VERSIONS, notes = VERSIONS } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vdl-vendor-'));
  const put = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  put(
    'package-lock.json',
    JSON.stringify({ packages: Object.fromEntries(Object.entries(VERSIONS).map(([p, v]) => [`node_modules/${p}`, { version: v }])) }),
  );
  for (const [pkg, version] of Object.entries(installed)) put(`node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, version }));
  const files = {
    'mux.js/dist/mux-mp4.min.js': ['src/vendor/mux-mp4.min.js', 'mux'],
    '@ffmpeg/ffmpeg/dist/esm/classes.js': ['src/vendor/ffmpeg/classes.js', 'classes'],
    '@ffmpeg/ffmpeg/dist/esm/classes.d.ts': ['src/vendor/ffmpeg/classes.d.ts', 'types'],
    '@ffmpeg/core/dist/esm/ffmpeg-core.js': ['src/vendor/ffmpeg/ffmpeg-core.js', 'core'],
    '@ffmpeg/core/dist/esm/ffmpeg-core.wasm': ['src/vendor/ffmpeg/ffmpeg-core.wasm', Buffer.from([0, 97, 115, 109])],
    '@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js': ['src/vendor/ffmpeg-mt/ffmpeg-core.worker.js', 'mt-worker'],
  };
  for (const [from, [to, content]] of Object.entries(files)) {
    put(`node_modules/${from}`, content);
    put(to, content);
  }
  put(
    'src/vendor/ffmpeg/VERSIONS',
    `@ffmpeg/ffmpeg ${notes['@ffmpeg/ffmpeg']} (dist/esm)\n@ffmpeg/core   ${notes['@ffmpeg/core']} (dist/esm)\n@ffmpeg/core-mt ${notes['@ffmpeg/core-mt']} (dist/esm)\n`,
  );
  put(
    'THIRD_PARTY_LICENSES.md',
    Object.entries(notes)
      .map(([pkg, v]) => `| [${pkg}](https://example.test) | ${v} | MIT | x | y |`)
      .join('\n'),
  );
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('checkVendor: identical copies and matching versions pass', () => {
  const r = repo();
  try {
    assert.deepEqual(checkVendor(r.root), { problems: [], checked: 6 });
  } finally {
    r.done();
  }
});

test('checkVendor: a changed byte, an unknown file and a missing source are reported', () => {
  const r = repo();
  try {
    r.put('src/vendor/ffmpeg/ffmpeg-core.wasm', Buffer.from([0, 97, 115, 110]));
    r.put('src/vendor/ffmpeg/extra.js', 'x');
    r.put('src/vendor/ffmpeg/ffmpeg-core.worker.js', 'w');
    const { problems } = checkVendor(r.root);
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(
      problems.find((p) => p.includes('wasm')),
      /differs from node_modules\/@ffmpeg\/core\/dist\/esm\/ffmpeg-core\.wasm \(@ffmpeg\/core 0\.12\.10\)/,
    );
    assert.match(
      problems.find((p) => p.includes('extra.js')),
      /does not exist/,
    );
    assert.match(
      problems.find((p) => p.includes('worker')),
      /does not exist/,
    );
  } finally {
    r.done();
  }
});

test('checkVendor: a file outside the known sources is reported', () => {
  const r = repo();
  try {
    r.put('src/vendor/other/lib.js', 'x');
    assert.deepEqual(checkVendor(r.root).problems, [
      'src/vendor/other/lib.js: no npm source is known for it (add it to SOURCES in scripts/check-vendor.js)',
    ]);
  } finally {
    r.done();
  }
});

test('checkVendor: an installed version other than the lock file, and outdated version notes, are reported', () => {
  const r = repo({ installed: { ...VERSIONS, 'mux.js': '7.2.0' }, notes: { ...VERSIONS, '@ffmpeg/core': '0.12.6' } });
  try {
    assert.deepEqual(checkVendor(r.root).problems.sort(), [
      'THIRD_PARTY_LICENSES.md: @ffmpeg/core should be 0.12.10',
      'mux.js: installed 7.2.0, package-lock.json says 7.1.1',
      'src/vendor/ffmpeg/VERSIONS: @ffmpeg/core should be 0.12.10',
    ]);
  } finally {
    r.done();
  }
});
