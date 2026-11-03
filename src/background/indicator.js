// Toolbar indicator for running downloads. While any download runs (in any
// tab, also after its tab was closed or reloaded) every tab's toolbar badge
// shows the overall progress in green ("%42", or "3↓" for several downloads)
// and the button tooltip names them. When the last one finishes a check mark
// is shown briefly, then the per-tab video counts come back.

import { activeDirectJobs } from './downloads.js';
import { updateBadge } from './badge.js';
import { t } from '../lib/i18n.js';

const GREEN = '#1a7f37';
let state = { count: 0, text: '' };
let lastDirect = []; // direct jobs seen running in the previous round
let timer = null;
let ticker = null;
let doneUntil = 0;

export function isIndicatorActive() {
  return state.count > 0 || Date.now() < doneUntil;
}

async function compute() {
  /** @type {Record<string, any>} */
  const all = await chrome.storage.session.get(null);
  const streams = Object.entries(all)
    .filter(([key, v]) => key.startsWith('job:') && ['queued', 'downloading', 'saving'].includes(v.status))
    .map(([, v]) => v);
  const fractions = streams.map((j) => (j.status === 'saving' ? 1 : j.phase === 'merging' ? 0.99 : j.total ? j.done / j.total : 0));
  const names = streams.map((j) => j.filename);

  const direct = activeDirectJobs();
  lastDirect = [...new Set([...lastDirect.filter((j) => !j.outcome), ...direct])];
  if (direct.length) {
    const running = await chrome.downloads.search({ state: 'in_progress' });
    for (const job of direct) {
      const entry = running.find((d) => d.id === job.downloadId);
      fractions.push(entry?.totalBytes > 0 ? entry.bytesReceived / entry.totalBytes : 0);
      names.push(job.filename);
    }
  }
  const count = fractions.length;
  const pct = count ? Math.floor((fractions.reduce((a, b) => a + b, 0) / count) * 100) : 0;
  return { count, pct, names };
}

async function forEachTab(fn) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => fn(t.id).catch(() => {})));
}

async function apply() {
  timer = null;
  const next = await compute();
  if (next.count > 0) {
    const text = next.count > 1 ? `${next.count}↓` : t('percent', next.pct);
    state = { count: next.count, text };
    doneUntil = 0;
    await chrome.action.setBadgeBackgroundColor({ color: GREEN });
    await forEachTab(async (tabId) => {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: GREEN });
    });
    const list = next.names.slice(0, 3).join(', ') + (next.names.length > 3 ? '…' : '');
    await chrome.action.setTitle({ title: t('indicatorTitle', t('extName'), next.count, t('percent', next.pct), list) });
    if (!ticker) ticker = setInterval(schedule, 1000); // plain files report no events between bytes
    return;
  }
  const wasActive = state.count > 0;
  state = { count: 0, text: '' };
  // A check mark only when something actually finished (not after a cancel).
  /** @type {Record<string, any>} */
  const all = await chrome.storage.session.get(null);
  const finishedOk =
    Object.entries(all).some(([k, v]) => k.startsWith('job:') && v.status === 'done' && Date.now() - (v.updatedAt ?? 0) < 10_000) ||
    lastDirect.some((j) => j.outcome?.state === 'done');
  lastDirect = [];
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  await chrome.action.setTitle({ title: t('extName') });
  if (wasActive && !finishedOk) {
    await forEachTab((tabId) => updateBadge(tabId));
  } else if (wasActive) {
    // Brief check mark, then the per-tab counts.
    doneUntil = Date.now() + 4000;
    await forEachTab((tabId) => chrome.action.setBadgeText({ tabId, text: '✓' }));
    setTimeout(() => {
      doneUntil = 0;
      forEachTab((tabId) => updateBadge(tabId));
    }, 4000);
  }
}

/** Recomputes soon (debounced). */
export function schedule() {
  if (!timer) timer = setTimeout(() => apply().catch(() => {}), 250);
}

export function startIndicator() {
  chrome.storage.session.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => k.startsWith('job:'))) schedule();
  });
  chrome.downloads.onCreated.addListener(schedule);
  chrome.downloads.onChanged.addListener(schedule);
  // New or reloaded tabs get the indicator too.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && state.count > 0) chrome.action.setBadgeText({ tabId, text: state.text }).catch(() => {});
  });
  schedule();
}
