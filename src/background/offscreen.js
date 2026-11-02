// Creates the offscreen document on demand and sends it jobs.

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let creating = null;

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

export async function runOffscreenJob(job, payload) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', job, payload });
  if (!response) throw new Error('Offscreen document did not answer');
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
