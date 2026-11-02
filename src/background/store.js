// Per-tab media store. In-memory Map for speed, mirrored to
// chrome.storage.session so the list survives service worker restarts and
// the popup can subscribe to changes via chrome.storage.session.onChanged.

const PREFIX = 'tab:';
const cache = new Map(); // tabId -> Map(groupKey -> item)
let loaded = false;

// Operations on one tab are serialized: a navigation's clear() and the first
// media response of the new page can otherwise interleave their storage
// writes and the late remove() wipes the fresh entry.
const queues = new Map(); // tabId -> Promise
function serialized(tabId, fn) {
  const prev = queues.get(tabId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    tabId,
    next.finally(() => {
      if (queues.get(tabId) === next) queues.delete(tabId);
    }),
  );
  return next;
}

async function loadAll() {
  if (loaded) return;
  loaded = true;
  /** @type {Record<string, any>} */
  const all = await chrome.storage.session.get(null);
  for (const [key, items] of Object.entries(all)) {
    if (!key.startsWith(PREFIX)) continue;
    const tabId = Number(key.slice(PREFIX.length));
    cache.set(tabId, new Map(items.map((item) => [item.key, item])));
  }
}

async function persist(tabId) {
  const items = cache.get(tabId);
  if (!items || items.size === 0) {
    await chrome.storage.session.remove(PREFIX + tabId);
  } else {
    await chrome.storage.session.set({ [PREFIX + tabId]: [...items.values()] });
  }
}

/**
 * Adds or merges a media item for a tab. Returns true when the list changed
 * in a way the UI cares about (new item, or size/type newly known).
 * @param {number} tabId
 * @param {{key:string, url:string, kind:string, size?:number|null, contentType?:string|null, pageUrl?:string, source?:string} & Record<string, any>} incoming  other fields (frame, title, stream …) are stored as given
 */
export function upsert(tabId, incoming) {
  return serialized(tabId, () => upsertNow(tabId, incoming));
}

async function upsertNow(tabId, incoming) {
  await loadAll();
  let items = cache.get(tabId);
  if (!items) {
    items = new Map();
    cache.set(tabId, items);
  }
  const existing = items.get(incoming.key);
  let changed = false;

  if (!existing) {
    items.set(incoming.key, {
      id: crypto.randomUUID(),
      firstSeen: Date.now(),
      requests: 1,
      ...incoming,
    });
    changed = true;
  } else {
    existing.requests += 1;
    existing.lastSeen = Date.now();
    if (incoming.size != null && existing.size !== incoming.size) {
      // Prefer the larger reported total (Content-Range total beats a chunk).
      if (existing.size == null || incoming.size > existing.size) {
        existing.size = incoming.size;
        changed = true;
      }
    }
    if (!existing.contentType && incoming.contentType) {
      existing.contentType = incoming.contentType;
      changed = true;
    }
    if (!existing.pageUrl && incoming.pageUrl) existing.pageUrl = incoming.pageUrl;
    for (const field of ['width', 'height', 'duration', 'title', 'lang', 'label', 'default']) {
      if (incoming[field] != null && existing[field] !== incoming[field]) {
        existing[field] = incoming[field];
        changed = true;
      }
    }
    if (incoming.source && existing.source !== incoming.source && existing.source !== 'both') {
      existing.source = 'both';
    }
    // Keep the most recent URL for segment groups (signed URLs rotate).
    if (incoming.url && incoming.kind === 'segment') existing.url = incoming.url;
  }

  if (changed) await persist(tabId);
  return changed;
}

export function list(tabId) {
  return serialized(tabId, async () => {
    await loadAll();
    const items = cache.get(tabId);
    return items ? [...items.values()].sort((a, b) => a.firstSeen - b.firstSeen) : [];
  });
}

export async function get(tabId, id) {
  const items = await list(tabId);
  return items.find((item) => item.id === id) ?? null;
}

/** Shallow-merges `patch` into one item. Returns the updated item or null. */
export function update(tabId, id, patch) {
  return serialized(tabId, async () => {
    await loadAll();
    const items = cache.get(tabId);
    const item = items && [...items.values()].find((it) => it.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    await persist(tabId);
    return item;
  });
}

export async function count(tabId) {
  return (await list(tabId)).length;
}

export function clear(tabId) {
  return serialized(tabId, async () => {
    await loadAll();
    cache.delete(tabId);
    await chrome.storage.session.remove(PREFIX + tabId);
  });
}
