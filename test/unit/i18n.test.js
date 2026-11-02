import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitute, t, setMessages, effectiveLanguage } from '../../src/lib/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (lang) => JSON.parse(readFileSync(path.join(ROOT, `_locales/${lang}/messages.json`), 'utf8'));
const en = load('en');
const tr = load('tr');

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|html)$/.test(name)) out.push(p);
  }
  return out;
}
const sources = [...files(path.join(ROOT, 'src')), path.join(ROOT, 'manifest.json')].map((p) => [p, readFileSync(p, 'utf8')]);
const all = sources.map(([, text]) => text).join('\n');

test('en and tr have the same keys, none empty, valid names', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  for (const [lang, messages] of [
    ['en', en],
    ['tr', tr],
  ]) {
    for (const [key, value] of Object.entries(messages)) {
      assert.match(key, /^[A-Za-z0-9_]+$/, `${lang}: ${key}`);
      assert.ok(value.message?.length, `${lang}: ${key} is empty`);
    }
  }
});

test('placeholders ($1…) match between the languages', () => {
  const holes = (text) => [...new Set(text.match(/\$[1-9]/g) ?? [])].sort().join();
  for (const key of Object.keys(en)) assert.equal(holes(tr[key].message), holes(en[key].message), key);
});

test('every key the code, the pages and the manifest use exists', () => {
  const used = new Set();
  for (const [, text] of sources) {
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n(?:-html|-title|-placeholder)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  }
  const missing = [...used].filter((key) => !en[key]);
  assert.deepEqual(missing, []);
});

test('every message is used somewhere (no dead entries)', () => {
  const unused = Object.keys(en).filter((key) => !all.includes(`'${key}'`) && !all.includes(`"${key}"`) && !all.includes(`__MSG_${key}__`));
  assert.deepEqual(unused, []);
});

test('substitute and t fill $1… like chrome.i18n; missing keys show the key', () => {
  assert.equal(substitute('Piece $1/$2 ($$)', [3, 4]), 'Piece 3/4 ($)');
  setMessages(en, 'en');
  assert.equal(t('stepPieceOf', 3, 841), 'Piece 3/841');
  assert.equal(t('noSuchKey'), 'noSuchKey');
  setMessages(tr, 'tr');
  assert.equal(t('stepPieceOf', 3, 841), 'Parça 3/841');
  assert.equal(effectiveLanguage('en'), 'en');
  assert.equal(effectiveLanguage('tr'), 'tr');
});

test('no "$1$2": Chrome reads "$2$" as an undefined named placeholder and refuses to load the extension', () => {
  for (const [lang, messages] of [
    ['en', en],
    ['tr', tr],
  ]) {
    for (const [key, value] of Object.entries(messages)) assert.doesNotMatch(value.message, /\$[A-Za-z0-9_@]+\$/, `${lang}: ${key}`);
  }
});
