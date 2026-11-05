// @vitest-environment jsdom
/**
 * Logical first, dbt as an add-on: dbt shows up only in dbt projects.
 *
 * One test over every surface a user reads, run on real fixtures through the
 * real code paths:
 *
 * - **No dbt** — `test/fixtures/logical-only` (YAML), `test/fixtures/dbml-native`
 *   (DBML) and an empty window (no folder): no control that only makes sense
 *   with dbt, and no `dbt` word anywhere a user can reach.
 * - **dbt** — `test/fixtures/dbt-project`: every one of those controls is
 *   still reachable, and the key dbt texts are still there.
 *
 * Each case copies its fixture to a temp folder and runs the real
 * `activate()` against the vscode mock, then reads:
 *
 * 1. **package.json contributes** — the Command Palette, every menu
 *    (`view/title`, `view/item/context`, `explorer/context`, the New… submenu),
 *    `viewsWelcome`, `views` and the walkthrough (title, description, every
 *    step's title, description, altText and the text drawn in its svg). A
 *    `when` clause is evaluated against the context keys `activate()` really
 *    set (`setContext`), with the runtime toggles (`hasDiagrams`, loading and
 *    filter states, …) swept over true and false; `view`, `viewItem`,
 *    `focusedView` and `resourceLangId` are wildcards ("true in some view").
 *    A view's own `when` gates its menus and welcome content.
 * 2. **Getting Started panel** — `erdStudio.showGettingStarted`, the HTML it
 *    really builds and the status it really posts, run in JSDOM: text that is
 *    not under `[hidden]` or a computed `display: none` (closed `<details>`,
 *    i.e. the transcript, included), plus aria-label / title, the page title
 *    and the captions of whichever cut plays.
 * 3. **Sidebar trees** — Diagrams, Table Library, Relationships, Help &
 *    Feedback (only those whose `when` holds): label, description, tooltip,
 *    command title.
 * 4. **The canvas** — the real `SemanticEditorProvider` (from activate())
 *    bridged to the real `<App/>` in jsdom, so the store's `logicalOnly` is
 *    whatever the host decided for that folder. States: the loaded diagram,
 *    the Legend, the toolbar's menus, the detail panel on every table (alias
 *    row with and without an alias), Add Existing Table, the New Relationship
 *    dialog when nothing decides the direction, an empty diagram, the
 *    `manifestMissing` flag forced on (the host never sets it without dbt;
 *    the strip must stay away anyway), a stale webview asking for the
 *    Physical stage (the host must answer with the logical stage), and in the
 *    dbt project Compare with dbt (whose panel offers Sync). Also the
 *    right-click menus on a table, a relationship line and a note, each
 *    table-menu entry that opens a host prompt (Move Table…, Show on Other
 *    Diagrams…), the New Table dialog and the Send Feedback dialog.
 * 5. **Toasts and prompts** — every information / warning / error message
 *    shown during the run (text and buttons), and every QuickPick and input
 *    box the host opens (title, placeholder, prompt, items).
 * 6. **AI helper files** — what Set Up My AI Helper installs, plus every
 *    harness target written by Install AI Helper Files….
 * 7. **CLI** — `erd-studio doctor` and `erd-studio inventory` human output.
 *
 * Matcher: `/\bdbt\b/i` (so `DBML`, `dbdiagram` and ids such as
 * `drawFromDbt` / `hasDbtProject` never match; the self-test proves it) plus
 * an explicit list of dbt-only controls whose words name no dbt (Try the
 * Sample Project, Refresh Manifest, the Physical tab, Sync, the Warehouse
 * name editor on a table without an alias, …).
 *
 * Out of scope, on purpose:
 * - The Settings UI (`contributes.configuration`): VS Code cannot hide a
 *   setting by context, and the deprecated `dbtSemantic.*` settings must stay
 *   contributed (CLAUDE.md).
 * - Marketplace copy (`description`, `keywords`): the listing, not the editor.
 * - Logs and telemetry: never shown as UI.
 * - Physical-stage-only strings (ghost reasons, provenance, sync modal): the
 *   Physical stage is unreachable without dbt, which state (4) asserts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { JSDOM, VirtualConsole } from 'jsdom';

const mockVsCode = vi.hoisted(() => ({
  queue: [] as unknown[],
  postMessage: (m: unknown) => { mockVsCode.queue.push(m); },
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { GETTING_STARTED_VIEW_TYPE } from '../../src/providers/GettingStartedPanel';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { HARNESS_TARGETS, HarnessService } from '../../src/services/harnessService';
import { main as cliMain } from '../../src/cli/index';
import { App } from '../../webview/App';
import { useEditorStore } from '../../webview/store/editorStore';
import { orientDraggedRelationship } from '../../webview/lib/relationshipDirection';
import { evalWhen, type WhenContext } from './helpers/whenClause';
import { START_INTENTS, START_INTENT_CONTEXT_KEY, moreStartsFor } from '../../src/types/startActions';

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/** `dbt` as a word, or the start of a dbt file name such as `dbt_project.yml`. */
const DBT_WORD = /\bdbt(?:\b|_)/i;

/** Controls that only make sense with dbt. Several name no dbt, so they are listed, not matched. */
const DBT_CONTROLS = [
  'Draw from dbt',
  'Try the Sample Project',
  'Select dbt Project…',
  'Refresh Manifest',
  'Regenerate dbt selectors.yml',
  'Strip Legacy Domain Tags',
  'Physical tab',
  'Compare with dbt',
  'Sync',
  'Run dbt parse',
  'Add Tables from dbt',
  'Warehouse name editor on a table without alias',
] as const;
type DbtControl = typeof DBT_CONTROLS[number];

/** A contributed command (palette, menu, link, tree row) → the dbt control it is. */
const COMMAND_CONTROLS: Record<string, DbtControl> = {
  'erdStudio.drawFromDbt': 'Draw from dbt',
  'erdStudio.trySampleProject': 'Try the Sample Project',
  'erdStudio.selectDbtProject': 'Select dbt Project…',
  'erdStudio.refreshManifest': 'Refresh Manifest',
  'erdStudio.syncDomainTags': 'Regenerate dbt selectors.yml',
  'erdStudio.stripLegacyDomainTags': 'Strip Legacy Domain Tags',
};

/** Getting Started panel actions → the dbt control they are. */
const PANEL_CONTROLS: Record<string, DbtControl> = {
  trySample: 'Try the Sample Project',
};

/** Getting Started panel starts (`data-action="start" data-start="…"`) → the dbt control they are. */
const PANEL_START_CONTROLS: Record<string, DbtControl> = {
  drawFromDbt: 'Draw from dbt',
};

type Surface = 'package.json' | 'gettingStarted' | 'importGuide' | 'trees' | 'canvas' | 'toasts' | 'harness' | 'cli';
const SURFACES: Surface[] = ['package.json', 'gettingStarted', 'importGuide', 'trees', 'canvas', 'toasts', 'harness', 'cli'];

/** Import guide buttons (`data-guide-action="…"`) → the dbt control they are. */
const GUIDE_CONTROLS: Record<string, DbtControl> = {
  dbt: 'Draw from dbt',
};

interface Shown { where: string; text: string }
interface Collected {
  text: Record<Surface, Shown[]>;
  controls: Map<DbtControl, string[]>;
  /** Canvas facts the assertions need besides text. */
  aliasRows: Array<{ table: string; hasAlias: boolean; row: boolean }>;
  physicalSwitch?: { stage: string; logicalOnly: boolean };
  harnessFiles: string[];
}

const dbtHits = (shown: Shown[]): string[] => shown.filter((s) => DBT_WORD.test(s.text)).map((s) => `${s.where}: ${s.text}`);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

/** `plain`: an open folder with nothing in it (no `dbt_project.yml`, no `.erd-studio/`), the usual logical-first start. */
interface Case { name: string; fixture: string | null; plain?: boolean; diagram?: string; dbt: boolean }
const LOGICAL_YAML: Case = { name: 'logical-only', fixture: 'logical-only', diagram: '.erd-studio/gold/sales.json', dbt: false };
const LOGICAL_DBML: Case = { name: 'dbml-native', fixture: 'dbml-native', diagram: '.erd-studio/gold/diagrams/sales.dbml', dbt: false };
const EMPTY_WINDOW: Case = { name: 'empty window', fixture: null, dbt: false };
const PLAIN_FOLDER: Case = { name: 'plain folder', fixture: null, plain: true, dbt: false };
const DBT_PROJECT: Case = { name: 'dbt-project', fixture: 'dbt-project', diagram: '.erd-studio/silver/showcase.json', dbt: true };

// ---------------------------------------------------------------------------
// 1. package.json contributes
// ---------------------------------------------------------------------------

const WILDCARDS = new Set(['view', 'viewItem', 'focusedView', 'resourceLangId']);
/** Context keys that change while the user works; every combination is swept. */
const TOGGLES = [
  'erdStudio.hasDiagrams', 'erdStudio.diagramsLoading', 'erdStudio.tablesLoading',
  'erdStudio.diagramsFiltered', 'erdStudio.tableLibraryFiltered', 'erdStudio.relationshipsFiltered',
  'erdStudio.sidebarFilterOpen', 'erdStudio.hasTrackedReports',
];

/** A markdown link's visible words; the `(command:…)` / URL target is not text. */
const linkText = (s: string) => s.replace(/\]\((command:[^)]*|https?:[^)]*)\)/g, ']');
const linkCommands = (s: string) => [...s.matchAll(/\(command:([^)?\s]+)/g)].map((m) => m[1]);

function svgText(file: string): string[] {
  const svg = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function contributesShown(base: WhenContext, out: Collected): void {
  const c = pkg.contributes;
  const titleOf = new Map<string, string>((c.commands as Array<{ command: string; title: string }>).map((x) => [x.command, x.title]));
  const views = Object.values(c.views as Record<string, Array<{ id: string; name: string; when?: string }>>).flat();
  const viewWhen = new Map(views.map((v) => [v.id, v.when]));
  const submenuLabel = new Map<string, string>((c.submenus as Array<{ id: string; label: string }>).map((s) => [s.id, s.label]));
  const shown = out.text['package.json'];
  const seen = new Set<string>();
  const push = (where: string, text: string) => {
    const key = `${where}\u0000${text}`;
    if (!seen.has(key)) { seen.add(key); shown.push({ where, text }); }
  };
  const control = (command: string, where: string) => {
    const name = COMMAND_CONTROLS[command];
    if (name) { out.controls.set(name, [...(out.controls.get(name) ?? []), where]); }
  };
  /** The view a menu entry or welcome content belongs to, from `view == x` in its clause. */
  const viewOf = (when: string | undefined) => /\bview == ([\w.]+)/.exec(when ?? '')?.[1];

  // The start screen's suggestion (`erdStudio.startIntent`) is swept too: unset (not looked yet) and every value.
  const intents: Array<string | undefined> = [undefined, ...START_INTENTS];
  for (let combo = 0; combo < (1 << TOGGLES.length) * intents.length; combo++) {
    const mask = combo % (1 << TOGGLES.length);
    const ctx: WhenContext = { ...base, [START_INTENT_CONTEXT_KEY]: intents[Math.floor(combo / (1 << TOGGLES.length))] };
    TOGGLES.forEach((key, i) => { ctx[key] = (mask & (1 << i)) !== 0; });
    const holds = (when: string | undefined) => evalWhen(when, ctx, WILDCARDS);
    const viewShown = (id: string | undefined) => id === undefined || (viewWhen.has(id) ? holds(viewWhen.get(id)) : true);

    // Command Palette: a command with no commandPalette entry is always listed.
    const palette = new Map<string, string | undefined>((c.menus.commandPalette as Array<{ command: string; when?: string }>).map((m) => [m.command, m.when]));
    for (const [command, title] of titleOf) {
      if (holds(palette.get(command))) {
        push(`palette ${command}`, `ERD Studio: ${title}`);
        control(command, `palette ${command}`);
      }
    }
    // Every other menu (view title bars, row context menus, explorer, the New… submenu).
    for (const [menu, items] of Object.entries(c.menus as Record<string, Array<{ command?: string; submenu?: string; when?: string }>>)) {
      if (menu === 'commandPalette') { continue; }
      for (const item of items) {
        if (!holds(item.when) || !viewShown(viewOf(item.when))) { continue; }
        // A submenu's entries show only while the submenu itself is reachable.
        if (menu === 'erdStudio.newMenu') {
          const parent = (c.menus['view/title'] as Array<{ submenu?: string; when?: string }>).find((m) => m.submenu === menu);
          if (!parent || !holds(parent.when) || !viewShown(viewOf(parent.when))) { continue; }
        }
        const text = item.command ? titleOf.get(item.command) ?? item.command : submenuLabel.get(item.submenu!) ?? item.submenu!;
        push(`menu ${menu} ${item.command ?? item.submenu}`, text);
        if (item.command) { control(item.command, `menu ${menu}`); }
      }
    }
    for (const v of views) {
      if (holds(v.when)) { push(`view ${v.id}`, v.name); }
    }
    for (const w of c.viewsWelcome as Array<{ view: string; contents: string; when?: string }>) {
      if (!holds(w.when) || !viewShown(w.view)) { continue; }
      push(`viewsWelcome ${w.view} [${w.when}]`, linkText(w.contents));
      for (const command of linkCommands(w.contents)) { control(command, `viewsWelcome ${w.view}`); }
    }
    for (const wt of c.walkthroughs as Array<{ id: string; title: string; description: string; when?: string; steps: Array<{ id: string; title: string; description: string; when?: string; media?: { svg?: string; image?: string; altText?: string } }> }>) {
      if (!holds(wt.when)) { continue; }
      push(`walkthrough ${wt.id} title`, wt.title);
      push(`walkthrough ${wt.id} description`, wt.description);
      for (const step of wt.steps) {
        if (!holds(step.when)) { continue; }
        const at = `walkthrough step ${step.id}`;
        push(`${at} title`, step.title);
        push(`${at} description`, linkText(step.description));
        if (step.media?.altText) { push(`${at} altText`, step.media.altText); }
        if (step.media?.svg) { for (const t of svgText(step.media.svg)) { push(`${at} svg`, t); } }
        for (const command of linkCommands(step.description)) { control(command, at); }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared: visible text in a DOM
// ---------------------------------------------------------------------------

function domText(doc: Document, win: Window & typeof globalThis, root: Element = doc.body): string[] {
  const shown = (el: Element): boolean => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if ((e as HTMLElement).hidden || win.getComputedStyle(e).display === 'none') { return false; }
    }
    return true;
  };
  const out: string[] = [];
  const shownNodes = new Set<Node>();
  const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, noscript')) { continue; }
    const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t && shown(parent)) { out.push(t); shownNodes.add(node); }
  }
  for (const el of root.querySelectorAll('[aria-label], [title], [placeholder], [alt]')) {
    if (!shown(el)) { continue; }
    for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
      const v = el.getAttribute(attr);
      if (v && v.trim()) { out.push(v.trim()); }
    }
  }
  // Whole blocks too (from their shown text only), so a sentence split over inline elements still reads as one.
  for (const el of root.querySelectorAll('p, li, button, label, h1, h2, h3, h4, summary, [role="status"]')) {
    if (!shown(el)) { continue; }
    let t = '';
    const inner = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
    for (let node = inner.nextNode(); node; node = inner.nextNode()) {
      if (shownNodes.has(node)) { t += node.textContent ?? ''; }
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t) { out.push(t); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type Ctx = import('vscode').ExtensionContext;

function makeContext(storageRoot: string): Ctx {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: pkg },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(storageRoot, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Ctx;
}

function listFiles(dir: string, rel = ''): string[] {
  if (!fs.existsSync(dir)) { return []; }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { out.push(...listFiles(path.join(dir, entry.name), r)); } else { out.push(r); }
  }
  return out;
}

type TreeLike = { getChildren(e?: unknown): unknown; getTreeItem(e: unknown): unknown };
type Item = { label?: string | { label: string }; description?: string | boolean; tooltip?: string | { value: string }; command?: { command: string; title?: string; tooltip?: string } };

async function treeText(id: string, provider: TreeLike, out: Collected): Promise<void> {
  const shown = out.text.trees;
  let budget = 400;
  const visit = async (element: unknown, depth: number) => {
    const children = (await provider.getChildren(element)) as unknown[] | undefined;
    for (const child of children ?? []) {
      if (budget-- <= 0) { return; }
      const item = (await provider.getTreeItem(child)) as Item;
      const label = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      const where = `tree ${id} "${label}"`;
      for (const t of [label, typeof item.description === 'string' ? item.description : '',
        typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value ?? '',
        item.command?.title ?? '', item.command?.tooltip ?? '']) {
        if (t) { shown.push({ where, text: t }); }
      }
      const control = item.command ? COMMAND_CONTROLS[item.command.command] : undefined;
      if (control) { out.controls.set(control, [...(out.controls.get(control) ?? []), where]); }
      if (depth < 3) { await visit(child, depth + 1); }
    }
  };
  await visit(undefined, 0);
}

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;

/** Opens the Welcome panel the way the command does, and lets it post its first status. */
async function openGettingStarted(): Promise<MockPanel> {
  await vscode.commands.executeCommand('erdStudio.showGettingStarted');
  const panel = vscode.window._webviewPanels.find((p) => p.viewType === GETTING_STARTED_VIEW_TYPE);
  if (!panel) { throw new Error('the Getting Started panel did not open'); }
  await panel._simulateMessage({ type: 'ready' });
  await vi.advanceTimersByTimeAsync(500);
  return panel as MockPanel;
}

/** Runs the panel's real HTML in JSDOM and replays everything the host posted to it (status, setup result). */
async function gettingStartedText(panel: MockPanel, out: Collected): Promise<void> {
  const posted = (panel._postedMessages as Array<{ type: string }>).filter((m) => m.type === 'status' || m.type === 'setupResult');
  if (!posted.some((m) => m.type === 'status')) { throw new Error('the Getting Started panel posted no status'); }

  const dom = new JSDOM(panel.webview.html, {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
    },
  });
  try {
    const win = dom.window as unknown as Window & typeof globalThis;
    const doc = dom.window.document;
    const shown = out.text.gettingStarted;
    const collect = (when: string) => {
      for (const t of domText(doc, win)) { shown.push({ where: `panel ${when}`, text: t }); }
      for (const el of doc.querySelectorAll<HTMLElement>('[data-action]')) {
        const control = el.dataset.action === 'start'
          ? PANEL_START_CONTROLS[el.dataset.start ?? '']
          : PANEL_CONTROLS[el.dataset.action ?? ''];
        let visible = true;
        for (let e: Element | null = el; e; e = e.parentElement) {
          if ((e as HTMLElement).hidden || win.getComputedStyle(e).display === 'none') { visible = false; break; }
        }
        if (control && visible) { out.controls.set(control, [...(out.controls.get(control) ?? []), `panel ${when}`]); }
      }
    };
    collect('before status');
    for (const message of posted) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
      collect(`after ${message.type}`);
    }
    shown.push({ where: 'panel title', text: doc.title });
    const data = JSON.parse(doc.getElementById('gs-data')?.textContent ?? '{}') as { cues?: Array<{ text: string }> };
    for (const cue of data.cues ?? []) { shown.push({ where: 'panel captions', text: cue.text }); }
    const video = doc.querySelector('video');
    // The file name of the cut that plays (the folder it sits in is not text a user reads).
    shown.push({ where: 'panel video', text: path.basename(video?.getAttribute('src') ?? video?.querySelector('source')?.getAttribute('src') ?? '') });
  } finally {
    dom.window.close();
  }
}

/** The real provider ↔ the real App: what one posts, the other receives. */
function bridge(panel: ReturnType<typeof vscode.createMockWebviewPanel>) {
  let cursor = 0;
  const toApp = () => {
    while (cursor < panel._postedMessages.length) {
      const data = panel._postedMessages[cursor++];
      act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
    }
  };
  const pump = async () => {
    for (let round = 0; round < 20; round++) {
      toApp();
      const pending = mockVsCode.queue.splice(0);
      if (pending.length === 0) { break; }
      for (const m of pending) { await panel._simulateMessage(m); }
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    }
    toApp();
  };
  return { pump, toApp };
}

async function canvasText(provider: SemanticEditorProvider, file: string, c: Case, out: Collected): Promise<void> {
  const shown = out.text.canvas;
  const collect = (state: string) => {
    for (const t of domText(document, window as Window & typeof globalThis)) { shown.push({ where: `canvas ${state}`, text: t }); }
    const control = (name: DbtControl) => out.controls.set(name, [...(out.controls.get(name) ?? []), `canvas ${state}`]);
    if (document.querySelector('[role="tablist"][aria-label="Design stage"]')) { control('Physical tab'); }
    const buttons = [...document.querySelectorAll('button')];
    const named = (re: RegExp) => buttons.some((b) => re.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''}`));
    if (named(/Compare with dbt/)) { control('Compare with dbt'); }
    if (named(/Refresh manifest data/i)) { control('Refresh Manifest'); }
    if (named(/Add Tables from dbt/)) { control('Add Tables from dbt'); }
    if (named(/Run dbt parse/)) { control('Run dbt parse'); }
    if (named(/^\s*⊕?\s*Sync\b/)) { control('Sync'); }
  };

  const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  const { pump } = bridge(panel);
  mockVsCode.queue.length = 0;
  render(<App />);
  await pump(); // the App's ready → the host's domainLoaded
  const store = useEditorStore.getState;
  const domain = store().domain;
  if (!domain) { throw new Error(`${c.name}: the canvas did not load ${file}`); }
  expect(store().logicalOnly, `${c.name}: logicalOnly`).toBe(!c.dbt);
  collect('loaded');

  act(() => { store().setLegendOpen(true); });
  collect('legend open');
  act(() => { store().setLegendOpen(false); });

  // Every toolbar menu, opened one at a time.
  for (const trigger of [...document.querySelectorAll<HTMLElement>('[aria-haspopup]')]) {
    act(() => { fireEvent.click(trigger); });
    await pump();
    collect(`menu "${trigger.getAttribute('aria-label') ?? trigger.textContent}"`);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    if (trigger.getAttribute('aria-expanded') === 'true') { act(() => { fireEvent.click(trigger); }); }
  }

  // The host never flags a missing manifest without dbt; the strip must not show even if it did.
  act(() => { store().setManifestMissing(true); });
  collect('manifestMissing forced');
  act(() => { store().setManifestMissing(false); });

  // The detail panel on every table.
  for (const model of domain.models.slice(0, 12)) {
    act(() => { store().selectNode(model.name); store().setDetailPanelOpen(true); });
    await pump();
    collect(`detail panel ${model.name}`);
    const hasAlias = Boolean(model.alias?.trim());
    const row = document.querySelector('.detail-panel__metadata-row--alias') !== null;
    out.aliasRows.push({ table: model.name, hasAlias, row });
    if (row && !hasAlias) { out.controls.set('Warehouse name editor on a table without alias', [`canvas detail panel ${model.name}`]); }
    // The row's edit mode and its hint.
    const edit = document.querySelector<HTMLElement>('.detail-panel__metadata-row--alias button[aria-label="Edit warehouse name"]');
    if (edit) {
      act(() => { fireEvent.click(edit); });
      collect(`detail panel ${model.name}, editing the warehouse name`);
      const input = document.querySelector<HTMLElement>('.detail-panel__alias-input');
      if (input) { act(() => { fireEvent.keyDown(input, { key: 'Escape' }); }); }
    }
  }
  act(() => { store().setDetailPanelOpen(false); store().selectNode(null); });

  act(() => { store().setAddExistingModelDialogOpen(true); });
  await pump();
  collect('add existing table');
  act(() => { store().setAddExistingModelDialogOpen(false); });

  // Compare with dbt (dbt project only), and the panel it opens (Sync).
  const compare = [...document.querySelectorAll('button')].find((b) => /Compare with dbt/.test(b.textContent ?? ''));
  if (compare) {
    act(() => { fireEvent.click(compare); });
    await pump();
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"]')].find((el) => /dbt|physical/i.test(el.textContent ?? ''));
    if (option) { act(() => { fireEvent.click(option); }); await pump(); }
    collect('comparing');
  }

  // A stale webview (or Alt+2 in an older one) asks for the Physical stage.
  mockVsCode.postMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 991 } });
  await pump();
  const reply = (panel._postedMessages as Array<{ type: string; requestId?: number; logicalOnly?: boolean; payload?: { stage: string } }>)
    .filter((m) => m.type === 'stageData' && m.requestId === 991).at(-1);
  out.physicalSwitch = { stage: reply?.payload?.stage ?? 'none', logicalOnly: reply?.logicalOnly === true };
  collect('after a physical switch');
  if (store().domain?.stage === 'physical') {
    mockVsCode.postMessage({ type: 'switchStage', payload: { stage: 'logical', requestId: 992 } });
    await pump();
  }

  // New Relationship, when no key or test decides which way it points.
  const col = (name: string) => ({ name, dataType: 'string', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false });
  const models = [{ name: 'left_table', columns: [col('shared_id')] }, { name: 'right_table', columns: [col('shared_id')] }];
  const real = store().domain!;
  act(() => {
    useEditorStore.setState({ domain: { ...real, models: models as never, relationships: [] } });
    store().openFkDialogWithPrefill(orientDraggedRelationship(
      { fromModel: 'left_table', fromColumn: 'shared_id', toModel: 'right_table', toColumn: 'shared_id' }, models as never));
  });
  collect('new relationship, direction undecided');
  act(() => { store().setNewFkDialogOpen(false); useEditorStore.setState({ domain: real }); });

  // The canvas's right-click menus: a table, a relationship line, a note.
  const firstTable = store().domain!.models[0];
  if (firstTable) {
    act(() => { store().openNodeContextMenu(40, 40, firstTable.name); });
    collect(`node context menu ${firstTable.name}`);
    // Each of its entries that opens a host prompt (Move Table…, Show on Other Diagrams…), answered with nothing.
    const entries = [...document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')]
      .filter((el) => /…/.test(el.textContent ?? ''));
    for (const label of entries.map((el) => el.textContent ?? '')) {
      act(() => { store().openNodeContextMenu(40, 40, firstTable.name); });
      const entry = [...document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"]')].find((el) => el.textContent === label);
      if (entry) { act(() => { fireEvent.click(entry); }); await pump(); }
      collect(`node context menu ${firstTable.name}, after "${label}"`);
    }
    act(() => { store().closeContextMenu(); });
  }
  // A diagram with no relationship still gets the menu, on a line between its first table and itself.
  const line = store().domain!.relationships[0]
    ?? (firstTable && { fromModel: firstTable.name, fromColumn: firstTable.columns[0]?.name ?? 'id', toModel: firstTable.name, toColumn: firstTable.columns[0]?.name ?? 'id' });
  if (line) {
    act(() => { store().openEdgeContextMenu(40, 40, { cardinality: 'many-to-one', ...line } as never); });
    collect('edge context menu');
    act(() => { store().closeContextMenu(); });
  }
  const note = store().domain!.viewConfig.annotations?.[0];
  act(() => { store().openAnnotationContextMenu(40, 40, note?.id ?? 'probe-note'); });
  collect('annotation context menu');
  act(() => { store().closeContextMenu(); });

  // The New Table dialog and the Send Feedback dialog.
  act(() => { store().setNewModelDialogOpen(true); });
  await pump();
  collect('new table dialog');
  act(() => { store().setNewModelDialogOpen(false); });
  act(() => { store().setFeedbackDialogOpen(true); });
  await pump();
  collect('feedback dialog');
  act(() => { store().setFeedbackDialogOpen(false); });

  // An empty diagram: the host's own payload with no tables.
  const loaded = (panel._postedMessages as Array<{ type: string; payload?: object }>).filter((m) => m.type === 'domainLoaded').at(-1)!;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { ...loaded, payload: { ...loaded.payload, models: [], relationships: [] } } }));
  });
  collect('empty diagram');

  cleanup();
  panel.dispose();
}

async function harnessText(ws: string, out: Collected): Promise<void> {
  const tops = new Set(HARNESS_TARGETS.map((t) => t.relativePath.split('/')[0]));
  await vscode.commands.executeCommand('erdStudio.setupAiHelper');
  await vi.advanceTimersByTimeAsync(100);
  const service = new HarnessService();
  for (const target of HARNESS_TARGETS) { service.install(ws, target, true); }
  const files = listFiles(ws).filter((f) => tops.has(f.split('/')[0]) || f.startsWith('.claude/'));
  out.harnessFiles = files;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ws, f), 'utf-8');
    // Files the dbt fixture already had count too: they are what that user's assistant reads.
    text.split('\n').forEach((line, i) => { if (line.trim()) { out.text.harness.push({ where: `${f}:${i + 1}`, text: line }); } });
  }
}

async function cliText(ws: string, out: Collected): Promise<void> {
  for (const argv of [['doctor', '--project', ws], ['inventory', '--project', ws], ['inventory', '--summary', '--project', ws]]) {
    let text = '';
    const io = {
      stdout: { write: (s: string) => { text += s; } },
      stderr: { write: (s: string) => { text += s; } },
      cwd: ws,
      env: { PATH: '' },
    };
    await cliMain(argv, io as never);
    text.split('\n').forEach((line) => { if (line.trim()) { out.text.cli.push({ where: `erd-studio ${argv[0]}${argv[1] === '--summary' ? ' --summary' : ''}`, text: line }); } });
  }
}

/** Bring In an Existing Data Model…: the page the host really builds for this window, its text and its buttons, in JSDOM. */
async function importGuideText(out: Collected): Promise<void> {
  const shown = vscode.commands.executeCommand('erdStudio.showImportGuide');
  await vi.advanceTimersByTimeAsync(2_000);
  await shown;
  const panel = vscode.window._webviewPanels.find((p) => p.viewType === 'erdStudio.importGuide');
  if (!panel) { throw new Error('the import guide did not open'); }
  const dom = new JSDOM(panel.webview.html, {
    runScripts: 'dangerously',
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined });
    },
  });
  try {
    const win = dom.window as unknown as Window & typeof globalThis;
    const doc = dom.window.document;
    for (const t of domText(doc, win)) { out.text.importGuide.push({ where: 'import guide', text: t }); }
    out.text.importGuide.push({ where: 'import guide title', text: doc.title });
    for (const el of doc.querySelectorAll<HTMLElement>('[data-guide-action]')) {
      const control = GUIDE_CONTROLS[el.dataset.guideAction ?? ''];
      if (control) { out.controls.set(control, [...(out.controls.get(control) ?? []), 'import guide']); }
    }
  } finally {
    dom.window.close();
  }
}

async function collect(c: Case): Promise<Collected> {
  const out: Collected = {
    text: Object.fromEntries(SURFACES.map((s) => [s, []])) as unknown as Record<Surface, Shown[]>,
    controls: new Map(),
    aliasRows: [],
    harnessFiles: [],
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-surfaces-')));
  const ws = path.join(root, c.fixture ?? (c.plain ? 'plain' : 'none'));
  const context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  _resetFirstRunGuardForTests();
  useEditorStore.setState(initialStoreState, true);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const kind of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage'] as const) {
    vi.spyOn(vscode.window, kind).mockImplementation((async (message: string, ...rest: unknown[]) => {
      const buttons = rest.filter((r): r is string => typeof r === 'string');
      out.text.toasts.push({ where: kind, text: [message, ...buttons].join(' | ') });
      return undefined;
    }) as never);
  }
  // Host prompts (QuickPick, input box) the canvas opens: their words, answered with nothing.
  type Item = string | { label?: string; description?: string; detail?: string };
  const promptText = (o: { title?: string; placeHolder?: string; prompt?: string } | undefined) =>
    [o?.title, o?.placeHolder, o?.prompt].filter((t): t is string => Boolean(t));
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Item[] | Promise<Item[]>, options?: { title?: string; placeHolder?: string }) => {
    const list = await items;
    const words = [...promptText(options), ...list.flatMap((i) => (typeof i === 'string' ? [i] : [i.label, i.description, i.detail]))];
    for (const w of words) { if (w) { out.text.toasts.push({ where: 'showQuickPick', text: w }); } }
    return undefined;
  }) as never);
  vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (options?: { title?: string; prompt?: string; placeHolder?: string }) => {
    for (const w of promptText(options)) { out.text.toasts.push({ where: 'showInputBox', text: w }); }
    return undefined;
  }) as never);
  const exec = vi.spyOn(vscode.commands, 'executeCommand');
  const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
  const trees: Array<{ id: string; provider: TreeLike }> = [];
  vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: { treeDataProvider: TreeLike }) => {
    trees.push({ id, provider: options.treeDataProvider });
    return { dispose() {}, reveal: async () => undefined, onDidChangeVisibility: () => ({ dispose() {} }), onDidExpandElement: () => ({ dispose() {} }), onDidCollapseElement: () => ({ dispose() {} }), onDidChangeSelection: () => ({ dispose() {} }), visible: true, title: '', description: '', message: '', badge: undefined };
  }) as never);
  vi.useFakeTimers();
  try {
    if (c.fixture || c.plain) {
      if (c.fixture) { fs.cpSync(path.join(FIXTURES, c.fixture), ws, { recursive: true }); } else { fs.mkdirSync(ws, { recursive: true }); }
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
    } else {
      vscode.workspace.workspaceFolders = [];
    }
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);

    // The context keys activate() set; the last value of each wins.
    const ctx: WhenContext = { workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0 };
    for (const call of exec.mock.calls) {
      if (call[0] === 'setContext') { ctx[String(call[1])] = call[2]; }
    }
    expect(Boolean(ctx['erdStudio.hasDbtProject']), `${c.name}: erdStudio.hasDbtProject`).toBe(c.dbt);
    contributesShown(ctx, out);

    const viewWhen = new Map(Object.values(pkg.contributes.views as Record<string, Array<{ id: string; when?: string }>>).flat().map((v) => [v.id, v.when]));
    for (const { id, provider } of trees) {
      if (!evalWhen(viewWhen.get(id), { ...ctx, 'erdStudio.diagramsLoading': false, 'erdStudio.tablesLoading': false })) { continue; }
      await treeText(id, provider, out);
    }

    const welcome = await openGettingStarted();
    await importGuideText(out);

    if (c.fixture && c.diagram) {
      const editorCall = registerEditor.mock.calls.find((call) => call[0] === SUBJECT_AREA_EDITOR_VIEW_TYPE);
      const provider = editorCall![1] as unknown as SemanticEditorProvider;
      await canvasText(provider, path.join(ws, c.diagram), c, out);
      // With the Welcome panel open, so its setup result is read too.
      await harnessText(ws, out);
    } else if (c.plain) {
      // No diagram to draw yet: Set Up My AI Helper (with the Welcome panel open) is what this folder offers.
      await harnessText(ws, out);
    }
    await gettingStartedText(welcome, out);
  } finally {
    cleanup();
    for (const sub of [...context.subscriptions].reverse()) {
      try { await sub.dispose(); } catch { /* best effort */ }
    }
    for (const panel of [...vscode.window._webviewPanels]) { panel.dispose(); }
    vscode._resetMockWebviewPanels();
    vi.useRealTimers();
  }
  try {
    // The plain folder runs the CLI before any .erd-studio/ exists: what an assistant sees on its first doctor.
    if (c.plain) { fs.rmSync(path.join(ws, '.erd-studio'), { recursive: true, force: true }); }
    if (c.fixture || c.plain) { await cliText(ws, out); }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

const initialStoreState = useEditorStore.getState();

beforeAll(() => {
  // React Flow measures its container; jsdom has no ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('the matcher', () => {
  it('matches dbt as a word, never DBML, dbdiagram or an id', () => {
    for (const yes of ['Draw from dbt…', 'Run dbt parse', 'dbt_project.yml', 'New to dbt? How to install it', 'DBT']) {
      expect(DBT_WORD.test(yes), yes).toBe(true);
    }
    for (const no of ['Import DBML…', 'Export to DBML', 'From dbdiagram.io or any DBML tool', 'erdStudio.drawFromDbt', 'erdStudio.hasDbtProject', 'dbtSemantic.projectPath']) {
      expect(DBT_WORD.test(no), no).toBe(false);
    }
  });

  it('evaluates the when clauses package.json uses', () => {
    const ctx = { 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': false, 'erdStudio.storage': 'dbml', workspaceFolderCount: 1 };
    expect(evalWhen('erdStudio.hasProject && !erdStudio.hasDbtProject', ctx)).toBe(true);
    expect(evalWhen('erdStudio.hasDbtProject || workspaceFolderCount == 0', ctx)).toBe(false);
    expect(evalWhen('erdStudio.storage =~ /^(dbml|mixed)$/', ctx)).toBe(true);
    expect(evalWhen('erdStudio.storage != dbml', ctx)).toBe(false);
    expect(evalWhen('view == erdStudio.domainTree && erdStudio.hasDbtProject', ctx, WILDCARDS)).toBe(false);
    expect(evalWhen('view == erdStudio.domainTree && erdStudio.hasProject', ctx, WILDCARDS)).toBe(true);
    expect(evalWhen('false', ctx)).toBe(false);
    expect(evalWhen(undefined, ctx)).toBe(true);
    // Every clause in package.json parses.
    const clauses: string[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n && typeof n === 'object') {
        for (const [k, v] of Object.entries(n)) { if ((k === 'when' || k === 'enablement') && typeof v === 'string') { clauses.push(v); } else { walk(v); } }
      }
    };
    const { configuration: _settings, ...rest } = pkg.contributes;
    walk(rest);
    expect(clauses.length).toBeGreaterThan(40);
    for (const clause of clauses) { expect(() => evalWhen(clause, {}, WILDCARDS), clause).not.toThrow(); }
  });
});

describe.each([LOGICAL_YAML, LOGICAL_DBML, PLAIN_FOLDER, EMPTY_WINDOW])('$name: no dbt control and no dbt word', (c) => {
  let got: Collected;
  beforeAll(async () => { got = await collect(c); }, 120_000);

  it('reaches no dbt-only control on any surface', () => {
    expect(Object.fromEntries(got.controls)).toEqual({});
  });

  it.each(SURFACES)('%s shows no dbt word', (surface) => {
    expect(dbtHits(got.text[surface])).toEqual([]);
  });

  it('read every surface it has (the sweep is not empty)', () => {
    expect(got.text['package.json'].length).toBeGreaterThan(20);
    expect(got.text.gettingStarted.length).toBeGreaterThan(10);
    expect(got.text.importGuide.length).toBeGreaterThan(20);
    expect(got.text['package.json'].some((s) => s.where.startsWith('walkthrough step'))).toBe(true);
    if (c.fixture) {
      expect(got.text.trees.length).toBeGreaterThan(3);
      expect(got.text.canvas.length).toBeGreaterThan(20);
      expect(got.text.harness.length).toBeGreaterThan(50);
      expect(got.text.cli.length).toBeGreaterThan(2);
      // The walkthrough without dbt has its own tour, and Set Up My AI Helper wrote no dbt-only file.
      expect(got.text['package.json'].some((s) => s.where === 'walkthrough step watchLogical title')).toBe(true);
      expect(got.harnessFiles.filter((f) => /SYNC\.md$|dbt-setup\.md$|dbt-explained\.md$|without-dbt\.md$/.test(f))).toEqual([]);
      expect(got.harnessFiles).toContain('.claude/skills/erd-studio-setup/SKILL.md');
      // Each canvas state really rendered.
      const canvas = (state: string) => got.text.canvas.filter((s) => s.where.startsWith(`canvas ${state}`)).map((s) => s.text).join('\n');
      expect(canvas('legend open')).toContain('Legend');
      expect(canvas('detail panel')).toContain('Schema');
      expect(canvas('add existing table')).toContain('Add Existing Tables');
      expect(canvas('new relationship')).toContain('Which way does this relationship point?');
      expect(canvas('empty diagram')).toContain('This diagram is empty');
      expect(canvas('node context menu')).toContain('Remove from Diagram');
      expect(canvas('edge context menu').length).toBeGreaterThan(0);
      expect(canvas('annotation context menu').length).toBeGreaterThan(0);
      expect(canvas('new table dialog')).toMatch(/New Table/i);
      expect(canvas('feedback dialog')).toMatch(/Feedback/i);
      expect(got.text.canvas.some((s) => s.where.startsWith('canvas menu'))).toBe(true);
      // The Welcome panel read Set Up My AI Helper's result too.
      expect(got.text.gettingStarted.some((s) => s.where === 'panel after setupResult')).toBe(true);
    }
    if (c.plain) {
      expect(got.text.harness.length).toBeGreaterThan(50);
      expect(got.harnessFiles.filter((f) => /SYNC\.md$|dbt-setup\.md$|dbt-explained\.md$|without-dbt\.md$/.test(f))).toEqual([]);
      // doctor and inventory both answered, with no .erd-studio/ folder yet.
      expect(got.text.cli.some((s) => s.where === 'erd-studio doctor' && s.text.includes('No .erd-studio/ folder found'))).toBe(true);
      expect(got.text.cli.some((s) => s.where === 'erd-studio inventory' && s.text.includes('No .erd-studio/ folder found'))).toBe(true);
    }
  });

  if (c.fixture) {
    it('keeps the Physical stage unreachable: the host answers a physical switch with the logical stage', () => {
      expect(got.physicalSwitch).toEqual({ stage: 'logical', logicalOnly: true });
    });

    it('shows the Warehouse name row only on a table that already has an alias', () => {
      expect(got.aliasRows.length).toBeGreaterThan(0);
      for (const r of got.aliasRows) { expect(r.row, r.table).toBe(r.hasAlias); }
    });
  }
});

describe('dbt-project: every dbt control and the key dbt texts are still there', () => {
  let got: Collected;
  beforeAll(async () => { got = await collect(DBT_PROJECT); }, 120_000);

  it.each(DBT_CONTROLS)('reaches %s', (control) => {
    expect(got.controls.get(control) ?? [], control).not.toEqual([]);
  });

  const all = (surface: Surface) => got.text[surface].map((s) => s.text).join('\n');

  it('package.json: the dbt walkthrough steps, welcome views and commands', () => {
    const shown = got.text['package.json'];
    // The fixture is a project from before 2.0: its start step is Convert, with Draw from dbt under it.
    for (const step of ['watch', 'convertDbt']) {
      expect(shown.some((s) => s.where === `walkthrough step ${step} title`), step).toBe(true);
    }
    // Draw from dbt is one of its "More ways to start…" (the quick pick: moreStartsFor).
    expect(shown.some((s) => s.where === 'walkthrough step convertDbt description' && s.text.includes('[More ways to start…]'))).toBe(true);
    expect(moreStartsFor({ hasProject: true, hasDbt: true, storage: 'yaml' })).toContain('drawFromDbt');
    expect(shown.some((s) => s.where.startsWith('walkthrough step watchLogical'))).toBe(false);
    expect(all('package.json')).toContain('then compare it with what dbt has');
    expect(all('package.json')).toContain('ERD Studio: Draw from dbt…');
    expect(all('package.json')).toContain('ERD Studio: Regenerate dbt selectors.yml');
    expect(shown.some((s) => s.where.startsWith('viewsWelcome') && DBT_WORD.test(s.text))).toBe(true);
  });

  it('Getting Started: the dbt page and the dbt tour', () => {
    const text = all('gettingStarted').replace(/\s+/g, ' ');
    for (const line of [
      'Turn the dbt project you already have into a data model you can see.',
      'Your assistant checks your dbt setup',
      'New to dbt? How to install it',
    ]) {
      expect(text, line).toContain(line);
    }
    expect(got.text.gettingStarted.some((s) => s.where === 'panel video' && /getting-started\.mp4/.test(s.text))).toBe(true);
    expect(got.text.gettingStarted.some((s) => s.where === 'panel captions' && DBT_WORD.test(s.text))).toBe(true);
    // Draft-first: the tab holds no start card; Draw from dbt is the dbt project's draft (the sidebar, the
    // popup's Show Me) and its own How-to clip, shown on the dbt page only (when the clips ship).
  });

  it('the import guide: the dbt card leads, with Draw from dbt', () => {
    expect(all('importGuide')).toContain('Draw from dbt copies your dbt models');
    expect(got.controls.get('Draw from dbt') ?? []).toContain('import guide');
  });

  it('the canvas: the dbt wording on the alias row and the New Relationship hint', () => {
    const text = all('canvas');
    expect(text).toMatch(/dbt has no test to tell/);
    expect(text).toMatch(/dbt alias|The table dbt builds/);
    expect(got.physicalSwitch).toEqual({ stage: 'physical', logicalOnly: false });
  });

  it('the AI helper files keep their dbt guides', () => {
    expect(got.harnessFiles).toContain('.claude/skills/erd-studio/SYNC.md');
    expect(got.harnessFiles.some((f) => /\.claude\/skills\/erd-studio-setup\/references\/dbt-setup\.md$/.test(f))).toBe(true);
    expect(dbtHits(got.text.harness).length).toBeGreaterThan(50);
  });

  it('the CLI names the dbt project', () => {
    expect(all('cli')).toMatch(DBT_WORD);
  });
});

afterAll(() => {
  useEditorStore.setState(initialStoreState, true);
});
