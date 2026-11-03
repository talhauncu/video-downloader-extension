// Downloads one subtitle track and turns it into a single .srt/.vtt text.
//  - 'hls-subs':  WebVTT media playlist → every segment, merged on the media
//                 timeline (X-TIMESTAMP-MAP)
//  - 'dash-subs': text representation → its file or segments (WebVTT/TTML)
//  - 'file-subs': one subtitle file (page <track>, captured .vtt/.srt/.ttml)
// Subtitles are small: kept in memory, no OPFS.

import { parseMediaPlaylist } from '../lib/m3u8.js';
import { mergeSubtitleSegments, serializeCues } from '../lib/subtitles.js';
import { fetchText, abortError, Throttle } from './fetch-utils.js';
import { t } from '../lib/i18n.js';

const MIME = { srt: 'application/x-subrip', vtt: 'text/vtt' };

export class SubtitleDownload {
  /**
   * @param {{track:Object, format?:'srt'|'vtt', onProgress?:Function, onCooldown?:Function, concurrency?:number, cooldownSchedule?:number[]}} opts
   */
  constructor({ track, format = 'srt', onProgress, onCooldown, concurrency = 4, cooldownSchedule }) {
    this.track = track;
    this.format = format === 'vtt' ? 'vtt' : 'srt';
    this.onProgress = onProgress;
    this.concurrency = concurrency;
    this.throttle = new Throttle({ concurrency, onCooldown, ...(cooldownSchedule ? { cooldownSchedule } : {}) });
    this.abort = new AbortController();
  }

  cancel() {
    this.abort.abort(abortError());
  }

  /** Segment URLs of the track. */
  async urls() {
    const { track } = this;
    if (track.type === 'hls-subs') {
      const text = await fetchText(track.url, this.abort.signal, 'manifest', this.throttle);
      const media = parseMediaPlaylist(text, track.url);
      if (media.live) throw new Error(t('errLiveSubtitles'));
      return media.segments.map((s) => s.url);
    }
    if (track.type === 'dash-subs') return track.segments.map((s) => s.url);
    return [track.url];
  }

  /** Piece count, read before the job starts; run() reuses the list (subtitles go first). */
  async count() {
    this.planned = await this.urls();
    return this.planned.length;
  }

  async run() {
    const urls = this.planned ?? (await this.urls());
    if (!urls.length) throw new Error(t('errNoSubtitlePieces'));
    const texts = new Array(urls.length);
    let next = 0;
    let done = 0;
    let bytes = 0;
    this.onProgress?.({ done: 0, total: urls.length, bytes: 0 });
    const worker = async () => {
      while (next < urls.length) {
        const i = next++;
        texts[i] = await fetchText(urls[i], this.abort.signal, 'subtitle', this.throttle);
        done++;
        bytes += texts[i].length;
        this.onProgress?.({ done, total: urls.length, bytes, ...this.throttle.snapshot() });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, urls.length) }, worker));

    const cues = mergeSubtitleSegments(texts);
    if (!cues.length) throw new Error(t('errSubtitleEmpty'));
    const file = new Blob([serializeCues(cues, this.format)], { type: MIME[this.format] });
    return {
      file,
      fileName: null,
      ext: this.format,
      cues,
      segments: urls.length,
      lang: this.track.lang ?? null,
      label: this.track.label ?? null,
      ...this.throttle.snapshot(),
    };
  }

  async cleanup() {
    // in memory only
  }
}
