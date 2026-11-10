// A minimal Chrome DevTools Protocol client with no dependencies (Node 22+ has a
// global WebSocket). Ported from the issue-to-pr skill's scripts/cdp/cdp.mjs and
// extended for the onboarding stories: explicit ports, iframe (webview) targets,
// events, and the browser endpoint (window bounds).
//
// VS Code exposes one `page` target for each window (URL ends in
// workbench.html) and one `iframe` target for each webview (custom editors such
// as the ERD canvas). A window reload replaces the page target: reconnect with
// `connect()` again.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every target on the port: `[{ id, type, url, title, webSocketDebuggerUrl }]`. */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/** True when something answers CDP on the port. */
export async function cdpAlive(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Open a session on one target (an entry from `listTargets`, or a browser ws URL). */
export async function attach(target) {
  const wsUrl = typeof target === 'string' ? target : target.webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`could not open CDP socket ${wsUrl}`)), { once: true });
  });
  let id = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${JSON.stringify(m.error)}`));
      else p.res(m.result);
    } else if (m.method && listeners.has(m.method)) {
      for (const fn of listeners.get(m.method)) fn(m.params);
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    for (const p of pending.values()) p.rej(new Error('CDP socket closed'));
    pending.clear();
  });
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((res, rej) => {
      if (closed) return rej(new Error('CDP socket closed'));
      const i = ++id;
      const timer = setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          rej(new Error(`${method}: timed out after ${timeoutMs} ms`));
        }
      }, timeoutMs);
      pending.set(i, {
        method,
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  /** Evaluate a JS expression in the target; resolves its JSON value. */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };
  return {
    target: typeof target === 'string' ? { url: target } : target,
    send,
    evaluate,
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method).delete(fn);
    },
    get closed() { return closed; },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

/**
 * The first target matching `match` (a URL substring, or a predicate on the
 * target), waiting up to `timeoutMs` for one to appear.
 */
export async function findTarget(port, { match = '', type = 'page', timeoutMs = 0 } = {}) {
  const pred = typeof match === 'function' ? match : (t) => t.url.includes(match);
  const until = Date.now() + timeoutMs;
  for (;;) {
    let list = [];
    try { list = await listTargets(port); } catch { /* the window is (re)starting */ }
    const hit = list.find((t) => (!type || t.type === type) && pred(t));
    if (hit) return hit;
    if (Date.now() >= until) {
      throw new Error(`no ${type || 'any'} target matching ${String(match)} on :${port}. Targets: ${list.map((t) => `${t.type} ${t.url.slice(0, 120)}`).join(' | ') || '(none)'}`);
    }
    await sleep(250);
  }
}

/** Attach to the first matching target (see `findTarget`). */
export async function connect(port, opts = {}) {
  return attach(await findTarget(port, opts));
}

/** The VS Code workbench page of the (only) window. */
export const WORKBENCH = (t) => /workbench(\.esm)?\.html/.test(t.url) || t.url.includes('/workbench/workbench');

/** The browser-level endpoint (Browser.* methods: window bounds). */
export async function browser(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return attach(v.webSocketDebuggerUrl);
}
