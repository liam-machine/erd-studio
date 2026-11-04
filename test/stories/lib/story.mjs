// The story DSL: a user story as code. Each step is a caption in the video
// (a mark), the actions a person takes, and the assertions that prove the
// outcome. A failing step fails the story with the step's name, a screenshot,
// and the video up to that point.
//
//   export default story({
//     id: 'empty-window-opens-an-example',
//     title: 'Open an example from an empty window',
//     persona: 'As someone who just installed ERD Studio',
//     want: 'I want to see a finished data model in one click',
//     soThat: 'so that I understand what the tool does',
//     workspace: 'empty',                       // see workspaces.mjs
//     steps: async (s) => {
//       await s.step('Given VS Code with no folder open', async () => { … });
//       await s.step('When I open the ERD Studio sidebar', async () => { await s.ui.openSidebar('ERD Studio'); });
//       await s.step('Then I see "Open an example"', async () => { await s.expectVisible(sel.welcomeLink('Open an example')); });
//       // With --narrate a step's caption is also spoken; `say` replaces it when it reads badly aloud.
//       await s.step('And it is its own file under .erd-studio/main/tables/', async () => { … }, { say: 'And it is saved as its own file.' });
//     },
//   });

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Webview, Workbench, sleep } from './act.mjs';
import { Noise } from './noise.mjs';
import { VSCodeUI, sel } from './vscode.mjs';

const REQUIRED = ['id', 'title', 'persona', 'want', 'soThat', 'steps'];

/** Declare a story (validated; run by run.mjs). */
export function story(def) {
  for (const k of REQUIRED) if (!def[k]) throw new Error(`story ${def.id ?? '(no id)'}: "${k}" is required`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) throw new Error(`story id "${def.id}": lower-case letters, digits and dashes only`);
  if (typeof def.steps !== 'function') throw new Error(`story ${def.id}: steps must be an async function (s) => { … }`);
  return { workspace: 'empty', settings: {}, realistic: false, ...def };
}

/** Raised by a failing step; carries the step's name. */
export class StepFailure extends Error {
  constructor(step, cause) {
    super(`${step}: ${cause?.message ?? cause}`);
    this.step = step;
    this.cause = cause;
  }
}

/** How long things take on screen, per run mode. */
export const PACES = {
  fast: { glide: 120, settle: 150, afterCaption: 250, intro: 300, tail: 300 },
  // Record: about 2.5 s to read each caption before its actions start.
  record: { glide: 650, settle: 450, afterCaption: 2500, intro: 4000, tail: 2500 },
  slow: { glide: 900, settle: 700, afterCaption: 3500, intro: 5000, tail: 3500 },
  // Record with --narrate: the voice reads each caption, so only a beat before
  // its actions; the encoder holds a frame wherever a line needs longer.
  narrate: { glide: 650, settle: 450, afterCaption: 900, intro: 1500, tail: 1500 },
};

/**
 * The `s` every story's steps receive.
 *
 *   s.step(caption, fn, { say, at }) one step: caption + actions + assertions (`say`: what --narrate speaks instead of
 *                                the caption; `at: 'left'`: the caption bottom-left, clear of a notification)
 *   s.wb                         the workbench actor (click, press, type, waitFor, highlight, ev…)
 *   s.ui                         VS Code helpers (openSidebar, waitForQuickPick, pick, runCommand, tabs…)
 *   s.sel                        selector expressions (vscode.mjs)
 *   s.webview(opts)              an actor inside a webview (the ERD canvas)
 *   s.home / s.workspace         the temp HOME, and the folder the story opened (undefined: empty window)
 *   s.path(...parts)             a path inside the workspace (or HOME for an empty window)
 *   s.expect…                    assertions (below); `s.assert` is node:assert/strict
 *   s.pause(ms)                  a beat for the viewer (scaled by the run mode)
 */
export class StoryContext {
  constructor({ def, port, home, workspace, marks, pace, log, outDir, ud }) {
    /** The window's --user-data-dir (its logs: `erdLog()`). */
    this.ud = ud;
    this.def = def;
    this.port = port;
    this.home = home;
    this.workspace = workspace;
    this.marks = marks;
    this.pace = pace;
    this.log = log;
    this.outDir = outDir;
    this.wb = new Workbench({ port, pace, log, home });
    this.ui = new VSCodeUI(this.wb);
    /** Interruptions since ERD Studio was installed (a realistic story: `installErdStudio()` starts it). */
    this.noise = new Noise({ wb: this.wb, log });
    this.sel = sel;
    this.assert = assert;
    /** `[{ name, status: 'passed'|'failed', ms, error? }]` */
    this.steps = [];
  }

  /**
   * A caption from now on; `say` is what --narrate speaks instead of `text`
   * ('' or null: nothing); `at: 'left'` films it bottom-left, clear of the
   * notification toasts (bottom-right).
   */
  mark(text, kind = 'step', say, at) {
    this.marks.push({ t: Date.now(), text, kind, ...(say !== undefined ? { say } : {}), ...(at ? { at } : {}) });
  }

  async pause(ms = 1000) {
    // The record pace's beats, kept when narrating (they show the viewer the result).
    const base = this.pace === PACES.narrate ? PACES.record.afterCaption : this.pace.afterCaption;
    await sleep(Math.round(ms * (base / PACES.record.afterCaption)));
  }

  async step(name, fn, { say, at } = {}) {
    if (this.failed) return;
    const t = Date.now();
    this.mark(name, 'step', say, at);
    this.log(`STEP ${this.steps.length + 1}: ${name}`);
    await sleep(this.pace.afterCaption);
    try {
      await fn();
      this.steps.push({ name, status: 'passed', ms: Date.now() - t });
      this.log(`  ok (${Date.now() - t} ms)`);
    } catch (err) {
      this.failed = true;
      this.steps.push({ name, status: 'failed', ms: Date.now() - t, error: String(err?.stack ?? err) });
      this.log(`  FAILED: ${err?.stack ?? err}`);
      throw new StepFailure(name, err);
    }
  }

  /**
   * A realistic story's install, as from the Marketplace: Extensions: Install
   * from VSIX… in the Command Palette, the VSIX the runner put in
   * ~/Downloads, Install. Starts the interruption clock as Install is pressed
   * (VS Code's "Completed installing" notice is the install's own answer) and
   * resolves once ERD Studio's icon is in the activity bar.
   */
  async installErdStudio() {
    if (!this.def.realistic) throw new Error('installErdStudio() is for realistic stories (realistic: true)');
    await this.ui.runCommand('Extensions: Install from VSIX', 'Extensions: Install from VSIX');
    const dialog = await this.ui.waitForQuickPick({ title: 'Install from VSIX' });
    const want = path.join(this.home, 'Downloads/erd-studio.vsix');
    if (dialog.value === `${this.home}/`) await this.ui.appendQuickInput('Downloads/erd-studio.vsix');
    else await this.ui.setQuickInput(want);
    await this.wb.waitFor(`${sel.quickInputBox}?.value === ${JSON.stringify(want)}`, { what: 'the VSIX in the file dialog' });
    await this.pause(600);
    this.noise.expect(/^Completed installing/, { kind: 'notification', within: 60000, why: 'the install' });
    await this.noise.start();
    await this.ui.quickInputButton('Install');
    await this.wb.waitFor(sel.activity('ERD Studio'), { timeout: 60000, what: 'the ERD Studio icon in the activity bar (installed)' });
  }

  /**
   * Run `fn` (the story's actions), asserting it took exactly one click: "the
   * draft (or the right next step) is reachable in one click".
   */
  async oneClick(fn) {
    const before = this.wb.clicks;
    const out = await fn();
    const clicks = this.wb.clicks - before;
    this.expect(clicks === 1, `it should take one click, but took ${clicks}`);
    return out;
  }

  /**
   * The first minute after the install, watched to its end: at most `max`
   * (default 1) interruptions nobody asked for from ERD Studio (its own, and
   * VS Code's on its behalf). VS Code's own unasked ones are logged, and
   * returned, but do not fail the story. Resolves `{ erd, vscode }`.
   */
  async expectQuietFirstMinute({ max = 1 } = {}) {
    await this.noise.until(60000);
    this.noise.stop();
    const erd = this.noise.unasked({ origin: 'erd' });
    const vscode = this.noise.unasked({ origin: 'vscode' });
    this.log(`NOISE: first minute: ${erd.length} from ERD Studio (${Noise.describe(erd)}); VS Code's own: ${Noise.describe(vscode)}`);
    this.expect(erd.length <= max, `ERD Studio interrupted ${erd.length} times in its first minute (at most ${max}): ${Noise.describe(erd)}`);
    return { erd, vscode };
  }

  path(...parts) {
    return path.join(this.workspace ?? this.home, ...parts);
  }

  /**
   * The ERD Studio output channel's text so far (a LogOutputChannel, which VS
   * Code writes under the profile's logs/ folder), or '' before it exists.
   */
  erdLog() {
    if (!this.ud) return '';
    const found = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'ERD Studio.log' || /^\d+-ERD Studio\.log$/.test(e.name)) found.push(full);
      }
    };
    walk(path.join(this.ud, 'logs'));
    return found.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  }

  async webview(opts) {
    return Webview.find(this.wb, opts);
  }

  // ---- assertions --------------------------------------------------------

  /** Assert `cond`; `message` says what was expected. */
  expect(cond, message) {
    if (!cond) throw new assert.AssertionError({ message });
  }

  /** Wait until `fn()` resolves truthy (or stops throwing); fails with `message`. */
  async eventually(fn, { timeout = 20000, interval = 250, message = 'condition never held' } = {}) {
    const until = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      if (Date.now() > until) throw new Error(`${message}${last ? ` (last error: ${last.message})` : ''}`);
      await sleep(interval);
    }
  }

  /** The element `expr` exists and is visible in the workbench (waits). */
  async expectVisible(expr, { timeout = 20000, what } = {}) {
    await this.wb.waitFor(`(() => { const el=${expr}; if(!el) return false; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0; })()`, { timeout, what: what ?? expr });
  }

  /** The workbench text of `expr` contains `text` (a string or RegExp; waits). */
  async expectText(expr, text, { timeout = 20000 } = {}) {
    const test = text instanceof RegExp ? `${text}.test(t)` : `t.includes(${JSON.stringify(text)})`;
    await this.wb.waitFor(`(() => { const el=${expr}; const t=el?.innerText ?? el?.textContent ?? ''; return ${test}; })()`, { timeout, what: `text ${text} in ${expr}` });
  }

  /**
   * A file exists in the workspace (or, for an empty window, in HOME): `rel`
   * is relative to it, or absolute. With `contains`, its text contains that
   * string or matches that RegExp. Waits up to `timeout` (files land async).
   */
  async expectFile(rel, { contains, timeout = 10000 } = {}) {
    const file = path.isAbsolute(rel) ? rel : this.path(rel);
    await this.eventually(() => fs.existsSync(file), { timeout, message: `expected the file ${file} to exist` });
    if (contains !== undefined) {
      const text = fs.readFileSync(file, 'utf8');
      const ok = contains instanceof RegExp ? contains.test(text) : text.includes(contains);
      this.expect(ok, `expected ${file} to contain ${contains}`);
    }
    return file;
  }

  /** No file at `rel` (relative to the workspace, or absolute). */
  expectNoFile(rel) {
    const file = path.isAbsolute(rel) ? rel : this.path(rel);
    this.expect(!fs.existsSync(file), `expected no file at ${file}`);
  }
}

/** Write a failure screenshot; never throws. */
export async function failureScreenshot(ctx, file) {
  try {
    await ctx.wb.screenshot(file);
    return file;
  } catch {
    return undefined;
  }
}
