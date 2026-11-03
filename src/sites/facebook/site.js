// Facebook: Reels, Watch and videos in posts. The player streams separate
// DASH tracks from fbcdn.net (hidden in the list by their `efg` tag, like
// Instagram's); the page's own data gives a progressive MP4 with audio, or
// the DASH manifest. See main.js for the extractor.

import { KIND } from '../../lib/media-url.js';
import { truncate } from '../../lib/filename.js';

const titleOf = (item) => {
  const text = (item.text ?? '').split('\n')[0].trim();
  return [item.owner, text ? truncate(text, 60) : null].filter(Boolean).join(' · ') || null;
};

/** @type {import('../index.js').SiteDefinition} */
export default {
  id: 'facebook',
  label: 'Facebook',
  hosts: [/(^|\.)facebook\.com$/],
  matches: ['*://*.facebook.com/*'],
  main: 'src/sites/facebook/main.js',
  version: 1,
  globals: { hooked: '__vdlFacebookHooked', version: '__vdlFacebookVersion', stats: '__vdlFacebookStats' },
  // The CDN accepts the page's own headers.
  fetchContext: 'page',

  toItems(report, { pageUrl }) {
    /** @type {{entry:Object, sizeFrom?:string, describe?:boolean}[]} */
    const out = [];
    for (const item of report.items ?? []) {
      const base = {
        source: 'site',
        site: 'facebook',
        code: item.id,
        duration: item.duration ?? null,
        title: titleOf(item),
        pageUrl,
        width: item.width ?? null,
        height: item.height ?? null,
      };
      // HD, else SD: both carry video and audio.
      const url = item.hd ?? item.sd;
      if (url) {
        out.push({
          entry: { ...base, key: `facebook:${item.id}`, url, kind: KIND.VIDEO, size: null, contentType: 'video/mp4' },
          sizeFrom: url,
        });
        continue;
      }
      // Only the DASH manifest (inline, or its address): video and audio tracks, merged after download.
      if (item.dashManifest || item.dashManifestUrl) {
        out.push({
          entry: {
            ...base,
            key: `facebook:${item.id}:dash`,
            url: item.dashManifest ? `https://www.facebook.com/watch/?v=${item.id}#dash` : item.dashManifestUrl,
            kind: KIND.DASH,
            ...(item.dashManifest ? { manifestText: item.dashManifest } : {}),
            size: null,
            contentType: 'application/dash+xml',
            // A later report may bring the MP4: this entry then hides behind it.
            coveredBy: `facebook:${item.id}`,
          },
          describe: true,
        });
      }
    }
    return out;
  },
};
