# Third-party licenses

Video Downloader's own code is MIT licensed (see [LICENSE](LICENSE)). The
extension ships these third-party components in `src/vendor/`:

| Component | Version | License | Files | License text |
|---|---|---|---|---|
| [mux.js](https://github.com/videojs/mux.js) (Brightcove) | 7.1.1 | Apache-2.0 | `src/vendor/mux-mp4.min.js` | [licenses/mux.js-Apache-2.0.txt](licenses/mux.js-Apache-2.0.txt) |
| [@ffmpeg/ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) (ffmpeg.wasm JavaScript API) | 0.12.15 | MIT | `src/vendor/ffmpeg/*.js`, `*.d.ts` (except `ffmpeg-core.*`) | [licenses/ffmpeg.wasm-MIT.txt](licenses/ffmpeg.wasm-MIT.txt) |
| [@ffmpeg/core](https://github.com/ffmpegwasm/ffmpeg.wasm) (FFmpeg compiled to WebAssembly) | 0.12.10 | GPL-2.0-or-later | `src/vendor/ffmpeg/ffmpeg-core.js`, `ffmpeg-core.wasm` | [licenses/GPL-2.0.txt](licenses/GPL-2.0.txt) |
| [@ffmpeg/core-mt](https://github.com/ffmpegwasm/ffmpeg.wasm) (the same, multi-threaded build) | 0.12.10 | GPL-2.0-or-later | `src/vendor/ffmpeg-mt/ffmpeg-core.js`, `ffmpeg-core.wasm`, `ffmpeg-core.worker.js` | [licenses/GPL-2.0.txt](licenses/GPL-2.0.txt) |

## About the GPL part

`@ffmpeg/core` is a build of [FFmpeg](https://ffmpeg.org) that includes
GPL-licensed libraries (among them x264), so the core is distributed under the
GNU General Public License, version 2 or later. The extension uses it only
inside its offscreen document, to merge audio and video tracks and to convert
VP9/AV1 video to H.264.

Because the core is included, **the extension as a whole (a packaged release)
is distributed under terms compatible with the GPL-2.0-or-later**. Our own
sources remain available under MIT as well. The complete corresponding source
of the core is the [ffmpeg.wasm v0.12.10 release](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10)
(build scripts and the FFmpeg/library versions it pins); this repository is
public, so the rest of the source is here.

If a release ever needs to be distributed without the GPL obligations, the
core can be swapped for an LGPL build of FFmpeg without x264; the merge path
only remuxes (`-c copy`), and only the optional H.264 conversion needs a GPL
encoder.

## Development dependencies

Playwright, ESLint, Prettier, TypeScript (type checks only), lint-staged and
simple-git-hooks are used for development and are not part of the packaged
extension.
