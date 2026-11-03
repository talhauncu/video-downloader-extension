// Builds the Firefox version of the extension in dist/firefox/: the same
// sources with a Firefox manifest. Firefox has no offscreen documents (its
// background is an event page with a DOM, which runs the offscreen work
// itself), no `key`, and no cross-origin isolation for extension pages (so no
// multi-threaded ffmpeg core either).
//   node scripts/firefox.js        (also run by `npm run package -- --firefox`)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GECKO_ID = 'video-downloader@talhauncu.github.io';
/** data_collection_permissions needs Firefox 140 (also an ESR). */
export const FIREFOX_MIN_VERSION = '140.0';

/** Files of the Chrome build that the Firefox one leaves out (paths relative to the root). */
export const FIREFOX_EXCLUDE = ['src/vendor/ffmpeg-mt', 'src/offscreen/offscreen.html'];

/**
 * The Firefox manifest made from the Chrome one. Pure (unit-tested).
 * @param {Record<string, any>} chrome
 */
export function firefoxManifest(chrome) {
  const {
    key: _key,
    minimum_chrome_version: _min,
    cross_origin_embedder_policy: _coep,
    cross_origin_opener_policy: _coop,
    ...rest
  } = chrome;
  return {
    ...rest,
    permissions: chrome.permissions.filter((p) => p !== 'offscreen'),
    // mux.js is a classic script the offscreen page loaded with a <script> tag; here it runs before the background module.
    background: { scripts: ['src/vendor/mux-mp4.min.js', chrome.background.service_worker], type: 'module' },
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION, data_collection_permissions: { required: ['none'] } },
    },
  };
}

const INCLUDE = ['_locales', 'src', 'LICENSE', 'THIRD_PARTY_LICENSES.md', 'licenses', 'README.md', 'README.tr.md'];

/** Writes dist/firefox/ and returns its path. */
export function buildFirefox(root) {
  const out = path.join(root, 'dist', 'firefox');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const skip = new Set(FIREFOX_EXCLUDE.map((p) => path.join(root, p)));
  for (const entry of INCLUDE) {
    cpSync(path.join(root, entry), path.join(out, entry), {
      recursive: true,
      filter: (src) => !skip.has(src) && !src.endsWith('.d.ts') && !src.endsWith('.DS_Store'),
    });
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(firefoxManifest(manifest), null, 2)}\n`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(path.relative(root, buildFirefox(root)));
}
