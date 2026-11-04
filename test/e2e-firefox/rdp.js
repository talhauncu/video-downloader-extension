// A small client for Firefox's Remote Debugging Protocol (the one web-ext
// and about:debugging use). Playwright's Firefox cannot attach to extension
// pages, so the Firefox tests install the add-on and run code in its
// background page and popup through this protocol.
//
// Packets are "<byte length>:<JSON>". A request goes to an actor (`to`) and
// its answer comes from it (`from`); events from an actor carry a `type`.
import net from 'node:net';

/** Connects to `--start-debugger-server <port>`, retrying while Firefox starts. */
export async function connectRdp(port, attempts = 100) {
  for (let i = 0; ; i++) {
    try {
      return await open(port);
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function open(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let greeted = false;
    const pending = []; // { from, resolve, reject }, answered in order per actor
    const listeners = new Set();

    const client = {
      send(packet) {
        const body = Buffer.from(JSON.stringify(packet));
        socket.write(`${body.length}:`);
        socket.write(body);
      },
      /** Sends a request and resolves with the actor's answer (a packet without an event type). */
      request(packet) {
        return new Promise((res, rej) => {
          pending.push({ from: packet.to, resolve: res, reject: rej });
          client.send(packet);
        });
      },
      /** Listens to every packet (events included); returns an unsubscribe function. */
      on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        socket.destroy();
      },
    };

    socket.on('error', (error) => (greeted ? pending.splice(0).forEach((p) => p.reject(error)) : reject(error)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(':');
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) return;
        const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
        buffer = buffer.subarray(colon + 1 + length);
        if (!greeted) {
          greeted = true;
          resolve(client);
          continue;
        }
        for (const fn of listeners) fn(packet);
        // Answers have no event type (errors do have `error`).
        if (packet.type && !packet.error) continue;
        const i = pending.findIndex((p) => p.from === packet.from);
        if (i < 0) continue;
        const [p] = pending.splice(i, 1);
        if (packet.error) p.reject(new Error(`${packet.error}: ${packet.message ?? ''}`));
        else p.resolve(packet);
      }
    });
  });
}

/**
 * Installs a temporary add-on and watches its documents (background page,
 * popups opened as tabs). Errors any of them logs are collected in `errors`.
 * @returns {Promise<{id:string, target:(match:RegExp, timeoutMs?:number) => Promise<Object>, evaluate:Function, errors:string[]}>}
 */
export async function installAddon(client, addonPath) {
  const root = await client.request({ to: 'root', type: 'getRoot' });
  const { addon } = await client.request({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath });
  let descriptor = null;
  for (let i = 0; i < 100 && !descriptor; i++) {
    const { addons } = await client.request({ to: 'root', type: 'listAddons' });
    descriptor = addons.find((a) => a.id === addon.id) ?? null;
    if (!descriptor) await new Promise((r) => setTimeout(r, 100));
  }
  const watcher = await client.request({ to: descriptor.actor, type: 'getWatcher', isServerTargetSwitchingEnabled: true });
  const targets = [];
  const errors = [];
  /** evaluationResult packets by resultID, until evaluate() takes them. */
  const results = new Map();
  client.on((packet) => {
    if (packet.type === 'evaluationResult') results.set(packet.resultID, packet);
  });
  client.on((packet) => {
    if (packet.from !== watcher.actor) return;
    if (packet.type === 'target-available-form') targets.push(packet.target);
    if (packet.type === 'target-destroyed-form') {
      const i = targets.findIndex((t) => t.actor === packet.target?.actor);
      if (i >= 0) targets.splice(i, 1);
    }
  });
  client.on((packet) => {
    if (packet.type !== 'resources-available-array') return;
    for (const [type, resources] of packet.array ?? []) {
      for (const r of resources) {
        if (type === 'error-message' && r.pageError && !r.pageError.warning)
          errors.push(`${r.pageError.errorMessage} (${r.pageError.sourceName})`);
        // Older servers wrap the message in `message`.
        const message = r.message ?? r;
        if (type === 'console-message' && message.level === 'error') errors.push(message.arguments.map(String).join(' '));
      }
    }
  });
  await client.request({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  await client.request({ to: watcher.actor, type: 'watchResources', resourceTypes: ['error-message', 'console-message'] });

  /** The first watched document whose URL matches, waiting for it to appear. */
  async function target(match, timeoutMs = 10_000) {
    const started = Date.now();
    for (;;) {
      const found = targets.find((t) => match.test(t.url ?? ''));
      if (found) return found;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no extension document matches ${match}: ${targets.map((t) => t.url).join(', ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Runs `fn(arg)` (its source is sent; it may be async) in a document and
   * returns its JSON-serialisable result. Throws what it throws, and when the
   * document goes away or does not answer in time.
   */
  async function evaluate(targetForm, fn, arg, timeoutMs = 120_000) {
    const text = `(async () => { try { return JSON.stringify({ ok: (await (${fn})(${JSON.stringify(arg ?? null)})) ?? null }); } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); } })()`;
    const started = await client.request({ to: targetForm.consoleActor, type: 'evaluateJSAsync', text, mapped: { await: true } });
    // The result event can come in the same chunk as this answer: it may already be here.
    // The document can also go away meanwhile (a suspended background page, a closed popup).
    const result = await new Promise((resolve, reject) => {
      const settle = () => {
        if (results.has(started.resultID)) {
          const packet = results.get(started.resultID);
          results.delete(started.resultID);
          return done(() => resolve(packet));
        }
        if (!targets.some((t) => t.actor === targetForm.actor)) return done(() => reject(new Error(`${targetForm.url} went away`)));
      };
      const timer = setTimeout(() => done(() => reject(new Error(`no answer from ${targetForm.url} within ${timeoutMs} ms`))), timeoutMs);
      const off = client.on(() => queueMicrotask(settle));
      function done(fn) {
        clearTimeout(timer);
        off();
        fn();
      }
      settle();
    });
    if (result.exception) throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionMessage ?? result.exception)}`);
    let value = result.result;
    if (value?.type === 'longString') {
      value = (await client.request({ to: value.actor, type: 'substring', start: 0, end: value.length })).substring;
    }
    const parsed = JSON.parse(value);
    if (parsed.error) throw new Error(parsed.error);
    return parsed.ok;
  }

  return { id: addon.id, target, evaluate, errors };
}
