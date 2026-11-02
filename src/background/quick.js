// "Download the best thing on this tab" — used by the keyboard shortcut.
// Uses the same ranking as the popup's "Ana video" card (src/lib/organize.js).

import * as store from './store.js';
import { KIND } from '../lib/media-url.js';
import { organize } from '../lib/organize.js';
import { getSettings } from '../lib/settings.js';
import { startDownload } from './start.js';
import { t } from '../lib/i18n.js';

function downloadable(item) {
  if (item.stream?.live || item.stream?.drm || item.stream?.unsupportedKey) return false;
  return [KIND.VIDEO, KIND.AUDIO, KIND.HLS, KIND.DASH].includes(item.kind);
}

/** @returns {Promise<{started:boolean, reason?:string, item?:Object, result?:Object}>} */
export async function downloadBest(tabId) {
  const [tab, items, settings] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), store.list(tabId), getSettings()]);
  const { recommended } = organize(items, { tabUrl: tab?.url ?? '', hideAds: settings.hideAds });
  const best = recommended.map((c) => c.item).find(downloadable);
  if (!best) return { started: false, reason: t('errNoVideoInTab') };

  const result = await startDownload({ tabId, id: best.id, subtitles: 'auto' });
  return { started: true, item: { id: best.id, kind: best.kind, url: best.url }, result };
}

async function flashBadge(tabId, text) {
  try {
    const previous = await chrome.action.getBadgeText({ tabId });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: previous }).catch(() => {}), 1500);
  } catch {
    // tab gone
  }
}

export function registerCommands() {
  chrome.commands?.onCommand.addListener(async (command, tab) => {
    if (command !== 'download-best') return;
    const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId == null) return;
    try {
      const res = await downloadBest(tabId);
      await flashBadge(tabId, res.started ? '↓' : '–');
    } catch (error) {
      console.warn('[video-downloader] shortcut failed', error);
      await flashBadge(tabId, '!');
    }
  });
}
