// Drives the real VS Code the default cut is recorded in, over the Chrome DevTools protocol (no
// dependencies; Node 22+ has WebSocket). The pointer glides to each target and a ripple marks a
// click; clicks are trusted CDP mouse events at the target's centre, so they work the same on
// the workbench and inside ERD Studio's webviews (each an out-of-process iframe).
//
// The pointer is not filmed: the screencast delivers about 25 frames a second, so a pointer drawn in
// the page would judder on the video's 30 fps clock. Every glide is logged instead (`d.trail`,
// record.mjs saves it as build/rec/<take>/pointer.json) and composite.mjs draws the pointer on the
// footage from that path, on the video's own clock. The ripple stays in the page (REC_PAGE_POINTER=1
// shows the page's own pointer too, for a dry run).
//
//   const d = await driver();                   // CDP_PORT (9555) — the isolated window launch.sh opens
//   await d.click(wb('.activitybar [aria-label^="ERD Studio"]'));
//   await d.click(wv('button', { text: 'New Table' }));      // inside whichever webview shows it
//   await d.type('dim_customer');
//
// A target is either wb(selector|expr, opts) (the workbench page) or wv(selector, opts) (the active
// frame of a visible webview). `opts.text` matches an element's trimmed text exactly (or a RegExp
// source with `opts.re`), `opts.last` picks the last match.

export const PORT = Number(process.env.CDP_PORT || 9555);
const PAGE_POINTER = process.env.REC_PAGE_POINTER === '1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

export async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  });
  ws.addEventListener('close', () => { for (const p of pending.values()) p.rej(new Error('socket closed')); pending.clear(); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, on: (f) => listeners.add(f), off: (f) => listeners.delete(f), close: () => ws.close() };
}

export async function workbench() {
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page) throw new Error(`no VS Code workbench on :${PORT}`);
  return attach(page.webSocketDebuggerUrl);
}

/** JS that finds one element in document `D`: a CSS selector, filtered by text. */
const finder = (sel, { text, re, last, visible = true } = {}) => `(() => {
  const all = (root, out = []) => { out.push(...root.querySelectorAll(${JSON.stringify(sel)})); for (const h of root.querySelectorAll('*')) if (h.shadowRoot) all(h.shadowRoot, out); return out; };
  let els = all(D);
  ${visible ? 'els = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });' : ''}
  ${text !== undefined ? `els = els.filter((e) => (e.innerText ?? e.textContent).trim() === ${JSON.stringify(text)});` : ''}
  ${re !== undefined ? `els = els.filter((e) => new RegExp(${JSON.stringify(re)}).test((e.innerText ?? e.textContent).trim()));` : ''}
  return els[${last ? 'els.length - 1' : '0'}] ?? null; })()`;

export const wb = (sel, opts = {}) => ({ kind: 'wb', sel, opts });
export const wv = (sel, opts = {}) => ({ kind: 'wv', sel, opts });

const POINTER = `(() => {
  if (document.getElementById('__cur')) return true;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;z-index:2147483647;left:0;top:0;width:24px;height:24px;pointer-events:none;transform:translate(70vw,60vh);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))${PAGE_POINTER ? '' : ';visibility:hidden'}}' +
    '#__ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #fbbf24;pointer-events:none;opacity:0}';
  document.head.appendChild(s);
  const cur = document.createElement('div'); cur.id = '__cur';
  const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z');
  p.setAttribute('fill', '#fff'); p.setAttribute('stroke', '#000'); p.setAttribute('stroke-width', '1.4');
  svg.appendChild(p); cur.appendChild(svg); document.body.appendChild(cur);
  const rp = document.createElement('div'); rp.id = '__ripple'; document.body.appendChild(rp);
  return true; })()`;

export async function driver() {
  let w = await workbench();
  const ev = (expr) => w.evaluate(expr);
  await ev(POINTER);
  let at = { x: 1000, y: 360 };
  /** The pointer's path, in workbench CSS px and epoch seconds: glides { s, d, x0, y0, x1, y1 } (d 0: a jump). */
  const trail = [];

  /** Every visible webview's active frame: its CDP session (kept open and reused) and its offset in the workbench. */
  const sessions = new Map();
  async function webviews() {
    const out = [];
    const live = (await targets()).filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://'));
    for (const [id, s] of sessions) if (!live.some((t) => t.id === id)) { s.close(); sessions.delete(id); }
    const boxes = await ev(`(() => [...document.querySelectorAll('iframe')].map((f) => { const r = f.getBoundingClientRect(); const st = getComputedStyle(f.parentElement);
      return { src: f.src || '', x: r.left, y: r.top, w: r.width, vis: r.width > 2 && st.visibility !== 'hidden' && st.display !== 'none' }; }))()`);
    for (const t of live) {
      const id = new URL(t.url).searchParams.get('id');
      const box = boxes.find((b) => b.src.includes(`id=${id}`));
      if (!box || !box.vis) continue;
      let s = sessions.get(t.id);
      if (!s) { s = await attach(t.webSocketDebuggerUrl); sessions.set(t.id, s); }
      const inner = await s.evaluate(`(() => { const f = document.querySelector('iframe#active-frame'); if (!f || !f.contentDocument) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`).catch(() => null);
      if (!inner) continue;
      out.push({ s, x: box.x + inner.x, y: box.y + inner.y, url: t.url });
    }
    return out;
  }
  /** Evaluate `body` (an expression using D = the active frame's document) in the first visible webview where `ok` holds. */
  async function inWebview(fnExpr, okExpr = 'true') {
    const views = await webviews();
    try {
      for (const v of views) {
        const r = await v.s.evaluate(`(() => { const D = document.querySelector('iframe#active-frame').contentDocument; if (!(${okExpr})) return { skip: true }; return { v: (${fnExpr}) }; })()`).catch(() => ({ skip: true }));
        if (!r.skip) return { value: r.v, x: v.x, y: v.y };
      }
      return null;
    } finally { /* sessions stay open for the next call */ }
  }
  /** The centre of a target in workbench px (null when it is not on screen). */
  async function locate(target, { dx = 0.5, dy = 0.5 } = {}) {
    const rectOf = `(() => { const el = ${finder(target.sel, target.opts)}; if (!el) return null; el.scrollIntoView?.({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width * ${dx}, y: r.top + r.height * ${dy}, w: r.width, h: r.height }; })()`;
    if (target.kind === 'wb') return ev(`(() => { const D = document; return ${rectOf}; })()`);
    const r = await inWebview(rectOf, `${finder(target.sel, target.opts)}`);
    return r && r.value ? { x: r.x + r.value.x, y: r.y + r.value.y, w: r.value.w, h: r.value.h } : null;
  }
  async function waitFor(target, ms = 15000, where = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const p = await locate(target, where).catch(() => null); if (p) return p; await sleep(100); }
    throw new Error(`timeout waiting for ${target.kind} ${target.sel} ${JSON.stringify(target.opts)}`);
  }
  /**
   * Glide the pointer to a point over `ms` (ease in-out, ~60 steps a second), moving the real mouse too
   * (hover states). `hover: false` leaves the real mouse where it is: the drawn pointer points, and
   * nothing it passes over or rests on opens a tooltip.
   */
  async function glide(p, ms = 650, { hover = true } = {}) {
    await ev(POINTER);
    const from = { ...at };
    const steps = Math.max(1, Math.round(ms / 16));
    const t0 = Date.now();
    trail.push({ s: t0 / 1000, d: ms / 1000, x0: from.x, y0: from.y, x1: p.x, y1: p.y });
    for (let i = 1; i <= steps; i++) {
      const k = i / steps; const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const x = from.x + (p.x - from.x) * e, y = from.y + (p.y - from.y) * e;
      await ev(`document.getElementById('__cur').style.transform='translate(${(x - 4).toFixed(1)}px,${(y - 2).toFixed(1)}px)'`);
      if (hover && (i % 4 === 0 || i === steps)) await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(t0 + (ms * i) / steps - Date.now());
    }
    at = { x: p.x, y: p.y };
  }
  const d = {
    ev, inWebview, locate, waitFor, glide, trail,
    get at() { return at; },
    async place(p) { trail.push({ s: Date.now() / 1000, d: 0, x0: p.x, y0: p.y, x1: p.x, y1: p.y }); at = { ...p }; await ev(POINTER); await ev(`document.getElementById('__cur').style.transform='translate(${p.x - 4}px,${p.y - 2}px)'`); },
    /** Press on a target, drag it by (dx, dy) workbench px over `ms`, release: a node moved. (Not the canvas itself: React Flow's pan misses the release and keeps panning.) */
    async drag(target, { dx = 0, dy = 0, ms = 700, glideMs = 500, at: where } = {}) {
      const p = target.x !== undefined ? target : await waitFor(target, 15000, where);
      await glide(p, glideMs);
      await w.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      const steps = Math.max(2, Math.round(ms / 16));
      const t0 = Date.now();
      trail.push({ s: t0 / 1000, d: ms / 1000, x0: p.x, y0: p.y, x1: p.x + dx, y1: p.y + dy });
      for (let i = 1; i <= steps; i++) {
        const k = i / steps; const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const x = p.x + dx * e, y = p.y + dy * e;
        await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        if (PAGE_POINTER) await ev(`document.getElementById('__cur').style.transform='translate(${(x - 4).toFixed(1)}px,${(y - 2).toFixed(1)}px)'`);
        await sleep(t0 + (ms * i) / steps - Date.now());
      }
      await w.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y + dy, button: 'left', buttons: 0, clickCount: 1 });
      at = { x: p.x + dx, y: p.y + dy };
    },
    async moveTo(target, { ms = 650, wait = 15000, dx, dy, hover = true } = {}) {
      const p = target.x !== undefined ? target : await waitFor(target, wait, { dx, dy });
      await glide(p, ms, { hover });
      return p;
    },
    /** Glide to the target and ripple, without sending it any event. */
    async tap(target, { ms } = {}) {
      const p = await d.moveTo(target, { ms });
      await ev(`(() => { const rp = document.getElementById('__ripple'); rp.style.left='${p.x}px'; rp.style.top='${p.y}px';
        rp.animate([{ opacity: 1, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 450 }); })()`);
      return p;
    },
    /**
     * Glide to the target and click it with trusted mouse events. `synthetic: true` dispatches DOM
     * events on the element instead (a workbench dropdown such as a view's + menu opens on its
     * DOM click and closes again on a trusted press/release pair).
     */
    async click(target, { ms, count = 1, dx, dy, button = 'left', synthetic = false } = {}) {
      if (process.env.REC_DEBUG) console.log(`  ${(Date.now() / 1000 % 100).toFixed(2)} click ${target.sel ?? ''} ${JSON.stringify(target.opts ?? {})}`);
      const p = await d.moveTo(target, { ms, dx, dy });
      await ev(`(() => { const rp = document.getElementById('__ripple'); rp.style.left='${p.x}px'; rp.style.top='${p.y}px';
        rp.animate([{ opacity: 1, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 450 }); })()`);
      if (synthetic) {
        if (target.kind !== 'wb') throw new Error('synthetic clicks are for the workbench');
        await ev(`(() => { const D = document; const el = ${finder(target.sel, target.opts)};
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, button: 0, view: window, clientX: ${p.x}, clientY: ${p.y} })); })()`);
        await sleep(120);
        return p;
      }
      for (let c = 1; c <= count; c++) {
        await w.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, buttons: button === 'left' ? 1 : 2, clickCount: c });
        await w.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount: c });
      }
      await sleep(120);
      return p;
    },
    async key(key, { code = key, keyCode = 0, modifiers = 0, text } = {}) {
      await w.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
      await w.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    enter: () => d.key('Enter', { keyCode: 13, text: '\r' }),
    escape: () => d.key('Escape', { keyCode: 27 }),
    down: () => d.key('ArrowDown', { keyCode: 40 }),
    tab: () => d.key('Tab', { keyCode: 9 }),
    async type(text, perChar = 55) {
      for (const ch of text) { await w.send('Input.insertText', { text: ch }); await sleep(perChar); }
    },
    /** Sets a <select> in a webview the way React sees a user pick (macOS draws native select menus outside the page, where CDP cannot film them): the pointer glides to it and ripples, then the value changes. */
    async pick(target, value, { ms = 450 } = {}) {
      await d.tap(target, { ms });
      const r = await inWebview(`(() => { const s = ${finder(target.sel, target.opts)}; if (!s) return 'missing';
        Object.getOwnPropertyDescriptor(D.defaultView.HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
        s.dispatchEvent(new D.defaultView.Event('change', { bubbles: true })); return s.value; })()`, finder(target.sel, target.opts));
      if (r?.value !== value) throw new Error(`could not pick ${value}: ${JSON.stringify(r)}`);
    },
    /** The text a viewer can see right now: every visible text run in the workbench and the visible webviews (an ellipsised one cut to the part that shows). */
    async screenText() {
      const VISIBLE = `(() => { const out = new Set(); const W = D.defaultView;
        const walk = (root) => { const tw = D.createTreeWalker(root, W.NodeFilter.SHOW_TEXT); let n;
          while ((n = tw.nextNode())) { const txt = n.textContent.replace(/\\s+/g, ' ').trim(); if (!txt) continue;
            const el = n.parentElement; if (!el || el.closest('script,style,.monaco-aria-container,[aria-hidden="true"]')) continue;
            const r = el.getBoundingClientRect(); if (r.width < 3 || r.height < 3 || r.bottom < 0 || r.right < 0 || r.top > W.innerHeight || r.left > W.innerWidth) continue;
            const cs = W.getComputedStyle(el); if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
            let shown = txt; if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.children.length === 0) shown = txt.slice(0, Math.floor(txt.length * el.clientWidth / el.scrollWidth));
            out.add(shown); }
          for (const h of root.querySelectorAll('*')) if (h.shadowRoot) walk(h.shadowRoot); };
        walk(D.body); return [...out]; })()`;
      const wbText = await ev(`(() => { const D = document; return ${VISIBLE}; })()`);
      const views = await webviews();
      const vText = [];
      for (const v of views) { try { vText.push(...(await v.s.evaluate(`(() => { const D = document.querySelector('iframe#active-frame').contentDocument; return ${VISIBLE}; })()`))); } catch {} }
      return [...new Set([...wbText, ...vText])].filter((x) => x !== '');
    },
    /** The rows the integrated terminal shows (screenText skips them: xterm marks its rows aria-hidden). */
    async terminalText() {
      return ev("[...document.querySelectorAll('.part.panel .xterm-rows > div')].filter((r) => r.getBoundingClientRect().height > 0).map((r) => r.textContent.replace(/\\s+$/, '')).filter((r) => r.trim())");
    },
    /** A mouse-wheel turn at p (workbench px; the real mouse moves there, the drawn pointer does not): the canvas zooms about p. */
    async wheel(p, deltaY) { await w.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY }); },
    /** Moves only the real mouse (not the drawn pointer) to p: off a row whose hover tooltip would cover something. */
    async parkMouse(p) { await w.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); },
    async selectAll() { await d.key('a', { code: 'KeyA', keyCode: 65, modifiers: 4 }); },
    close: () => { for (const s of sessions.values()) s.close(); w.close(); },
  };
  return d;
}
