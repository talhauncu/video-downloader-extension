// User-facing text. Messages live in _locales/<lang>/messages.json (the
// Chrome i18n format). By default Chrome's own language is used
// (chrome.i18n); the "uiLanguage" setting can pick English or Turkish
// instead, and places without chrome.i18n (the offscreen document, Node
// tests) get the messages handed to them with setMessages().

export const UI_LANGUAGES = ['en', 'tr'];
export const DEFAULT_LANGUAGE = 'en';

/** @type {Record<string, {message:string}>|null} */
let messages = null;
let language = null;

/** Uses these messages (one locale's messages.json) instead of chrome.i18n. */
export function setMessages(next, lang = null) {
  messages = next;
  language = lang;
}

/** Fills $1…$9 (and $$) like chrome.i18n.getMessage does. */
export function substitute(text, subs = []) {
  return text.replace(/\$(\$|[1-9])/g, (m, which) => (which === '$' ? '$' : String(subs[Number(which) - 1] ?? '')));
}

/**
 * Message `key` with $1… replaced by `subs`. Falls back to the key itself,
 * so a missing message shows up instead of an empty label.
 * @param {string} key
 * @param {...(string|number)} subs
 */
export function t(key, ...subs) {
  const entry = messages?.[key];
  if (entry) return substitute(entry.message, subs);
  const viaChrome = globalThis.chrome?.i18n?.getMessage?.(key, subs.map(String));
  return viaChrome || key;
}

/** The language in effect: the setting, else Chrome's UI language when we have it, else English. */
export function effectiveLanguage(setting = 'auto') {
  if (UI_LANGUAGES.includes(setting)) return setting;
  const ui = (globalThis.chrome?.i18n?.getUILanguage?.() ?? globalThis.navigator?.language ?? '').toLowerCase().split('-')[0];
  return UI_LANGUAGES.includes(ui) ? ui : DEFAULT_LANGUAGE;
}

export function currentLanguage() {
  return language ?? effectiveLanguage();
}

/** Reads one locale's messages.json from the extension package. */
export async function loadMessages(lang) {
  const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
  return res.json();
}

/**
 * Follows the "uiLanguage" setting: 'auto' leaves the work to chrome.i18n
 * (when present); 'en' / 'tr' load that locale's messages.
 * @param {string} setting
 * @param {{always?:boolean}} [opts]  always: load the messages even for 'auto' (no chrome.i18n here)
 */
export async function initI18n(setting = 'auto', { always = false } = {}) {
  if (setting === 'auto' && !always && globalThis.chrome?.i18n) {
    setMessages(null, null);
    return effectiveLanguage(setting);
  }
  const lang = effectiveLanguage(setting);
  setMessages(await loadMessages(lang), lang);
  return lang;
}

/**
 * Fills a page's static text: data-i18n (text), data-i18n-title,
 * data-i18n-placeholder, data-i18n-html (trusted markup from our own
 * messages: <code>, <b>). Sets <html lang>.
 * @param {ParentNode} root
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]'))
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  if (root === document) document.documentElement.lang = currentLanguage();
}
