// Subtitle helpers: parse WebVTT / SubRip / TTML into cues, merge segmented
// WebVTT (HLS), convert to .srt or .vtt, and pick tracks by language.
// Pure functions (no chrome.*), used by the service worker, the offscreen
// document, the popup and unit tests.
//
// Cue model: { start, end, text } with times in seconds and `text` in WebVTT
// cue markup (tags like <i>, entities like &amp;), lines joined with "\n".

import { t } from './i18n.js';

// ---- languages -----------------------------------------------------------

/** ISO 639-1 → [ISO 639-2/T, display name]. Common languages only. */
const LANGUAGES = {
  tr: ['tur', 'Türkçe'],
  en: ['eng', 'English'],
  de: ['deu', 'Deutsch'],
  fr: ['fra', 'Français'],
  es: ['spa', 'Español'],
  it: ['ita', 'Italiano'],
  pt: ['por', 'Português'],
  nl: ['nld', 'Nederlands'],
  ru: ['rus', 'Русский'],
  uk: ['ukr', 'Українська'],
  pl: ['pol', 'Polski'],
  cs: ['ces', 'Čeština'],
  sv: ['swe', 'Svenska'],
  da: ['dan', 'Dansk'],
  fi: ['fin', 'Suomi'],
  nb: ['nob', 'Norsk bokmål'],
  no: ['nor', 'Norsk'],
  el: ['ell', 'Ελληνικά'],
  hu: ['hun', 'Magyar'],
  ro: ['ron', 'Română'],
  bg: ['bul', 'Български'],
  hr: ['hrv', 'Hrvatski'],
  sr: ['srp', 'Српски'],
  sk: ['slk', 'Slovenčina'],
  sl: ['slv', 'Slovenščina'],
  ar: ['ara', 'العربية'],
  fa: ['fas', 'فارسی'],
  he: ['heb', 'עברית'],
  hi: ['hin', 'हिन्दी'],
  ja: ['jpn', '日本語'],
  ko: ['kor', '한국어'],
  zh: ['zho', '中文'],
  th: ['tha', 'ไทย'],
  vi: ['vie', 'Tiếng Việt'],
  id: ['ind', 'Bahasa Indonesia'],
  ms: ['msa', 'Bahasa Melayu'],
  az: ['aze', 'Azərbaycanca'],
  ka: ['kat', 'ქართული'],
  ku: ['kur', 'Kurdî'],
  sq: ['sqi', 'Shqip'],
  bs: ['bos', 'Bosanski'],
  mk: ['mkd', 'Македонски'],
  et: ['est', 'Eesti'],
  lv: ['lav', 'Latviešu'],
  lt: ['lit', 'Lietuvių'],
  ca: ['cat', 'Català'],
};

/** Words that name a language in subtitle URLs ("movie.turkish.vtt"). */
const LANGUAGE_WORDS = {
  turkish: 'tr',
  turkce: 'tr',
  english: 'en',
  ingilizce: 'en',
  german: 'de',
  deutsch: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  russian: 'ru',
  arabic: 'ar',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
  almanca: 'de',
  fransizca: 'fr',
  francais: 'fr',
  ispanyolca: 'es',
  espanol: 'es',
  italyanca: 'it',
  italiano: 'it',
  rusca: 'ru',
  arapca: 'ar',
  japonca: 'ja',
  korece: 'ko',
};

const ISO2_BY_ISO3 = Object.fromEntries(Object.entries(LANGUAGES).map(([two, [three]]) => [three, two]));
// ISO 639-2/B codes that differ from /T.
Object.assign(ISO2_BY_ISO3, {
  ger: 'de',
  fre: 'fr',
  dut: 'nl',
  cze: 'cs',
  gre: 'el',
  rum: 'ro',
  slo: 'sk',
  per: 'fa',
  chi: 'zh',
  alb: 'sq',
  mac: 'mk',
  geo: 'ka',
  may: 'ms',
});

/**
 * Normalised language tag: lower case, "_" → "-", 3-letter codes of known
 * languages folded to 2 letters ("tur" → "tr", "pt_BR" → "pt-br").
 * @returns {string|null}
 */
export function normalizeLanguage(lang) {
  if (!lang) return null;
  const tag = String(lang).trim().toLowerCase().replace(/_/g, '-');
  if (!/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(tag)) return null;
  const [primary, ...rest] = tag.split('-');
  const two = primary.length === 3 ? (ISO2_BY_ISO3[primary] ?? primary) : primary;
  return [two, ...rest].join('-');
}

/** Primary subtag ("pt-br" → "pt"). */
function primaryOf(lang) {
  return normalizeLanguage(lang)?.split('-')[0] ?? null;
}

/** ISO 639-2 code for ffmpeg/MP4 metadata ("tr" → "tur"); "und" when unknown. */
export function iso639_2(lang) {
  const primary = primaryOf(lang);
  if (!primary) return 'und';
  if (primary.length === 3) return primary;
  return LANGUAGES[primary]?.[0] ?? 'und';
}

/** Human label for a track: its own label, else the language's name, else the code. */
export function languageLabel(lang, label = null) {
  if (label && String(label).trim()) return String(label).trim();
  const primary = primaryOf(lang);
  if (!primary) return t('languageUnknown');
  return LANGUAGES[primary]?.[1] ?? normalizeLanguage(lang);
}

/** Language a track name spells out ("Türkçe", "English", "Deutsch"); null otherwise. */
export function languageFromName(name) {
  const folded = String(name ?? '')
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
  for (const token of folded.split(/[^a-z]+/).filter(Boolean)) {
    if (LANGUAGE_WORDS[token]) return LANGUAGE_WORDS[token];
  }
  return null;
}

/**
 * Language named by a subtitle URL: lang/language query parameter, then
 * tokens of the file name ("film-tr.vtt", "sub_eng.srt", "movie.turkish.vtt").
 * @returns {string|null}
 */
export function guessLanguage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const key of ['lang', 'language', 'srclang', 'hl']) {
    const value = normalizeLanguage(u.searchParams.get(key));
    if (value) return value;
  }
  const file = decodeURIComponent(u.pathname.split('/').pop() ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '');
  const tokens = file.split(/[^a-z]+/).filter(Boolean);
  for (const token of tokens.reverse()) {
    if (LANGUAGE_WORDS[token]) return LANGUAGE_WORDS[token];
    if (token.length === 2 && LANGUAGES[token]) return token;
    if (token.length === 3 && ISO2_BY_ISO3[token]) return ISO2_BY_ISO3[token];
  }
  return null;
}

/** True when `lang` satisfies one of the preferred tags ("*" = every language). */
export function languageMatches(lang, prefs = []) {
  if (prefs.includes('*')) return true;
  const tag = normalizeLanguage(lang);
  if (!tag) return false;
  return prefs.some((p) => {
    const pref = normalizeLanguage(p);
    return Boolean(pref) && (tag === pref || tag.startsWith(`${pref}-`) || primaryOf(tag) === pref);
  });
}

/**
 * Choices the "auto" selection takes: tracks whose language is preferred, in
 * preference order, one per language (non-forced first).
 * @template {{lang?:string|null, forced?:boolean, ref?:string}} T
 * @param {T[]} choices
 * @param {string[]} prefs
 * @returns {T[]}
 */
export function autoPick(choices, prefs = []) {
  if (!prefs.length) return [];
  const order = (c) => {
    if (prefs.includes('*')) return 0;
    const i = prefs.findIndex((p) => languageMatches(c.lang, [p]));
    return i === -1 ? Infinity : i;
  };
  const matching = choices
    .filter((c) => order(c) !== Infinity)
    .sort((a, b) => order(a) - order(b) || Number(Boolean(a.forced)) - Number(Boolean(b.forced)));
  const seen = new Set();
  return matching.filter((c) => {
    const key = normalizeLanguage(c.lang) ?? `#${c.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- content ---------------------------------------------------------------

/** Frequent short words per language (lower case), for guessing from cue text. */
// prettier-ignore
const STOPWORDS = {
  tr: ['ve', 'bir', 'bu', 'ne', 'için', 'de', 'da', 'mi', 'mı', 'ben', 'sen', 'çok', 'değil', 'var', 'yok', 'şey', 'gibi', 'ama', 'neden', 'nasıl', 'evet', 'hayır', 'tamam', 'beni', 'seni', 'onu', 'şimdi', 'burada', 'hadi'],
  en: ['the', 'you', 'and', 'to', 'is', 'it', 'of', 'that', 'what', 'this', 'are', 'me', 'my', 'we', 'have', 'not', 'your', 'just', 'with', 'be', 'do', 'know', 'he', 'was', 'can', "don't", "i'm", "it's"],
  de: ['und', 'ich', 'nicht', 'das', 'die', 'der', 'ist', 'du', 'sie', 'es', 'wir', 'was', 'ein', 'mit', 'zu', 'den', 'mir', 'ja', 'auf', 'aber'],
  fr: ['je', 'de', 'est', 'pas', 'le', 'la', 'vous', 'et', 'que', 'un', 'tu', 'les', 'il', 'une', 'ce', 'ne', 'en', 'qui', 'nous', 'mais'],
  es: ['que', 'de', 'no', 'la', 'el', 'es', 'y', 'en', 'lo', 'un', 'por', 'qué', 'me', 'una', 'te', 'los', 'se', 'con', 'para', 'está'],
  it: ['che', 'non', 'di', 'è', 'il', 'la', 'un', 'per', 'mi', 'sono', 'ho', 'ti', 'una', 'questo', 'ma', 'cosa', 'lo', 'sei', 'bene', 'come'],
  pt: ['que', 'não', 'de', 'é', 'o', 'a', 'você', 'um', 'eu', 'para', 'uma', 'com', 'do', 'se', 'isso', 'está', 'em', 'me', 'da', 'mas'],
};
/** Scripts that name a language on their own. */
/** @type {[string, RegExp][]} */
const SCRIPTS = [
  ['ru', /[\u0400-\u04FF]/g],
  ['ar', /[\u0600-\u06FF]/g],
  ['el', /[\u0370-\u03FF]/g],
  ['he', /[\u0590-\u05FF]/g],
  ['ja', /[\u3040-\u30FF]/g],
  ['ko', /[\uAC00-\uD7AF]/g],
  ['zh', /[\u4E00-\u9FFF]/g],
  ['th', /[\u0E00-\u0E7F]/g],
];

/** Plain text of cues: tags and entities removed. */
function plainText(cues) {
  return cues.map((c) => markupToSrtText(c.text).replace(/<[^>]+>/g, '')).join('\n');
}

/**
 * Language of subtitle cues from their words ("tr", "en"…), for files whose
 * URL and player name none (1.vtt, 2.vtt). Null when unsure.
 * @param {{text:string}[]} cues
 */
export function guessLanguageFromCues(cues) {
  const text = plainText(cues);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters < 20) return null;
  for (const [lang, re] of SCRIPTS) {
    if ((text.match(re) ?? []).length / letters > 0.3) return lang;
  }
  const words = text.toLocaleLowerCase('tr').match(/[\p{L}']+/gu) ?? [];
  /** @type {[string, number][]} */
  const scores = Object.entries(STOPWORDS)
    .map(([lang, list]) => {
      const set = new Set(list);
      return /** @type {[string, number]} */ ([lang, words.filter((w) => set.has(w)).length / words.length]);
    })
    .sort((a, b) => b[1] - a[1]);
  // Turkish letters settle Turkish when the words are few or SHOUTED signs.
  const turkish = (text.match(/[ğĞışŞİ]/g) ?? []).length / letters;
  if (turkish > 0.01 && scores[0][1] < 0.08) return 'tr';
  const [[best, top], [, second]] = scores;
  return top >= 0.04 && top >= second * 1.5 ? best : null;
}

/**
 * Forced ("signs only") subtitles: a dub's translation of on-screen text,
 * a few dozen cues over a whole film. Fewer than one cue a minute.
 * @param {{start:number,end:number}[]} cues
 */
export function looksForced(cues) {
  if (!cues.length) return false;
  const span = (cues[cues.length - 1].end - cues[0].start) / 60;
  return span >= 10 && cues.length / span < 1;
}

/**
 * What a subtitle file holds, for labels and auto picking.
 * @returns {{format:string, cues:number, langGuess:string|null, forced:boolean}}
 */
export function describeSubtitle(text) {
  const { format, cues } = parseSubtitle(text);
  const sorted = normalizeCues(cues);
  return { format, cues: sorted.length, langGuess: guessLanguageFromCues(sorted), forced: looksForced(sorted) };
}

/** File name suffix for a subtitle file ("tr", "pt-br"; a localized "subtitles" word when unknown). */
export function languageSuffix(lang) {
  return normalizeLanguage(lang) ?? t('fileSuffixSubtitle');
}

// ---- timestamps ----------------------------------------------------------

/** "01:02:03.456", "02:03.456", "01:02:03,456" → seconds; null when invalid. */
export function parseTimestamp(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(text).trim());
  if (!m) return null;
  const [, h, min, s, frac] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(frac.padEnd(3, '0')) / 1000 : 0);
}

function formatTime(seconds, separator) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${separator}${p(ms, 3)}`;
}

// ---- format detection ----------------------------------------------------

/** @returns {'vtt'|'srt'|'ttml'|null} */
export function detectFormat(text) {
  const head = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 2000);
  if (/^WEBVTT(?:[ \t]|\r?\n|$)/.test(head)) return 'vtt';
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[a-z0-9]+:)?tt[\s>]/i.test(head)) return 'ttml';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}

/** Lowercase extension → format, for URLs and MIME types. */
export function formatOf({ url = '', mimeType = '', codecs = '' } = {}) {
  const mime = String(mimeType).toLowerCase();
  if (/wvtt|stpp/i.test(codecs) || mime === 'application/mp4') return 'mp4';
  if (mime.includes('vtt')) return 'vtt';
  if (mime.includes('ttml') || mime.includes('dfxp')) return 'ttml';
  if (mime.includes('subrip') || mime.includes('srt')) return 'srt';
  const ext = (() => {
    try {
      return new URL(url).pathname.split('.').pop().toLowerCase();
    } catch {
      return '';
    }
  })();
  if (ext === 'vtt' || ext === 'webvtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  if (ext === 'ttml' || ext === 'dfxp' || ext === 'xml') return 'ttml';
  return null;
}

// ---- markup helpers ------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Plain text → WebVTT cue markup. */
function escapeMarkup(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Loose markup (SRT text: may contain <i>, <b>, <u>, <font>) → WebVTT
 * markup: keeps i/b/u, drops other tags, escapes stray "&" and "<".
 */
function srtTextToMarkup(text) {
  const parts = [];
  const re = /<\/?([a-z]+)\b[^>]*>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    parts.push(escapeMarkup(decodeEntities(text.slice(last, m.index))));
    const tag = m[1].toLowerCase();
    if (['i', 'b', 'u'].includes(tag)) parts.push(m[0].startsWith('</') ? `</${tag}>` : `<${tag}>`);
    last = m.index + m[0].length;
  }
  parts.push(escapeMarkup(decodeEntities(text.slice(last))));
  return parts.join('');
}

/**
 * WebVTT cue markup → SubRip text: keeps <i>, <b>, <u>; drops classes,
 * voices, ruby, inline timestamps; decodes entities.
 */
export function markupToSrtText(markup) {
  return decodeEntities(
    markup
      .replace(/<(\/?)([a-z]+)(?:\.[^\s>]*)?(?:\s[^>]*)?>/gi, (m, close, tag) => {
        const t = tag.toLowerCase();
        return ['i', 'b', 'u'].includes(t) ? `<${close}${t}>` : '';
      })
      .replace(/<\d[^>]*>/g, ''),
  );
}

// ---- WebVTT --------------------------------------------------------------

/**
 * @returns {{cues: {start:number,end:number,text:string}[], timestampMap: {mpegts:number, local:number}|null}}
 */
export function parseVtt(text) {
  const blocks = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  const cues = [];
  let timestampMap = null;
  const header = blocks.shift() ?? '';
  const map = /X-TIMESTAMP-MAP=([^\n]+)/.exec(header);
  if (map) {
    const mpegts = /MPEGTS:(\d+)/.exec(map[1]);
    const local = /LOCAL:([\d:.]+)/.exec(map[1]);
    timestampMap = { mpegts: mpegts ? Number(mpegts[1]) : 0, local: local ? (parseTimestamp(local[1]) ?? 0) : 0 };
  }
  // A header without the blank line before the first cue still has cues in it.
  const headerLines = header.split('\n');
  const firstTiming = headerLines.findIndex((l) => l.includes('-->'));
  if (firstTiming > 0) {
    const prev = headerLines[firstTiming - 1];
    const hasId = Boolean(prev) && !/^(WEBVTT|X-TIMESTAMP-MAP)/.test(prev);
    blocks.unshift(headerLines.slice(firstTiming - (hasId ? 1 : 0)).join('\n'));
  }

  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;
    const [startText, rest] = lines[timingIndex].split('-->');
    const start = parseTimestamp(startText);
    const end = parseTimestamp((rest ?? '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  return { cues, timestampMap };
}

export function toVtt(cues) {
  const body = cues.map((c) => `${formatTime(c.start, '.')} --> ${formatTime(c.end, '.')}\n${c.text.replace(/-->/g, '--&gt;')}`);
  return `WEBVTT\n\n${body.join('\n\n')}${body.length ? '\n' : ''}`;
}

// ---- SubRip --------------------------------------------------------------

export function parseSrt(text) {
  const blocks = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;
    const [startText, endText] = lines[timingIndex].split('-->');
    const start = parseTimestamp(startText);
    const end = parseTimestamp((endText ?? '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (!body) continue;
    cues.push({ start, end, text: srtTextToMarkup(body) });
  }
  return { cues };
}

export function toSrt(cues) {
  return (
    cues.map((c, i) => `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}\n${markupToSrtText(c.text)}`).join('\n\n') +
    (cues.length ? '\n' : '')
  );
}

// ---- TTML ----------------------------------------------------------------

/** TTML time expression → seconds. */
export function parseTtmlTime(text, { frameRate = 30, tickRate = 1 } = {}) {
  if (text == null) return null;
  const t = String(text).trim();
  let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  m = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.\d+)?$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / frameRate;
  m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(t);
  if (m) {
    const v = Number(m[1]);
    return { h: v * 3600, m: v * 60, s: v, ms: v / 1000, f: v / frameRate, t: v / tickRate }[m[2]];
  }
  return null;
}

function attrsOf(tagBody) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagBody)))
    attrs[m[1].replace(/^[a-z]+:(?=(begin|end|dur|fontStyle|fontWeight|textDecoration)$)/i, '')] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/**
 * TTML / DFXP → cues. Supports begin/end/dur on <p> (and offsets from
 * timed ancestors), clock and offset time expressions, <br/>, italic/bold/
 * underline spans. Styles referenced by id are not resolved.
 */
export function parseTtml(text) {
  const xml = String(text ?? '');
  const tt = /<(?:[a-z0-9]+:)?tt\b([^>]*)>/i.exec(xml);
  const ttAttrs = tt ? attrsOf(tt[1]) : {};
  const rates = {
    frameRate:
      Number(ttAttrs['ttp:frameRate'] ?? 30) *
      (ttAttrs['ttp:frameRateMultiplier']
        ? (() => {
            const [a, b] = ttAttrs['ttp:frameRateMultiplier'].split(/\s+/).map(Number);
            return a && b ? a / b : 1;
          })()
        : 1),
    tickRate: Number(ttAttrs['ttp:tickRate'] ?? 1) || 1,
  };
  const time = (v) => parseTtmlTime(v, rates);

  const cues = [];
  const stack = []; // { name, begin (absolute offset) , style: 'i'|'b'|'u'|null }
  let cue = null; // { start, end, parts: [] }
  const re = /<(\/?)([a-z0-9]+:)?([a-z0-9]+)\b([^>]*?)(\/?)>|([^<]+)/gi;
  let m;
  const body = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  while ((m = re.exec(body))) {
    const [, close, , rawName, attrText, selfClose, textNode] = m;
    if (textNode != null) {
      if (cue) cue.parts.push(escapeMarkup(decodeEntities(textNode).replace(/\s+/g, ' ')));
      continue;
    }
    const name = rawName.toLowerCase();
    if (close) {
      const top = stack.pop();
      if (cue && top?.style) cue.parts.push(`</${top.style}>`);
      if (name === 'p' && cue) {
        const textOut = cue.parts
          .join('')
          .split('\n')
          .map((l) => l.trim())
          .join('\n')
          .trim();
        if (textOut && cue.end != null && cue.end > cue.start) cues.push({ start: cue.start, end: cue.end, text: textOut });
        cue = null;
      }
      continue;
    }
    if (name === 'br') {
      if (cue) cue.parts.push('\n');
      continue;
    }
    const attrs = attrsOf(attrText);
    const parentBegin = stack.length ? stack[stack.length - 1].begin : 0;
    const begin = parentBegin + (time(attrs.begin) ?? 0);
    let style = null;
    if (cue && name === 'span') {
      if (/italic/i.test(attrs.fontStyle ?? '')) style = 'i';
      else if (/bold/i.test(attrs.fontWeight ?? '')) style = 'b';
      else if (/underline/i.test(attrs.textDecoration ?? '')) style = 'u';
      if (style) cue.parts.push(`<${style}>`);
    }
    if (name === 'p') {
      const dur = time(attrs.dur);
      const end = attrs.end != null ? parentBegin + time(attrs.end) : dur != null ? begin + dur : null;
      cue = { start: begin, end, parts: [] };
    }
    if (selfClose) {
      if (cue && style) cue.parts.push(`</${style}>`);
      continue;
    }
    stack.push({ name, begin, style });
  }
  return { cues };
}

// ---- generic parse / merge / convert -------------------------------------

/** Parses any supported subtitle text. @returns {{format, cues, timestampMap}} */
export function parseSubtitle(text) {
  const format = detectFormat(text);
  if (format === 'vtt') return { format, ...parseVtt(text) };
  if (format === 'srt') return { format, ...parseSrt(text), timestampMap: null };
  if (format === 'ttml') return { format, ...parseTtml(text), timestampMap: null };
  throw new Error(t('errSubtitleFormat'));
}

/**
 * Sorts cues, drops exact duplicates (a cue repeated in two segments) and
 * joins a cue split at a segment boundary (same text, touching times).
 */
export function normalizeCues(cues) {
  const sorted = [...cues].filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const c of sorted) {
    const dup = out.find((o) => o.text === c.text && Math.abs(o.start - c.start) < 0.01 && Math.abs(o.end - c.end) < 0.01);
    if (dup) continue;
    const prev = [...out].reverse().find((o) => o.text === c.text && Math.abs(o.end - c.start) < 0.05);
    if (prev) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/**
 * Merges subtitle segments (HLS WebVTT segments, DASH text segments) into
 * one cue list on the media timeline.
 *
 * HLS WebVTT segments map their cue times to the MPEG-TS clock with
 * X-TIMESTAMP-MAP (MPEGTS = 90 kHz ticks matching LOCAL). The media file we
 * write starts at 0, so times are rebased on the smallest MPEGTS value seen
 * (the start of the stream); segments without a map are used as-is.
 * @param {string[]} texts
 */
export function mergeSubtitleSegments(texts) {
  const parsed = texts.map((t) => (t && t.trim() ? parseSubtitle(t) : { cues: [], timestampMap: null }));
  const maps = parsed.map((p) => p.timestampMap).filter(Boolean);
  const base = maps.length ? Math.min(...maps.map((m) => m.mpegts)) : 0;
  const all = [];
  for (const p of parsed) {
    const offset = p.timestampMap ? (p.timestampMap.mpegts - base) / 90000 - p.timestampMap.local : 0;
    for (const c of p.cues) all.push({ start: c.start + offset, end: c.end + offset, text: c.text });
  }
  return normalizeCues(all);
}

/** Cues → file text in the requested format ('srt' | 'vtt'). */
export function serializeCues(cues, format = 'srt') {
  return format === 'vtt' ? toVtt(cues) : toSrt(cues);
}

/** Any subtitle text → 'srt' | 'vtt' text. */
export function convertSubtitle(text, format = 'srt') {
  return serializeCues(normalizeCues(parseSubtitle(text).cues), format);
}
