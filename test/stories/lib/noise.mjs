// Interruptions: what pops up on a person who did not ask for it. The
// first-60-seconds stories (`realistic: true`) count every notification,
// editor tab, walkthrough, modal dialog and quick pick that appears in the
// workbench in the first minute after ERD Studio is installed, and fail when
// ERD Studio (or VS Code on its behalf: its walkthrough opened on install)
// interrupts more than once.
//
// Node-side polling (every POLL_MS), so a reload loses nothing: each poll
// takes a snapshot of the workbench, and whatever is new since the last one
// is an event `{ t, kind, text, origin, asked }`:
//
//   kind     'notification' | 'tab' | 'walkthrough' | 'modal' | 'quickPick'
//   origin   'erd'     ERD Studio's own (a notification whose source is ERD Studio, or
//                      a progress notification, an ERD Studio tab, its walkthrough) — what the stories limit
//            'vscode'  VS Code's own (its install notice, a recommendation…) — logged
//   asked    a story declared it with `expect()` just before the click that
//            causes it (Show Me → its draft tab), or a quick pick that opened
//            within QUICK_INPUT_GRACE_MS of the story's own input (the palette)

const POLL_MS = 250;
const QUICK_INPUT_GRACE_MS = 3000;

/** Tabs ERD Studio opens: its webviews and its diagrams. */
const ERD_TAB = /^(Draft|Example): |^ERD Studio Tour$|^Bring In Your Data Model$|^Convert to DBML$|\.dbml$/;

const SNAPSHOT = `(() => {
  const shown = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; };
  const toasts = [...document.querySelectorAll('.notification-toast-container .notification-list-item')].filter(shown).map((n) => ({
    text: (n.querySelector('.notification-list-item-message')?.textContent ?? '').trim(),
    source: (n.querySelector('.notification-list-item-source')?.textContent ?? '').replace(/^Source:\\s*/, '').trim(),
    progress: [...n.querySelectorAll('.monaco-progress-container')].some((p) => !p.classList.contains('done') && shown(p)),
  }));
  const tabs = [...document.querySelectorAll('.tabs-container .tab')].map((t) => (t.getAttribute('aria-label') ?? '').split(',')[0].trim());
  // A walkthrough's own page (not VS Code's Welcome page listing them): its detail slide, on screen.
  const details = [...document.querySelectorAll('.gettingStartedContainer .gettingStartedSlideDetails')].find(shown);
  const walkthrough = details ? ([...details.querySelectorAll('h2')].find(shown)?.textContent ?? '').trim() || null : null;
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(shown).map((d) => (d.querySelector('.dialog-message-text')?.textContent ?? '').trim());
  const w = [...document.querySelectorAll('.quick-input-widget')].find((x) => x.style.display !== 'none' && shown(x));
  const quick = w ? ((w.querySelector('.quick-input-title')?.textContent ?? '') + ' ' + (w.querySelector('.quick-input-box input')?.placeholder ?? '')).trim() || 'quick input' : null;
  return { toasts, tabs, walkthrough, dialogs, quick };
})()`;

export class Noise {
  constructor({ wb, log = () => {} }) {
    this.wb = wb;
    this.log = log;
    /** @type {Array<{ t: number, kind: string, text: string, origin: string, asked: boolean, why?: string }>} */
    this.events = [];
    this.asks = [];
    this.prev = null;
    this.t0 = undefined;
    this.timer = undefined;
  }

  /** Start the clock (the moment ERD Studio is installed) and the polling. */
  start() {
    this.t0 = Date.now();
    this.log('NOISE: clock started');
    const tick = async () => {
      if (this.stopped) return;
      await this.poll();
      if (!this.stopped) this.timer = setTimeout(tick, POLL_MS);
    };
    // The first snapshot is the baseline: what was already there (VS Code's Welcome page) is not news.
    return this.poll({ baseline: true }).then(() => { this.timer = setTimeout(tick, POLL_MS); });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Seconds since the clock started. */
  elapsed() {
    return this.t0 === undefined ? 0 : (Date.now() - this.t0) / 1000;
  }

  /**
   * The next action is asked for: an event of `kind` (any, when omitted)
   * whose text matches `pattern`, within `within` ms from now, is its answer.
   */
  expect(pattern, { kind, within = 20000, why } = {}) {
    this.asks.push({ pattern, kind, until: Date.now() + within, why: why ?? String(pattern) });
  }

  async poll({ baseline = false } = {}) {
    const snap = await this.wb.ev(SNAPSHOT).catch(() => null);
    if (!snap) return;
    const prev = this.prev ?? { toasts: [], tabs: [], walkthrough: null, dialogs: [], quick: null };
    this.prev = snap;
    if (baseline) {
      this.log(`NOISE: baseline ${JSON.stringify(snap)}`);
      return;
    }
    const was = new Set(prev.toasts.map((x) => x.text));
    // ERD Studio's own: its source says so; a progress toast (window.withProgress) carries no source, and is an extension's.
    for (const toast of snap.toasts) if (!was.has(toast.text)) this.add('notification', toast.text, toast.source === 'ERD Studio' || !toast.source && toast.progress ? 'erd' : 'vscode', toast.source || (toast.progress ? 'a progress notification' : undefined));
    const tabsWere = new Set(prev.tabs);
    for (const tab of snap.tabs) if (!tabsWere.has(tab)) this.add('tab', tab, ERD_TAB.test(tab) ? 'erd' : 'vscode');
    if (snap.walkthrough && snap.walkthrough !== prev.walkthrough) this.add('walkthrough', snap.walkthrough, /ERD Studio/.test(snap.walkthrough) ? 'erd' : 'vscode');
    const dialogsWere = new Set(prev.dialogs);
    for (const d of snap.dialogs) if (!dialogsWere.has(d)) this.add('modal', d, 'erd');
    if (snap.quick && snap.quick !== prev.quick) {
      const recent = Date.now() - (this.wb.lastInputAt ?? 0) < QUICK_INPUT_GRACE_MS;
      this.add('quickPick', snap.quick, 'erd', undefined, recent ? 'opened by my own input' : undefined);
    }
  }

  add(kind, text, origin, source, askedWhy) {
    const now = Date.now();
    const ask = askedWhy ? { why: askedWhy } : this.asks.find((a) => a.until >= now && (!a.kind || a.kind === kind) && (a.pattern instanceof RegExp ? a.pattern.test(text) : text.includes(a.pattern)));
    const event = { t: Number(((now - (this.t0 ?? now)) / 1000).toFixed(1)), kind, text, origin, asked: !!ask, ...(ask ? { why: ask.why } : {}), ...(source ? { source } : {}) };
    this.events.push(event);
    this.log(`NOISE: ${event.t}s ${kind} [${origin}${event.asked ? `, asked: ${event.why}` : ', UNASKED'}] ${text}`);
  }

  /** Poll until `ms` after the clock started (the first minute: 60000). */
  async until(ms) {
    while (this.t0 !== undefined && Date.now() - this.t0 < ms) await new Promise((r) => setTimeout(r, POLL_MS));
    await this.poll();
  }

  /** Events nobody asked for; `origin` narrows them ('erd': ERD Studio's own and VS Code's on its behalf). */
  unasked({ origin } = {}) {
    return this.events.filter((e) => !e.asked && (!origin || e.origin === origin));
  }

  /** One line per event, for an assertion's message. */
  static describe(events) {
    return events.map((e) => `${e.t}s ${e.kind}: ${e.text}`).join(' | ') || 'none';
  }
}
