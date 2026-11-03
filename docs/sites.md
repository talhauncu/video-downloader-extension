# Adding a site extractor

Most sites need nothing special: the extension sees their MP4s, playlists and
manifests on the network. A **site extractor** is for sites whose player hides
the useful file: Instagram and X stream separate tracks, while the page's own
data holds complete MP4s with audio. Prefer a general fix (capture, matching,
resilience) when one exists; write an extractor when the right file is only
in the page.

An extractor has three parts:

| Part | Where | Runs in | Does |
|---|---|---|---|
| Definition | `src/sites/<id>/site.js` | service worker, popup, Node tests (pure, no `chrome.*`) | names the site, its hosts and scripts, turns reports into list entries |
| Extractor | `src/sites/<id>/main.js` | the page's **main world** (classic script) | reads the page's data (inline JSON, `fetch`/XHR responses) and posts what it finds |
| Bridge | `src/sites/bridge.js` (shared) | the isolated world | relays the extractor's posts to the service worker |

The service worker derives everything else from the definition
(`src/background/sites.js`): content script registration
(`<id>-main`, `<id>-bridge`), the injection check when a popup opens or a page
finishes loading, the extractor probe in the debug info, and the handling of
reports (`site:media`). The popup takes the card label from it.

## 1. The definition

```js
// src/sites/example/site.js
import { KIND } from '../../lib/media-url.js';

/** @type {import('../index.js').SiteDefinition} */
export default {
  id: 'example',                       // lower case; entries get site: 'example'
  label: 'Example',                    // popup card label
  hosts: [/(^|\.)example\.com$/],      // top-frame hosts (decides injection)
  matches: ['*://*.example.com/*'],    // content script patterns for the same hosts
  main: 'src/sites/example/main.js',
  version: 1,                          // = VERSION in main.js; bump both together
  globals: { hooked: '__vdlExampleHooked', version: '__vdlExampleVersion', stats: '__vdlExampleStats' },
  fetchContext: 'page',                // Referer for its URLs: 'page' (the tab) or 'frame' (the reporting frame)
  // Optional: the entry a captured player chunk belongs to. The list hides the
  // chunk behind that entry once it exists (and only then).
  chunkOf(url) {
    const id = /\/videos\/(\d+)\//.exec(new URL(url).pathname)?.[1];
    return id ? `example:${id}` : null;  // = the key toItems gives that video
  },

  // One report from the extractor → store entries.
  toItems(report, { pageUrl }) {
    return (report.items ?? []).map((item) => ({
      entry: {
        key: `example:${item.id}`,     // stable per video: repeated reports merge
        url: item.url,
        kind: KIND.VIDEO,              // or KIND.DASH with manifestText, KIND.HLS …
        site: 'example',
        source: 'site',
        title: item.title ?? null,
        duration: item.duration ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        pageUrl,
      },
      sizeFrom: item.url,              // optional: HEAD this URL for the size
      // describe: true,               // optional: read a DASH/HLS manifest right away
    }));
  },
};
```

Then add it to `SITES` in `src/sites/index.js`. `validateSites()` (run by
`test/unit/sites.test.js`) checks every field, that ids are unique, that no
two sites claim the same hosts, that `main.js` exists, sets the three
`globals` and declares the same `VERSION`.

Entries with `site` set are "site entries": the list ranks the open page's
one first ("This page"; the page URL names `code` as a path segment), raw
chunks of the same video are hidden behind them (`chunkOf`, or Instagram's
`hidden` track tags), a captured copy of the entry's own file is hidden too,
and the in-page badge matches feed videos to them by `code` (a post's
shortcode or id, read from links like `/p/CODE/` or `/user/status/ID` around
the video) or duration. A new link shape goes into `POST_LINK` in
`src/content/badge.js`.

## 2. The extractor

```js
// src/sites/example/main.js — classic script, page main world, document_start
(() => {
  const VERSION = 1; // = version in site.js
  if (window.__vdlExampleVersion === VERSION) return;
  window.__vdlExampleVersion = VERSION;
  window.__vdlExampleHooked = true;
  const stats = { hooked: true, found: 0 };
  window.__vdlExampleStats = stats;

  const known = new Map();
  function publish(items) {
    const fresh = items.filter((it) => !known.has(it.id) && known.set(it.id, it));
    if (!fresh.length) return;
    stats.found += fresh.length;
    window.postMessage({ __vdl: 'site-media', site: 'example', items: fresh }, '*');
    window.postMessage({ __vdl: 'site-stats', site: 'example', stats }, '*');
  }

  // A reloaded extension brings a new bridge, which asks for a replay.
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.__vdl === 'site-resync' && known.size) {
      window.postMessage({ __vdl: 'site-media', site: 'example', items: [...known.values()] }, '*');
    }
  });

  // … read inline JSON, wrap fetch/XHR, call publish(found) …
})();
```

Rules that came from real bugs:

- **Version everything.** After an extension reload the main-world script
  stays in the page (a page global) but its bridge dies. The service worker
  pings the bridge and compares `window.<globals.version>` with
  `site.version`; a missing bridge is re-injected and asks for a replay, an
  old extractor gets the current one next to it.
- **Registered scripts do not reach tabs opened before the extension
  loaded.** That is why the service worker also injects on demand.
- **Keep posting small.** Post only new items; keep a `known` map for
  replays; send stats (what you scanned, what you found, sample keys) so the
  debug info explains an empty list.
- **Read data as the site sends it.** Real pages ship minified JSON; do not
  depend on formatting (the fixture pages are excluded from Prettier for this
  reason).

## 3. Tests

- **Unit** (`test/unit/sites.test.js`): `toItems` for each shape the site
  sends (progressive files, manifests, nothing usable). The registry checks
  run for the new site automatically.
- **Fixture page** (`test/fixtures/pages/<id>.html`): imitate the site's page:
  the inline JSON it ships, the API responses it fetches (serve them from
  `test/fixtures/media/`), the player's network requests. Never test against
  the real site.
- **E2E** (`test/e2e/<stage>-<id>.spec.js`): register the scripts for the
  fixture origin and point the site at the fixture host:

  ```js
  await ext.worker.evaluate(() => globalThis.__vdl.registerSiteScripts(['*://*.example.com/*', 'http://127.0.0.1/*'], 'example'));
  await ext.worker.evaluate(() => globalThis.__vdl.addSiteHost('127.0.0.1', 'example'));
  ```

  Then check that the popup shows one complete entry per video, that the
  download is byte-exact, that the debug info reports the extractor, and that
  a reload of the extension does not lose what was found. End the spec with
  "service worker logged no errors". See `test/e2e/stage4b-instagram.spec.js`
  and `test/e2e/stage5a-twitter.spec.js`.
- Add the site to the real-site checklist in the README for manual tests.
