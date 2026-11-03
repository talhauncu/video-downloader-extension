// Tiny static server for e2e fixtures.
// Serves test/fixtures/pages (HTML) and test/fixtures/media (video assets)
// with correct content types and HTTP Range support, so the extension sees
// realistic responses. Can be started standalone: `npm run serve`.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.key': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.ttml': 'application/ttml+xml; charset=utf-8',
};

function resolveFile(urlPath) {
  // /pages/x.html -> fixtures/pages/x.html, /media/x.mp4 -> fixtures/media/x.mp4
  // "/pages/x.html/ABC/" serves x.html: lets tests put a shortcode in the path.
  const clean = decodeURIComponent(urlPath.split('?')[0])
    .replace(/\.\./g, '')
    .replace(/(\.html)\/.*$/, '$1');
  const target = path.join(ROOT, clean);
  if (!target.startsWith(ROOT)) return null;
  return target;
}

/** Token of the rotating-directory fixture (long, like real ones). */
export const ROT_TOKEN = 'H3IjMKWanKWfYwVjZwLhI0IPYHEZYwRjBQOjYxEIDHjhrQV2';

/** Playlists of the rotating-directory fixture, built on hls-audio (video-only + audio-only fMP4). */
async function rotatingPlaylist(name) {
  const absolute = async (dir) =>
    (await fs.readFile(path.join(ROOT, `media/hls-audio/${dir}/playlist.m3u8`), 'utf8'))
      .replace(/URI="([^"]+)"/g, `URI="/media/hls-audio/${dir}/$1"`)
      .split('\n')
      .map((line) => (line && !line.startsWith('#') ? `/media/hls-audio/${dir}/${line}` : line))
      .join('\n');
  if (name === `${ROT_TOKEN}avr1`) {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="/media/rot/mw/${ROT_TOKEN}vr1b180l0tra1"`,
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/media/rot/m9/${ROT_TOKEN}vr1b180l0ena2"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2",AUDIO="audio0"',
      `/media/rot/mw/${ROT_TOKEN}vr1b180`,
      '',
    ].join('\n');
  }
  if (name === `${ROT_TOKEN}vr1b180`) return absolute('video');
  if (name.startsWith(`${ROT_TOKEN}vr1b180l0`)) return absolute('audio');
  return null;
}

/**
 * @param {{port?:number, requireReferer?:boolean, requireRefererOrigin?:string|null, txtAlias?:boolean}} [opts]
 *  requireRefererOrigin: media requests must carry a Referer from this origin (else 404), like a player host
 *  txtAlias: /x/playlist.txt is served from playlist.m3u8 (or manifest.mpd) as text/plain, like disguised hosts
 */
export async function startServer({
  port = 0,
  requireReferer = false,
  requireRefererOrigin = null,
  txtAlias = false,
  rateLimit = null,
  tokenRotate = null,
  onceThenForbid = null,
  always404 = null,
} = {}) {
  // always404: regex source → matching media URLs always answer 404 (a mirror that lost the file)
  let notFoundRe = always404 ? new RegExp(always404) : null;
  // Mirrors: /media/mirror/playlist.m3u8 is generated from hls-ts/playlist.m3u8 with
  // segment i served from mirrors[i % n] (absolute URLs), like hosts that spread
  // segments over several equivalent servers. Set after start via setMirrors().
  let mirrors = [];
  // onceThenForbid: regex source → matching media URLs are served once, then answer 403 (an expired signed URL)
  const forbidRe = onceThenForbid ? new RegExp(onceThenForbid) : null;
  const servedOnce = new Set();
  // tokenRotate: { every: N } → playlists (.m3u8/.txt/.mpd) are rewritten so segment URLs carry ?t=<token>;
  // the token changes after every N media requests; a segment request with a stale/absent token answers 403.
  let tokenCounter = 0;
  let tokenRequests = 0;
  const currentToken = () => `tok${tokenCounter}`;
  // rateLimit: { every: N, match?: regex source, retryAfter: seconds, times = 1 }
  //   every Nth media request (or every request whose URL matches `match`) answers 429 on its first `times` attempts
  const matchRe = rateLimit?.match ? new RegExp(rateLimit.match) : null;
  let mediaRequests = 0;
  const limited = new Map(); // url -> 429s served so far
  let selfOrigin = null;
  const requested = []; // paths of rotating-directory playlists, in order (which audio a job fetched)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = resolveFile(url.pathname);

    // Optional Referer check, used by the "hotlink protected CDN" test:
    // /media/* under a server started with requireReferer answers 403
    // when the Referer header is missing.
    if (requireReferer && url.pathname.startsWith('/media/') && !req.headers.referer) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden: missing Referer');
    }
    if (notFoundRe && url.pathname.startsWith('/media/') && notFoundRe.test(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found (mirror)');
    }
    if (url.pathname === '/media/mirror/playlist.m3u8' && mirrors.length) {
      const source = await fs.readFile(path.join(ROOT, 'media/hls-ts/playlist.m3u8'), 'utf8');
      let i = 0;
      const text = source
        .split('\n')
        .map((line) => (line && !line.startsWith('#') ? `${mirrors[i++ % mirrors.length]}/media/hls-ts/${line}` : line))
        .join('\n');
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': Buffer.byteLength(text),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      return res.end(text);
    }
    // Rotating first directory: /media/rot/<any dir>/<token name>
    // serves the same playlist whatever the directory; the master lists
    // "/mw/…" while the page asks for "/mt/…" and "/mi/…".
    const rot = /^\/media\/rot\/[a-z0-9]+\/(.+)$/.exec(url.pathname);
    if (rot) {
      requested.push(url.pathname);
      const text = await rotatingPlaylist(rot[1]);
      if (text == null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': Buffer.byteLength(text),
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      return res.end(text);
    }
    if (forbidRe && url.pathname.startsWith('/media/') && forbidRe.test(url.pathname)) {
      if (servedOnce.has(url.pathname)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Forbidden: expired');
      }
      servedOnce.add(url.pathname);
    }
    if (tokenRotate && url.pathname.startsWith('/media/')) {
      const isPlaylist = /\.(m3u8|txt|mpd)$/i.test(url.pathname);
      if (!isPlaylist) {
        if (url.searchParams.get('t') !== currentToken()) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          return res.end('Forbidden: stale token');
        }
        // Only served segments advance the clock (a real host rotates by time, not by failed attempts).
        tokenRequests++;
        if (tokenRequests % tokenRotate.every === 0) tokenCounter++;
      }
    }
    if (rateLimit && url.pathname.startsWith('/media/')) {
      mediaRequests++;
      const served = limited.get(req.url) ?? 0;
      const times = rateLimit.times ?? 1;
      const selected = matchRe ? matchRe.test(req.url) : mediaRequests % rateLimit.every === 0;
      if ((served > 0 && served < times) || (served === 0 && selected)) {
        limited.set(req.url, served + 1);
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': String(rateLimit.retryAfter ?? 1) });
        return res.end('Too Many Requests');
      }
    }
    if (requireRefererOrigin && url.pathname.startsWith('/media/')) {
      let origin;
      try {
        origin = req.headers.referer ? new URL(req.headers.referer).origin : null;
      } catch {
        origin = null;
      }
      const wanted = requireRefererOrigin === 'self' ? selfOrigin : requireRefererOrigin;
      if (origin !== wanted) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found (wrong Referer)');
      }
    }

    // ?delay=<ms> slows a response down (progress / cancel tests).
    const delay = Number(url.searchParams.get('delay'));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5000)));

    let stat;
    let servedFile = file;
    let forcedType = null;
    try {
      stat = file && (await fs.stat(file));
    } catch {
      stat = null;
    }
    if ((!stat || !stat.isFile()) && txtAlias && file && /\.txt$/i.test(file)) {
      for (const real of [file.replace(/\.txt$/i, '.m3u8'), file.replace(/\.txt$/i, '.mpd')]) {
        try {
          const st = await fs.stat(real);
          if (st.isFile()) {
            stat = st;
            servedFile = real;
            forcedType = 'text/plain; charset=utf-8';
            break;
          }
        } catch {
          // try next
        }
      }
    }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    file = servedFile;

    const type = forcedType ?? CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      // ?cacheable: a page the back/forward cache may keep (no-store rules it out).
      'cache-control': url.searchParams.has('cacheable') ? 'no-cache' : 'no-store',
      'access-control-allow-origin': '*',
    };

    // Instagram/Facebook CDN style: ?bytestart=&byteend= selects a range.
    let rangeHeader = req.headers.range;
    if (!rangeHeader && url.searchParams.has('bytestart')) {
      rangeHeader = `bytes=${url.searchParams.get('bytestart')}-${url.searchParams.get('byteend') ?? ''}`;
    }
    const range = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
      });
      return createReadStream(file, { start, end }).pipe(res);
    }

    if (tokenRotate && /\.(m3u8|txt|mpd)$/i.test(url.pathname)) {
      // Rewrite segment references with the current token (like a signing host would).
      let text = await fs.readFile(file, 'utf8');
      const tok = currentToken();
      if (/\.mpd$/i.test(file)) {
        text = text
          .replace(/(media|initialization)="([^"]+)"/g, (_, k, v) => `${k}="${v}${v.includes('?') ? '&' : '?'}t=${tok}"`)
          .replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_, v) => `<BaseURL>${v}${v.includes('?') ? '&' : '?'}t=${tok}</BaseURL>`);
      } else {
        text = text
          .split('\n')
          .map((line) => (line && !line.startsWith('#') ? `${line}${line.includes('?') ? '&' : '?'}t=${tok}` : line))
          .join('\n')
          .replace(/URI="([^"]+)"/g, (_, v) =>
            /\.m3u8|\.txt/i.test(v) ? `URI="${v}"` : `URI="${v}${v.includes('?') ? '&' : '?'}t=${tok}"`,
          );
      }
      res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(text), 'content-type': type });
      if (req.method === 'HEAD') return res.end();
      return res.end(text);
    }
    // ?throttle=<bytes per 100 ms> serves the body slowly (progress / cancel tests).
    const throttle = Number(url.searchParams.get('throttle'));
    if (throttle > 0 && req.method !== 'HEAD') {
      const data = await fs.readFile(file);
      res.writeHead(200, { ...headers, 'content-length': data.length });
      let offset = 0;
      const tick = () => {
        if (res.destroyed) return;
        const chunk = data.subarray(offset, offset + throttle);
        offset += chunk.length;
        if (offset >= data.length) return res.end(chunk);
        res.write(chunk);
        setTimeout(tick, 100);
      };
      return tick();
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: boundPort } = server.address();
  selfOrigin = `http://127.0.0.1:${boundPort}`;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    /** Rotating-directory playlist paths requested so far. */
    rotRequests: () => [...requested],
    setMirrors(origins) {
      mirrors = origins;
    },
    /** Turns the always-404 rule on (regex source) or off (null) while running. */
    setAlways404(source) {
      notFoundRe = source ? new RegExp(source) : null;
    },
    close: () =>
      new Promise((resolve) => {
        // Keep-alive sockets (e.g. Node's fetch) would otherwise delay close().
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Standalone mode.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer({ port: Number(process.env.PORT) || 8787 });
  console.log(`Fixture server listening at ${url}`);
}
