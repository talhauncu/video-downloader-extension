// Builds safe download file names from a template.
// Tokens: {site} {title} {date} {time} {quality} {id}
// Default template: {site}-{title}-{date}  →  x.com-Harika video-20261031-1405.mp4

const MAX_LENGTH = 120;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export const DEFAULT_TEMPLATE = '{site}-{title}-{date}';
export const TOKENS = ['site', 'title', 'date', 'time', 'quality', 'id'];

export function sanitizePart(text) {
  return String(text ?? '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

export function siteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'video';
  }
}

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function timeOnly(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function shortId() {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Fills the template, drops empty tokens together with the separator that
 * precedes/follows them, and collapses repeated separators.
 */
export function applyTemplate(template, values) {
  let out = template.replace(/\{(\w+)\}/g, (_, key) => (values[key] ? `\u0000${values[key]}\u0000` : '\u0001'));
  // Remove empty tokens and the separator glued to them (\u0000 / \u0001 mark filled / empty fields).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[-_ .]*\u0001[-_ .]*/g, (m) =>
    m.startsWith('-') || m.startsWith('_') || m.startsWith(' ') || m.startsWith('.') ? m[0] : '',
  );
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\u0000/g, '');
  out = out.replace(/([-_ .])\1+/g, '$1').replace(/^[-_ .]+|[-_ .]+$/g, '');
  return out;
}

/**
 * @param {{pageUrl?: string, title?: string, ext: string, date?: Date, template?: string, quality?: string}} opts
 */
export function buildFilename({ pageUrl, title, ext, date, template, quality }) {
  const now = date ?? new Date();
  const values = {
    site: sanitizePart(siteFromUrl(pageUrl ?? '')),
    title: sanitizePart(title),
    date: timestamp(now),
    time: timeOnly(now),
    quality: sanitizePart(quality),
    id: shortId(),
  };
  const cleanExt = sanitizePart(ext).replace(/^\.+/, '').toLowerCase() || 'bin';
  const suffix = `.${cleanExt}`;

  const tpl = template || DEFAULT_TEMPLATE;
  let base = sanitizePart(applyTemplate(tpl, values));
  const room = MAX_LENGTH - suffix.length;
  if (base.length > room && values.title) {
    // Shorten the title first so date/site/quality survive.
    const overflow = base.length - room;
    values.title = values.title.slice(0, Math.max(0, values.title.length - overflow)).replace(/[-. _]+$/, '');
    base = sanitizePart(applyTemplate(tpl, values));
  }
  if (!base) base = `video-${values.date}`;
  if (base.length > room) base = base.slice(0, room).replace(/[-. _]+$/, '');
  return `${base}${suffix}`;
}
