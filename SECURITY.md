# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
**private vulnerability reporting** (the repository's Security tab → "Report a
vulnerability"), with what you found, how to reproduce it and the extension
version. You will get an answer within a few days; a fix goes into the next
release and the report is credited unless you prefer otherwise.

## Scope

In scope: the extension's own code (`src/`, except `src/vendor/`) — for
example a page being able to run code in the extension's popup or settings
page, read data of another site through the extension, or make it download
something the user did not choose.

Out of scope: problems in the vendored libraries (report them to
[mux.js](https://github.com/videojs/mux.js) or
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm); we update promptly),
and the fact that the extension needs broad permissions (host access to all
sites, `webRequest`) to see media requests — that is its purpose and is
explained in the README.

## Supported versions

Only the latest release is supported.
