// Fetches one piece (segment or init) of a stream with a fallback chain:
//  1. the piece's own URL; while it answers 403/410 (expired signed URL)
//     the playlist is re-read (≤ 3 refreshes per piece)
//  2. the same path on other mirror hosts of the playlist (≤ 3)
//  3. one more playlist refresh, then the own URL again
//  4. spaced retries on the own URL for about two minutes, re-reading the
//     playlist once more half way (film CDNs answer 404 for a while under
//     load; failing loses the whole job)
// Long rate-limit cooldowns only happen on the own URL (step 1); mirrors and
// late retries fail fast so a broken mirror cannot stall the job for minutes.
// Rate limits (429/503) are governed by the cooldown budget: after step 1
// only other mirrors are tried (their quota may differ), no refresh or late
// retries, so "maxCooldownMinutes: 0" still fails fast.

import { fetchBytes } from './fetch-utils.js';
import { alternateUrls } from '../lib/mirrors.js';

export const FALLBACK_DELAYS_MS = [1000, 3000, 6000, 15000, 30000, 60000];
/** Late retry before which the playlist is read again. */
const LATE_REFRESH_AT = 3;
const EXPIRED = new Set([403, 410]);
const MIRROR_WORTHY = new Set([403, 404, 408, 410, 425, 429, 500, 502, 503, 504]);
const RATE_LIMITED = new Set([429, 503]);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * @param {() => {url:string, byteRange?:Object|null}} getPiece  re-read after each refresh
 * @param {{step?:string, index?:number, total?:number}} label
 * @param {{signal:AbortSignal, throttle:Object, origins:() => string[], refresh?:(() => Promise<void>)|null, stats:{mirrorSwitches:number}, delays?:number[]}} ctx
 * @returns {Promise<Uint8Array>}
 */
export async function fetchPieceWithFallback(getPiece, label, ctx) {
  let attempts = 0;
  let refreshes = 0;
  let mirrorsTried = 0;
  let lastError = null;

  const attempt = async (url, opts) => {
    try {
      const data = await fetchBytes(url, getPiece().byteRange ?? null, ctx.signal, label, ctx.throttle, opts);
      attempts += 1;
      return data;
    } catch (error) {
      if (!error?.detail) throw error; // abort or a non-HTTP failure: no fallback
      attempts += error.detail.attempts ?? 1;
      lastError = error;
      return null;
    }
  };
  const status = () => lastError?.detail?.status ?? null;
  const retryable = () => Boolean(lastError?.detail?.network) || MIRROR_WORTHY.has(status());
  const refresh = async () => {
    if (!ctx.refresh || refreshes >= 3) return false;
    refreshes++;
    await ctx.refresh();
    return true;
  };
  const fail = () => {
    lastError.detail.attempts = attempts;
    lastError.detail.mirrorsTried = mirrorsTried;
    return lastError;
  };

  // 1. Own URL, refreshing while the signed URL is expired.
  let data = await attempt(getPiece().url);
  while (data === null && EXPIRED.has(status()) && (await refresh())) {
    data = await attempt(getPiece().url);
  }
  if (data) return data;
  if (!retryable()) throw fail();

  // 2. Same path on other mirrors.
  const rateLimited = RATE_LIMITED.has(status());
  for (const alt of alternateUrls(getPiece().url, ctx.origins?.() ?? [], 3)) {
    mirrorsTried++;
    data = await attempt(alt, { allowCooldown: false });
    if (data) {
      ctx.stats.mirrorSwitches++;
      return data;
    }
  }
  if (rateLimited) throw fail();

  // 3. Re-read the playlist once more (URLs or mirror assignment may change).
  try {
    if (await refresh()) {
      data = await attempt(getPiece().url, { allowCooldown: false });
      if (data) return data;
    }
  } catch {
    // refresh itself failed: keep the segment error
  }

  // 4. Spaced retries.
  for (const [i, delay] of (ctx.delays ?? FALLBACK_DELAYS_MS).entries()) {
    await sleep(delay, ctx.signal);
    if (i === LATE_REFRESH_AT) await refresh().catch(() => false);
    data = await attempt(getPiece().url, { allowCooldown: false });
    if (data) return data;
  }
  throw fail();
}
