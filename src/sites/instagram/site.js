// Instagram: reels and posts. The player streams separate DASH tracks; the
// page's own data (video_versions, video_dash_manifest) gives one complete
// file per video instead. See main.js for the extractor.

import { KIND } from '../../lib/media-url.js';

/** Largest progressive version (they carry video and audio). */
export function pickBestVersion(versions = []) {
  return [...versions].sort((a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0))[0] ?? null;
}

const titleOf = (item) =>
  [item.username ? `@${item.username}` : null, item.caption ? item.caption.split('\n')[0].slice(0, 60) : null].filter(Boolean).join(' ');

/** @type {import('../index.js').SiteDefinition} */
export default {
  id: 'instagram',
  label: 'Instagram',
  hosts: [/(^|\.)instagram\.com$/],
  matches: ['*://*.instagram.com/*'],
  main: 'src/sites/instagram/main.js',
  version: 4,
  globals: { hooked: '__vdlInstagramHooked', version: '__vdlInstagramVersion', stats: '__vdlInstagramStats' },
  // The CDN accepts the page's own headers.
  fetchContext: 'page',

  toItems(report, { pageUrl }) {
    /** @type {{entry:Object, sizeFrom?:string, describe?:boolean}[]} */
    const out = [];
    for (const item of report.items ?? []) {
      const base = {
        source: 'site',
        site: 'instagram',
        code: item.code ?? null,
        duration: item.duration ?? null,
        title: titleOf(item),
        pageUrl,
      };
      const best = pickBestVersion(item.versions);
      if (best) {
        out.push({
          entry: {
            ...base,
            key: `instagram:${item.pk}`,
            url: best.url,
            kind: KIND.VIDEO,
            size: null,
            contentType: 'video/mp4',
            width: best.width ?? item.width ?? null,
            height: best.height ?? item.height ?? null,
            versions: item.versions,
          },
          sizeFrom: best.url,
        });
        continue;
      }
      // No progressive URL: keep the DASH manifest (video + audio tracks) so the
      // stream job can download and merge it.
      if (item.dashManifest) {
        out.push({
          entry: {
            ...base,
            key: `instagram:${item.pk}:dash`,
            url: `https://www.instagram.com/reel/${item.code ?? item.pk}/#dash`,
            kind: KIND.DASH,
            manifestText: item.dashManifest,
            size: null,
            contentType: 'application/dash+xml',
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
