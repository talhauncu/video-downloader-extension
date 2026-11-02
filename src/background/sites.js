// Site extractors (src/sites/): registered as content scripts for their
// sites, and additionally injected on demand (popup open, page load) because
// registered scripts do not reach tabs that were loaded before the extension
// was (re)loaded. Everything here is derived from the site definitions.

import { SITES, BRIDGE_SCRIPT, siteForUrl } from '../sites/index.js';

/** Test hosts: {site, re}. Tests point a site at the fixture server. */
const extraHosts = [];

/** Tests add the fixture host here (for every site, or one). */
export function addSiteHost(hostname, siteId = null) {
  const re = new RegExp(`^${hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  for (const site of SITES) if (!siteId || site.id === siteId) extraHosts.push({ site: site.id, re });
}

/** The site definition of a page, if it has an extractor. */
export function siteOfUrl(url) {
  return siteForUrl(url, extraHosts);
}

export function isSiteUrl(url) {
  return Boolean(siteOfUrl(url));
}

/** @type {Promise<unknown>} */
let registering = Promise.resolve();

/**
 * Registers (or updates) every site's extractor and bridge. Calls run one
 * after another: two overlapping calls (worker start-up and a caller) would
 * both see "not registered" and the second registration fails as a duplicate.
 * @param {string[]|null} [matches]  tests: these match patterns instead of each site's own
 */
export function registerSiteScripts(matches = null) {
  const run = registering.then(() => registerNow(matches));
  registering = run.catch(() => {});
  return run;
}

/** Content scripts of a site: its extractor in the main world, the shared bridge in the isolated one. */
function scriptsOf(site, matches = site.matches) {
  return [
    { id: `${site.id}-main`, matches, js: [site.main], world: 'MAIN', runAt: 'document_start', allFrames: false },
    { id: `${site.id}-bridge`, matches, js: [BRIDGE_SCRIPT], world: 'ISOLATED', runAt: 'document_start', allFrames: false },
  ];
}

async function registerNow(matches) {
  /** @type {chrome.scripting.RegisteredContentScript[]} */
  const scripts = /** @type {any[]} */ (SITES.flatMap((site) => scriptsOf(site, matches ?? site.matches)));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: scripts.map((s) => s.id) });
  const existingIds = new Set(existing.map((s) => s.id));
  const toUpdate = scripts.filter((s) => existingIds.has(s.id));
  const toRegister = scripts.filter((s) => !existingIds.has(s.id));
  if (toUpdate.length) await chrome.scripting.updateContentScripts(toUpdate);
  if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);
  return scripts.map((s) => s.id);
}

/** Runs in the page's main world: is the extractor there, and what has it seen? */
function probeMainWorld(globals) {
  const w = /** @type {any} */ (window);
  return {
    hooked: Boolean(w[globals.hooked]),
    version: w[globals.version] ?? (w[globals.hooked] ? 1 : 0),
    stats: w[globals.stats] ?? null,
    jsonScripts: document.querySelectorAll('script[type="application/json"]').length,
    readyState: document.readyState,
  };
}

/**
 * The extractor's state in a tab (debug info, injection check). Without a
 * site: the tab's site, else the first site whose extractor is there (a
 * registered script may run on a host the site list does not name), else
 * the first site's (empty) state.
 */
export async function probeTab(tabId, site = null) {
  try {
    const own = site ?? siteOfUrl((await chrome.tabs.get(tabId))?.url ?? '');
    const results = [];
    for (const target of own ? [own] : SITES) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeMainWorld,
        args: [target.globals],
      });
      if (res?.result) results.push({ site: target.id, ...res.result });
    }
    return results.find((r) => r.hooked) ?? results[0] ?? null;
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** Is a bridge of THIS extension instance alive in the tab's top frame? */
export async function pingBridge(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'bridge:ping' }, { frameId: 0 });
    return Boolean(res?.alive);
  } catch {
    return false; // no receiver: never injected, or orphaned by an extension reload
  }
}

/**
 * Makes sure the site's extractor and the bridge run in the tab's top frame.
 * Returns what was done so the popup/debug info can show it.
 */
export async function ensureInjected(tabId, url) {
  const site = siteOfUrl(url);
  if (!site) return { applicable: false };
  /** @type {any} */
  const probe = await probeTab(tabId, site);
  if (probe?.error) return { applicable: true, site: site.id, injected: false, probe };
  const bridgeAlive = await pingBridge(tabId);
  const mainCurrent = Boolean(probe?.hooked) && probe.version === site.version;
  if (mainCurrent && bridgeAlive) return { applicable: true, site: site.id, injected: false, probe };
  try {
    // A main-world extractor survives extension reloads (page global) while the
    // bridge does not; the new bridge asks it to replay what it has found.
    if (!bridgeAlive) {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [BRIDGE_SCRIPT] });
    }
    if (!mainCurrent) {
      // Missing or outdated extractor: install the current one. It rescans the
      // page's inline data itself; an old instance keeps running harmlessly.
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [site.main] });
    }
    return {
      applicable: true,
      site: site.id,
      injected: true,
      bridgeInjected: !bridgeAlive,
      mainInjected: !mainCurrent,
      probe: await probeTab(tabId, site),
    };
  } catch (error) {
    return { applicable: true, site: site.id, injected: false, error: String(error?.message ?? error), probe };
  }
}

export function watchSiteTabs() {
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status === 'complete' && tab?.url && isSiteUrl(tab.url)) {
      ensureInjected(tabId, tab.url).catch(() => {});
    }
  });
}
