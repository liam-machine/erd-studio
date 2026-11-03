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
//     },
//   });

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Webview, Workbench, sleep } from './act.mjs';
import { VSCodeUI, sel } from './vscode.mjs';

const REQUIRED = ['id', 'title', 'persona', 'want', 'soThat', 'steps'];

/** Declare a story (validated; run by run.mjs). */
export function story(def) {
  for (const k of REQUIRED) if (!def[k]) throw new Error(`story ${def.id ?? '(no id)'}: "${k}" is required`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id)) throw new Error(`story id "${def.id}": lower-case letters, digits and dashes only`);
  if (typeof def.steps !== 'function') throw new Error(`story ${def.id}: steps must be an async function (s) => { … }`);
  return { workspace: 'empty', settings: {}, ...def };
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
  record: { glide: 650, settle: 450, afterCaption: 1400, intro: 3500, tail: 2500 },
  slow: { glide: 900, settle: 700, afterCaption: 2500, intro: 4500, tail: 3500 },
};

/**
 * The `s` every story's steps receive.
 *
 *   s.step(caption, fn)          one step: caption + actions + assertions
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
  constructor({ def, port, home, workspace, marks, pace, log, outDir }) {
    this.def = def;
    this.port = port;
    this.home = home;
    this.workspace = workspace;
    this.marks = marks;
    this.pace = pace;
    this.log = log;
    this.outDir = outDir;
    this.wb = new Workbench({ port, pace, log });
    this.ui = new VSCodeUI(this.wb);
    this.sel = sel;
    this.assert = assert;
    /** `[{ name, status: 'passed'|'failed', ms, error? }]` */
    this.steps = [];
  }

  mark(text, kind = 'step') {
    this.marks.push({ t: Date.now(), text, kind });
  }

  async pause(ms = 1000) {
    await sleep(Math.round(ms * (this.pace.afterCaption / PACES.record.afterCaption)));
  }

  async step(name, fn) {
    if (this.failed) return;
    const t = Date.now();
    this.mark(name);
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

  path(...parts) {
    return path.join(this.workspace ?? this.home, ...parts);
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
