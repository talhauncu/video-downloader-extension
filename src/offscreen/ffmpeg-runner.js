// ffmpeg.wasm wrapper (vendored). Two cores:
//  - single-threaded (src/vendor/ffmpeg): loaded lazily the first time a
//    merge or transcode is needed and kept for the document's lifetime; its
//    memory grows up to 2 GB, so it takes every merge and large file.
//  - multi-threaded (src/vendor/ffmpeg-mt): ~3× faster H.264 transcoding;
//    needs the cross-origin isolation the manifest turns on. Its memory is a
//    fixed 1 GB, so it only takes transcodes of inputs that fit
//    (MT_INPUT_LIMIT), is loaded per job and terminated afterwards to give
//    that memory back. When it fails the single-threaded core runs the job.
//
// Inputs are mounted with WORKERFS (zero-copy from File objects); output is
// written to MEMFS and read back once.

import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { mergeArgs, pickCore, mtThreads } from '../lib/ffmpeg-args.js';
import { t } from '../lib/i18n.js';

const CORES = {
  single: { coreURL: 'src/vendor/ffmpeg/ffmpeg-core.js', wasmURL: 'src/vendor/ffmpeg/ffmpeg-core.wasm' },
  mt: {
    coreURL: 'src/vendor/ffmpeg-mt/ffmpeg-core.js',
    wasmURL: 'src/vendor/ffmpeg-mt/ffmpeg-core.wasm',
    workerURL: 'src/vendor/ffmpeg-mt/ffmpeg-core.worker.js',
  },
};

/** @param {'single'|'mt'} name */
async function loadCore(name) {
  const ff = new FFmpeg();
  const urls = Object.fromEntries(Object.entries(CORES[name]).map(([key, file]) => [key, chrome.runtime.getURL(file)]));
  await ff.load({ classWorkerURL: chrome.runtime.getURL('src/vendor/ffmpeg/worker.js'), ...urls });
  return ff;
}

let instance = null;
let loading = null;

/** The single-threaded core, shared by every job. */
export async function getFFmpeg() {
  if (instance) return instance;
  if (!loading) {
    loading = loadCore('single')
      .then((ff) => (instance = ff))
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export function isFFmpegLoaded() {
  return Boolean(instance);
}

/** Collects ffmpeg's stderr-style log lines. */
function logCollector() {
  const lines = [];
  const handler = ({ message }) => lines.push(message);
  return { lines, handler };
}

/** Parses "Stream #0:0 ... Video: vp9 ..." lines into codec names. */
export function codecsFromLog(lines) {
  const out = { video: null, audio: null };
  for (const line of lines) {
    let m = /Stream #\d+:\d+.*?: Video: ([a-z0-9]+)/i.exec(line);
    if (m && !out.video) out.video = m[1].toLowerCase();
    m = /Stream #\d+:\d+.*?: Audio: ([a-z0-9]+)/i.exec(line);
    if (m && !out.audio) out.audio = m[1].toLowerCase();
  }
  return out;
}

let mountCounter = 0;

async function withInputs(ff, files, run) {
  const mountPoint = `/in-${Date.now()}-${++mountCounter}`;
  await ff.createDir(mountPoint);
  await ff.mount('WORKERFS', { files }, mountPoint);
  try {
    return await run((name) => `${mountPoint}/${name}`);
  } finally {
    await ff.unmount(mountPoint).catch(() => {});
    await ff.deleteDir(mountPoint).catch(() => {});
  }
}

/** Runs `ffmpeg -i <path>` on an already mounted file and parses the stream codecs. */
async function probeAt(ff, mountedPath) {
  const { lines, handler } = logCollector();
  ff.on('log', handler);
  try {
    await ff.exec(['-hide_banner', '-i', mountedPath]); // exits non-zero: no output, that is fine
  } catch {
    // expected
  } finally {
    ff.off('log', handler);
  }
  return codecsFromLog(lines);
}

/** Reads the stream codecs of a file without decoding it. */
export async function probe(file) {
  const ff = await getFFmpeg();
  const named = new File([file], 'probe.bin');
  return withInputs(ff, [named], (p) => probeAt(ff, p('probe.bin')));
}

/**
 * One merge/transcode on a loaded core.
 * @returns {Promise<{data: Uint8Array|null, transcoded: boolean, codecs: {video:string|null,audio:string|null}, threads: number|null, ms: number}>}
 *   data: null when there was nothing to do (already H.264, nothing to merge or embed)
 */
function runMerge(ff, core, { inputs, video, audio, subtitles, transcode, onProgress }) {
  return withInputs(ff, inputs, async (p) => {
    const codecs = { video: null, audio: null };
    if (video) Object.assign(codecs, await probeAt(ff, p('video.bin')));
    if (audio) codecs.audio = (await probeAt(ff, p('audio.bin'))).audio ?? codecs.audio;

    const needsTranscode = Boolean(transcode && codecs.video && codecs.video !== 'h264');
    if (!needsTranscode && !audio && !subtitles.length) return { data: null, transcoded: false, codecs, threads: null, ms: 0 };
    const threads = core === 'mt' && needsTranscode ? mtThreads(navigator.hardwareConcurrency) : null;
    const args = ['-hide_banner', '-y'];
    for (const f of inputs) args.push('-i', p(f.name));
    args.push(...mergeArgs({ audio: Boolean(audio), subtitles, transcode: needsTranscode, audioCodec: codecs.audio, threads }), 'out.mp4');

    const progressHandler = onProgress ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))) : null;
    if (progressHandler) ff.on('progress', progressHandler);
    const { lines, handler } = logCollector();
    ff.on('log', handler);
    const started = performance.now();
    let code;
    try {
      code = await ff.exec(args);
    } finally {
      if (progressHandler) ff.off('progress', progressHandler);
      ff.off('log', handler);
    }
    if (code !== 0) {
      throw new Error(t('errFfmpegFailed', code, lines.slice(-3).join(' | ')));
    }
    const ms = Math.round(performance.now() - started);
    const data = await ff.readFile('out.mp4');
    await ff.deleteFile('out.mp4').catch(() => {});
    return { data, transcoded: needsTranscode, codecs, threads, ms };
  });
}

/**
 * Merges a video-only and an audio-only file into one MP4 without
 * re-encoding. Optionally re-encodes the video to H.264 when it is not
 * already (VP9/AV1 → QuickTime-compatible), and embeds subtitles (SRT text)
 * as mov_text tracks.
 * @param {{video:Blob, audio?:Blob|null, subtitles?:{text:string, language:string, title?:string|null}[], transcode?:boolean,
 *   onProgress?:Function, coreMode?:string}} opts  coreMode: 'auto', 'single', or 'mt-fail' (tests: the multi-threaded core fails)
 * @returns {Promise<{data: Uint8Array|null, transcoded: boolean, codecs: {video:string|null,audio:string|null},
 *   core: 'single'|'mt', threads: number|null, ms: number, fellBack: boolean}>}
 */
export async function mergeTracks({ video, audio, subtitles = [], transcode = false, onProgress, coreMode = 'auto' }) {
  const inputs = [];
  if (video) inputs.push(new File([video], 'video.bin'));
  if (audio) inputs.push(new File([audio], 'audio.bin'));
  if (!inputs.length) throw new Error(t('errNothingToMerge'));
  subtitles.forEach((s, i) => inputs.push(new File([s.text], `sub${i}.srt`)));
  const job = { inputs, video, audio, subtitles, transcode, onProgress };

  const core = pickCore({
    transcode,
    isolated: Boolean(globalThis.crossOriginIsolated),
    inputBytes: inputs.reduce((sum, f) => sum + f.size, 0),
    mode: coreMode === 'single' ? 'single' : 'auto',
  });
  let fellBack = false;
  if (core === 'mt') {
    let ff = null;
    try {
      ff = await loadCore('mt');
      if (coreMode === 'mt-fail') throw new Error('multi-threaded core failure (test)');
      return { ...(await runMerge(ff, 'mt', job)), core: 'mt', fellBack };
    } catch (error) {
      console.warn('[video-downloader] multi-threaded ffmpeg failed; the single-threaded core runs the job', error);
      fellBack = true;
    } finally {
      ff?.terminate(); // gives its fixed 1 GB back
    }
  }
  return { ...(await runMerge(await getFFmpeg(), 'single', job)), core: 'single', fellBack };
}
