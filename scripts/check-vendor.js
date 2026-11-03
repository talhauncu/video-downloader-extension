// Checks that src/vendor/ holds the npm packages' files unchanged: every
// vendored file must be byte-identical (SHA-256) to its source in
// node_modules, the installed versions must be the ones in package-lock.json,
// and the versions written in src/vendor/ffmpeg/VERSIONS and
// THIRD_PARTY_LICENSES.md must match them. Run after `npm ci`.
//   npm run check:vendor
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where each vendored file comes from. `src` is relative to the package directory. */
export const SOURCES = [
  { file: 'src/vendor/mux-mp4.min.js', pkg: 'mux.js', src: 'dist/mux-mp4.min.js' },
  { dir: 'src/vendor/ffmpeg', pkg: '@ffmpeg/core', src: 'dist/esm', match: /^ffmpeg-core\./ },
  { dir: 'src/vendor/ffmpeg', pkg: '@ffmpeg/ffmpeg', src: 'dist/esm', match: /^(?!ffmpeg-core\.).*\.(js|mjs|d\.ts)$/ },
  { dir: 'src/vendor/ffmpeg-mt', pkg: '@ffmpeg/core-mt', src: 'dist/esm', match: /^ffmpeg-core\./ },
];
/** Our own notes next to the vendored files. */
export const NOTES = ['src/vendor/ffmpeg/VERSIONS'];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

/**
 * @param {string} root  repository root
 * @returns {{problems: string[], checked: number}}
 */
export function checkVendor(root) {
  const problems = [];
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const lock = readJson(path.join(root, 'package-lock.json'));

  // Versions: lock file = installed package.
  const versions = {};
  for (const pkg of new Set(SOURCES.map((s) => s.pkg))) {
    const locked = lock.packages?.[`node_modules/${pkg}`]?.version ?? null;
    let installed;
    try {
      installed = readJson(path.join(root, 'node_modules', pkg, 'package.json')).version;
    } catch {
      problems.push(`${pkg}: not installed (run npm ci)`);
      continue;
    }
    if (!locked) problems.push(`${pkg}: missing from package-lock.json`);
    else if (installed !== locked) problems.push(`${pkg}: installed ${installed}, package-lock.json says ${locked}`);
    versions[pkg] = locked ?? installed;
  }

  // Files: every vendored file has exactly one source and the same bytes.
  const vendored = filesUnder(path.join(root, 'src/vendor')).map(rel);
  let checked = 0;
  for (const file of vendored) {
    if (NOTES.includes(file) || path.basename(file) === '.DS_Store') continue;
    const name = path.basename(file);
    const source = SOURCES.find((s) => (s.file ? s.file === file : path.dirname(file) === s.dir && s.match.test(name)));
    if (!source) {
      problems.push(`${file}: no npm source is known for it (add it to SOURCES in scripts/check-vendor.js)`);
      continue;
    }
    const from = path.join(root, 'node_modules', source.pkg, source.file ? source.src : path.join(source.src, name));
    let expected;
    try {
      expected = sha256(from);
    } catch {
      problems.push(`${file}: ${rel(from)} does not exist`);
      continue;
    }
    if (sha256(path.join(root, file)) !== expected)
      problems.push(`${file}: differs from ${rel(from)} (${source.pkg} ${versions[source.pkg]})`);
    checked++;
  }

  // Written versions: VERSIONS and the third-party licence table.
  const notes = readFileSync(path.join(root, 'src/vendor/ffmpeg/VERSIONS'), 'utf8');
  const table = readFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), 'utf8');
  for (const [pkg, version] of Object.entries(versions)) {
    if (pkg.startsWith('@ffmpeg/') && !new RegExp(`^${escape(pkg)}\\s+${escape(version)}\\b`, 'm').test(notes))
      problems.push(`src/vendor/ffmpeg/VERSIONS: ${pkg} should be ${version}`);
    const row = table.split('\n').find((line) => line.startsWith('|') && line.includes(`[${pkg}]`));
    if (!row || !row.split('|').some((cell) => cell.trim() === version))
      problems.push(`THIRD_PARTY_LICENSES.md: ${pkg} should be ${version}`);
  }
  return { problems, checked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, checked } = checkVendor(root);
  if (problems.length) {
    console.error(`Vendored files do not match their npm packages:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`src/vendor: ${checked} files match their npm packages.`);
}
