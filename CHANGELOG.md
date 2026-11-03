# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.13.0] - 2026-11-03

### Added
- Faster H.264 conversion: ffmpeg.wasm's multi-threaded core (`@ffmpeg/core-mt` 0.12.10) converts videos up to 256 MB about three times faster (20 s of 720p VP9: 17.7 s → 5.5 s). Larger videos, merges, and conversions the multi-threaded core fails on use the single-threaded core as before. The release package grows by about 10 MB.
- With "Convert to H.264" on, plain video files are converted too: the extension downloads them itself instead of Chrome (in 4 MB pieces, with the stream downloads' progress, queue, retries and resume) and converts them when they are not H.264. H.264 files are saved unchanged.
- With "Embed subtitles" on, a plain video file and the page's subtitles chosen with it become one MP4.

### Changed
- The extension's pages are cross-origin isolated (manifest `cross_origin_opener_policy` / `cross_origin_embedder_policy`), which the multi-threaded core needs.
- A conversion with nothing to do (the video is already H.264, nothing to merge or embed) no longer copies the file through ffmpeg.

## [0.12.0] - 2026-11-03

### Added
- Download queue: at most two HLS/DASH downloads run at once (setting "Downloads at once", 1–4); further ones wait as "Queued" in the popup and on the in-page button, can be cancelled while waiting, and start in turn.
- Notifications: a system notification when a stream download is done (click it to show the file) or has failed (setting, on by default). Adds the `notifications` permission.
- Folder inside Downloads: a template with `{site}` and `{date}` (e.g. `VideoDownloader/{site}`); empty by default.
- A failed HLS (fMP4) or DASH download keeps what it downloaded until the browser closes: downloading the same video again continues after the pieces it has (finished tracks are not fetched again). TS streams start over.

## [0.11.0] - 2026-11-03

### Added
- Vimeo extractor: on vimeo.com and in Vimeo players embedded in other sites' pages, each video becomes one entry from the player's configuration (`window.playerConfig`, or the `…/config` JSON): the largest progressive MP4 with audio, else the HLS master (the H.264 one first), titled "channel · title". Embedded players' entries keep the player frame as their context.
- Site extractors can run in every frame (`allFrames`).
- The in-page button matches an embedded player by the video its frame names, so two players of the same length on one page each download their own video.

### Fixed
- A player is no longer merged by length into a site entry of another frame (an embedded player could download its neighbour's video).

## [0.10.1] - 2026-11-03

### Fixed
- Downloads no longer fail with "Invalid filename" for titles with emoji sequences or invisible characters. File names drop what Chrome refuses: format characters (the zero-width joiner inside emoji like 👨‍👩‍👧, direction marks, BOM, soft hyphen), half of an emoji, non-characters, DEL/C1 controls and a leading tilde. Titles and file names are cut without splitting an emoji.

## [0.10.0] - 2026-11-03

### Added
- Facebook extractor: Reels, Watch and videos in posts become one entry each, from the video data in the page's inline JSON and GraphQL responses: the HD (else SD) MP4 with video and audio, or the DASH manifest (downloaded and merged) when there is no MP4. Titled with the owner and the first line of the post (Reels: the owner). Files nested below the video object take its id, length and owner. The player's own fbcdn tracks stay hidden; a manifest entry hides behind the video's MP4 once that arrives.
- The in-page button reads Facebook links as post codes (`/watch/?v=ID`, `/<page>/videos/ID`, `/reel/ID`); "this page" also matches the `?v=` query.
- The in-page button also appears on players without a URL: Facebook attaches its MediaSource from a worker (`srcObject`); such a player is matched through its post code like a `blob:` one.

### Fixed
- A hidden entry no longer stands for the open page: the page's real entry was listed as a neighbour.

## [0.9.1] - 2026-11-03

### Fixed
- File names named the wrong site ("google.com-…" for a post opened from search results) when the page had opened without a page request in the tab: restored from the back/forward cache or prerendered by the browser. The extension now follows the tab's address as it changes, and file names take the site from the tab's current address.
- A page restored from the back/forward cache lists its videos again (the list was cleared when the page was left).

## [0.9.0] - 2026-11-03

### Added
- X (Twitter) extractor: on x.com and twitter.com the list shows one complete MP4 per video (video and audio in one file, the highest bitrate) and per GIF, titled with the user and the post's text, instead of the player's HLS pieces. Posts without an MP4 get their HLS master, downloaded and merged. The in-page button downloads the post it sits in (the `/user/status/ID` link around the video).
- Site definitions can name the entry a captured player chunk belongs to (`chunkOf`); the list hides such chunks only once that entry exists, so a video the extractor missed stays downloadable. A captured copy of a site entry's own file is hidden behind it too.

### Changed
- The popup's site notes name the site ("X (Twitter): …") instead of always saying Instagram.

## [0.8.2] - 2026-11-03

### Fixed
- The progress of a job with several tracks (subtitles, video, separate audio) no longer goes back. Every track's piece count is read before the first one starts, so the total is fixed and 100% appears only at the end. Before, it reached 100% after the subtitles and dropped as each new track added its pieces. Subtitle pieces count only in subtitle-only jobs.

## [0.8.1] - 2026-11-03

### Changed
- Debug info masks addresses (query values and long path tokens: signed URLs, sessions) and leaves the page title out, so it can be pasted into a public issue.

### Added
- `SECURITY.md` (private vulnerability reporting) and a "Responsible use" section in the READMEs.

## [0.8.0] - 2026-11-03

### Changed
- Site extractors are definitions under `src/sites/`: each site describes its hosts, content script patterns, extractor, version and how its reports become list entries (`src/sites/<id>/site.js`), next to the extractor itself (`main.js`); one bridge serves every site. The service worker derives registration, the injection check and the debug probe from them. Instagram moved there with the same behaviour; its extractor's version went to 4 (generic message names).

### Added
- `docs/sites.md`: how to add a site, with the rules learned from Instagram and a test template; `validateSites()` checks the definitions.
- README images (popup, in-page button GIF, settings; English and Turkish), made from a demo fixture page with `npm run screenshots`.

## [0.7.0] - 2026-11-02

### Added
- English interface. All texts live in `_locales/en` and `_locales/tr`; English is the default locale and Chrome's language decides, or the new setting "Interface language" (Chrome's language / English / Türkçe) picks one. The extension's name, the toolbar title and the shortcut's description follow it too ("Video Downloader" / "Video İndirici").
- MIT license, `THIRD_PARTY_LICENSES.md` (mux.js Apache-2.0, ffmpeg.wasm MIT, its core GPL-2.0-or-later, with the license texts in `licenses/`), an English `README.md` next to `README.tr.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, issue and pull request templates.
- Release packages: pushing a `v*` tag builds `video-downloader-<version>.zip` (`npm run package`) and attaches it to a GitHub release; the tag must match `manifest.json`'s version.
- Code quality: ESLint, Prettier and `tsc --checkJs` (`npm run lint`, `npm run typecheck`), run in CI and by a pre-commit hook (lint-staged).

### Changed
- File names of separate tracks and unknown-language subtitles follow the interface language (`-audio.m4a` / `-ses.m4a`, `-subtitles.srt` / `-altyazi.srt`).

## [0.6.2] - 2026-11-02

### Fixed
- A download started before the page's master playlist had been read (slow, rate-limited film hosts) could come out silent with a one-segment subtitle: the video playlist looked like a film of its own and the first WebVTT segment like a subtitle file. A download now waits (up to 10 s) for the tab's playlists to be read, and one started on a sub-playlist goes to its master (the clicked quality kept), so audio and whole subtitle tracks come along. The in-page badge follows that job.

## [0.6.1] - 2026-11-02

### Fixed
- HLS streams with MPEG-TS segments that are not merged by ffmpeg (one muxed stream) did not play in QuickTime: the file showed 13:15:21 (or 27 hours) and stayed blank and silent. mux.js writes "unknown" durations, which QuickTime adds as a start offset, and restarts every fragment's sequence number at 0, where QuickTime stops reading. The remuxer now writes the playlist's length into the init segment (with an `mehd` box) and numbers the fragments 1, 2, 3, ….

## [0.6.0] - 2026-11-02

### Added
- Subtitles. HLS subtitle renditions (WebVTT segments, merged on the media timeline with `X-TIMESTAMP-MAP`), DASH text tracks (WebVTT and TTML files), `<track>` elements next to a video and subtitle files captured from the network (`.vtt`, `.srt`, `.ttml`/`.dfxp`) are found and downloaded as `<name>-<language>.srt` next to the video.
- Popup: subtitle chips under a card, one per language; the preferred languages are ticked in advance. A subtitle file without a video is listed under "Diğer" and can be downloaded on its own. DASH text tracks packed in MP4 (stpp/wvtt) are reported as unsupported.
- The in-page badge and the keyboard shortcut take the preferred languages along; the badge menu names them ("Altyazı: Türkçe").
- Settings "Altyazılar": languages taken automatically (default `tr`, `*` = all), format (.srt default, or .vtt), and embedding the chosen subtitles into the MP4 as mov_text tracks with language tags (ffmpeg.wasm, stream downloads only, off by default).
- Subtitle playlists and their WebVTT segments fold under the master playlist instead of filling the list; a stream's subtitle playlist without its master is listed under "Diğer".

- Subtitle files whose name gives no language (`1.vtt`, `2.vtt`) are read once: the language is guessed from their words (Turkish letters settle Turkish signs in capitals), and a dub's forced subtitles (on-screen text only, under one cue a minute) are marked "zorunlu" and lose to a full track of the same language.
- Audio language (dub or original). Streams with several audio languages (for example a dub and the original) get an audio menu in the popup. Setting "Ses dili": the site's default (as before), original (a track named "Orijinal", else the first non-Turkish one), Turkish or English; it presets the menu and decides what the badge and the shortcut take. The badge note names it ("Ses: English"), the job shows "ses: …".

### Fixed
- With merging off and H.264 transcoding on, a stream with a separate audio track lost its audio file (only the transcoded video was saved).
- HLS: with "H.264'ü öne al" (default on) H.264 variants now come before AV1/HEVC/VP9 ones, as on DASH; some players' top variant is AV1, which QuickTime on most Macs cannot play. The quality menu names those codecs ("800p · 1.5 Mbps · AV1").
- A segment that answers 404 for a while (film CDNs under load) no longer fails the whole job after ~10 s: late retries now span about two minutes, with one more playlist read half way.
- Popup quality and audio menus closed by themselves while another download was running: every progress update redrew the whole list. The list is now redrawn only when its entries or their download state change, and never while one of its menus is open.
- Registering the Instagram extractor could fail with "Duplicate script ID" when two registrations overlapped (worker start-up and another call); they now run one after another.
- The popup could stay on "İnceleniyor…" when the playlist was described between its first read and the start of its change listener; it now listens first.
- Players whose CDN rotates the first directory of playlist URLs (the master lists `/mw/<token>`, the player asks for `/mt/<token>`) got a silent, video-only file: the video playlist was not recognised as part of the master and was downloaded on its own. Child playlists now also match the master by their long file name.

## [0.5.0] - 2026-11-02

### Added
- Download badge on videos (1DM-style): hovering a video shows a small "İndir" button at its top-left corner, also inside iframe players and in fullscreen players. One quality → downloads at once; several → a small quality menu. While a stream downloads the badge shows a progress ring, then a check mark; errors show a short message. Ads get no badge; players without a captured playlist point to the toolbar list.
- Settings: badge mode (on hover / always / off) and a list of sites where the badge is hidden.
- Badge controls while downloading: hovering shows the file name, pieces/bytes and a remaining-time estimate, and the button turns into "× İptal"; cancelling takes a second click within 3 s ("İptal edilsin mi?", Esc backs out). Works for stream jobs and plain files.
- The badge picks up a download that is still running after the page is reloaded (or one started from the popup).
- Done: clicking the check mark shows the file in its folder. Error: clicking "Tekrar dene" restarts with the same quality.
- Esc closes the quality menu.
- Download indicator: while any download runs (in any tab, also after its page was reloaded or closed) the toolbar icon shows the overall progress in green on every tab ("%42", or "3↓"), its tooltip names the files, and a check mark follows a successful finish. The popup lists downloads running in other tabs ("Başka sekme · site"), and the first badge download shows a one-time hint that it keeps going without the page.

### Fixed
- On Instagram feeds every post's badge downloaded the same (longest) reel; the badge now identifies the post by its shortcode.
- In the Reels viewer the badge read the music link (/reels/audio/…) as the post and kept saying the data had not arrived.
- After a reload on sites that serve the playlist from a different mirror host each time, the badge did not find the running download; jobs are now also matched by URL path.

## [0.4.1] - 2026-11-02

### Fixed
- A temporary 404 (or 5xx / network error) on one mirror no longer kills a long stream download: the segment is fetched from the other mirror hosts listed in the playlist, then the playlist is re-read, then a few spaced retries follow before giving up. Mirror switches are counted in the job row and debug info.
- `lastHttp.attempts` in debug info reports the real number of requests made instead of a constant.

## [0.4.0] - 2026-11-02

### Added
- Popup "Önerilen / Tümü" views. Önerilen shows one "Ana video" card first, other real videos after it, and folds ads, neighbouring reels and unmatched player streams into a collapsible "Diğer (n)" section. Tümü is the previous flat list (raw chunks included).
- Sub-playlists listed by a master playlist (variants, audio renditions) fold under the master instead of appearing as separate entries.
- A MediaSource player (`blob:`) is merged with the HLS/DASH playlist of the same frame (duration within 2 % or 2 s): one card with the player's resolution and duration and the playlist's quality list.
- Ad filter: banner sizes (728×90, 300×250, 250×250, …), extreme aspect ratios, very short/small clips and known ad hosts are scored; ads go to "Diğer" (setting "Reklam videolarını Diğer altına katla", on by default).
- Stream entries are described in the background as soon as they are captured, so folding and the toolbar badge are right before the popup opens.

### Changed
- The toolbar badge counts recommended videos only (ads, sub-playlists and raw chunks no longer inflate it).
- The keyboard shortcut downloads the popup's "Ana video".
- The "Ham parçaları göster" checkbox is replaced by the Tümü view.

## [0.3.0] - 2026-11-02

### Added
- Adaptive request pacing: after a 429 the job spaces its requests out (+250 ms per limit, slowly relaxing after successes) so rate-limited hosts stop answering 429 instead of being retried dozens of times.
- Playlist refresh: when a segment answers 403/410 (expired signed URL), the media playlist is re-read and the segment is fetched from its fresh URL (up to 2 refreshes per segment).
- Setting "Hız sınırında en fazla bekleme" (minutes) controls how long a job may sit in cooldowns before giving up.

## [0.2.0] - 2026-11-02

### Added
- Requests are tracked per frame: the Referer/Origin used for manifests, segments and size lookups is the player iframe's URL, not the top page's.
- Playlists disguised as `.txt` (or other non-media extensions) served as `text/plain` are sniffed: `#EXTM3U` becomes an HLS entry, `<MPD` a DASH entry.
- Junk bytes in front of TS / fMP4 segments are trimmed before remuxing (setting, on by default).
- Debug info shows each entry's frame URL and each job's last HTTP failure (step, status, URL).

### Changed
- Stream download errors name the step that failed: manifest, key or segment N/M.
- Every manifest, key and segment request retries up to 6 times with exponential backoff; 429/503 honour `Retry-After` and pause all parallel workers of the job. After the first rate limit the job continues with one request at a time; when quick retries run out it waits through long cooldowns (30 s, 1 min, 2 min, 5 min, or `Retry-After`) and the popup shows "Bekliyor … N sn". Retry and cooldown counts show in the job row and in debug info.

## [0.1.0] - 2026-11-01

First plan (stages 0-5, PRs #1-#10): network and DOM capture, direct downloads with Referer fallback,
HLS (AES-128, TS remux), DASH, Instagram extractor, ffmpeg.wasm merge/transcode, options, history,
shortcut, debug info, CI, pinned extension id.
