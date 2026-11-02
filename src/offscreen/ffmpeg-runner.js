// ffmpeg.wasm wrapper (single-threaded core, vendored). Loaded lazily the
// first time a merge or transcode is needed; the ~31 MB wasm is compiled once
// per offscreen document lifetime.
//
// Inputs are mounted with WORKERFS (zero-copy from File objects); output is
// written to MEMFS and read back once.

import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { mergeArgs } from '../lib/ffmpeg-args.js';
import { t } from '../lib/i18n.js';

let instance = null;
let loading = null;

export async function getFFmpeg(onLog) {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      if (onLog) ff.on('log', onLog);
      await ff.load({
        classWorkerURL: chrome.runtime.getURL('src/vendor/ffmpeg/worker.js'),
        coreURL: chrome.runtime.getURL('src/vendor/ffmpeg/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('src/vendor/ffmpeg/ffmpeg-core.wasm'),
      });
      instance = ff;
      return ff;
    })().finally(() => {
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

async function withInputs(files, run) {
  const ff = await getFFmpeg();
  const mountPoint = `/in-${Date.now()}-${++mountCounter}`;
  await ff.createDir(mountPoint);
  await ff.mount('WORKERFS', { files }, mountPoint);
  try {
    return await run(ff, (name) => `${mountPoint}/${name}`);
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
  const named = new File([file], 'probe.bin');
  return withInputs([named], (ff, p) => probeAt(ff, p('probe.bin')));
}

/**
 * Merges a video-only and an audio-only file into one MP4 without
 * re-encoding. Optionally re-encodes the video to H.264 when it is not
 * already (VP9/AV1 → QuickTime-compatible), and embeds subtitles (SRT text)
 * as mov_text tracks.
 * @param {{video:Blob, audio?:Blob|null, subtitles?:{text:string, language:string, title?:string|null}[], transcode?:boolean, onProgress?:Function}} opts
 * @returns {Promise<{data: Uint8Array, transcoded: boolean, codecs: {video:string|null,audio:string|null}}>}
 */
export async function mergeTracks({ video, audio, subtitles = [], transcode = false, onProgress }) {
  const inputs = [];
  if (video) inputs.push(new File([video], 'video.bin'));
  if (audio) inputs.push(new File([audio], 'audio.bin'));
  if (!inputs.length) throw new Error(t('errNothingToMerge'));
  subtitles.forEach((s, i) => inputs.push(new File([s.text], `sub${i}.srt`)));

  return withInputs(inputs, async (ff, p) => {
    const codecs = { video: null, audio: null };
    if (video) Object.assign(codecs, await probeAt(ff, p('video.bin')));
    if (audio) codecs.audio = (await probeAt(ff, p('audio.bin'))).audio ?? codecs.audio;

    const needsTranscode = transcode && codecs.video && codecs.video !== 'h264';
    const args = ['-hide_banner', '-y'];
    for (const f of inputs) args.push('-i', p(f.name));
    args.push(...mergeArgs({ audio: Boolean(audio), subtitles, transcode: Boolean(needsTranscode), audioCodec: codecs.audio }), 'out.mp4');

    const progressHandler = onProgress ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))) : null;
    if (progressHandler) ff.on('progress', progressHandler);
    const { lines, handler } = logCollector();
    ff.on('log', handler);
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
    const data = await ff.readFile('out.mp4');
    await ff.deleteFile('out.mp4').catch(() => {});
    return { data, transcoded: Boolean(needsTranscode), codecs };
  });
}
