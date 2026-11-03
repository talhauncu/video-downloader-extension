// Creates the offscreen document on demand and sends it jobs.
//
// Firefox has no offscreen documents: its background is an event page with a
// DOM, so the offscreen module runs right here instead, loaded on first use
// (a service worker could not import it). Its reports go straight to the
// message handlers.

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let creating = null;
let local = null;

export async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Fetch media with page headers and hand it to chrome.downloads as a Blob',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** The offscreen module in this page (Firefox). */
function inProcess() {
  local ??= Promise.all([import('../offscreen/offscreen.js'), import('./messages.js')]).then(([offscreen, { handleMessage }]) => {
    offscreen.setSink((type, payload) =>
      handleMessage({ type, payload }, {}).catch((error) => console.warn('[video-downloader] report', type, error)),
    );
    return offscreen;
  });
  return local;
}

export async function runOffscreenJob(job, payload) {
  if (!chrome.offscreen) return (await inProcess()).runLocalJob(job, payload);
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', job, payload });
  if (!response) throw new Error('Offscreen document did not answer');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
