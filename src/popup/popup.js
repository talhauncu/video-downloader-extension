// Popup: lists media found in the active tab, starts downloads, shows the
// progress of stream jobs (HLS) and lets the user cancel them.

import { formatBytes, KIND, codecHint, QUICKTIME_UNSUPPORTED } from '../lib/media-url.js';
import { organize, subtitleChoices } from '../lib/organize.js';
import { autoPick, languageSuffix } from '../lib/subtitles.js';
import { pickAudio, audioTrackLabel } from '../lib/audio-lang.js';
import { t, initI18n, applyI18n } from '../lib/i18n.js';
import { SITES } from '../sites/index.js';

const listEl = document.getElementById('media-list');
const emptyEl = document.getElementById('empty-state');
const errorEl = document.getElementById('error-state');
const statusEl = document.getElementById('status');
const tabInfoEl = document.getElementById('tab-info');
const clearBtn = document.getElementById('clear');
const jobsSection = document.getElementById('jobs-section');
const jobsList = document.getElementById('jobs-list');
const itemTemplate = /** @type {HTMLTemplateElement} */ (document.getElementById('item-template'));
const viewToggle = document.getElementById('view-toggle');
const viewRecommendedBtn = document.getElementById('view-recommended');
const viewAllBtn = document.getElementById('view-all');
const allCount = document.getElementById('all-count');
const othersEl = document.getElementById('others');
const othersList = document.getElementById('others-list');
const othersCount = document.getElementById('others-count');
const recommendedEmpty = document.getElementById('recommended-empty');
const historySection = document.getElementById('history-section');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historyTemplate = /** @type {HTMLTemplateElement} */ (document.getElementById('history-template'));
const debugOut = /** @type {HTMLTextAreaElement} */ (document.getElementById('debug-out'));
const siteNote = document.getElementById('site-note');
const jobTemplate = /** @type {HTMLTemplateElement} */ (document.getElementById('job-template'));

const SITE_LABEL = Object.fromEntries(SITES.map((s) => [s.id, s.label]));
let currentTabUrl = '';

// Message keys; looked up when drawn (the language is known only after start-up).
const KIND_LABEL = {
  [KIND.VIDEO]: 'kindVideo',
  [KIND.AUDIO]: 'kindAudio',
  [KIND.SEGMENT]: 'kindSegment',
  [KIND.BLOB]: 'kindBlob',
  [KIND.SUBTITLE]: 'kindSubtitle',
};
const kindLabel = (kind) => (KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind.toUpperCase());
const JOB_STATE = {
  downloading: 'jobStateDownloading',
  saving: 'jobStateSaving',
  done: 'jobStateDone',
  error: 'jobStateError',
  cancelled: 'cancelled',
};
const jobStateLabel = (status) => (JOB_STATE[status] ? t(JOB_STATE[status]) : status);

let tabId = null;
let items = [];
let jobs = [];
let siteState = { applicable: false };
let view = 'recommended'; // 'recommended' | 'all' (not persisted: every popup opens on Recommended)
let hideAds = true;
let subtitleLangs = ['tr'];
let audioLang = 'default';
const describing = new Set(); // item ids whose playlist is being fetched
const chosenVariant = new Map(); // item id -> variant url
const chosenAudio = new Map(); // item id -> audio url (HLS) or representation id (DASH)
const chosenSubs = new Map(); // item id -> Set of "source|ref" (survives re-renders)
const seenSubs = new Map(); // item id -> Set of "source|ref|lang" already offered (preselected once, from settings)

// ---- messaging -----------------------------------------------------------

async function resolveTabId() {
  // Tests open the popup as a normal page with ?tabId=N.
  const fromQuery = new URLSearchParams(location.search).get('tabId');
  if (fromQuery) return Number(fromQuery);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? t('errUnknown')));
      resolve(response.result);
    });
  });
}

// ---- formatting ----------------------------------------------------------

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

function formatDuration(seconds) {
  if (seconds == null) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function metaText(item) {
  const parts = [];
  if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
  const duration = item.duration ?? item.stream?.duration;
  if (duration) parts.push(formatDuration(duration));
  if (item.size != null) parts.push(formatBytes(item.size));
  if (item.stream?.type === 'media' && item.stream.segments) parts.push(t('metaPieces', item.stream.segments));
  const codec = codecHint(item.trackTag);
  if (codec) parts.push(codec);
  return parts.join(' · ');
}

function displayName(item) {
  try {
    const u = new URL(item.url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last || u.hostname;
  } catch {
    return item.url;
  }
}

// ---- rendering: items ----------------------------------------------------

function activeJobFor(itemId) {
  return jobs.find((j) => j.itemId === itemId && (j.status === 'downloading' || j.status === 'saving'));
}

const subKey = (c) => `${c.source}|${c.ref}`;

/**
 * Subtitle chips of a card: one checkbox per language/rendition, preselected
 * with the preferred languages. Returns a getter for the download payload.
 */
function renderSubtitleChips(item, card, node) {
  const choices = item.kind === KIND.SUBTITLE ? [] : subtitleChoices(card ?? { item, subtitles: [] });
  const box = node.querySelector('.item-subs');
  if (!choices.length) return () => undefined;
  if (!chosenSubs.has(item.id)) chosenSubs.set(item.id, new Set());
  if (!seenSubs.has(item.id)) seenSubs.set(item.id, new Set());
  const chosen = chosenSubs.get(item.id);
  const seen = seenSubs.get(item.id);
  // Preselect preferred languages the first time a choice shows up (the
  // stream's renditions arrive after the page's <track>s), one per language.
  // A file's language may only be known once it was read: look again then.
  const auto = new Set(autoPick(choices, subtitleLangs).map(subKey));
  for (const c of choices) {
    const key = subKey(c);
    const seenKey = `${key}|${c.lang ?? ''}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    const langTaken = choices.some((o) => chosen.has(subKey(o)) && o.lang && o.lang === c.lang);
    if (auto.has(key) && !langTaken) chosen.add(key);
  }
  box.hidden = false;
  const title = document.createElement('span');
  title.textContent = t('popupSubtitles');
  box.appendChild(title);
  const labels = choices.map((c) => c.label);
  for (const c of choices) {
    const chip = document.createElement('label');
    chip.className = 'sub-chip';
    chip.dataset.lang = c.lang ?? '';
    chip.dataset.source = c.source;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = chosen.has(subKey(c));
    input.addEventListener('change', () => (input.checked ? chosen.add(subKey(c)) : chosen.delete(subKey(c))));
    // Same label twice (two "English" tracks): add the code to tell them apart.
    const text = labels.filter((l) => l === c.label).length > 1 && c.lang ? `${c.label} (${c.lang})` : c.label;
    chip.append(input, document.createTextNode(`${text}${c.forced ? t('popupForced') : ''}`));
    box.appendChild(chip);
  }
  return () => choices.filter((c) => chosen.has(subKey(c))).map((c) => ({ source: c.source, ref: c.ref }));
}

function renderStreamControls(item, node, btn, subtitlesOf = () => undefined) {
  const select = node.querySelector('.quality');
  const note = node.querySelector('.note');
  const info = item.stream;

  if (!info) {
    btn.disabled = true;
    btn.textContent = t('popupDescribing');
    if (!describing.has(item.id)) {
      describing.add(item.id);
      send('media:describe', { tabId, id: item.id }).catch((e) => {
        describing.delete(item.id);
        showError(t('errManifestUnreadable', e.message));
      });
    }
    return;
  }

  if (info.live) {
    btn.hidden = true;
    note.textContent = t('noteLive');
    return;
  }
  if (info.type === 'media' && info.unsupportedKey) {
    btn.hidden = true;
    note.textContent = t('noteEncrypted', info.unsupportedKey);
    return;
  }
  if (info.type === 'dash' && info.drm) {
    btn.hidden = true;
    note.textContent = t('noteDrm');
    return;
  }

  const options =
    info.type === 'master'
      ? info.variants.map((v) => ({ value: v.url, label: v.label }))
      : info.type === 'dash'
        ? info.videos.map((v) => ({ value: v.id, label: v.label }))
        : [];
  if (options.length) {
    select.hidden = false;
    select.innerHTML = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    }
    const chosen = chosenVariant.get(item.id);
    if (chosen && options.some((o) => o.value === chosen)) select.value = chosen;
    select.addEventListener('change', () => chosenVariant.set(item.id, select.value));
  }

  const audioOf = renderAudioSelect(item, node, info, select);

  const notes = [];
  if (info.subtitle) notes.push(t('noteSubtitleStream'));
  if (info.separateAudio) notes.push(t('noteSeparateAudio'));
  if (info.type === 'media' && info.encrypted) notes.push(t('noteAesEncrypted'));
  if (info.type === 'dash' && !info.videos.length && info.audios.length) notes.push(t('noteAudioOnly'));
  if (info.unsupportedSubtitles) notes.push(t('noteMp4Subtitles', info.unsupportedSubtitles));
  note.textContent = notes.join(' · ');

  btn.addEventListener('click', () => {
    const value = select.hidden ? null : select.value;
    const audio = audioOf();
    const payload = info.type === 'dash' ? { videoRepId: value, audioRepId: audio } : { variantUrl: value, audioUrl: audio };
    startDownload(item, btn, { ...payload, subtitles: subtitlesOf() });
  });
}

/**
 * Audio language menu of a stream with several languages (a dub and the
 * original). Preselects the settings' preference; the choice survives
 * re-renders. HLS lists the renditions of the chosen variant's group.
 * @returns {() => string|undefined} the chosen audio URL / representation id
 */
function renderAudioSelect(item, node, info, qualitySelect) {
  const select = node.querySelector('.audio');
  const all = info.type === 'master' ? (info.audios ?? []).filter((a) => a.url) : info.type === 'dash' ? (info.audios ?? []) : [];
  const valueOf = (a) => (info.type === 'dash' ? a.id : a.url);
  const listFor = () => {
    if (info.type !== 'master') return all;
    const variant = info.variants.find((v) => v.url === (qualitySelect.hidden ? null : qualitySelect.value)) ?? info.variants[0];
    return all.filter((a) => !variant?.audioGroup || a.groupId === variant.audioGroup);
  };
  const fill = () => {
    const list = listFor();
    const languages = new Set(list.map((a) => a.lang ?? valueOf(a)));
    select.hidden = languages.size < 2;
    if (select.hidden) return;
    const labels = list.map((a) => (info.type === 'dash' ? `${audioTrackLabel(a)} · ${a.label}` : audioTrackLabel(a)));
    select.innerHTML = '';
    list.forEach((a, i) => {
      const opt = document.createElement('option');
      opt.value = valueOf(a);
      opt.textContent = labels.filter((l) => l === labels[i]).length > 1 ? `${labels[i]} (${a.label})` : labels[i];
      opt.dataset.lang = a.lang ?? '';
      select.appendChild(opt);
    });
    const chosen = chosenAudio.get(item.id);
    select.value = chosen && list.some((a) => valueOf(a) === chosen) ? chosen : valueOf(pickAudio(list, audioLang));
  };
  fill();
  select.addEventListener('change', () => chosenAudio.set(item.id, select.value));
  qualitySelect.addEventListener('change', fill);
  return () => (select.hidden ? undefined : select.value);
}

/**
 * On a supported site (Instagram, X) without complete entries, explain why
 * only raw chunks are listed and what fixes it.
 */
function renderSiteNote(hasSiteEntries) {
  let text = '';
  if (siteState.applicable && !hasSiteEntries) {
    if (!siteState.hooked || siteState.injectedNow) {
      text = t('siteNoteReload', siteState.label ?? '');
    } else if (siteState.found === 0) {
      text = t('siteNoteNoEntries', siteState.label ?? '');
    }
  }
  siteNote.textContent = text;
  siteNote.hidden = !text;
}

/** Builds one list entry. `card` overrides display fields (merged player info). */
function renderItemNode(item, { card = null, main = false } = {}) {
  const shown = card
    ? {
        ...item,
        width: card.display.width ?? item.width,
        height: card.display.height ?? item.height,
        duration: card.display.duration ?? item.duration,
      }
    : item;
  const node = /** @type {HTMLElement} */ (itemTemplate.content.firstElementChild.cloneNode(true));
  node.dataset.id = item.id;
  node.dataset.kind = item.kind;
  if (item.site) node.dataset.site = item.site;
  if (item.hidden) node.dataset.hidden = 'true';
  if (card?.reason) node.dataset.reason = card.reason;
  if (card?.merged?.length) node.dataset.merged = String(card.merged.length);
  if (main) node.classList.add('main');
  node.querySelector('.kind').textContent = item.site ? (SITE_LABEL[item.site] ?? item.site) : kindLabel(item.kind);
  /** @type {HTMLElement} */ (node.querySelector('.badge.here')).hidden = !main;
  node.querySelector('.name').textContent =
    item.kind === KIND.BLOB ? t('popupPlayerStream') : item.site && item.title ? item.title : displayName(item);
  if (item.kind === KIND.SUBTITLE) {
    const sub = subtitleChoices({ item })[0];
    node.dataset.lang = sub.lang ?? '';
    node.querySelector('.name').textContent = `${sub.label} · ${displayName(item)}`;
  }
  /** @type {HTMLElement} */ (node.querySelector('.name')).title = item.url;
  node.querySelector('.size').textContent = metaText(shown);

  const btn = /** @type {HTMLButtonElement} */ (node.querySelector('.download'));
  const job = activeJobFor(item.id);
  const subtitlesOf = job || item.kind === KIND.BLOB ? () => undefined : renderSubtitleChips(item, card, node);
  if (item.kind === KIND.BLOB) {
    btn.hidden = true;
    node.querySelector('.note').textContent = t('noteBlob');
  } else if (job) {
    btn.disabled = true;
    btn.textContent = jobStateLabel(job.status) + '…';
  } else if (item.kind === KIND.HLS || item.kind === KIND.DASH) {
    renderStreamControls(item, node, btn, subtitlesOf);
  } else if (item.kind === KIND.SUBTITLE) {
    btn.addEventListener('click', () => startDownload(item, btn, {}));
  } else if (item.kind === KIND.VIDEO || item.kind === KIND.AUDIO) {
    const codec = codecHint(item.trackTag);
    if (codec && QUICKTIME_UNSUPPORTED.has(codec)) {
      node.querySelector('.note').textContent = t('noteQuickTime', codec);
    }
    if (card?.reason === 'ad') node.querySelector('.note').textContent = t('noteLikelyAd');
    btn.addEventListener('click', () => startDownload(item, btn, { subtitles: subtitlesOf() }));
  } else {
    btn.disabled = true;
    btn.textContent = t('popupNotDownloadable');
  }
  return node;
}

function setView(next) {
  view = next;
  viewRecommendedBtn.classList.toggle('active', view === 'recommended');
  viewAllBtn.classList.toggle('active', view === 'all');
  viewRecommendedBtn.setAttribute('aria-selected', String(view === 'recommended'));
  viewAllBtn.setAttribute('aria-selected', String(view === 'all'));
  renderItems();
}

function renderItems() {
  listEl.innerHTML = '';
  othersList.innerHTML = '';
  const o = organize(items, { tabUrl: currentTabUrl, hideAds });
  renderSiteNote(items.some((it) => it.site));

  const hasItems = items.length > 0;
  viewToggle.hidden = !hasItems;
  allCount.textContent = String(items.length);
  const ownJobs = jobs.filter((j) => !j.otherTab);
  emptyEl.hidden = hasItems || ownJobs.length > 0;
  clearBtn.hidden = !hasItems && ownJobs.length === 0;

  if (view === 'all') {
    // Previous flat list: everything, raw chunks and folded playlists included.
    for (const item of o.all) listEl.appendChild(renderItemNode(item));
    listEl.hidden = !hasItems;
    othersEl.hidden = true;
    recommendedEmpty.hidden = true;
    return;
  }

  o.recommended.forEach((card, i) =>
    listEl.appendChild(renderItemNode(card.item, { card, main: i === 0 && o.recommended.length > 0 && card === o.main })),
  );
  for (const card of o.others) othersList.appendChild(renderItemNode(card.item, { card }));
  listEl.hidden = o.recommended.length === 0;
  recommendedEmpty.hidden = !(hasItems && o.recommended.length === 0);
  othersEl.hidden = o.others.length === 0;
  othersCount.textContent = String(o.others.length);
}

// ---- rendering: jobs -----------------------------------------------------

function renderJobs() {
  jobsList.innerHTML = '';
  jobsSection.hidden = jobs.length === 0;
  for (const job of jobs) {
    const node = /** @type {HTMLElement} */ (jobTemplate.content.firstElementChild.cloneNode(true));
    node.dataset.jobId = job.jobId;
    node.classList.add(job.status);
    node.querySelector('.job-name').textContent = job.filename;
    /** @type {HTMLElement} */ (node.querySelector('.job-name')).title = job.filename;
    if (job.otherTab) {
      node.dataset.otherTab = 'true';
      const tag = document.createElement('span');
      tag.className = 'job-tab';
      tag.textContent = job.otherSite ? t('jobOtherTabSite', job.otherSite) : t('jobOtherTab');
      node.querySelector('.job-head').after(tag);
    }
    const stateEl = node.querySelector('.job-state');
    const merging = job.status === 'downloading' && job.phase === 'merging';
    const cooling = job.status === 'downloading' && job.phase === 'cooldown';
    stateEl.textContent = merging ? t('jobStateMerging') : cooling ? t('jobStateWaiting') : jobStateLabel(job.status);
    stateEl.classList.add(job.status);

    const pct =
      job.status === 'done' || job.status === 'saving'
        ? 100
        : merging
          ? Math.round((job.phaseProgress ?? 0) * 100)
          : job.total
            ? Math.round((job.done / job.total) * 100)
            : 0;
    /** @type {HTMLElement} */ (node.querySelector('.bar')).style.width = `${pct}%`;

    const detail = [];
    if (merging) detail.push(t('jobFfmpeg', t('percent', pct)));
    if (cooling) {
      const left = Math.max(0, Math.round(((job.cooldownUntil ?? Date.now()) - Date.now()) / 1000));
      const status = job.cooldownStatus ?? 429;
      detail.push(job.cooldownOf ? t('jobRateLimitOf', status, left, job.cooldownIndex, job.cooldownOf) : t('jobRateLimit', status, left));
    }
    if (job.warning) detail.push(job.warning);
    if (job.files?.some((f) => f.transcoded)) detail.push(t('jobTranscoded'));
    if (job.tracks > 1 && job.status === 'downloading' && job.track) detail.push(t('jobFileOf', job.track, job.tracks));
    if (job.audio) detail.push(t('jobAudio', job.audio));
    if (job.status === 'downloading' && job.subtitles?.length && job.kind !== 'subtitle')
      detail.push(t('jobSubtitles', job.subtitles.join(', ')));
    const embedded = job.files?.flatMap((f) => f.embeddedSubtitles ?? []) ?? [];
    if (embedded.length) detail.push(t('jobEmbedded', embedded.join(', ')));
    if (job.total) detail.push(t('progressPieces', job.done, job.total));
    if (job.retries) detail.push(t('jobRetries', job.retries));
    if (job.status === 'downloading' && job.spacingMs) detail.push(t('jobSpacing', job.spacingMs));
    if (job.refreshes) detail.push(t('jobRefreshes', job.refreshes));
    if (job.mirrorSwitches) detail.push(t('jobMirrorSwitches', job.mirrorSwitches));
    if (job.files?.length > 1 && (job.status === 'done' || job.status === 'saving')) {
      // "video.mp4 + ses.m4a + tr.srt": the part of each name after the shared stem.
      const part = new RegExp(`^.*-(${t('fileSuffixVideo')}|${t('fileSuffixAudio')})\\.`);
      detail.push(
        job.files.map((f) => (f.role === 'subtitle' ? `${languageSuffix(f.lang)}.${f.ext}` : f.filename.replace(part, '$1.'))).join(' + '),
      );
    }
    if (job.bytes) detail.push(formatBytes(job.bytes));
    if (job.status === 'error' && job.error) detail.push(job.error);
    node.querySelector('.job-detail').textContent = detail.join(' · ');

    const cancel = /** @type {HTMLButtonElement} */ (node.querySelector('.cancel'));
    cancel.hidden = job.status !== 'downloading';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        await send('media:cancel', { jobId: job.jobId });
      } catch (e) {
        showError(e.message);
      }
    });
    jobsList.appendChild(node);
  }
}

// ---- actions -------------------------------------------------------------

async function startDownload(item, btn, extra) {
  showError('');
  btn.disabled = true;
  btn.textContent = t('popupStarting');
  try {
    const result = await send('media:download', { tabId, id: item.id, ...extra });
    const subtitleOnly = result.kind === 'subtitle';
    const subs = result.subtitles && !subtitleOnly ? t('popupPlusSubtitles', result.subtitles) : '';
    if (result.jobId) {
      const what = subtitleOnly ? t('popupSubtitleDownloading') : t('popupStreamDownloading');
      const media = result.tracks - (result.subtitles ?? 0);
      showStatus((media > 1 ? t('popupStatusFiles', what, media, result.filename) : t('popupStatusFile', what, result.filename)) + subs);
    } else {
      btn.textContent = t('popupStarted');
      showStatus(t('popupDownloadStarted', result.filename) + subs);
    }
    if (result.subtitleError) showError(t('popupSubtitleStartFailed', result.subtitleError));
  } catch (error) {
    btn.disabled = false;
    btn.textContent = t('badgeDownload');
    showError(error.message);
  }
}

// ---- history -------------------------------------------------------------

function basename(path) {
  return String(path ?? '')
    .split(/[\\/]/)
    .pop();
}

function formatWhen(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderHistory() {
  const entries = await send('history:list');
  historyList.innerHTML = '';
  historyEmpty.hidden = entries.length > 0;
  for (const entry of entries) {
    const node = /** @type {HTMLElement} */ (historyTemplate.content.firstElementChild.cloneNode(true));
    const name = /** @type {HTMLElement} */ (node.querySelector('.history-name'));
    name.textContent = basename(entry.filename);
    name.title = entry.url;
    name.addEventListener('click', () => send('history:show', { downloadId: entry.downloadId }).catch((e) => showError(e.message)));
    const site = entry.pageUrl
      ? (() => {
          try {
            return new URL(entry.pageUrl).hostname.replace(/^www\./, '');
          } catch {
            return '';
          }
        })()
      : '';
    node.querySelector('.history-meta').textContent = [formatWhen(entry.at), site, formatBytes(entry.size)].filter(Boolean).join(' · ');
    historyList.appendChild(node);
  }
}

async function copyDebugInfo() {
  showError('');
  try {
    const info = await send('debug:info', { tabId });
    const text = JSON.stringify(info, null, 2);
    debugOut.value = text;
    try {
      await navigator.clipboard.writeText(text);
      showStatus(t('popupDebugCopied'));
    } catch {
      debugOut.hidden = false;
      debugOut.select();
      showStatus(t('popupDebugSelect'));
    }
  } catch (e) {
    showError(e.message);
  }
}

let tickTimer = null;
function scheduleTick() {
  clearTimeout(tickTimer);
  if (jobs.some((j) => j.status === 'downloading' && j.phase === 'cooldown')) tickTimer = setTimeout(() => renderJobs(), 1000);
}

let refreshSeq = 0;
async function refresh() {
  // Overlapping refreshes (a storage change while one runs): only the latest draws.
  const seq = ++refreshSeq;
  const result = await send('media:list', { tabId });
  if (seq !== refreshSeq) return;
  items = result.items;
  jobs = result.jobs ?? [];
  siteState = result.site ?? { applicable: false };
  renderJobs();
  renderItemsIfChanged();
  scheduleTick();
}

/**
 * Job progress changes many times a second; redrawing the list then would
 * close an open quality/audio menu under the pointer. The list is redrawn
 * only when what it shows changed (entries, which ones are downloading),
 * and not while one of its menus has focus (redrawn when it loses it).
 */
let itemsShown = null;
let itemsPending = false;
function itemsSignature() {
  const active = jobs.filter((j) => j.status === 'downloading' || j.status === 'saving').map((j) => [j.itemId, j.status]);
  return JSON.stringify([items.map(({ requests, lastSeen, ...rest }) => rest), active, siteState]);
}
function menuOpen() {
  const el = document.activeElement;
  return el?.tagName === 'SELECT' && (listEl.contains(el) || othersList.contains(el));
}
function renderItemsIfChanged() {
  const signature = itemsSignature();
  if (signature === itemsShown) return;
  if (menuOpen()) {
    itemsPending = true;
    return;
  }
  itemsShown = signature;
  itemsPending = false;
  renderItems();
}
for (const list of [listEl, othersList]) {
  list.addEventListener('focusout', () =>
    setTimeout(() => {
      if (itemsPending && !menuOpen()) renderItemsIfChanged();
    }),
  );
}

async function main() {
  try {
    tabId = await resolveTabId();
    if (tabId == null) throw new Error(t('errNoActiveTab'));
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) {
      currentTabUrl = tab.url;
      try {
        tabInfoEl.textContent = new URL(tab.url).hostname;
      } catch {
        tabInfoEl.textContent = '';
      }
    }
    const settings = await send('settings:get').catch(() => ({ hideAds: true, subtitleLangs: ['tr'], uiLanguage: 'auto' }));
    await initI18n(settings.uiLanguage).catch(() => {});
    applyI18n(document);
    for (const template of document.querySelectorAll('template')) applyI18n(template.content);
    hideAds = settings.hideAds !== false;
    subtitleLangs = settings.subtitleLangs ?? ['tr'];
    audioLang = settings.audioLang ?? 'default';
    // Live updates while the popup is open: tab list or any job changed.
    // Listen before the first read, or a change in between (a playlist
    // described meanwhile) is lost and the card stays "Reading…".
    chrome.storage.session.onChanged.addListener((changes) => {
      const relevant = Object.keys(changes).some((key) => key === `tab:${tabId}` || key.startsWith('job:'));
      if (relevant) refresh().catch((e) => showError(e.message));
    });
    await refresh();

    viewRecommendedBtn.addEventListener('click', () => setView('recommended'));
    viewAllBtn.addEventListener('click', () => setView('all'));

    document.getElementById('history-toggle').addEventListener('click', async () => {
      historySection.hidden = !historySection.hidden;
      if (!historySection.hidden) await renderHistory();
    });
    document.getElementById('history-clear').addEventListener('click', async () => {
      await send('history:clear');
      await renderHistory();
    });
    document.getElementById('debug').addEventListener('click', copyDebugInfo);
    document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    chrome.storage.local.onChanged.addListener((changes) => {
      if ('history' in changes && !historySection.hidden) renderHistory().catch(() => {});
    });

    clearBtn.addEventListener('click', async () => {
      await send('media:clear', { tabId });
      await refresh();
    });
  } catch (error) {
    showError(error.message);
  }
}

main();
