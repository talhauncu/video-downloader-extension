// Vimeo: vimeo.com pages and players embedded in other sites (an iframe of
// player.vimeo.com). The player's configuration lists progressive MP4s with
// audio (when the video still has them) and the HLS master it streams. See
// main.js for the extractor.

import { KIND } from '../../lib/media-url.js';

/** Largest progressive file (each carries video and audio); null when there is none. */
export function pickBestProgressive(files = []) {
  return (
    [...files].sort((a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0) || (b.fps ?? 0) - (a.fps ?? 0))[0] ?? null
  );
}

const titleOf = (item) => [item.owner, item.title].filter(Boolean).join(' · ') || null;

/** @type {import('../index.js').SiteDefinition} */
export default {
  id: 'vimeo',
  label: 'Vimeo',
  hosts: [/(^|\.)vimeo\.com$/],
  matches: ['*://*.vimeo.com/*'],
  main: 'src/sites/vimeo/main.js',
  version: 1,
  globals: { hooked: '__vdlVimeoHooked', version: '__vdlVimeoVersion', stats: '__vdlVimeoStats' },
  // Embedded players: the CDN may check that requests come from the player's frame.
  fetchContext: 'frame',
  allFrames: true,

  toItems(report, { pageUrl }) {
    /** @type {{entry:Object, sizeFrom?:string, describe?:boolean}[]} */
    const out = [];
    for (const item of report.items ?? []) {
      const base = {
        source: 'site',
        site: 'vimeo',
        code: item.id,
        duration: item.duration ?? null,
        title: titleOf(item),
        pageUrl,
      };
      const best = pickBestProgressive(item.progressive);
      if (best) {
        out.push({
          entry: {
            ...base,
            key: `vimeo:${item.id}`,
            url: best.url,
            kind: KIND.VIDEO,
            size: null,
            contentType: 'video/mp4',
            width: best.width ?? item.width ?? null,
            height: best.height ?? item.height ?? null,
            versions: item.progressive,
          },
          sizeFrom: best.url,
        });
        continue;
      }
      if (item.hls) {
        out.push({
          entry: {
            ...base,
            key: `vimeo:${item.id}:hls`,
            url: item.hls,
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
