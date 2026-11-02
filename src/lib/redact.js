// Masks what a bug report should not carry: query values (signed URLs,
// session tokens) and long tokens in URL paths, for the popup's "Debug info".
// Pure (unit-tested).

/** A path segment that looks like a token rather than a name: long, no dot-extension words. */
const TOKEN_SEGMENT = /^[A-Za-z0-9_\-~%=+]{24,}$/;

/** Keeps the first and last 4 characters, enough to tell two tokens apart. */
const shorten = (text) => `${text.slice(0, 4)}…${text.slice(-4)}`;

/**
 * "https://cdn.test/mw/H3IjMKWanKWf…/seg1.ts?s=abc&e=1" →
 * "https://cdn.test/mw/H3Ij…Wf9x/seg1.ts?s=…&e=…". Not an http(s) URL: unchanged.
 * @param {string} text
 */
export function redactUrl(text) {
  if (typeof text !== 'string' || !/^https?:\/\//i.test(text)) return text;
  let u;
  try {
    u = new URL(text);
  } catch {
    return text;
  }
  const path = u.pathname
    .split('/')
    .map((segment) => (TOKEN_SEGMENT.test(segment) ? shorten(segment) : segment))
    .join('/');
  const query = [...u.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=…`).join('&');
  return `${u.origin}${path}${query ? `?${query}` : ''}`;
}

/**
 * A copy of `value` with every http(s) URL string masked (redactUrl), at any
 * depth: item and frame addresses, playlist variants, job contexts, errors' URLs.
 */
export function redactDeep(value) {
  if (typeof value === 'string') return redactUrl(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}
