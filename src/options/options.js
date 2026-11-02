import { buildFilename, DEFAULT_TEMPLATE } from '../lib/filename.js';
import { t, initI18n, applyI18n } from '../lib/i18n.js';

const fields = [
  'mergeTracks',
  'preferH264',
  'transcodeToH264',
  'concurrency',
  'stripJunk',
  'maxCooldownMinutes',
  'hideAds',
  'badgeMode',
  'badgeDisabledHosts',
  'filenameTemplate',
  'historyLimit',
  'subtitleLangs',
  'subtitleFormat',
  'embedSubtitles',
  'audioLang',
  'uiLanguage',
];
/** @type {Record<string, any>} */
const el = Object.fromEntries(fields.map((f) => [f, document.getElementById(f)]));
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');

function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? t('errUnknown')));
      resolve(response.result);
    });
  });
}

function show(settings) {
  el.mergeTracks.checked = settings.mergeTracks;
  el.transcodeToH264.checked = settings.transcodeToH264;
  el.preferH264.checked = settings.preferH264;
  el.stripJunk.checked = settings.stripJunk;
  el.maxCooldownMinutes.value = settings.maxCooldownMinutes;
  el.hideAds.checked = settings.hideAds;
  el.badgeMode.value = settings.badgeMode;
  // Do not rewrite the textarea while the user is typing in it.
  if (document.activeElement !== el.badgeDisabledHosts) el.badgeDisabledHosts.value = settings.badgeDisabledHosts.join('\n');
  el.concurrency.value = settings.concurrency;
  el.filenameTemplate.value = settings.filenameTemplate;
  el.historyLimit.value = settings.historyLimit;
  if (document.activeElement !== el.subtitleLangs) el.subtitleLangs.value = settings.subtitleLangs.join(', ');
  el.subtitleFormat.value = settings.subtitleFormat;
  el.embedSubtitles.checked = settings.embedSubtitles;
  el.audioLang.value = settings.audioLang;
  el.uiLanguage.value = settings.uiLanguage;
  preview();
}

function preview() {
  previewEl.textContent = buildFilename({
    pageUrl: 'https://www.ornek-site.com/video/123',
    title: t('optPreviewTitle'),
    ext: 'mp4',
    quality: '1080p',
    template: el.filenameTemplate.value,
  });
}

function read() {
  return {
    mergeTracks: el.mergeTracks.checked,
    transcodeToH264: el.transcodeToH264.checked,
    preferH264: el.preferH264.checked,
    stripJunk: el.stripJunk.checked,
    maxCooldownMinutes: Number(el.maxCooldownMinutes.value),
    hideAds: el.hideAds.checked,
    badgeMode: el.badgeMode.value,
    badgeDisabledHosts: el.badgeDisabledHosts.value,
    concurrency: Number(el.concurrency.value),
    filenameTemplate: el.filenameTemplate.value,
    historyLimit: Number(el.historyLimit.value),
    subtitleLangs: el.subtitleLangs.value,
    subtitleFormat: el.subtitleFormat.value,
    embedSubtitles: el.embedSubtitles.checked,
    audioLang: el.audioLang.value,
    uiLanguage: el.uiLanguage.value,
  };
}

let saveTimer = null;
function scheduleSave() {
  preview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const before = document.documentElement.dataset.uiLanguage;
      const saved = await send('settings:set', read());
      // A new interface language redraws the page's texts.
      if (saved.uiLanguage !== before) await localize(saved.uiLanguage);
      show(saved);
      statusEl.textContent = t('optSaved');
      setTimeout(() => (statusEl.textContent = ''), 1500);
    } catch (e) {
      statusEl.textContent = t('optSaveFailed', e.message);
    }
  }, 250);
}

for (const f of fields) el[f].addEventListener('input', scheduleSave);
document.getElementById('resetTemplate').addEventListener('click', () => {
  el.filenameTemplate.value = DEFAULT_TEMPLATE;
  scheduleSave();
});
document.getElementById('clearHistory').addEventListener('click', async () => {
  await send('history:clear');
  statusEl.textContent = t('optHistoryCleared');
});

async function localize(uiLanguage) {
  await initI18n(uiLanguage).catch(() => {});
  applyI18n(document);
  document.documentElement.dataset.uiLanguage = uiLanguage;
}

send('settings:get')
  .then(async (settings) => {
    await localize(settings.uiLanguage);
    show(settings);
  })
  .catch((e) => (statusEl.textContent = e.message));
