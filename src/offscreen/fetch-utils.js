/** Error that names the step (manifest | key | init | segment) and the HTTP status. */
export class HttpStepError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'HttpStepError';
    this.detail = detail;
  }
}

export { RETRY_STATUSES, THROTTLE_STATUSES, MAX_ATTEMPTS, retryDelay, Throttle, fetchWithRetry } from '../lib/retry.js';
import { MAX_ATTEMPTS, fetchWithRetry } from '../lib/retry.js';
import { t } from '../lib/i18n.js';

/** "Piece 3/841", "Piece 3" or "Piece" (localized). */
function pieceName(label) {
  if (label.index == null) return t('stepPiece');
  return label.total ? t('stepPieceOf', label.index + 1, label.total) : t('stepPieceIndex', label.index + 1);
}

export async function fetchText(url, signal, step = 'manifest', throttle = null) {
  const res = await fetchWithRetry(url, {}, signal, throttle);
  if (!res.ok) throw new HttpStepError(t('errManifest', res.status), { step, status: res.status, url });
  return res.text();
}

/**
 * @param {{step?:string, index?:number, total?:number}} [label] names the piece in error messages
 */
export async function fetchBytes(url, byteRange, signal, label = {}, throttle = null, opts = {}) {
  const headers = {};
  if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  let res;
  try {
    res = await fetchWithRetry(url, { headers }, signal, throttle, null, opts);
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    const step = label.step ?? 'segment';
    throw new HttpStepError(t('errStepNetwork', pieceName(label)), {
      step,
      index: label.index ?? null,
      status: null,
      url,
      attempts: error?.attempts ?? 1,
      network: true,
    });
  }
  if (!res.ok) {
    const step = label.step ?? 'segment';
    const where = step === 'key' ? t('stepKey') : step === 'init' ? t('stepInit') : pieceName(label);
    throw new HttpStepError(t('errStepHttp', where, res.status), {
      step,
      index: label.index ?? null,
      status: res.status,
      url,
      attempts: res.attempts ?? MAX_ATTEMPTS,
      retryAfter: res.retryAfter ?? res.headers.get('retry-after') ?? null,
      cooldowns: throttle?.cooldowns ?? 0,
      waitedMs: throttle?.waitedMs ?? 0,
      spacingMs: throttle?.spacingMs ?? 0,
    });
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function abortError() {
  return new DOMException(t('cancelled'), 'AbortError');
}
