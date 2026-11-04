// Scripted actions on the VS Code workbench, filmed: a visible cursor that
// glides to its target, a click ripple and a highlight box, drawn into the
// page (the recorder films the page, so they show in the video). Captions are
// never drawn here: the story's steps log marks, and video.mjs burns them in.
//
// Ported from the issue-to-pr skill's scripts/cdp/act.mjs. Differences: the
// actor knows its port and reconnects across window reloads, clicks are
// trusted CDP input by default (`click`), the old synthetic DOM click is
// `domClick`, and webviews (the ERD canvas) get an actor of their own whose
// clicks land through the workbench at the right place.
//
// Every target is a JS EXPRESSION evaluated in the page, so any selector logic works.

import { WORKBENCH, attach, findTarget, listTargets } from './cdp.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overlay = (glideMs) => `(() => {
  if (document.getElementById('__cur')) return true;
  const s = document.createElement('style');
  s.textContent = '#__cur{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;pointer-events:none;transition:transform ${glideMs}ms cubic-bezier(.4,.1,.2,1);transform:translate(50vw,50vh)}' +
    '#__ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #fbbf24;pointer-events:none;opacity:0}' +
    '#__hl{position:fixed;z-index:2147483644;border:3px solid #fbbf24;border-radius:6px;box-shadow:0 0 0 4000px rgba(0,0,0,.28);pointer-events:none;transition:all .45s;opacity:0}';
  document.head.appendChild(s);
  const cur = document.createElement('div'); cur.id = '__cur';
  const NS = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z');
  p.setAttribute('fill', '#fff'); p.setAttribute('stroke', '#000'); p.setAttribute('stroke-width', '1.4');
  svg.appendChild(p); cur.appendChild(svg); document.body.appendChild(cur);
  for (const id of ['__ripple', '__hl']) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
  return true; })()`;

/**
 * Film the story's temp HOME as `~`: VS Code's own file dialog (a quick input)
 * shows the full path it is in (`/tmp/erds-…/home/shop-database/`), a path
 * from the recording machine that a published clip must not show. While the
 * box holds a path under `home`, its text is drawn over it as `~/…` and the
 * real text is made transparent; the DOM (what stories assert) is unchanged.
 */
const maskHome = (home) => `(() => {
  if (window.__maskHome) return true;
  const homes = ${JSON.stringify(home ? [home, `/private${home}`] : [])};
  if (!homes.length) return true;
  window.__maskHome = setInterval(() => {
    const w = [...document.querySelectorAll('.quick-input-widget')].find((x) => x.style.display !== 'none' && x.offsetParent !== null);
    const box = w?.querySelector('.quick-input-box input');
    const v = box?.value ?? '';
    const h = homes.find((x) => v === x || v.startsWith(x + '/'));
    let m = document.getElementById('__mask');
    const prev = window.__maskedBox;
    if (prev && prev !== box) { prev.style.color = ''; prev.style.caretColor = ''; window.__maskedBox = null; }
    if (!box || !h) {
      if (m) m.style.display = 'none';
      if (window.__maskedBox) { window.__maskedBox.style.color = ''; window.__maskedBox.style.caretColor = ''; window.__maskedBox = null; }
      return;
    }
    if (!m) { m = document.createElement('div'); m.id = '__mask'; document.body.appendChild(m); }
    if (window.__maskedBox !== box) { window.__maskColor = getComputedStyle(box).color; box.style.color = 'transparent'; box.style.caretColor = 'transparent'; window.__maskedBox = box; }
    const cs = getComputedStyle(box); const r = box.getBoundingClientRect();
    Object.assign(m.style, { display: 'flex', alignItems: 'center', position: 'fixed', zIndex: 2147483640, pointerEvents: 'none', overflow: 'hidden', whiteSpace: 'pre',
      left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', boxSizing: 'border-box',
      paddingLeft: cs.paddingLeft, font: cs.font, letterSpacing: cs.letterSpacing, color: window.__maskColor });
    m.textContent = '~' + v.slice(h.length);
  }, 40);
  return true; })()`;

/** CDP modifier bits. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
/** Cmd on macOS, Ctrl elsewhere. */
export const PRIMARY = process.platform === 'darwin' ? MOD.meta : MOD.ctrl;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  F1: { key: 'F1', code: 'F1', keyCode: 112 },
};

const RETRYABLE = /closed|CLOSED|not open|Cannot find context|Execution context|Inspected target|Target closed|timed out/;

/**
 * The workbench actor. `pace` = { glide, settle } in ms: how long the cursor
 * takes to reach its target and how long to wait after an action.
 */
export class Workbench {
  constructor({ port, pace = { glide: 150, settle: 150 }, log = () => {}, home }) {
    this.port = port;
    this.pace = pace;
    this.log = log;
    /** The story's temp HOME: shown as `~` in file dialogs (`maskHome`). */
    this.home = home;
    /** Trusted clicks so far, and when the story last clicked, pressed or typed (noise.mjs tells its own input apart). */
    this.clicks = 0;
    this.lastInputAt = 0;
    this.c = null;
  }

  /** The cursor, ripple and highlight elements, and the HOME mask (again after a reload). */
  async overlay(glideMs) {
    await this.ev(overlay(glideMs));
    await this.ev(maskHome(this.home));
  }

  async client() {
    if (!this.c || this.c.closed) {
      this.c = await attach(await findTarget(this.port, { match: WORKBENCH, timeoutMs: 60000 }));
    }
    return this.c;
  }

  /** Evaluate in the workbench, retrying through reloads. */
  async ev(expr) {
    let last;
    for (let i = 0; i < 40; i++) {
      try {
        return await (await this.client()).evaluate(expr);
      } catch (e) {
        last = e;
        if (!RETRYABLE.test(String(e))) throw e;
        try { this.c?.close(); } catch { /* gone */ }
        this.c = null;
        await sleep(500);
      }
    }
    throw new Error(`the window never came back: ${last}`);
  }

  async send(method, params) {
    return (await this.client()).send(method, params);
  }

  /** Wait until `expr` is truthy; resolves its value. */
  async waitFor(expr, { timeout = 20000, what } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = await this.ev(`(() => { try { const v = (${expr}); return v && typeof v === 'object' && 'nodeType' in v ? true : (v || null); } catch { return null; } })()`).catch(() => null);
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for ${what ?? expr}`);
      await sleep(200);
    }
  }

  /**
   * The element's centre; a link that wraps onto two lines (its box's centre
   * is between them, on plain text) is aimed at its widest line instead.
   */
  async center(expr) {
    return this.ev(`(() => { const el=${expr}; if(!el) return null; el.scrollIntoView?.({block:'nearest'});
      const lines=[...el.getClientRects()]; const r=lines.length > 1 ? lines.reduce((a, b) => (b.width > a.width ? b : a)) : el.getBoundingClientRect();
      if(!r.width&&!r.height) return null; return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
  }

  async moveToPoint(p) {
    await this.overlay(Math.max(1, this.pace.glide));
    await this.ev(`document.getElementById('__cur').style.transform='translate(${p.x - 4}px,${p.y - 2}px)'`);
    await sleep(this.pace.glide + 50);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  }

  async moveTo(expr) {
    const p = await this.center(expr);
    if (!p) throw new Error(`not found on screen: ${expr}`);
    await this.moveToPoint(p);
    return p;
  }

  async ripple(p) {
    await this.ev(`(() => { const rp=document.getElementById('__ripple'); if(!rp) return; rp.style.left='${p.x}px'; rp.style.top='${p.y}px';
      rp.animate([{opacity:1,transform:'scale(.4)'},{opacity:0,transform:'scale(1.6)'}],{duration:500}); })()`);
  }

  /** A trusted click at a point (CDP Input), as a person's click. */
  async clickAt(p, { clickCount = 1 } = {}) {
    this.clicks = (this.clicks ?? 0) + 1;
    this.lastInputAt = Date.now();
    await this.moveToPoint(p);
    await this.ripple(p);
    const press = async () => {
      // Hover first, so the target (a webview's button) has the pointer when it is pressed.
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
      }
    };
    // Never while the recorder captures a frame (recorder.mjs `quiet`).
    await (this.recorder ? this.recorder.quiet(press) : press());
    await sleep(this.pace.settle);
  }

  /** A trusted click on the element `expr` evaluates to. */
  async click(expr, opts) {
    const p = await this.center(expr);
    if (!p) throw new Error(`not found on screen: ${expr}`);
    await this.clickAt(p, opts);
  }

  /** A synthetic DOM click (for controls hidden under something). */
  async domClick(expr) {
    const p = await this.moveTo(expr);
    await this.ripple(p);
    await this.ev(`(() => { const el=${expr}; const o={bubbles:true,cancelable:true,clientX:${p.x},clientY:${p.y},button:0,view:window};
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,o)); })()`);
    await sleep(this.pace.settle);
  }

  async hover(expr) { return this.moveTo(expr); }

  /** Press a key: `press('Enter')`, `press('a', MOD.meta)`. */
  async press(name, modifiers = 0) {
    const k = KEYS[name] ?? { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, keyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0 };
    this.lastInputAt = Date.now();
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text && !modifiers ? { text: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(Math.min(this.pace.settle, 200));
  }

  /** Type text into whatever has focus, one character at a time. */
  async type(text, perChar = this.pace.glide > 300 ? 45 : 8) {
    for (const ch of text) {
      this.lastInputAt = Date.now();
      await this.send('Input.insertText', { text: ch });
      if (perChar) await sleep(perChar);
    }
  }

  async highlight(expr, pad = 4) {
    await this.overlay(this.pace.glide);
    return this.ev(`(() => { const h=document.getElementById('__hl'); const el=${expr}; if(!el){h.style.opacity=0;return false;}
      const r=el.getBoundingClientRect(); Object.assign(h.style,{left:(r.left-${pad})+'px',top:(r.top-${pad})+'px',
      width:(r.width+2*${pad})+'px',height:(r.height+2*${pad})+'px',opacity:1}); return true; })()`);
  }

  /** The highlight box around a rectangle in workbench coordinates. */
  async highlightRect(r, pad = 4) {
    await this.overlay(this.pace.glide);
    return this.ev(`(() => { const h=document.getElementById('__hl');
      Object.assign(h.style,{left:'${r.x - pad}px',top:'${r.y - pad}px',width:'${r.width + 2 * pad}px',height:'${r.height + 2 * pad}px',opacity:1}); return true; })()`);
  }

  async unhighlight() {
    await this.ev(`(document.getElementById('__hl')||{style:{}}).style.opacity=0`);
  }

  /** Tag this page load, so `waitForReload` can tell when a new one is up. */
  async tagPage() {
    const tag = `p${Date.now()}`;
    await this.ev(`window.__storyPage = '${tag}'`);
    return tag;
  }

  /** Wait for the window to reload (an empty window that opens a folder reuses itself). */
  async waitForReload(tag, { timeout = 60000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = await this.ev(`window.__storyPage !== '${tag}' && !!document.querySelector('.monaco-workbench .part.activitybar, .monaco-workbench .activitybar')`).catch(() => false);
      if (v) return;
      if (Date.now() > until) throw new Error(`the window did not reload within ${timeout} ms`);
      await sleep(250);
    }
  }

  async screenshot(file) {
    const fs = await import('node:fs');
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  close() { try { this.c?.close(); } catch { /* gone */ } }
}

/**
 * An actor inside a webview (a custom editor such as the ERD canvas). VS Code
 * hosts each webview in an `iframe` target whose page holds the content in
 * `iframe#active-frame`; expressions here see that document as `doc` (and its
 * window as `win`). Clicks are trusted clicks through the workbench, at the
 * element's position on screen.
 */
export class Webview {
  constructor(wb, target) {
    this.wb = wb;
    this.target = target;
    this.c = null;
    this.id = new URL(target.url).searchParams.get('id');
  }

  /**
   * The webview shown in the active editor whose target URL contains `match`
   * (default: an ERD Studio webview — the canvas). Other webviews of the same
   * extension (a walkthrough step's image, a hidden tab's editor) are skipped:
   * the one picked is visible and covers most of the active editor group.
   */
  static async find(wb, { match = 'extensionId=liamwynne.erd-studio', timeout = 20000 } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const candidates = (await Webview.list(wb.port)).filter((t) => t.url.includes(match));
      let best;
      for (const t of candidates) {
        const id = new URL(t.url).searchParams.get('id');
        const area = await wb.ev(`(() => { const f=[...document.querySelectorAll('iframe')].find(f => (f.src||'').includes(${JSON.stringify(id)}));
          const g=document.querySelector('.editor-group-container.active .editor-container') ?? document.querySelector('.editor-group-container.active');
          if(!f||!g) return 0; const cs=getComputedStyle(f.parentElement ?? f); if(cs.visibility==='hidden'||cs.display==='none') return 0;
          const a=f.getBoundingClientRect(), b=g.getBoundingClientRect();
          const w=Math.min(a.right,b.right)-Math.max(a.left,b.left), h=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
          return w>0&&h>0 ? w*h : 0; })()`).catch(() => 0);
        if (area > 0 && (!best || area > best.area)) best = { t, area };
      }
      if (best) return new Webview(wb, best.t);
      if (Date.now() > until) throw new Error(`no webview matching ${match} is showing in the active editor (${candidates.length} candidate${candidates.length === 1 ? '' : 's'})`);
      await sleep(300);
    }
  }

  /** Every webview target on the port. */
  static async list(port) {
    return (await listTargets(port)).filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'));
  }

  async ev(expr) {
    if (!this.c || this.c.closed) this.c = await attach(this.target);
    return this.c.evaluate(`(() => { const f = document.querySelector('iframe#active-frame'); const doc = f?.contentDocument; const win = f?.contentWindow;
      if (!doc) return null; return (${expr}); })()`);
  }

  async waitFor(expr, { timeout = 20000, what } = {}) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = await this.ev(`(() => { try { const v = (${expr}); return v && typeof v === 'object' && 'nodeType' in v ? true : (v || null); } catch { return null; } })()`).catch(() => null);
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting in the webview for ${what ?? expr}`);
      await sleep(250);
    }
  }

  /**
   * The element's box in workbench coordinates (`{ x, y, width, height }`),
   * scrolled into view first (a page such as the Welcome panel scrolls).
   */
  async rect(expr) {
    const inner = await this.ev(`(() => { const el=${expr}; if(!el) return null; el.scrollIntoView?.({block:'nearest'}); const r=el.getBoundingClientRect();
      if(!r.width&&!r.height) return null;
      const f=document.querySelector('iframe#active-frame').getBoundingClientRect(); return {x:f.left+r.left, y:f.top+r.top, width:r.width, height:r.height}; })()`);
    if (!inner) return null;
    const outer = await this.wb.ev(`(() => { const f=[...document.querySelectorAll('iframe')].find(f => (f.src||'').includes('${this.id}'));
      if(!f) return null; const r=f.getBoundingClientRect(); return {x:r.left, y:r.top}; })()`);
    if (!outer) return null;
    return { x: outer.x + inner.x, y: outer.y + inner.y, width: inner.width, height: inner.height };
  }

  /** The element's centre in workbench coordinates. */
  async center(expr) {
    const r = await this.rect(expr);
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }

  /**
   * A trusted click on the element, through the workbench. A click into an
   * out-of-process webview is sometimes dropped by Chromium (recorded runs
   * lost one in a few: a draft's Show details, a schema row, a guide's
   * button), so the element is watched for the click and, if none arrived
   * within a second and a half, clicked once more (logged). The element's own
   * listeners are untouched.
   */
  async click(expr) {
    const token = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const watch = `(() => { const el=${expr}; if(!el) return false; el.addEventListener('click', () => { win.__storyClicked = ${JSON.stringify(token)}; }, { once: true, capture: true }); return true; })()`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const p = await this.center(expr);
      if (!p) throw new Error(`not found in the webview: ${expr}`);
      const watching = await this.ev(watch).catch(() => false);
      await this.wb.clickAt(p);
      if (!watching) return;
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        // The click landed, or the element is gone (the page moved on, a tab closed).
        const ok = await this.ev(`win.__storyClicked === ${JSON.stringify(token)} || !(${expr})`).catch(() => true);
        if (ok) return;
        await sleep(100);
      }
      this.wb.log?.(`  (the click on ${expr.slice(0, 80)} did not reach the webview; clicking again)`);
    }
  }

  /** Click the element, then type `text` into it (trusted input, as a person types). */
  async fill(expr, text) {
    await this.click(expr);
    await this.wb.type(text);
  }

  /** Draw the workbench's highlight box around an element of the webview. */
  async highlight(expr, pad = 4) {
    const r = await this.rect(expr);
    if (!r) return false;
    return this.wb.highlightRect(r, pad);
  }

  close() { try { this.c?.close(); } catch { /* gone */ } }
}
