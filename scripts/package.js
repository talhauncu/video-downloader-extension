// Builds dist/video-downloader-<version>.zip: what a release contains (the
// unpacked extension plus its licenses). `--check-tag <tag>` first verifies
// that the tag (v1.2.3) matches manifest.json's version (release workflow).
// `--firefox` also builds dist/firefox/ (scripts/firefox.js) and zips it as
// dist/video-downloader-firefox-<version>.zip.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirefox } from './firefox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const tagAt = process.argv.indexOf('--check-tag');
if (tagAt !== -1) {
  const tag = process.argv[tagAt + 1] ?? '';
  if (tag !== `v${version}`) {
    console.error(`Tag ${tag || '(none)'} does not match manifest.json version ${version} (expected v${version}).`);
    process.exit(1);
  }
}

const INCLUDE = ['manifest.json', '_locales', 'src', 'LICENSE', 'THIRD_PARTY_LICENSES.md', 'licenses', 'README.md', 'README.tr.md'];
// Type declarations are for tsc only.
const EXCLUDE = ['*.d.ts', '*.DS_Store'];

const out = path.join(ROOT, 'dist', `video-downloader-${version}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-q', '-r', '-X', out, ...INCLUDE, '-x', ...EXCLUDE], { cwd: ROOT, stdio: 'inherit' });
console.log(`${path.relative(ROOT, out)} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);

if (process.argv.includes('--firefox')) {
  const dir = buildFirefox(ROOT);
  const firefoxOut = path.join(ROOT, 'dist', `video-downloader-firefox-${version}.zip`);
  rmSync(firefoxOut, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', firefoxOut, '.'], { cwd: dir, stdio: 'inherit' });
  console.log(`${path.relative(ROOT, firefoxOut)} (${(statSync(firefoxOut).size / 1e6).toFixed(1)} MB)`);
}
