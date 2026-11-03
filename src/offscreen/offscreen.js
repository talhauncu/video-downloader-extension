// Offscreen document: runs work the service worker cannot do itself
// (Blob URLs, long fetches, OPFS, mux.js). Receives jobs from the service
// worker via chrome.runtime messages tagged with target: 'offscreen'.
//
// Long jobs answer immediately and report back with job:progress /
// job:complete / job:error messages so the service worker may be restarted
// mid-way without losing the result.

import { HlsDownload } from './hls-downloader.js';
import { DashTrackDownload } from './dash-downloader.js';
import { SubtitleDownload } from './subtitle-downloader.js';
import { serializeCues, iso639_2 } from '../lib/subtitles.js';
import { parseMpd, tracksOf } from '../lib/mpd.js';
import { fetchText } from './fetch-utils.js';
import { mergeTracks, probe, isFFmpegLoaded, getFFmpeg } from './ffmpeg-runner.js';
import { t, setMessages } from '../lib/i18n.js';
import { TrackProgress } from '../lib/track-progress.js';

const blobUrls = new Map(); // key (jobId or jobId:role) -> { url, fileName }
const active = new Map(); // jobId -> StreamJob
// Failed jobs that kept what they downloaded: a retry in this session continues them.
const stalled = new Map(); // jobId -> { job: StreamJob, timer }
const STALLED_TTL_MS = 60 * 60_000;

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  webm: 'video/webm',
  ts: 'video/mp2t',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
};

export function mimeFor(ext, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[(ext ?? '').toLowerCase()] ?? fallback;
}

function extOfUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return last.includes('.') ? last.split('.').pop() : '';
  } catch {
    return '';
  }
}

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('downloads', { create: true });
}

function notify(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
  } catch {
    // service worker gone; nothing to do
  }
}

/**
 * Files read back from OPFS carry no MIME type, and Chrome names a blob:
 * download after its sniffed type (".txt" for an untyped blob). Re-type the
 * file without copying it (slice shares the underlying bytes).
 */
function registerBlob(key, file, fileName, type) {
  const blob = file.slice(0, file.size, type);
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, { url, fileName });
  return url;
}

/** Streams a URL into OPFS and returns a blob: URL (Referer fallback path). */
async function fetchToBlob({ jobId, url }) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const headerType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  const type = headerType && headerType !== 'application/octet-stream' ? headerType : mimeFor(extOfUrl(url));
  const dir = await opfsDir();
  const fileName = `${jobId}.bin`;
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await response.body.pipeTo(writable);
  const file = await handle.getFile();
  return { blobUrl: registerBlob(jobId, file, fileName, type), size: file.size, type };
}

/**
 * A stream job downloads one or more tracks (subtitles, video, audio)
 * sequentially and reports aggregated progress. Each track is an HLS
 * playlist URL, a DASH segment plan or a subtitle source. Subtitles go
 * first (small, and their signed URLs are freshest) and may fail without
 * failing the job. Every track's piece count is read before the first
 * download, so the reported total is fixed from the start.
 *
 * A job that fails keeps its finished tracks and the written pieces of the
 * failed one (fMP4/DASH); resume() runs it again from there.
 */
class StreamJob {
  constructor({ jobId, tracks, dir, postProcess, concurrency, stripJunk, cooldownSchedule, fallbackDelays, subtitleFormat }) {
    this.subtitleFormat = subtitleFormat ?? 'srt';
    this.fallbackDelays = fallbackDelays ?? undefined;
    this.jobId = jobId;
    this.tracks = tracks;
    this.dir = dir;
    this.postProcess = postProcess ?? {};
    this.concurrency = concurrency ?? 4;
    this.stripJunk = stripJunk ?? true;
    this.cooldownSchedule = cooldownSchedule ?? null;
    this.current = null;
    this.cancelled = false;
    this.completed = [];
    this.downloaders = null;
    this.next = 0; // the track to download next
    this.lastReport = 0;
    this.progress = new TrackProgress(tracks.map((t) => t.role));
  }

  cancel() {
    this.cancelled = true;
    this.current?.cancel();
  }

  report(trackIndex, p, force = false) {
    const now = Date.now();
    if (!force && now - this.lastReport < 150) return;
    this.lastReport = now;
    const { done, total } = this.progress.snapshot();
    const bytesBefore = this.completed.reduce((s, c) => s + c.file.size, 0);
    const retriesBefore = this.completed.reduce((s, c) => s + (c.retries ?? 0), 0);
    const cooldownsBefore = this.completed.reduce((s, c) => s + (c.cooldowns ?? 0), 0);
    const refreshesBefore = this.completed.reduce((s, c) => s + (c.refreshes ?? 0), 0);
    const mirrorBefore = this.completed.reduce((s, c) => s + (c.mirrorSwitches ?? 0), 0);
    notify('job:progress', {
      jobId: this.jobId,
      done,
      total,
      bytes: bytesBefore + p.bytes,
      retries: retriesBefore + (p.retries ?? 0),
      cooldowns: cooldownsBefore + (p.cooldowns ?? 0),
      refreshes: refreshesBefore + (p.refreshes ?? 0),
      mirrorSwitches: mirrorBefore + (p.mirrorSwitches ?? 0),
      spacingMs: p.spacingMs ?? 0,
      track: trackIndex + 1,
      tracks: this.tracks.length,
    });
  }

  /** The downloader of track i; nothing is fetched yet. */
  downloaderFor(track, i) {
    const onProgress = (p) => {
      this.progress.update(i, p.done, p.total);
      this.report(i, p, p.done === p.total);
    };
    const onCooldown = (c) =>
      notify('job:phase', {
        jobId: this.jobId,
        phase: 'cooldown',
        until: Date.now() + c.delay,
        status: c.status,
        cooldown: c.cooldown,
        of: c.of,
      });
    if (track.role === 'subtitle') {
      return new SubtitleDownload({
        track,
        format: this.subtitleFormat,
        onProgress,
        onCooldown,
        concurrency: this.concurrency,
        cooldownSchedule: this.cooldownSchedule,
      });
    }
    const common = {
      jobId: this.jobId,
      tag: track.role,
      dir: this.dir,
      onProgress,
      onCooldown,
      concurrency: this.concurrency,
      stripJunk: this.stripJunk,
      cooldownSchedule: this.cooldownSchedule,
      fallbackDelays: this.fallbackDelays,
    };
    return track.type === 'dash'
      ? new DashTrackDownload({
          ...common,
          plan: { init: track.init, segments: track.segments },
          ext: track.ext,
          refreshPlan: dashRefresher(track),
        })
      : new HlsDownload({ ...common, url: track.url });
  }

  /**
   * Reads every track's piece count. A media track that cannot be read fails
   * the job now, before anything is downloaded; a subtitle counts as 0 and
   * reports its own error when its turn comes.
   */
  async plan(downloaders) {
    for (let i = 0; i < downloaders.length; i++) {
      if (this.cancelled) throw new DOMException(t('cancelled'), 'AbortError');
      this.current = downloaders[i];
      try {
        this.progress.setTotal(i, await downloaders[i].count());
      } catch (error) {
        if (this.cancelled || error?.name === 'AbortError' || this.tracks[i].role !== 'subtitle') throw error;
      }
    }
    this.current = null;
  }

  async run() {
    try {
      if (!this.downloaders) {
        this.downloaders = this.tracks.map((track, i) => this.downloaderFor(track, i));
        await this.plan(this.downloaders);
      }
      for (; this.next < this.tracks.length; this.next++) {
        const i = this.next;
        if (this.cancelled) throw new DOMException(t('cancelled'), 'AbortError');
        const track = this.tracks[i];
        this.current = this.downloaders[i];
        if (track.role === 'subtitle') {
          try {
            this.completed.push({ ...(await this.current.run()), role: 'subtitle', downloader: this.current });
          } catch (error) {
            if (this.cancelled || error?.name === 'AbortError') throw error;
            const media = this.tracks.some((t) => t.role !== 'subtitle');
            // Alone, a failed subtitle is the job's error; next to a video it is a warning.
            if (!media && !this.tracks.slice(i + 1).length && !this.completed.length) throw error;
            notify('job:phase', {
              jobId: this.jobId,
              phase: 'subtitle-failed',
              label: track.label ?? track.lang ?? null,
              error: String(error?.message ?? error),
            });
          }
          this.current = null;
          continue;
        }
        const result = await this.current.run();
        this.completed.push({ ...result, role: track.role, downloader: this.current });
        this.current = null;
      }
    } catch (error) {
      this.current = null;
      if (!this.resumable(error)) await this.discard();
      throw error;
    }
    return this.completed;
  }

  /** After a failure: is there downloaded media worth keeping for a retry? */
  resumable(error) {
    if (this.cancelled || error?.name === 'AbortError' || !this.downloaders) return false;
    return this.completed.some((c) => c.role !== 'subtitle') || (this.downloaders[this.next]?.written ?? 0) > 0;
  }

  /** The same download chosen again: same tracks in the same order (their URLs may have changed). */
  matches(tracks) {
    return (
      Array.isArray(tracks) &&
      tracks.length === this.tracks.length &&
      tracks.every((t, i) => t.role === this.tracks[i].role && (t.type ?? null) === (this.tracks[i].type ?? null))
    );
  }

  /**
   * Prepares a run from the failed track on: fresh URLs for the tracks still
   * to come; the failed one keeps its written pieces when its plan allows.
   * @returns {{done:number, total:number}} pieces already there
   */
  resume(tracks) {
    this.cancelled = false;
    for (let i = this.next; i < tracks.length; i++) {
      this.tracks[i] = tracks[i];
      if (i === this.next && this.downloaders[i].prepareResume) this.downloaders[i].prepareResume(tracks[i]);
      else this.downloaders[i] = this.downloaderFor(tracks[i], i);
    }
    // The failed track keeps its written pieces (none for TS, which starts over).
    this.progress.reset(this.next, this.downloaders[this.next]?.written ?? 0);
    return this.progress.snapshot();
  }

  /** Removes every file the job wrote. */
  async discard() {
    for (const c of this.completed) await c.downloader.cleanup();
    for (const d of this.downloaders ?? []) await d.cleanup?.();
    this.completed = [];
  }

  /**
   * ffmpeg.wasm step: video + audio → one MP4, optional H.264 transcode,
   * optional subtitles embedded as mov_text tracks.
   * @returns {Promise<{merged: Object, consumed: Object[]}|null>} the new file
   *   and the completed entries it replaces; null when nothing had to be done
   */
  async finish() {
    const { merge, transcode, embedSubtitles } = this.postProcess;
    const video = this.completed.find((c) => c.role === 'video');
    const audio = this.completed.find((c) => c.role === 'audio');
    const subs = this.completed.filter((c) => c.role === 'subtitle');
    const wantsMerge = merge && video && audio;
    const wantsTranscode = transcode && video;
    const wantsEmbed = embedSubtitles && video && subs.length > 0;
    if (!wantsMerge && !wantsTranscode && !wantsEmbed) return null;
    if (this.cancelled) throw new DOMException(t('cancelled'), 'AbortError');

    notify('job:phase', { jobId: this.jobId, phase: 'merging', progress: 0 });
    const result = await mergeTracks({
      video: video.file,
      audio: wantsMerge ? audio.file : null,
      subtitles: wantsEmbed
        ? subs.map((s) => ({ text: serializeCues(s.cues, 'srt'), language: iso639_2(s.lang), title: s.label ?? null }))
        : [],
      transcode: Boolean(wantsTranscode),
      onProgress: (progress) => notify('job:phase', { jobId: this.jobId, phase: 'merging', progress }),
    });
    if (!result.transcoded && !wantsMerge && !wantsEmbed) return null; // nothing changed (already H.264, no audio to merge)

    const consumed = [video, ...(wantsMerge ? [audio] : []), ...(wantsEmbed ? subs : [])];
    const fileName = `${this.jobId}-merged.out`;
    const handle = await this.dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(result.data);
    await writable.close();
    for (const c of consumed) await c.downloader.cleanup();
    const file = await handle.getFile();
    const media = consumed.filter((c) => c.role !== 'subtitle');
    const merged = {
      role: 'merged',
      file,
      fileName,
      ext: 'mp4',
      segments: media.reduce((s, c) => s + c.segments, 0),
      duration: media.find((c) => c.duration)?.duration ?? null,
      remuxed: true,
      transcoded: result.transcoded,
      codecs: result.codecs,
      embeddedSubtitles: wantsEmbed ? subs.map((s) => s.lang ?? s.label ?? '?') : [],
      // Keep the tracks' resilience counters on the merged file.
      retries: media.reduce((s, c) => s + (c.retries ?? 0), 0),
      cooldowns: media.reduce((s, c) => s + (c.cooldowns ?? 0), 0),
      refreshes: media.reduce((s, c) => s + (c.refreshes ?? 0), 0),
      mirrorSwitches: media.reduce((s, c) => s + (c.mirrorSwitches ?? 0), 0),
      junkBytes: media.reduce((s, c) => s + (c.junkBytes ?? 0), 0),
      spacingMs: Math.max(...media.map((c) => c.spacingMs ?? 0)),
      downloader: { cleanup: () => this.dir.removeEntry(fileName).catch(() => {}) },
    };
    return { merged, consumed };
  }
}

/** Re-reads the MPD and returns the fresh plan of the same representation (signed URLs rotate). */
function dashRefresher(track) {
  if (!track.mpdUrl || !track.repId) return null;
  return async () => {
    const text = track.manifestText ?? (await fetchText(track.mpdUrl, undefined, 'manifest'));
    const manifest = parseMpd(text, track.mpdUrl);
    const { videos, audios } = tracksOf(manifest);
    const rep = [...videos, ...audios].find((r) => r.id === track.repId);
    if (!rep?.plan) throw new Error(t('errRefreshedRepresentation'));
    return { init: rep.plan.init, segments: rep.plan.segments };
  };
}

async function streamDownload({ jobId, tracks, postProcess, concurrency, stripJunk, cooldownSchedule, fallbackDelays, subtitleFormat }) {
  if (active.has(jobId)) throw new Error(t('errJobRunning'));
  if (!Array.isArray(tracks) || !tracks.length) throw new Error(t('errNoPieces'));
  await dropStalled(jobId);
  const dir = await opfsDir();
  const job = new StreamJob({ jobId, tracks, dir, postProcess, concurrency, stripJunk, cooldownSchedule, fallbackDelays, subtitleFormat });
  runJob(job);
  return { started: true, tracks: tracks.length };
}

/**
 * The same download again after a failure: continues the kept job when it is
 * still here and the tracks match; otherwise { resumed: false } (the caller
 * starts over).
 */
async function streamResume({ jobId, tracks }) {
  if (active.has(jobId)) throw new Error(t('errJobRunning'));
  const entry = stalled.get(jobId);
  if (!entry || !entry.job.matches(tracks)) {
    await dropStalled(jobId);
    return { resumed: false };
  }
  clearTimeout(entry.timer);
  stalled.delete(jobId);
  const { done, total } = entry.job.resume(tracks);
  runJob(entry.job);
  return { resumed: true, done, total };
}

async function dropStalled(jobId) {
  const entry = stalled.get(jobId);
  if (!entry) return;
  clearTimeout(entry.timer);
  stalled.delete(jobId);
  await entry.job.discard();
}

/** Runs (or continues) a job in the background and reports how it ended. */
function runJob(job) {
  const { jobId } = job;
  active.set(jobId, job);
  job
    .run()
    .then(async (completed) => {
      const merged = await job.finish().catch((error) => {
        // ffmpeg problems must not lose the downloaded tracks: fall back to separate files.
        console.warn('[video-downloader] post-processing failed, keeping separate files', error);
        notify('job:phase', { jobId, phase: 'merge-failed', error: String(error?.message ?? error) });
        return null;
      });
      // The merged file first, then whatever it did not absorb (subtitle files, an unmerged audio track).
      return merged ? [merged.merged, ...completed.filter((c) => !merged.consumed.includes(c))] : completed;
    })
    .then((completed) => {
      active.delete(jobId);
      const files = completed.map((c, index) => {
        // An audio-only fMP4 track is an .m4a as far as players are concerned.
        const ext = c.role === 'audio' && c.ext === 'mp4' ? 'm4a' : c.ext;
        return {
          role: c.role,
          ext,
          size: c.file.size,
          segments: c.segments,
          remuxed: c.remuxed ?? false,
          junkBytes: c.junkBytes ?? 0,
          retries: c.retries ?? 0,
          cooldowns: c.cooldowns ?? 0,
          refreshes: c.refreshes ?? 0,
          mirrorSwitches: c.mirrorSwitches ?? 0,
          spacingMs: c.spacingMs ?? 0,
          transcoded: c.transcoded ?? false,
          codecs: c.codecs ?? null,
          ...(c.role === 'subtitle' ? { lang: c.lang ?? null, label: c.label ?? null } : {}),
          ...(c.embeddedSubtitles?.length ? { embeddedSubtitles: c.embeddedSubtitles } : {}),
          blobUrl: registerBlob(`${jobId}:${index}:${c.role}`, c.file, c.fileName, mimeFor(ext)),
        };
      });
      const duration = completed.find((c) => c.duration)?.duration ?? null;
      notify('job:complete', { jobId, files, duration });
    })
    .catch((error) => {
      active.delete(jobId);
      const cancelled = error?.name === 'AbortError';
      const resumable = !cancelled && job.resumable(error);
      if (resumable) {
        // Kept for a retry in this session; dropped after a while.
        stalled.set(jobId, { job, timer: setTimeout(() => dropStalled(jobId), STALLED_TTL_MS) });
      }
      notify('job:error', {
        jobId,
        cancelled,
        resumable,
        error: cancelled ? t('cancelled') : String(error?.message ?? error),
        detail: error?.detail ?? null,
      });
    });
}

async function cancel({ jobId }) {
  const job = active.get(jobId);
  if (!job) return { cancelled: false };
  job.cancel();
  return { cancelled: true };
}

/** Releases every blob/file registered under a job id (and its per-role keys), and what a failed job kept. */
async function release({ jobId }) {
  const dir = await opfsDir();
  let released = 0;
  if (stalled.has(jobId)) {
    await dropStalled(jobId);
    released++;
  }
  for (const [key, entry] of [...blobUrls]) {
    if (key !== jobId && !key.startsWith(`${jobId}:`)) continue;
    URL.revokeObjectURL(entry.url);
    blobUrls.delete(key);
    if (entry.fileName) await dir.removeEntry(entry.fileName).catch(() => {}); // subtitles live in memory only
    released++;
  }
  return { released };
}

/** Debug/test helper: names of files currently held in OPFS. */
async function opfsList() {
  const dir = await opfsDir();
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  return { files: names, activeJobs: [...active.keys()], blobs: [...blobUrls.keys()], stalledJobs: [...stalled.keys()] };
}

const jobs = {
  'fetch-to-blob': fetchToBlob,
  'stream-download': streamDownload,
  'stream-resume': streamResume,
  cancel,
  release,
  'opfs-list': opfsList,
  'ffmpeg-load': async () => {
    await getFFmpeg();
    return { loaded: isFFmpegLoaded() };
  },
  'ffmpeg-probe': async ({ blobUrl }) => {
    const blob = await (await fetch(blobUrl)).blob();
    return probe(blob);
  },
  ping: async () => ({ pong: true, mux: typeof globalThis.muxjs?.Transmuxer === 'function' }),
};

// No chrome.i18n in an offscreen document: the service worker hands over the
// messages of the language in use (re-read now and then: the setting may change).
let i18nAt = 0;
let i18nLoading = null;
function ensureI18n() {
  if (!i18nLoading || Date.now() - i18nAt > 10_000) {
    i18nAt = Date.now();
    i18nLoading = chrome.runtime
      .sendMessage({ type: 'i18n:get' })
      .then((response) => {
        if (response?.ok) setMessages(response.result.messages, response.result.lang);
      })
      .catch(() => {});
  }
  return i18nLoading;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  const job = jobs[message.job];
  if (!job) {
    sendResponse({ ok: false, error: `Unknown offscreen job: ${message.job}` });
    return false;
  }
  ensureI18n()
    .then(() => job(message.payload ?? {}))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
