import * as store from './store.js';
import { organize, badgeCount } from '../lib/organize.js';
import { getSettings } from '../lib/settings.js';
import { isIndicatorActive } from './indicator.js';

/** Shows the number of recommended videos (ads, sub-playlists and raw chunks excluded). */
export async function updateBadge(tabId) {
  // The download indicator owns the badge while downloads run.
  if (isIndicatorActive()) return;
  try {
    const [items, tab, settings] = await Promise.all([store.list(tabId), chrome.tabs.get(tabId).catch(() => null), getSettings()]);
    const n = badgeCount(organize(items, { tabUrl: tab?.url ?? '', hideAds: settings.hideAds }));
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    if (n) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0969da' });
  } catch {
    // Tab may already be gone.
  }
}
