// Downloads one DASH representation (init + media segments, or a single
// SegmentBase file) into one OPFS file. The segment plan comes from the
// service worker (src/lib/mpd.js), so this only fetches and concatenates.

import { runPool } from './segment-pool.js';
import { abortError, Throttle } from './fetch-utils.js';
import { trimJunk } from '../lib/sniff.js';
import { mirrorOrigins } from '../lib/mirrors.js';
import { fetchPieceWithFallback } from './fallback.js';
import { t } from '../lib/i18n.js';

export class DashTrackDownload {
  /**
   * @param {{jobId:string, tag:string, plan:{init:Object|null, segments:Array}, ext:string, dir:FileSystemDirectoryHandle, onProgress?:Function,
   *   onCooldown?:Function, concurrency?:number, stripJunk?:boolean, cooldownSchedule?:number[], refreshPlan?:Function|null, fallbackDelays?:number[]}} opts
   */
  constructor({
    jobId,
    tag,
    plan,
    ext,
    dir,
    onProgress,
    onCooldown,
    concurrency = 4,
    stripJunk = true,
    cooldownSchedule,
    refreshPlan = null,
    fallbackDelays,
  }) {
    this.onCooldown = onCooldown;
    this.stats = { mirrorSwitches: 0 };
    this.origins = mirrorOrigins((plan.segments ?? []).map((s) => s.url));
    this.fallbackDelays = fallbackDelays;
    this.refreshPlan = refreshPlan; // async () => plan with fresh URLs (token rotation)
    this.refreshes = 0;
    this.refreshing = null;
    this.jobId = jobId;
    this.concurrency = concurrency;
    this.stripJunk = stripJunk;
    this.tag = tag;
    this.plan = plan;
    this.ext = ext;
    this.dir = dir;
    this.onProgress = onProgress;
    this.abort = new AbortController();
    this.files = [];
    this.throttle = new Throttle({ concurrency, onCooldown, ...(cooldownSchedule ? { cooldownSchedule } : {}) });
  }

  refresh() {
    if (!this.refreshPlan) return Promise.reject(new Error('no refresh'));
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const plan = await this.refreshPlan();
        if (plan.segments.length !== this.plan.segments.length) throw new Error(t('errManifestPiecesChanged'));
        this.plan = plan;
        this.origins = mirrorOrigins(plan.segments.map((s) => s.url));
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
      refresh: this.refreshPlan ? () => this.refresh() : null,
      stats: this.stats,
      delays: this.fallbackDelays,
    };
  }

  async fetchInit() {
    try {
      return await fetchPieceWithFallback(() => this.plan.init, { step: 'init' }, this.fallbackContext());
    } catch (error) {
      if (error?.detail) error.detail.refreshes = this.refreshes;
      throw error;
    }
  }

  async fetchSegmentAt(i, total, clean) {
    try {
      return clean(await fetchPieceWithFallback(() => this.plan.segments[i], { step: 'segment', index: i, total }, this.fallbackContext()));
    } catch (error) {
      if (error?.detail) error.detail.refreshes = this.refreshes;
      throw error;
    }
  }

  cancel() {
    this.abort.abort(abortError());
  }

  async run() {
    const { init, segments } = this.plan;
    const total = segments.length;
    if (!total) throw new Error(t('errDashNoPieces'));
    this.onProgress?.({ done: 0, total, bytes: 0 });

    const fileName = `${this.jobId}-${this.tag}.out`;
    const handle = await this.dir.getFileHandle(fileName, { create: true });
    this.files.push(fileName);
    const writable = await handle.createWritable();
    let bytes = 0;
    let done = 0;

    try {
      const clean = (data) => (this.stripJunk ? trimJunk(data, 'fmp4') : data);
      if (init) {
        const data = clean(await this.fetchInit());
        await writable.write(data);
        bytes += data.length;
      }
      await runPool({
        count: total,
        concurrency: this.concurrency,
        signal: this.abort.signal,
        fetchIndex: async (i) => {
          await this.throttle.acquire(this.abort.signal);
          try {
            return await this.fetchSegmentAt(i, total, clean);
          } finally {
            this.throttle.release();
          }
        },
        write: async (_i, data) => {
          await writable.write(data);
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
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await this.cleanup();
      throw error;
    }

    const file = await handle.getFile();
    return {
      file,
      fileName,
      ext: this.ext,
      segments: total,
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
