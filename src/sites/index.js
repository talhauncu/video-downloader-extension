// Site extractors: page code that finds complete files the network capture
// cannot (progressive MP4s with audio on Instagram, X and Facebook). Each site is a pure
// definition here; the service worker derives the content script
// registration, the injection check and the entries from it
// (src/background/sites.js). See docs/sites.md to add one.

import instagram from './instagram/site.js';
import twitter from './twitter/site.js';
import facebook from './facebook/site.js';

/**
 * @typedef {Object} SiteDefinition
 * @property {string} id            lower-case, also the entries' `site` and the script ids (`<id>-main`)
 * @property {string} label         shown on the popup card
 * @property {RegExp[]} hosts       top-frame host names the site lives on (decides injection)
 * @property {string[]} matches     content script match patterns for the same hosts
 * @property {string} main          path of the extractor, run in the page's main world
 * @property {number} version       must equal the extractor's own VERSION; a page holding an older one gets the new one
 * @property {{hooked:string, version:string, stats:string}} globals  window properties the extractor sets (probe)
 * @property {'page'|'frame'} fetchContext  Referer/Origin its URLs need: the tab's page or the reporting frame
 * @property {(report:{items?:Object[]}, ctx:{pageUrl:string|null}) => {entry:Object, sizeFrom?:string, describe?:boolean}[]} toItems
 *   store entries for one extractor report; sizeFrom: URL to HEAD for the size; describe: read its manifest now
 * @property {(url:string) => string|null} [chunkOf]
 *   optional: the key of the entry a captured player chunk (playlist, segment) belongs to; the list hides
 *   the chunk behind that entry once it exists
 */

/** Shared isolated-world bridge (relays every site's reports). */
export const BRIDGE_SCRIPT = 'src/sites/bridge.js';

/** @type {SiteDefinition[]} */
export const SITES = [instagram, twitter, facebook];

export function siteById(id) {
  return SITES.find((s) => s.id === id) ?? null;
}

/** Key of the site entry a captured URL is a piece of (see SiteDefinition.chunkOf), else null. */
export function siteChunkKey(url, sites = SITES) {
  for (const site of sites) {
    const key = site.chunkOf?.(url);
    if (key) return key;
  }
  return null;
}

/** The site a page belongs to (by its top-frame host), with test hosts added on top. */
export function siteForUrl(url, extraHosts = [], sites = SITES) {
  let hostname;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return null;
  }
  return (
    sites.find((s) => s.hosts.some((re) => re.test(hostname)) || extraHosts.some((h) => h.site === s.id && h.re.test(hostname))) ?? null
  );
}

/** Problems of one definition; empty when it is complete. */
export function validateSite(def) {
  const errors = [];
  const need = (ok, what) => ok || errors.push(`${def?.id ?? '?'}: ${what}`);
  need(typeof def?.id === 'string' && /^[a-z][a-z0-9-]*$/.test(def.id), 'id: lower-case letters, digits, dashes');
  need(typeof def?.label === 'string' && def.label.length > 0, 'label missing');
  need(Array.isArray(def?.hosts) && def.hosts.length > 0 && def.hosts.every((h) => h instanceof RegExp), 'hosts: at least one RegExp');
  need(
    Array.isArray(def?.matches) && def.matches.length > 0 && def.matches.every((m) => /^(\*|https?):\/\/[^/]+\/.*$/.test(m)),
    'matches: content script match patterns',
  );
  need(
    typeof def?.main === 'string' && def.main.startsWith(`src/sites/${def?.id}/`) && def.main.endsWith('.js'),
    'main: src/sites/<id>/*.js',
  );
  need(Number.isInteger(def?.version) && def.version > 0, 'version: positive integer');
  need(
    ['hooked', 'version', 'stats'].every((k) => typeof def?.globals?.[k] === 'string'),
    'globals: hooked, version, stats',
  );
  need(['page', 'frame'].includes(def?.fetchContext), "fetchContext: 'page' or 'frame'");
  need(typeof def?.toItems === 'function', 'toItems missing');
  need(def?.chunkOf === undefined || typeof def.chunkOf === 'function', 'chunkOf: a function when given');
  return errors;
}

/** Problems of a set of definitions: each one's, duplicate ids, and a host claimed twice. */
export function validateSites(sites = SITES) {
  const errors = sites.flatMap(validateSite);
  const ids = sites.map((s) => s.id);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) errors.push(`duplicate id: ${id}`);
  const patterns = sites.flatMap((s) => s.matches.map((m) => [m, s.id]));
  for (const [m, id] of patterns) {
    const other = patterns.find(([m2, id2]) => id2 !== id && m2 === m);
    if (other && id < other[1]) errors.push(`match pattern ${m} claimed by ${id} and ${other[1]}`);
  }
  // Each site's hosts must not cover another site's sample host (its first match pattern's host).
  for (const s of sites) {
    for (const o of sites) {
      if (o === s) continue;
      const sample = o.matches[0]?.replace(/^[^:]+:\/\/\*?\.?/, '').replace(/\/.*$/, '');
      if (sample && s.hosts.some((re) => re.test(sample))) errors.push(`${s.id} hosts also match ${o.id} (${sample})`);
    }
  }
  return errors;
}
