// Temporary declarativeNetRequest session rules that add a Referer/Origin to
// requests. The context URL should be the document that issued the original
// request: the player iframe when there is one, else the top page. They
// apply to the extension's own fetches (offscreen document, service worker),
// not to chrome.downloads requests.

let nextRuleId = 1000;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @returns {chrome.declarativeNetRequest.ModifyHeaderInfo[]} */
function headersFor(pageUrl) {
  const origin = new URL(pageUrl).origin;
  return [
    { header: 'Referer', operation: /** @type {any} */ ('set'), value: pageUrl },
    { header: 'Origin', operation: /** @type {any} */ ('set'), value: origin },
  ];
}

async function add(condition, pageUrl) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return null;
  const id = nextRuleId++;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: headersFor(pageUrl) }, condition }],
  });
  return id;
}

/** Exact-URL rule (single file download). */
export function addUrlRule(url, pageUrl) {
  return add({ regexFilter: `^${escapeRegex(url)}$`, resourceTypes: ['xmlhttprequest', 'media', 'other'] }, pageUrl);
}

/**
 * Broad rule for a running stream job: every request that does not come
 * from a tab (tabId -1 = extension contexts) gets the page's headers.
 */
export function addJobRule(pageUrl) {
  return add({ regexFilter: '^https?://', tabIds: [-1], resourceTypes: ['xmlhttprequest', 'media', 'other'] }, pageUrl);
}

export async function removeRule(id) {
  if (id == null) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}
