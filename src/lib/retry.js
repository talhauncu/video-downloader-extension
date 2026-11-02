// Retry/backoff helpers shared by the service worker (manifests, sniffing)
// and the offscreen downloaders (segments).

/** Statuses worth retrying; 429/503 additionally pause every worker (shared throttle). */
export const RETRY_STATUSES = new Set([403, 404, 408, 410, 425, 429, 500, 502, 503, 504]);
export const THROTTLE_STATUSES = new Set([429, 503]);
/** Authorization/not-found answers get one quick retry only; the playlist-refresh path handles expired URLs. */
export const AUTH_STATUSES = new Set([403, 404, 410]);
export const MAX_ATTEMPTS = 6;
export const AUTH_ATTEMPTS = 2;
/** Base long waits used when quick retries are exhausted by a rate limit (quota windows). */
export const COOLDOWN_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000];
/** Adaptive spacing between requests after a rate limit. */
export const SPACING_STEP_MS = 250;
export const SPACING_MAX_MS = 3_000;
export const SPACING_DECAY_MS = 50;
export const SPACING_DECAY_EVERY = 20;

/**
 * Cooldown schedule that fits a total budget in minutes: the base steps, then
 * 5-minute steps until the budget is used. 0 → no long cooldowns.
 */
export function scheduleForBudget(minutes) {
  const budget = Math.max(0, Number(minutes) || 0) * 60_000;
  if (budget <= 0) return [];
  const out = [];
  let total = 0;
  for (const step of COOLDOWN_SCHEDULE_MS) {
    if (total + step > budget) break;
    out.push(step);
    total += step;
  }
  while (total + 300_000 <= budget) {
    out.push(300_000);
    total += 300_000;
  }
  if (!out.length) out.push(Math.min(budget, COOLDOWN_SCHEDULE_MS[0]));
  return out;
}

/**
 * Delay before attempt `attempt` (1-based retry number). Honours Retry-After
 * (seconds or HTTP date, capped at `cap`), else exponential 0.5 s · 2^(n-1)
 * with jitter, capped at 8 s.
 */
export function retryDelay(attempt, retryAfter = null, now = Date.now(), cap = 30_000) {
  const fromHeader = parseRetryAfter(retryAfter, now);
  if (fromHeader != null) return Math.min(fromHeader, cap);
  const base = 500 * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(base, 8_000) + jitter;
}

/** Retry-After header → milliseconds, or null when absent/invalid. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  return null;
}

const sleep = (ms, signal) =>
  new Promise(
    /** @param {(value?: unknown) => void} resolve */ (resolve, reject) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason);
        },
        { once: true },
      );
    },
  );

/**
 * Shared state for all workers of one job:
 *  - a pause everyone waits for (set when the server rate-limits one request),
 *  - a semaphore whose capacity drops to 1 after the first 429,
 *  - adaptive spacing between request starts (+250 ms per 429, relaxing −50 ms
 *    every 20 successes), so a quota-limited host stops answering 429,
 *  - long cooldowns when quick retries are exhausted (quota windows),
 *  - counters for the UI.
 */
export class Throttle {
  constructor({ concurrency = 4, cooldownSchedule = COOLDOWN_SCHEDULE_MS, onCooldown = null, spacingStep = SPACING_STEP_MS } = {}) {
    this.until = 0;
    this.retries = 0;
    this.cooldowns = 0;
    this.waitedMs = 0;
    this.capacity = concurrency;
    this.active = 0;
    this.queue = [];
    this.cooldownSchedule = cooldownSchedule;
    this.onCooldown = onCooldown;
    this.spacingMs = 0;
    this.spacingStep = spacingStep;
    this.lastStart = 0;
    this.successes = 0;
    this.limits = 0;
  }

  pause(ms) {
    this.until = Math.max(this.until, Date.now() + ms);
  }

  /** Called on every rate-limit response: serialize and space out the remaining requests. */
  rateLimited() {
    this.limits++;
    if (this.capacity > 1) this.capacity = 1;
    this.spacingMs = Math.min(SPACING_MAX_MS, this.spacingMs + this.spacingStep);
    this.successes = 0;
  }

  /** Called on every successful response: relax the spacing slowly. */
  succeeded() {
    if (this.spacingMs <= 0) return;
    this.successes++;
    if (this.successes >= SPACING_DECAY_EVERY) {
      this.successes = 0;
      this.spacingMs = Math.max(0, this.spacingMs - SPACING_DECAY_MS);
    }
  }

  async wait(signal) {
    const ms = this.until - Date.now();
    if (ms <= 0) return;
    await sleep(ms, signal);
  }

  /** Waits for the next allowed request start when spacing is active. */
  async space(signal) {
    if (this.spacingMs <= 0) return;
    const next = this.lastStart + this.spacingMs;
    const ms = next - Date.now();
    this.lastStart = Math.max(next, Date.now());
    if (ms > 0) await sleep(ms, signal);
  }

  async acquire(signal) {
    if (signal?.aborted) throw signal.reason;
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(entry);
          if (i !== -1) this.queue.splice(i, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    this.active++;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.queue.length && this.active < this.capacity) this.queue.shift().resolve();
  }

  snapshot() {
    return { retries: this.retries, cooldowns: this.cooldowns, waitedMs: this.waitedMs, spacingMs: this.spacingMs, limits: this.limits };
  }
}

/**
 * fetch with retries. `throttle` (optional) is shared across a job's workers.
 * Network errors count as retryable too. When quick retries run out on a
 * rate limit (429/503) and a throttle is present, long cooldowns follow
 * (Retry-After when given, else the throttle's schedule) before giving up.
 */
export async function fetchWithRetry(url, init = {}, signal, throttle = null, onRetry = null, { allowCooldown = true } = {}) {
  let lastError = null;
  let lastRes;
  let cooldownIndex = 0;
  let requests = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (throttle) {
      await throttle.wait(signal);
      await throttle.space(signal);
    }
    let res;
    requests++;
    try {
      res = await fetch(url, { credentials: 'include', signal, ...(attempt ? { cache: 'no-store' } : {}), ...init });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
      res = null;
    }
    if (res && !RETRY_STATUSES.has(res.status)) {
      throttle?.succeeded();
      res.attempts = requests;
      return res;
    }
    lastRes = res;
    const retryAfter = res?.headers.get('retry-after') ?? null;
    const rateLimited = Boolean(res && THROTTLE_STATUSES.has(res.status));
    if (rateLimited && throttle) throttle.rateLimited();

    const budget = res && AUTH_STATUSES.has(res.status) ? AUTH_ATTEMPTS : MAX_ATTEMPTS;
    if (attempt < budget - 1) {
      const delay = res && AUTH_STATUSES.has(res.status) ? 400 : retryDelay(attempt + 1, retryAfter);
      if (rateLimited && throttle) throttle.pause(delay);
      if (throttle) {
        throttle.retries++;
        throttle.waitedMs += delay;
      }
      onRetry?.({ url, status: res?.status ?? null, attempt: attempt + 1, delay });
      await sleep(delay, signal);
      continue;
    }

    // Quick retries exhausted.
    if (allowCooldown && rateLimited && throttle && cooldownIndex < throttle.cooldownSchedule.length) {
      const delay = parseRetryAfter(retryAfter) ?? throttle.cooldownSchedule[cooldownIndex];
      cooldownIndex++;
      throttle.cooldowns++;
      throttle.waitedMs += delay;
      throttle.pause(delay);
      throttle.onCooldown?.({ url, status: res.status, delay, cooldown: cooldownIndex, of: throttle.cooldownSchedule.length, retryAfter });
      await sleep(delay, signal);
      attempt = MAX_ATTEMPTS - 2; // one attempt after the cooldown, then the next cooldown
      continue;
    }

    if (lastRes) {
      lastRes.retryAfter = retryAfter;
      lastRes.attempts = requests;
      return lastRes;
    }
    const error = lastError ?? new Error('fetch failed');
    error.attempts = requests;
    throw error;
  }
}
