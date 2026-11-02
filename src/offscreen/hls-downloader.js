// Downloads one HLS track (VOD) into a single OPFS file.
//  - master playlist → best variant (callers pass a chosen variant URL)
//  - segments fetched with limited concurrency, written strictly in order
//  - AES-128 segments decrypted with WebCrypto
//  - TS segments remuxed to fMP4 with mux.js; raw TS kept as a fallback
//  - fMP4 segments (EXT-X-MAP) concatenated as-is

import { isMasterPlaylist, parseMasterPlaylist, parseMediaPlaylist, sortVariants, ivForSegment } from '../lib/m3u8.js';
import { TsRemuxer } from './remux.js';
import { runPool } from './segment-pool.js';
import { fetchText, fetchBytes, abortError, Throttle } from './fetch-utils.js';
import { trimJunk } from '../lib/sniff.js';
import { mirrorOrigins } from '../lib/mirrors.js';
import { fetchPieceWithFallback } from './fallback.js';
import { t } from '../lib/i18n.js';

export class HlsDownload {
  /**
   * @param {{jobId:string, tag?:string, url:string, dir:FileSystemDirectoryHandle, onProgress?:Function,
   *   onCooldown?:Function, concurrency?:number, stripJunk?:boolean, cooldownSchedule?:number[], fallbackDelays?:number[]}} opts
   */
  constructor({
    jobId,
    tag = 'video',
    url,
    dir,
    onProgress,
    onCooldown,
    concurrency = 4,
    stripJunk = true,
    cooldownSchedule,
    fallbackDelays,
  }) {
    this.jobId = jobId;
    this.stats = { mirrorSwitches: 0 };
    this.origins = [];
    this.fallbackDelays = fallbackDelays;
    this.concurrency = concurrency;
    this.stripJunk = stripJunk;
    /** @type {'ts'|'fmp4'|'unknown'} */
    this.container = 'unknown';
    this.throttle = new Throttle({ concurrency, onCooldown, ...(cooldownSchedule ? { cooldownSchedule } : {}) });
    this.refreshes = 0;
    this.mediaUrl = null; // resolved media playlist URL (after master selection)
    this.segments = null;
    this.refreshing = null;
    this.tag = tag;
    this.url = url;
    this.dir = dir;
    this.onProgress = onProgress;
    this.abort = new AbortController();
    this.keys = new Map();
    this.files = [];
  }

  cancel() {
    this.abort.abort(abortError());
  }

  async resolveMediaPlaylist() {
    const signal = this.abort.signal;
    let url = this.url;
    let text;
    try {
      text = await fetchText(url, signal, 'manifest', this.throttle);
    } catch (error) {
      if (error?.detail?.status === 403 || error?.detail?.status === 410) {
        error.message = t('errPlayerUrlExpiredShort');
        error.detail.expired = true;
      }
      throw error;
    }
    if (isMasterPlaylist(text)) {
      const { variants } = parseMasterPlaylist(text, url);
      if (!variants.length) throw new Error(t('errMasterEmpty'));
      url = sortVariants(variants)[0].url;
      text = await fetchText(url, signal, 'manifest', this.throttle);
    }
    const media = parseMediaPlaylist(text, url);
    if (media.live) throw new Error(t('errLiveStream'));
    if (media.unsupportedKey) throw new Error(t('errEncryptionUnsupported', media.unsupportedKey));
    if (!media.segments.length) throw new Error(t('errPlaylistNoPieces'));
    this.mediaUrl = url;
    this.segments = media.segments;
    this.origins = mirrorOrigins(media.segments.map((s) => s.url));
    return media;
  }

  /**
   * Re-reads the media playlist (signed segment URLs may have expired) and
   * swaps in the fresh segment list. Concurrent callers share one refresh.
   */
  refreshPlaylist() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const text = await fetchText(this.mediaUrl, this.abort.signal, 'manifest', this.throttle);
        const media = parseMediaPlaylist(text, this.mediaUrl);
        if (media.segments.length !== this.segments.length) {
          throw new Error(t('errPlaylistPiecesChanged', this.segments.length, media.segments.length));
        }
        this.segments = media.segments;
        this.origins = mirrorOrigins(media.segments.map((s) => s.url));
        this.refreshes++;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  fallbackContext() {
    return {
      signal: this.abort.signal,
      throttle: this.throttle,
      origins: () => this.origins,
      refresh: () => this.refreshPlaylist(),
      stats: this.stats,
      delays: this.fallbackDelays,
    };
  }

  /** Init segment of segment `i` (EXT-X-MAP) through the fallback chain. */
  async fetchInit(i) {
    try {
      const data = await this.withSlot(() => fetchPieceWithFallback(() => this.segments[i].map, { step: 'init' }, this.fallbackContext()));
      return this.postProcess(data, { key: null }, { step: 'init' });
    } catch (error) {
      if (error?.detail) error.detail.refreshes = this.refreshes;
      throw error;
    }
  }

  /** Segment `i` through the fallback chain (expired URL refresh, mirrors, spaced retries). */
  async fetchSegmentAt(i, total) {
    const label = { step: 'segment', index: i, total };
    try {
      const data = await this.withSlot(() => fetchPieceWithFallback(() => this.segments[i], label, this.fallbackContext()));
      return this.postProcess(data, this.segments[i], label);
    } catch (error) {
      if (error?.detail) error.detail.refreshes = this.refreshes;
      throw error;
    }
  }

  async withSlot(fn) {
    await this.throttle.acquire(this.abort.signal);
    try {
      return await fn();
    } finally {
      this.throttle.release();
    }
  }

  async keyFor(keyInfo) {
    let p = this.keys.get(keyInfo.url);
    if (!p) {
      p = fetchBytes(keyInfo.url, null, this.abort.signal, { step: 'key' }, this.throttle).then((raw) => {
        if (raw.length !== 16) throw new Error(t('errAesKeySize'));
        return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      });
      this.keys.set(keyInfo.url, p);
    }
    return p;
  }

  /** Decrypts (AES-128) and trims junk bytes of a fetched piece. */
  async postProcess(data, segment, label = {}) {
    if (segment.key?.method === 'AES-128') {
      const key = await this.keyFor(segment.key);
      const iv = ivForSegment(segment);
      data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: /** @type {any} */ (iv) }, key, /** @type {any} */ (data)));
    }
    if (this.stripJunk && label.step !== 'key') {
      const trimmed = trimJunk(data, this.container);
      if (trimmed !== data) {
        this.junkBytes = (this.junkBytes ?? 0) + (data.length - trimmed.length);
        data = trimmed;
      }
    }
    return data;
  }

  async openFile(name) {
    const handle = await this.dir.getFileHandle(name, { create: true });
    this.files.push(name);
    return { handle, writable: await handle.createWritable() };
  }

  async run() {
    const media = await this.resolveMediaPlaylist();
    const { segments } = media;
    const total = segments.length;
    const isTs = media.container !== 'fmp4';
    this.container = isTs ? 'ts' : 'fmp4';
    this.onProgress?.({ done: 0, total, bytes: 0 });

    const out = await this.openFile(`${this.jobId}-${this.tag}.out`);
    const raw = isTs ? await this.openFile(`${this.jobId}-${this.tag}.raw`) : null;
    let remuxer = null;
    let remuxFailed = false;
    if (isTs) {
      try {
        remuxer = new TsRemuxer({ duration: media.totalDuration });
      } catch {
        remuxFailed = true;
      }
    }

    let bytes = 0;
    let done = 0;
    let lastMapKey = null;

    try {
      await runPool({
        count: total,
        concurrency: this.concurrency,
        signal: this.abort.signal,
        fetchIndex: (i) => this.fetchSegmentAt(i, total),
        write: async (i, data) => {
          const segment = segments[i];
          if (isTs) {
            await raw.writable.write(data);
            if (remuxer && !remuxFailed) {
              try {
                for (const chunk of remuxer.push(data)) await out.writable.write(chunk);
              } catch (error) {
                console.warn('[video-downloader] remux failed, keeping raw TS', error);
                remuxFailed = true;
              }
            }
          } else {
            const mapKey = segment.map
              ? `${segment.map.url}|${segment.map.byteRange?.offset ?? ''}|${segment.map.byteRange?.length ?? ''}`
              : null;
            if (mapKey && mapKey !== lastMapKey) {
              const init = await this.fetchInit(i);
              await out.writable.write(init);
              bytes += init.length;
              lastMapKey = mapKey;
            }
            await out.writable.write(data);
          }
          bytes += data.length;
          done += 1;
          this.onProgress?.({
            done,
            total,
            bytes,
            ...this.throttle.snapshot(),
            refreshes: this.refreshes,
            mirrorSwitches: this.stats.mirrorSwitches,
          });
        },
      });
      await out.writable.close();
      if (raw) await raw.writable.close();
    } catch (error) {
      await out.writable.abort().catch(() => {});
      if (raw) await raw.writable.abort().catch(() => {});
      await this.cleanup();
      throw error;
    }

    const useRaw = isTs && (remuxFailed || !remuxer);
    const finalName = useRaw ? `${this.jobId}-${this.tag}.raw` : `${this.jobId}-${this.tag}.out`;
    const finalHandle = useRaw ? raw.handle : out.handle;
    for (const name of this.files) {
      if (name !== finalName) await this.dir.removeEntry(name).catch(() => {});
    }
    this.files = [finalName];

    const file = await finalHandle.getFile();
    return {
      file,
      fileName: finalName,
      ext: useRaw ? 'ts' : 'mp4',
      remuxed: isTs && !useRaw,
      segments: total,
      duration: media.totalDuration,
      junkBytes: this.junkBytes ?? 0,
      ...this.throttle.snapshot(),
      refreshes: this.refreshes,
      mirrorSwitches: this.stats.mirrorSwitches,
    };
  }

  async cleanup() {
    for (const name of this.files) await this.dir.removeEntry(name).catch(() => {});
    this.files = [];
  }
}
