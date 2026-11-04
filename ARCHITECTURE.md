# Architecture

Video Downloader is a Manifest V3 extension without a build step: the files in
`src/` are loaded as they are (ES modules where Chrome allows them). This page
explains how the parts fit together and why some things are done the way they
are. The user-facing description is in [README.md](README.md).

```
manifest.json
_locales/{en,tr}/messages.json   interface texts (chrome.i18n format)
src/background/   service worker: capture, store, describe, jobs, downloads, badge/indicator, messages
src/content/      content scripts in every frame: DOM scanner, in-page download badge
src/sites/        site extractors: a pure definition per site, its main-world extractor, a shared bridge
src/offscreen/    offscreen document: segment downloads, AES, remux (mux.js), ffmpeg.wasm, subtitles
src/popup/        toolbar popup
src/options/      settings page
src/lib/          pure modules (no chrome.*): parsers, ranking, file names, i18n, settings …
src/vendor/       mux.js, ffmpeg.wasm (see THIRD_PARTY_LICENSES.md)
test/             unit tests (node:test), e2e tests (Playwright), fixtures (local server, pages, media)
```

## Components and messages

```
 page (every frame)                  service worker                        offscreen document
 ───────────────────                 ──────────────                        ──────────────────
 scanner.js  ── dom:media ────────▶  store (storage.session, per tab)
 badge.js    ── badge:resolve ────▶  organize / badge-resolve
             ── badge:download ───▶  start.js ─▶ jobs.js ── stream-download ─▶ HlsDownload / DashTrackDownload
             ◀─ badge:progress ───   job state (storage.session job:<id>)  ◀── job:progress / job:complete
 sites/<id>/main.js (MAIN world) ─▶ sites/bridge.js ── site:media ─▶ site.toItems ─▶ store
 popup.js    ── media:list / media:download / media:describe / … ─▶ messages.js
```

- **Service worker** (`src/background/service-worker.js`): captures media
  requests (`capture.js`, `chrome.webRequest`), keeps a per-tab list in
  `chrome.storage.session` (`store.js`, serialized per tab), describes
  playlists (`jobs.describe`), starts downloads (`start.js`) and answers the
  messages of the popup, the options page, the content scripts and the
  offscreen document (`messages.js`). Dynamic `import()` is not allowed in a
  service worker; tests talk to it through `globalThis.__vdl` hooks.
- **Offscreen document** (`src/offscreen/`): long downloads run here, because a
  service worker may be stopped at any time. Pieces are fetched with a small
  pool, written to OPFS in order and handed to `chrome.downloads` as a Blob at
  the end. It answers a job immediately (`{started: true}`) and reports
  progress and the result with `job:*` messages, so a restarted service worker
  loses nothing. A job's tracks (subtitles first, then video and audio) are
  downloaded one after another; their piece counts are read before the first
  one starts, so the reported total is fixed (`lib/track-progress.js`).
- **Content scripts** (`src/content/`): `scanner.js` reports `<video>`,
  `<source>` and `<track>` elements (open shadow roots and iframes included);
  `badge.js` draws the in-page download button.
- **Site extractors** (`src/sites/`): each site is a pure definition
  (`<id>/site.js`: hosts, match patterns, extractor path, version, probe
  globals, `toItems` turning reports into entries) plus an extractor running
  in the page's main world (`<id>/main.js`); one bridge (`bridge.js`, isolated
  world) relays every site's reports. `src/background/sites.js` derives the
  content script registration, the injection check (bridge ping + extractor
  version) and the debug probe from the definitions; `validateSites()` checks
  them. A definition may also name the entry a captured player chunk belongs
  to (`chunkOf`): the list then hides that chunk behind the entry (X's HLS
  pieces), and a captured copy of a site entry's own file is hidden too. Sites:
  Instagram, X, Facebook, Vimeo. A site may run in every frame (`allFrames`:
  Vimeo's players embedded in other sites); its entries then keep the player
  frame as their context. How to add a site:
  [docs/sites.md](docs/sites.md).
- **Pure modules** (`src/lib/`): everything that can be tested in Node lives
  here: the HLS and DASH parsers (`m3u8.js`, `mpd.js` on a tiny XML parser,
  `xml.js`), the list ranking (`organize.js`), badge matching
  (`badge-resolve.js`), subtitles (`subtitles.js`), audio language choice
  (`audio-lang.js`), file names, retries, settings and texts (`i18n.js`).

## Capturing media

- `capture.js` classifies responses by content type and URL
  (`media-url.js`): progressive files, HLS, DASH, segments, subtitles. Segment
  requests and byte ranges collapse into one entry per stream.
- A new page in the tab (a `main_frame` request) clears the tab's list. The
  tab's page address also follows `tabs.onUpdated`: a page restored from the
  back/forward cache or a prerendered one opens without a page request, and
  single-page apps change the address in place (the list is kept then). After
  a back/forward cache restore the DOM scanner reports the page again. File
  names take `{site}` from the tab's current address.
- Each request remembers its **frame**: many sites play their videos in a third-party player iframe
  and their media servers expect that iframe as the Referer. Manifest reads,
  segment downloads, HEAD size checks and direct downloads all use the
  requesting frame's address as their context (`contextUrl`), set through
  temporary `declarativeNetRequest` session rules (`header-rules.js`). These
  rules apply to the extension's own fetches, not to `chrome.downloads`
  requests; a direct download that the server refuses is retried through the
  offscreen document.
- **Disguised playlists** (`master.txt` served as `text/plain`) are sniffed with
  a small GET when the name looks like a playlist; `#EXTM3U` → HLS, `<MPD` → DASH.
- Playlists are **described in the background** as soon as they are captured
  (`autoDescribe`, shared with the popup's request), so the list and the badge
  are right before the popup opens. A download waits (up to 10 s) for the tab's
  undescribed playlists (`start.js` `settle`) and is sent to the master when it
  was started on one of its sub-playlists (`organize.masterFor`).

## The list: organize()

`src/lib/organize.js` turns the tab's entries into cards; the popup, the badge
and the keyboard shortcut all use it.

- Variant, audio and subtitle playlists listed by a master fold under it. They
  match by origin + path, and by origin + file name when the name is a long
  token (CDNs that rotate the first directory, `/mw/<token>` vs `/mt/<token>`).
- A `blob:` player (MediaSource) and a playlist of the same frame merge into one
  card when their durations match (≤ max(2 s, 2 %)).
- Ads score points (banner sizes, extreme aspect ratio, short, small, ad hosts,
  ad iframes); 3 or more go to "Other" (`hideAds`).
- The main card: the open page's site entry > the playlist the player plays >
  duration > area > size.
- Subtitle files attach to the card of their frame (else the main video); the
  WebVTT segments of a subtitle playlist fold away.

## Streams

- **HLS** (`m3u8.js`, `hls-downloader.js`): master and media playlists,
  `EXT-X-MAP`, `EXT-X-KEY` AES-128 (WebCrypto), byte ranges. MPEG-TS segments are
  remuxed to fragmented MP4 with mux.js as they arrive (raw `.ts` is kept as a
  fallback). mux.js output is repaired for QuickTime (`fmp4-fix.js`): real
  durations in the init segment and fragment numbers 1, 2, 3 …; AVFoundation
  otherwise reads no video at all. With "prefer H.264" (default) H.264 variants
  come before AV1/HEVC/VP9 ones.
- **DASH** (`mpd.js`, `dash-downloader.js`): `SegmentTemplate` (`$Number$`,
  `$Time$`, `SegmentTimeline`), `SegmentList`, `SegmentBase`; ContentProtection
  → "DRM protected". The plan (segment list) is built in the service worker and
  sent to the offscreen document.
- **Separate audio**: the audio rendition / representation is downloaded as its
  own track; `audioLang` (site default, original, a language) picks it when a
  stream has several (`audio-lang.js`).
- **Resilience** (`retry.js`, `fallback.js`, `mirrors.js`): retries with
  backoff, `Retry-After`, a shared throttle that drops to one request and adds
  spacing after a 429, long cooldowns within a budget (`maxCooldownMinutes`),
  playlist/MPD re-reads when signed URLs expire (403/410), the same path on
  other mirror hosts of the playlist on 404/5xx, and late retries spread over
  about two minutes. Junk bytes some hosts put in front of segments are trimmed
  (`stripJunk`). Errors name their step ("Piece 3/841 could not be fetched (HTTP 404)").
- **Live streams** (no `ENDLIST`), SAMPLE-AES and DRM are refused.
- **Plain files through the extension** (`startFileJob`, `file-plan.js`): with
  "convert to H.264" on, or with subtitles to embed, a plain video file is not
  handed to `chrome.downloads` but downloaded like a stream, so ffmpeg can work
  on it. The service worker asks for one byte (`Range: bytes=0-0`) with the
  frame's headers to learn the size, and sends a `file` track of 4 MB byte
  ranges; the offscreen document fetches it with the DASH downloader (no junk
  trimming). It is a stream job like any other: queue, progress, retries,
  resume. A server without ranges gives one piece. An H.264 file with nothing
  to embed is saved unchanged.

### Queue, notifications, resume

- **Queue** (`jobs.js`): at most `maxJobs` jobs (HLS/DASH and plain-file
  jobs, not subtitle-only jobs) are `downloading` at once. A job over the limit is saved
  as `queued`, its offscreen payload under `jobrun:<id>` (session storage), and
  gets no header rule until it starts. `pumpQueue()` starts the oldest queued
  jobs when a slot frees (a job reaches `saving`, fails or is cancelled), when
  `maxJobs` grows and when the service worker starts. Counting and claiming
  run under one lock (`exclusive`), so two starts never take the same slot.
- **Notifications**: a job that ends `done` or `error` (not cancelled, not a
  video's side job for its subtitles) raises a `chrome.notifications` card;
  clicking a "done" card shows the file (`chrome.downloads.show`). Setting
  `notify`.
- **Folder**: `subfolder` is a template (`{site}` `{date}`) cleaned to a
  relative path (`filename.js`: no `..`, no empty parts); file names are
  passed to `chrome.downloads` as `<folder>/<name>`.
- **Resume in the session**: the segment pool (`segment-pool.js`) stops at
  the first failure only after the write under way, so an fMP4/DASH track's
  output is a clean prefix of `written` pieces. On a failure the downloader
  commits that prefix (`close()` instead of `abort()`), and `StreamJob` keeps
  its finished tracks and the failed one in the offscreen document's `stalled`
  map (dropped after an hour, on `release`, or with "Clear list"). The job is
  marked `resumable`; downloading the same entry with the same tracks again
  (`resumeKeyOf`: entry key + role/representation/URL path of each track)
  reuses the job: `stream-resume` re-reads the playlist (or takes the fresh
  DASH plan), reopens the file with `keepExistingData` and continues from
  piece `written`; finished tracks are not fetched again. A TS track starts
  over (the remuxer's state is gone), as does a track whose piece count
  changed. When the offscreen document no longer has the job, it starts from
  the beginning.

## ffmpeg.wasm

`src/vendor/ffmpeg/`: `@ffmpeg/ffmpeg` 0.12.15 and the single-threaded
`@ffmpeg/core` 0.12.10 (31 MB wasm, CSP `'wasm-unsafe-eval'`);
`src/vendor/ffmpeg-mt/`: the multi-threaded `@ffmpeg/core-mt` 0.12.10. ffmpeg
runs as a module worker inside the offscreen document and is loaded on first
use. Inputs are mounted with WORKERFS (no copy), the output is read from MEMFS.
It merges separate video and audio (`-c copy`, `mergeTracks`), optionally
converts non-H.264 video to H.264 (`transcodeToH264`), and embeds subtitles as
`mov_text` tracks (`embedSubtitles`); arguments come from `ffmpeg-args.js`. If
ffmpeg fails, the tracks are saved separately with a warning.

Two cores (`ffmpeg-runner.js`, `pickCore`):

- The **multi-threaded core** needs `SharedArrayBuffer`, so the manifest makes
  the extension's pages cross-origin isolated (`cross_origin_opener_policy`
  `same-origin`, `cross_origin_embedder_policy` `require-corp`). The offscreen
  document's cross-origin fetches are not affected: they run under the host
  permissions. It converts to H.264 about 3× faster (20 s of 720p VP9: 17.7 s
  → 5.5 s). Its memory is a fixed 1 GB and the output lives in it, so it only
  takes conversions whose inputs are at most 256 MB (`MT_INPUT_LIMIT`). x264
  gets `-threads` (at most 4, `mtThreads`): left to itself it never finishes
  on this core, and with 6 or more threads the document crashed. It is loaded
  for each job and terminated afterwards to give the memory back.
- The **single-threaded core** (memory grows up to 2 GB) does every merge and
  larger conversions, and runs a conversion again when the multi-threaded
  core fails. The job's file records which core ran (`files[].ffmpeg`).

The vendored files are copies of the npm packages' files, unchanged.
`npm run check:vendor` (CI, lint job) compares each one with its source in
`node_modules` (SHA-256), the installed versions with `package-lock.json`, and
the versions in `src/vendor/ffmpeg/VERSIONS` and `THIRD_PARTY_LICENSES.md` with
both. A library upgrade copies the new files and updates those two notes in
the same change.

## Subtitles

`subtitles.js` parses WebVTT, SubRip and TTML into one cue list and writes
`.srt` or `.vtt`. HLS subtitle segments are placed on the stream's timeline
with `X-TIMESTAMP-MAP` (rebased on the smallest `MPEGTS`, since the downloaded
MP4 starts at 0); repeated cues are dropped and split cues joined. A file whose
URL and page name no language is read once: the language is guessed from its
words, and a file with fewer than one cue a minute is a dub's forced
(signs-only) track. Subtitle tracks run first in a job and only warn on failure.

## Interface languages

Texts live in `_locales/en/messages.json` and `_locales/tr/messages.json` and
are read through `src/lib/i18n.js` `t(key, …subs)` (`$1`… placeholders, like
`chrome.i18n`). The `uiLanguage` setting is `auto` (Chrome's language through
`chrome.i18n`), `en` or `tr` (that locale's messages are loaded). The offscreen
document has no `chrome.i18n`; it and the content scripts ask the service
worker for the messages in use (`i18n:get`). Pages mark their static texts with
`data-i18n`, `data-i18n-html` (trusted markup from our own messages),
`data-i18n-title` and `data-i18n-placeholder`. Never put two placeholders next
to each other (`$1$2`): Chrome reads `$1$` as a named placeholder and refuses
to load the extension (a unit test checks).

## In-page badge

`badge.js` keeps one button per visible `<video>` ≥ 200×112 in its own shadow
root, `position: fixed` with the highest z-index, following the video with
`getBoundingClientRect`. Pointer tracking is window-wide (players' overlays
swallow events). The service worker resolves the video to an entry
(`badge:resolve`, same ranking as the popup); feed videos of Instagram, X and
Facebook match by the post's code read from the links around them
(`/p/CODE/`, `/user/status/ID`, `/watch/?v=ID`, `/videos/ID`; `POST_LINKS`); an
embedded player is matched by the video its own frame names
(`player.vimeo.com/video/ID`). Site entries are never merge targets for
players by length. Progress is polled (`badge:progress`), downloads can be
cancelled (two clicks), and jobs are found again after a reload by entry id,
key and URL path.

## Firefox

The Firefox version is the same source with another manifest
(`scripts/firefox.js` → `dist/firefox/`; `npm run build:firefox`,
`npm run package -- --firefox`): `background.scripts` (an event page, module
type, mux.js loaded first) instead of the service worker, no `offscreen`
permission, no `key`, no COOP/COEP, and `browser_specific_settings.gecko`
(id `video-downloader@talhauncu.github.io`, Firefox 140+,
`data_collection_permissions: none`). The multi-threaded ffmpeg core is left
out.

- **No offscreen document.** Firefox's background page has a DOM, so
  `runOffscreenJob` (`src/background/offscreen.js`) imports the offscreen
  module into it on first use and calls its jobs directly (`runLocalJob`).
  Its reports go to the message handlers through a function (`setSink`)
  instead of `runtime.sendMessage`, which does not reach the sender's own page.
- **Staying awake.** Firefox suspends an idle background page after about 30 s
  without an extension event, which would stop a download running in it.
  While a job runs, the offscreen module writes an `awake` key to
  `storage.session` every 10 s; the background's `storage.onChanged`
  listeners make that an event.
- **Referer rules** apply to `chrome.downloads` too in Firefox (not in
  Chrome), so a Referer-protected plain file downloads directly.
- **Navigation order.** In Firefox a new page's first reports (DOM scan, a
  site extractor's inline data) can reach the background before its
  `main_frame` request does; the navigation therefore drops only the entries
  last seen before the request started (`store.clear(tab, before)`).
- **Tests** (`test/e2e-firefox`) start Playwright's Firefox with its remote
  debugging server, install `dist/firefox` as a temporary add-on and reach the
  background page and the popup (opened as a tab) through the Remote
  Debugging Protocol (`rdp.js`: `installTemporaryAddon`, the add-on's watcher,
  `evaluateJSAsync`); Playwright cannot attach to extension pages in Firefox.
- **Release**: the release workflow signs the Firefox build on
  addons.mozilla.org (channel `unlisted`, `web-ext sign`, with the source
  archive) when the API key is set as repository secrets, and attaches the
  `.xpi`. CI runs `web-ext lint` (Mozilla's add-on linter) on every push.

## Tests

- Unit tests (`npm test`): `node --test` with `test/unit/setup.js` loading the
  Turkish messages (the tests check Turkish texts).
- E2E (`npm run e2e`): Playwright starts Chromium (new headless mode) with the
  extension loaded, against a local fixture server (`test/fixtures/server.js`:
  Range support, Referer checks, rate limits, token rotation, mirrors, rotating
  directories, delays). The helpers set `uiLanguage: 'tr'` (the browser's own
  language differs between machines); `stage4a-i18n.spec.js` runs in English.
- Fixtures are small and committed; `npm run fixtures` regenerates the media
  with ffmpeg.
- Every spec ends with "service worker logged no errors".
