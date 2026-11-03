// X (Twitter): videos and GIFs in posts. The player streams HLS through MSE
// (separate video and audio playlists); the post data the web client loads
// (`video_info.variants`) lists progressive MP4s with video and audio in one
// file. See main.js for the extractor.

import { KIND } from '../../lib/media-url.js';
import { truncate } from '../../lib/filename.js';

/** Highest-bitrate MP4 variant (each carries video and audio); null when there is none. */
export function pickBestVariant(variants = []) {
  const mp4 = variants.filter((v) => v.type === 'video/mp4');
  return (
    mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0] ??
    null
  );
}

/** "WIDTHxHEIGHT" in a variant URL (…/vid/avc1/1280x720/…). */
export function sizeFromUrl(url) {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

// Player chunks on the video CDN (video.twimg.com) name the media they
// belong to: /ext_tw_video/<media id>/… and /amplify_video/<media id>/….
// Matched on the path alone, so the fixture server can stand in for the CDN.
const CHUNK = /\/(?:ext_tw_video|amplify_video)\/(\d+)\//;

const titleOf = (item) => {
  const text = (item.text ?? '')
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [item.user ? `@${item.user}` : null, text ? truncate(text, 60) : null].filter(Boolean).join(' ') || null;
};

/** @type {import('../index.js').SiteDefinition} */
export default {
  id: 'twitter',
  label: 'X (Twitter)',
  hosts: [/(^|\.)x\.com$/, /(^|\.)twitter\.com$/],
  matches: ['*://*.x.com/*', '*://*.twitter.com/*'],
  main: 'src/sites/twitter/main.js',
  version: 1,
  globals: { hooked: '__vdlTwitterHooked', version: '__vdlTwitterVersion', stats: '__vdlTwitterStats' },
  // The video CDN serves the files without the page's cookies or Referer.
  fetchContext: 'page',

  chunkOf(url) {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    const m = CHUNK.exec(path);
    return m ? `twitter:${m[1]}` : null;
  },

  toItems(report, { pageUrl }) {
    /** @type {{entry:Object, sizeFrom?:string, describe?:boolean}[]} */
    const out = [];
    for (const item of report.items ?? []) {
      const base = {
        source: 'site',
        site: 'twitter',
        code: item.tweetId ?? null,
        duration: item.duration ?? null,
        title: titleOf(item),
        pageUrl,
      };
      const best = pickBestVariant(item.variants);
      if (best) {
        const size = sizeFromUrl(best.url);
        out.push({
          entry: {
            ...base,
            key: `twitter:${item.mediaId}`,
            url: best.url,
            kind: KIND.VIDEO,
            size: null,
            contentType: 'video/mp4',
            width: size.width ?? item.width ?? null,
            height: size.height ?? item.height ?? null,
            versions: item.variants.filter((v) => v.type === 'video/mp4'),
          },
          sizeFrom: best.url,
        });
        continue;
      }
      // No progressive file: the HLS master (video and audio playlists, merged after download).
      const hls = item.variants?.find((v) => v.type === 'application/x-mpegURL');
      if (hls) {
        out.push({
          entry: {
            ...base,
            key: `twitter:${item.mediaId}:hls`,
            url: hls.url,
            kind: KIND.HLS,
            size: null,
            contentType: 'application/x-mpegurl',
            width: item.width ?? null,
            height: item.height ?? null,
          },
          describe: true,
        });
      }
    }
    return out;
  },
};
