/**
 * The draft preview's host half (`src/providers/DraftPreviewPanel.ts`,
 * docs/dev/draft-first.md §2 and §12): the HTML shell and its CSP, the tab's
 * options, and the ask → answer lifecycle against the stateful vscode mock.
 * Also the build wiring the page needs (the sixth esbuild target, the
 * tsconfig and .vscodeignore lines) and the page's bundle itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import {
  DraftPreviewPanel,
  buildDraftPreviewHtml,
  createDraftPreview,
  draftPreviewCsp,
} from '../../src/providers/DraftPreviewPanel';
import { DRAFT_PREVIEW_VIEW_TYPE, toDraftView, type Draft, type DraftAnswer, type DraftTrigger, type DraftView } from '../../src/types/draft';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test/fixtures/draft');

function fixture(name: string): DraftView {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as DraftView;
}

function draftOf(name: string, trigger: DraftTrigger = 'start', patch: Partial<Draft> = {}): Draft {
  return { ...fixture(name), keep: { writer: 'none' }, trigger, ...patch };
}

type MockPanel = ReturnType<typeof import('../__mocks__/vscode').createMockWebviewPanel> & {
  viewType: string;
  title: string;
  _column: unknown;
  webview: { options: Record<string, unknown> };
};

const panels = (): MockPanel[] => (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels;
const lastPanel = (): MockPanel => panels()[panels().length - 1];
const extensionUri = vscode.Uri.file('/ext');

/** Settle the microtasks a resolve or a post queues. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** An ask whose answer can be read once it has resolved. */
function track(promise: Promise<DraftAnswer>): { answer: () => DraftAnswer | undefined } {
  let answer: DraftAnswer | undefined;
  void promise.then((a) => { answer = a; });
  return { answer: () => answer };
}

beforeEach(() => {
  DraftPreviewPanel.close();
  _resetMockWebviewPanels();
});

afterEach(() => {
  DraftPreviewPanel.close();
});

// ---------------------------------------------------------------------------
// The HTML shell
// ---------------------------------------------------------------------------

describe('buildDraftPreviewHtml', () => {
  const html = buildDraftPreviewHtml({
    cspSource: 'https://csp.example',
    nonce: 'N0NCE',
    scriptUri: 'https://csp.example/dist/draft.js',
    styleUri: 'https://csp.example/dist/draft.css',
    title: 'Draft: <sales> & "co"',
  });

  it('has a nonce-only CSP with no unsafe-inline, and a blob: worker for ELK', () => {
    const csp = draftPreviewCsp('https://csp.example', 'N0NCE');
    expect(csp).toBe(
      "default-src 'none'; script-src 'nonce-N0NCE'; style-src https://csp.example 'nonce-N0NCE'; "
      + 'img-src https://csp.example data:; font-src https://csp.example; worker-src blob:',
    );
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('content="default-src &#39;none&#39;; script-src &#39;nonce-N0NCE&#39;;');
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('loads only the bundled script and stylesheet, both nonced, from cspSource', () => {
    expect(html).toContain('<script nonce="N0NCE" src="https://csp.example/dist/draft.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="https://csp.example/dist/draft.css" nonce="N0NCE">');
    const urls = html.match(/(?:src|href)="[^"]*"/g) ?? [];
    expect(urls).toEqual(['href="https://csp.example/dist/draft.css"', 'src="https://csp.example/dist/draft.js"']);
    // One script element, and it has a src (no inline script body).
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toMatch(/<script nonce="[^"]+" src="[^"]+"><\/script>/);
  });

  it('has no inline style, no <style> element and no on…= handler', () => {
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('escapes the title', () => {
    expect(html).toContain('<title>Draft: &lt;sales&gt; &amp; &quot;co&quot;</title>');
  });

  it('has an empty root for the page to draw into', () => {
    expect(html).toContain('<div id="root" class="draft-root"></div>');
  });
});

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

describe('DraftPreviewPanel: the tab', () => {
  it('opens one tab with the view type, the title, Active column, scripts, retained context and dist/ only', () => {
    const preview = createDraftPreview(extensionUri);
    void preview.ask(draftOf('small'));
    expect(panels()).toHaveLength(1);
    const panel = lastPanel();
    expect(panel.viewType).toBe(DRAFT_PREVIEW_VIEW_TYPE);
    expect(panel.viewType).toBe('erdStudio.draftPreview');
    expect(panel.title).toBe('Draft: sales');
    expect(panel._column).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
    expect(panel.webview.options).toMatchObject({ enableScripts: true, retainContextWhenHidden: true });
    const roots = panel.webview.options.localResourceRoots as Array<{ path: string }>;
    expect(roots.map((r) => r.path)).toEqual(['/ext/dist']);
    expect(panel.webview.html).toContain('/ext/dist/draft.js');
    expect(panel.webview.html).toContain('/ext/dist/draft.css');
    expect(panel.webview.html).toContain(`style-src ${'https://mock-csp-source'}`);
    expect(preview.isOpen()).toBe(true);
  });

  it('keeps the focus where it was for the automatic (sidebar) draft', () => {
    void createDraftPreview(extensionUri).ask(draftOf('small', 'sidebar'));
    expect(lastPanel()._column).toEqual({ viewColumn: vscode.ViewColumn.Active, preserveFocus: true });
  });

  it('posts the view (never keep or trigger) only after the page is ready', async () => {
    void createDraftPreview(extensionUri).ask(draftOf('small', 'start', { keep: { writer: 'drawFromDbt', scopeId: 's', fingerprint: 'f', target: { layer: 'main', layerLabel: 'Main', name: 'sales', diagramFile: '.erd-studio/main/diagrams/sales.dbml' } } }));
    const panel = lastPanel();
    await flush();
    expect(panel._postedMessages).toEqual([]);
    await panel._simulateMessage({ type: 'ready' });
    await flush();
    expect(panel._postedMessages).toEqual([{ type: 'draft', view: fixture('small') }]);
    const posted = panel._postedMessages[0] as { view: Record<string, unknown> };
    expect(posted.view).not.toHaveProperty('keep');
    expect(posted.view).not.toHaveProperty('trigger');
  });

  it('redraws the open tab for a second ask, superseding the first', async () => {
    const preview = createDraftPreview(extensionUri);
    const first = track(preview.ask(draftOf('small')));
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    const second = track(preview.ask(draftOf('dbt', 'sidebar')));
    await flush();
    expect(panels()).toHaveLength(1);
    expect(first.answer()).toEqual({ kind: 'superseded' });
    expect(second.answer()).toBeUndefined();
    expect(panel.title).toBe('Draft: finance');
    expect(panel._postedMessages.at(-1)).toEqual({ type: 'draft', view: fixture('dbt') });
    expect(panel._reveals).toEqual([undefined]);
  });

  it('resolves closed when the user closes the tab, and close() does the same', async () => {
    const preview = createDraftPreview(extensionUri);
    const a = track(preview.ask(draftOf('small')));
    lastPanel()._simulateDispose();
    await flush();
    expect(a.answer()).toEqual({ kind: 'closed' });
    expect(preview.isOpen()).toBe(false);
    expect(DraftPreviewPanel.currentPanel).toBeUndefined();

    const b = track(preview.ask(draftOf('small')));
    expect(panels()).toHaveLength(2);
    preview.close();
    await flush();
    expect(b.answer()).toEqual({ kind: 'closed' });
    expect(lastPanel()._disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

describe('DraftPreviewPanel: the answers', () => {
  async function opened(name = 'small', trigger: DraftTrigger = 'start') {
    const preview = createDraftPreview(extensionUri);
    const draft = draftOf(name, trigger);
    const asked = track(preview.ask(draft));
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    await flush();
    panel._postedMessages.length = 0;
    return { preview, asked, panel, draft };
  }

  it('keep: busy until settled; kept closes the tab', async () => {
    const { asked, panel } = await opened();
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const answer = asked.answer();
    expect(answer?.kind).toBe('keep');
    expect(panel._postedMessages).toEqual([{ type: 'busy', action: 'keep' }]);
    expect(panel._disposed).toBe(false);
    if (answer?.kind !== 'keep') throw new Error('unreachable');
    answer.settle({ kept: true });
    expect(panel._disposed).toBe(true);
    expect(DraftPreviewPanel.currentPanel).toBeUndefined();
  });

  it('keep: not kept brings the buttons back with the notice, once', async () => {
    const { asked, panel } = await opened();
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const answer = asked.answer();
    if (answer?.kind !== 'keep') throw new Error('expected keep');
    answer.settle({ kept: false, notice: 'Your files changed.' });
    answer.settle({ kept: true }); // a second settle is ignored
    await flush();
    expect(panel._postedMessages).toEqual([{ type: 'busy', action: 'keep' }, { type: 'idle', notice: 'Your files changed.' }]);
    expect(panel._disposed).toBe(false);
  });

  it('keep: a settle from before a newer ask does nothing', async () => {
    const { preview, asked, panel } = await opened();
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const answer = asked.answer();
    if (answer?.kind !== 'keep') throw new Error('expected keep');
    void preview.ask(draftOf('small', 'start', { id: 'redrawn' }));
    answer.settle({ kept: true });
    await flush();
    expect(panel._disposed).toBe(false);
    expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'idle')).toEqual([]);
  });

  it('a choice made while nobody asks (after a Keep that did not save) answers the flow\'s next ask of the same Draft object, which redraws nothing', async () => {
    const { preview, asked, panel, draft } = await opened();
    expect(preview.showing?.()).toBe(draft.id);
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const answer = asked.answer();
    if (answer?.kind !== 'keep') throw new Error('expected keep');
    answer.settle({ kept: false, notice: 'Nothing was saved.' });
    await panel._simulateMessage({ type: 'discard' });
    expect(panel._disposed).toBe(false);
    // What every flow does after a Keep that did not save: ask the draft it showed again.
    const again = track(preview.ask(draft));
    await flush();
    expect(again.answer()).toEqual({ kind: 'discard' });
    expect(panel._disposed).toBe(true);
    // The page kept what it showed (its notice included): no second `draft` post.
    expect(panel._postedMessages).toEqual([{ type: 'busy', action: 'keep' }, { type: 'idle', notice: 'Nothing was saved.' }]);
    expect(preview.showing?.()).toBeUndefined();
  });

  it('after a Keep that did not save, a second Keep on the same draft is answered (the flow re-asks)', async () => {
    const { preview, asked, panel, draft } = await opened();
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const first = asked.answer();
    if (first?.kind !== 'keep') throw new Error('expected keep');
    first.settle({ kept: false });
    const again = track(preview.ask(draft));
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const second = again.answer();
    expect(second?.kind).toBe('keep');
    if (second?.kind !== 'keep') return;
    second.settle({ kept: true });
    expect(panel._disposed).toBe(true);
  });

  it('a choice queued for one draft does not answer another', async () => {
    const { preview, asked, panel } = await opened();
    await panel._simulateMessage({ type: 'keep' });
    await flush();
    const answer = asked.answer();
    if (answer?.kind !== 'keep') throw new Error('expected keep');
    answer.settle({ kept: false });
    await panel._simulateMessage({ type: 'discard' });
    const next = track(preview.ask(draftOf('small', 'start', { id: 'another' })));
    await flush();
    expect(next.answer()).toBeUndefined();
  });

  it('scope: busy until the next ask, which redraws', async () => {
    const { preview, asked, panel } = await opened('dbt');
    await panel._simulateMessage({ type: 'scope', scopeId: 'folder:marts/core' });
    await flush();
    expect(asked.answer()).toEqual({ kind: 'scope', scopeId: 'folder:marts/core' });
    expect(panel._postedMessages).toEqual([{ type: 'busy', action: 'scope' }]);
    expect(panel._disposed).toBe(false);
    const next = fixture('dbt');
    void preview.ask({ ...next, id: 'core', scopes: { ...next.scopes!, current: 'folder:marts/core' }, keep: { writer: 'none' }, trigger: 'start' });
    await flush();
    expect((panel._postedMessages.at(-1) as { type: string; view: DraftView }).view.id).toBe('core');
  });

  it.each([
    [{ type: 'changeOptions' }, { kind: 'changeOptions' }],
    [{ type: 'discard' }, { kind: 'discard' }],
    [{ type: 'otherStart', start: 'import' }, { kind: 'otherStart', start: 'import' }],
  ])('%j disposes the tab, then resolves', async (message, expected) => {
    let disposedWhenResolved: boolean | undefined;
    const p = createDraftPreview(extensionUri).ask(draftOf('small'));
    const tab = lastPanel();
    const answered = p.then((a) => { disposedWhenResolved = tab._disposed; return a; });
    await tab._simulateMessage({ type: 'ready' });
    await tab._simulateMessage(message);
    expect(await answered).toEqual(expected);
    expect(disposedWhenResolved).toBe(true);
    expect(DraftPreviewPanel.currentPanel).toBeUndefined();
  });

  it('reports detailsOpened and layoutFailed through the events, answering nothing', async () => {
    const events = { detailsOpened: vi.fn(), layoutFailed: vi.fn() };
    const preview = createDraftPreview(extensionUri, events);
    const asked = track(preview.ask(draftOf('dbt')));
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'detailsOpened' });
    await panel._simulateMessage({ type: 'layoutFailed' });
    await flush();
    expect(events.detailsOpened).toHaveBeenCalledWith('dbt');
    expect(events.layoutFailed).toHaveBeenCalledWith('dbt');
    expect(asked.answer()).toBeUndefined();
    expect(panel._disposed).toBe(false);
  });

  it('passes a failed layout\'s checked detail to the events, and refuses one with a field out of range', async () => {
    const events = { detailsOpened: vi.fn(), layoutFailed: vi.fn() };
    const preview = createDraftPreview(extensionUri, events);
    track(preview.ask(draftOf('dbt')));
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    const detail = {
      ms: 31000, failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout',
      log: { tables: 1134, relationships: 2417, message: 'Maximum call stack size exceeded' },
    };
    await panel._simulateMessage({ type: 'layoutFailed', ...detail, table: 'dim_customer' });
    await flush();
    expect(events.layoutFailed).toHaveBeenCalledWith('dbt', detail);
    events.layoutFailed.mockClear();
    await panel._simulateMessage({ type: 'layoutFailed', tableBucket: 1134 });
    await flush();
    expect(events.layoutFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['not an object', 'keep'],
    ['no type', {}],
    ['an unknown type', { type: 'runCommand', command: 'workbench.action.files.save' }],
    ['a start the draft does not offer', { type: 'otherStart', start: 'openFolder' }],
    ['a start that is not a start', { type: 'otherStart', start: 'erdStudio.createDomain' }],
    ['a scope on a draft with no switcher', { type: 'scope', scopeId: 'folder:marts/core' }],
  ])('drops %s', async (_label, message) => {
    const { asked, panel } = await opened('small');
    panel.webview.html = 'unchanged';
    await panel._simulateMessage(message);
    await flush();
    expect(asked.answer()).toBeUndefined();
    expect(panel._postedMessages).toEqual([]);
    expect(panel._disposed).toBe(false);
  });

  it('drops Keep where nothing can be kept, Change options… where it is not offered, and the current scope again', async () => {
    const { asked, panel } = await opened('example-no-folder');
    await panel._simulateMessage({ type: 'keep' });
    await panel._simulateMessage({ type: 'changeOptions' });
    await panel._simulateMessage({ type: 'scope', scopeId: 'example:coffee-shop' });
    await panel._simulateMessage({ type: 'scope', scopeId: 'exampleProject:nope' });
    await flush();
    expect(asked.answer()).toBeUndefined();
    expect(panel._postedMessages).toEqual([]);
    // What it does offer still answers.
    await panel._simulateMessage({ type: 'otherStart', start: 'openFolder' });
    await flush();
    expect(asked.answer()).toEqual({ kind: 'otherStart', start: 'openFolder' });
  });

  it('rebuilds the answer from checked fields only', async () => {
    const { asked, panel } = await opened('dbt');
    await panel._simulateMessage({ type: 'scope', scopeId: 'folder:staging', command: 'evil', extra: 1 });
    await flush();
    expect(asked.answer()).toEqual({ kind: 'scope', scopeId: 'folder:staging' });
  });
});

// ---------------------------------------------------------------------------
// Fixtures and build wiring
// ---------------------------------------------------------------------------

describe('draft fixtures', () => {
  it.each(['small', 'large', 'dbt', 'example-no-folder'])('%s is a DraftView toDraftView keeps whole', (name) => {
    const view = fixture(name);
    expect(toDraftView({ ...view, keep: { writer: 'none' }, trigger: 'start' })).toEqual(view);
    // The primary and every shown start are offered (otherwise the host drops their message).
    const offered = new Set(view.otherStarts.map((s) => s.id));
    if (view.banner.primary !== 'keep') expect(offered.has(view.banner.primary)).toBe(true);
    for (const id of view.banner.shownStarts) expect(offered.has(id)).toBe(true);
  });
});

describe('build wiring for the draft page', () => {
  const esbuildSource = fs.readFileSync(path.join(ROOT, 'esbuild.js'), 'utf8');

  it('esbuild.js has a draft target (webview-draft/index.tsx → dist/draft.js) in both the build and watch branches', () => {
    expect(esbuildSource).toMatch(/entryPoints:\s*\['\.\/webview-draft\/index\.tsx'\]/);
    expect(esbuildSource).toMatch(/outfile:\s*'\.\/dist\/draft\.js'/);
    const draftBlock = esbuildSource.slice(esbuildSource.indexOf('const draftConfig'));
    expect(draftBlock).toMatch(/__ELK_WORKER_CODE__/);
    expect(draftBlock).toMatch(/\.\.\.webviewConfig/); // browser IIFE, React JSX, CSS loader
    const watch = esbuildSource.slice(esbuildSource.indexOf('if (isWatch)'), esbuildSource.indexOf('} else {'));
    const once = esbuildSource.slice(esbuildSource.indexOf('} else {'));
    expect(watch).toContain('esbuild.context(draftConfig)');
    expect(once).toContain('esbuild.build(draftConfig)');
  });

  it('the webview tsconfig compiles the page and .vscodeignore keeps its source out of the VSIX', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.webview.json'), 'utf8')) as { include: string[] };
    expect(tsconfig.include).toContain('webview-draft/**/*');
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(ignore).toContain('webview-draft/**');
  });

  it('the page source sets no inline style, injects no HTML and calls acquireVsCodeApi in one place', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, 'webview-draft'));
    expect(files.length).toBeGreaterThan(5);
    const acquirers: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bstyle=\{/);
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/);
      if (/acquireVsCodeApi/.test(text)) acquirers.push(path.relative(ROOT, file));
    }
    expect(acquirers).toEqual([path.join('webview-draft', 'lib', 'draftHost.ts')]);
  });

  it('bundles as esbuild.js builds it (browser IIFE, CSS beside it) with no DBML parser and no <style> injection', async () => {
    const result = await build({
      entryPoints: [path.join(ROOT, 'webview-draft/index.tsx')],
      bundle: true,
      write: false,
      outdir: path.join(ROOT, 'dist', '.draft-bundle-test'),
      format: 'iife',
      platform: 'browser',
      target: ['es2020', 'chrome114'],
      jsx: 'automatic',
      loader: { '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"', __ELK_WORKER_CODE__: '""' },
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((i) => i.includes('webview-draft/index.tsx'))).toBe(true);
    expect(inputs.filter((i) => /@dbml|dbml-parse/.test(i))).toEqual([]);
    const names = result.outputFiles!.map((f) => path.basename(f.path)).sort();
    expect(names).toEqual(['index.css', 'index.js']);
    const js = result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text;
    // Nothing the viewer runs creates a <style> element (the CSP has no
    // 'unsafe-inline'). The one in the bundle is the column-reorder drag's
    // cursor sheet, an editing affordance ErdCanvas (viewer) never offers.
    const makers: string[] = [];
    const re = /createElement\(\s*["']style["']\s*\)/g;
    for (let m = re.exec(js); m; m = re.exec(js)) {
      const before = js.slice(0, m.index);
      const marker = before.match(/\/\/ (\S+\.tsx?)\n(?![\s\S]*\/\/ \S+\.tsx?\n)/);
      makers.push(marker?.[1] ?? '?');
    }
    expect(makers).toEqual(['packages/renderer/src/hooks/useColumnReorder.ts']);
  }, 120_000);
});
