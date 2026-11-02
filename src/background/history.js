// Download history: the last N completed downloads in chrome.storage.local.

import { getSettings } from '../lib/settings.js';

const KEY = 'history';
let chain = Promise.resolve();

function serialized(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

export function listHistory() {
  return serialized(async () => /** @type {any[]} */ ((await chrome.storage.local.get(KEY))[KEY] ?? []));
}

/** @param {{filename:string, url:string, pageUrl?:string|null, size?:number|null, downloadId?:number, kind?:string, site?:string|null, path?:string|null}} entry */
export function recordDownload(entry) {
  return serialized(async () => {
    const { historyLimit } = await getSettings();
    const list = /** @type {any[]} */ ((await chrome.storage.local.get(KEY))[KEY] ?? []);
    list.unshift({ id: crypto.randomUUID(), at: Date.now(), ...entry });
    const trimmed = list.slice(0, historyLimit);
    await chrome.storage.local.set({ [KEY]: trimmed });
    return trimmed.length;
  });
}

export function clearHistory() {
  return serialized(() => chrome.storage.local.remove(KEY));
}
