// Mirror hosts of a playlist: some hosts spread segments over several
// equivalent servers (same path on every host). When one mirror fails, the
// same path can be fetched from another. Pure functions.

/**
 * Distinct origins used by the segment URLs, in first-seen order. Fewer than
 * two origins means there are no mirrors.
 * @param {string[]} urls
 * @returns {string[]}
 */
export function mirrorOrigins(urls) {
  const seen = [];
  for (const url of urls) {
    try {
      const { origin } = new URL(url);
      if (!seen.includes(origin)) seen.push(origin);
    } catch {
      // relative or invalid: ignore
    }
  }
  return seen.length >= 2 ? seen : [];
}

/**
 * The same path and query on up to `max` other mirrors, starting with the
 * mirror after the URL's own one (spreads load instead of always hitting the
 * first host).
 * @returns {string[]}
 */
export function alternateUrls(url, origins, max = 3) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!origins?.length) return [];
  const own = origins.indexOf(parsed.origin);
  const ordered = own === -1 ? origins : [...origins.slice(own + 1), ...origins.slice(0, own)];
  return ordered
    .filter((o) => o !== parsed.origin)
    .slice(0, max)
    .map((origin) => `${origin}${parsed.pathname}${parsed.search}`);
}
