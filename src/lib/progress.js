// Normalised progress for the in-page badge: one shape for stream jobs and
// progressive (chrome.downloads) files, with ready-to-show texts and a
// remaining-time estimate. Pure functions.

import { formatBytes } from './media-url.js';
import { t } from './i18n.js';

/** "~45 s", "~3 min", "~1 h 20 min" (localized); null for unknown. */
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return t('etaSeconds', Math.max(1, s));
  const m = Math.round(s / 60);
  if (m < 60) return t('etaMinutes', m);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? t('etaHoursMinutes', h, rest) : t('etaHours', h);
}

const ACTIVE = new Set(['downloading', 'saving']);
export const isActive = (p) => Boolean(p && ACTIVE.has(p.status));

/**
 * @param {Object} job  getJob() result
 * @param {number} now
 */
export function streamProgress(job, now = Date.now()) {
  if (!job) return null;
  const merging = job.status === 'downloading' && job.phase === 'merging';
  const waiting = job.status === 'downloading' && job.phase === 'cooldown';
  const pct =
    job.status === 'saving' || job.status === 'done'
      ? 100
      : merging
        ? Math.round((job.phaseProgress ?? 0) * 100)
        : job.total
          ? Math.min(100, Math.round((job.done / job.total) * 100))
          : 0;

  // Average rate since the start, without time spent in rate-limit waits.
  let etaSec = null;
  if (job.status === 'downloading' && !merging && !waiting && job.done > 0 && job.total > job.done && job.startedAt) {
    const elapsed = Math.max(1, (now - job.startedAt - (job.waitedMs ?? 0)) / 1000);
    etaSec = ((job.total - job.done) * elapsed) / job.done;
  }

  const parts = [];
  if (merging) parts.push(t('progressMerging', t('percent', pct)));
  else if (waiting) {
    const left = Math.max(0, Math.round(((job.cooldownUntil ?? now) - now) / 1000));
    parts.push(t('progressServerWait', left));
  }
  if (job.total) parts.push(t('progressPieces', job.done, job.total));
  if (job.bytes) parts.push(formatBytes(job.bytes));
  const eta = formatEta(etaSec);
  if (eta) parts.push(t('progressRemaining', eta));
  if (job.status === 'error' && job.error) parts.push(job.error);

  const label = merging
    ? t('progressMerging', t('percent', pct))
    : waiting
      ? t('progressWaiting')
      : job.status === 'saving'
        ? t('progressSaving')
        : job.status === 'downloading'
          ? t('percent', pct)
          : null;

  return {
    type: 'stream',
    jobId: job.jobId,
    itemId: job.itemId ?? null,
    status: job.status,
    pct,
    label,
    detail: parts.join(' · '),
    etaSec,
    filename: job.files?.length ? job.files.join(' + ') : job.filename,
    downloadId: job.downloadIds?.[0] ?? null,
    error: job.error ?? null,
  };
}

/**
 * @param {Object|null} entry  chrome.downloads DownloadItem (may be gone)
 * @param {Object|null} job    in-memory direct job (may be gone after a service worker restart)
 */
export function fileProgress(entry, job, now = Date.now()) {
  const outcome = job?.outcome?.state ?? null;
  let status;
  if (entry?.state === 'complete' || outcome === 'done') status = 'done';
  else if (entry?.state === 'in_progress' && !entry.paused) status = 'downloading';
  else if (entry?.state === 'interrupted' && entry.error === 'USER_CANCELED') status = 'cancelled';
  else if (outcome === 'cancelled') status = 'cancelled';
  else if (outcome === 'error') status = 'error';
  else if (job && !outcome && (job.mode === 'fallback' || !entry))
    status = 'downloading'; // fallback fetch, or switching
  else if (entry?.state === 'interrupted') status = 'error';
  else if (entry?.paused) status = 'downloading';
  else return null;

  const received = entry?.bytesReceived ?? 0;
  const total = entry?.totalBytes > 0 ? entry.totalBytes : null;
  const pct = status === 'done' ? 100 : total ? Math.min(100, Math.round((received / total) * 100)) : null;
  let etaSec = null;
  if (status === 'downloading' && entry?.estimatedEndTime) etaSec = Math.max(0, (Date.parse(entry.estimatedEndTime) - now) / 1000);

  const parts = [];
  if (status === 'downloading' && job?.mode === 'fallback' && !entry) parts.push(t('progressWithPageHeaders'));
  if (received || total) parts.push(total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received));
  const eta = formatEta(etaSec);
  if (eta) parts.push(t('progressRemaining', eta));
  const error = status === 'error' ? (job?.outcome?.error ?? entry?.error ?? t('progressInterrupted')) : null;
  if (error) parts.push(error);

  return {
    type: 'file',
    itemId: job?.itemId ?? null,
    status,
    pct: pct ?? 0,
    label: status === 'downloading' ? (pct != null ? t('percent', pct) : t('progressDownloading')) : null,
    detail: parts.join(' · '),
    etaSec,
    filename: String(entry?.filename ?? job?.filename ?? '')
      .split(/[\\/]/)
      .pop(),
    downloadId: entry?.id ?? job?.downloadId ?? null,
    error,
  };
}
