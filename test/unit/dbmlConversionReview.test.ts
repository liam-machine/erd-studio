/**
 * The Convert to DBML panel (native DBML storage §6.2, after pre-release
 * 1.9.0 feedback): the plan as sections, refusal locations, the panel's
 * message validation, its HTML (nonce-only CSP, theme colours only, every
 * path listed) and the host's handling of each message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { ConvertToDbmlPanel } from '../../src/providers/ConvertToDbmlPanel';
import { DBML_SELF_CHECK_REFUSAL_END, type DbmlConversionPlan } from '../../src/services/dbmlConversion';
import {
  CONVERT_PANEL_TITLE,
  CONVERT_PANEL_VIEW_TYPE,
  buildConvertPanelCsp,
  buildConvertPanelHtml,
  buildConvertReview,
  isConvertPanelToHost,
  locateDbmlRefusal,
  MIGRATE_TO_V5_COMMAND_TITLE,
  UNSAVED_TAG,
} from '../../src/services/dbmlConversionReview';

function plan(overrides: Partial<DbmlConversionPlan> = {}): DbmlConversionPlan {
  return {
    creates: [], replaces: [], deletes: [], resumed: [], refusals: [], handled: [], leftAsIs: [], keptMissing: [], notes: [], v4SubjectAreas: [],
    movedRelationships: [], placedDiagrams: [],
    summary: { tables: 0, diagrams: 0, relationshipsFiles: 0, relationships: 0 },
    ...overrides,
  };
}

const display = (rel: string): string => `.erd-studio/${rel}`;
const LIAM = 'logical-models/gold/gld_fct_controlpro_project_monthly.yml does not parse as YAML (line 293): Map keys must be unique at line 293, column 5:. Fix it, then convert.';

describe('locateDbmlRefusal', () => {
  it('finds the file and line a refusal names', () => {
    expect(locateDbmlRefusal(LIAM)).toEqual({ path: 'logical-models/gold/gld_fct_controlpro_project_monthly.yml', line: 293 });
    expect(locateDbmlRefusal('tables/gold/x.dbml is not readable DBML (Unexpected token, line 7), and gold/a.json needs it. Fix it, then convert.'))
      .toEqual({ path: 'tables/gold/x.dbml', line: 7 });
    expect(locateDbmlRefusal('Convert would write DBML that does not compile: tables/x.dbml:12 bad [3001]. Nothing was changed.'))
      .toEqual({ path: 'tables/x.dbml', line: 12 });
    expect(locateDbmlRefusal('gold/sales.json is not valid JSON (Unexpected token). Fix it, then convert.')).toEqual({ path: 'gold/sales.json' });
  });

  it('opens only a file that exists, never one outside the project, and nothing when no file is named', () => {
    const refusal = 'One table has 2 files: logical-models/a.yml, tables/a.dbml. Keep one of them, then convert.';
    expect(locateDbmlRefusal(refusal, (p) => p === 'tables/a.dbml')).toEqual({ path: 'tables/a.dbml' });
    expect(locateDbmlRefusal('Convert would write tables/new.dbml so that it no longer loads.', () => false)).toBeUndefined();
    expect(locateDbmlRefusal('../outside/secret.yml does not parse as YAML (line 1)')).toBeUndefined();
    expect(locateDbmlRefusal('This project has a layer called "tables". Rename that layer, then convert.')).toBeUndefined();
  });
});

describe('buildConvertReview', () => {
  const review = plan({
    creates: [
      { path: 'tables/gold/_relationships.dbml', text: '' },
      { path: 'tables/gold/dim_b.dbml', text: '' },
      { path: 'tables/gold/dim_a.dbml', text: '' },
      { path: 'gold/sales.dbml', text: '' },
      { path: 'gold/sales.dbdiagram', text: '' },
      { path: 'gold/aaa.dbdiagram', text: '' },
      { path: 'gold/aaa.dbml', text: '' },
    ],
    replaces: [{ path: 'tables/silver/_relationships.dbml', text: '' }],
    deletes: ['logical-models/gold/dim_a.yml', 'logical-models/gold/dim_b.yml', 'gold/sales.json', 'gold/aaa.json'],
    notes: ['logical-models/gold/dim_a.yml: keys ERD Studio does not read (columns[].isSourceCode) are kept as // lines above the Table in tables/gold/dim_a.dbml.'],
    movedRelationships: [{ from: 'fct.a_id', to: 'dim_a.id', diagrams: ['gold/aaa.json'] }, { from: 'x.y', to: 'z.w', diagrams: [] }],
    summary: { tables: 2, diagrams: 2, relationshipsFiles: 2, relationships: 3 },
  });

  it('groups the plan into sections, every path project-relative, each diagram beside its layout file', () => {
    const { view, locations } = buildConvertReview(review, { display, introLines: ['intro'] });
    expect(view.mode).toBe('review');
    expect(locations).toEqual([]);
    const section = (id: string) => view.sections.find((x) => x.id === id)!;
    expect(view.sections.map((x) => x.id)).toEqual(['tables', 'relationships', 'diagrams', 'removed', 'moved', 'notes']);
    expect(section('tables').items).toEqual([
      { path: '.erd-studio/tables/gold/dim_a.dbml', tag: 'new' },
      { path: '.erd-studio/tables/gold/dim_b.dbml', tag: 'new' },
    ]);
    expect(section('relationships').items).toEqual([
      { path: '.erd-studio/tables/gold/_relationships.dbml', tag: 'new' },
      { path: '.erd-studio/tables/silver/_relationships.dbml', tag: 'updated' },
    ]);
    expect(section('diagrams').items.map((i) => i.path)).toEqual([
      '.erd-studio/gold/aaa.dbdiagram', '.erd-studio/gold/aaa.dbml', '.erd-studio/gold/sales.dbdiagram', '.erd-studio/gold/sales.dbml',
    ]);
    expect(section('diagrams').items[0].tag).toBe('new layout');
    expect(section('removed').items).toHaveLength(4);
    // Each diagram as the .dbml it becomes, project-relative, in the path style.
    expect(section('moved').items).toEqual([
      { text: 'fct.a_id → dim_a.id also shows in', paths: ['.erd-studio/gold/aaa.dbml'] },
      { text: '1 other relationship shows in the same diagrams as before.' },
    ]);
    expect(buildConvertPanelHtml(view, 'n')).toContain('<span class="cdb-item__paths"><code class="cdb-item__path">.erd-studio/gold/aaa.dbml</code></span>');
    expect(section('notes').items[0].text).toContain('are kept as // lines');
    expect(view.counts).toEqual([
      { label: 'tables', value: 2 }, { label: 'diagrams', value: 2 }, { label: 'relationships', value: 3 },
      { label: 'files created', value: 7 }, { label: 'file updated', value: 1 }, { label: 'files removed', value: 4 },
    ]);
  });

  it('refusals: a Problems list whose items name file and line and open by index; notes stay below; no Convert', () => {
    const refused = plan({
      refusals: [LIAM, 'This project has a layer called "tables". Rename that layer, then convert.'],
      notes: ['logical-models/gold/gld_dim_contact.yml: keys ERD Studio does not read (columns[].isSourceCode) are kept as // lines above the Table in tables/gold/gld_dim_contact.dbml.'],
      v4SubjectAreas: ['gold/old.json'],
    });
    const { view, locations } = buildConvertReview(refused, { display, introLines: [], nothingChanged: 'Nothing was changed.' });
    expect(view.mode).toBe('refused');
    expect(view.sections.map((x) => x.id)).toEqual(['problems', 'notes']);
    expect(view.sections[0].items).toEqual([
      { path: '.erd-studio/logical-models/gold/gld_fct_controlpro_project_monthly.yml', line: 293, text: LIAM, open: 0 },
      { text: 'This project has a layer called "tables". Rename that layer, then convert.' },
      expect.objectContaining({ path: '.erd-studio/gold/old.json', open: 1 }),
    ]);
    expect(locations).toEqual([{ path: 'logical-models/gold/gld_fct_controlpro_project_monthly.yml', line: 293 }, { path: 'gold/old.json' }]);
    const html = buildConvertPanelHtml(view, 'n0nce');
    expect(html).toContain('<code class="cdb-item__path">.erd-studio/logical-models/gold/gld_fct_controlpro_project_monthly.yml:293</code>');
    expect(html).toContain('data-action="open" data-index="0"');
    expect(html).not.toContain('data-action="convert"');
    expect(html).toContain('>Close</button>');
    expect(html).toContain('>Check Again</button>');
    expect(html).toContain('are kept as // lines');
    expect(html).not.toContain('data-action="sendFeedback"');
    expect(view.intro[0]).toBe('Fix these and save, then choose Check Again. Nothing was changed.');
    expect(view.reportable).toBeUndefined();
  });

  it('a problem whose file has unsaved edits says Check Again reads what is saved', () => {
    const { view } = buildConvertReview(plan({ refusals: [LIAM], v4SubjectAreas: ['gold/old.json'] }), {
      display, introLines: [], unsaved: (rel) => rel === 'logical-models/gold/gld_fct_controlpro_project_monthly.yml',
    });
    expect(view.sections[0].items[0].tag).toBe(UNSAVED_TAG);
    expect(view.sections[0].items[1].tag).toBeUndefined();
    expect(buildConvertPanelHtml(view, 'n')).toContain(`<span class="cdb-item__tag">${UNSAVED_TAG}</span>`);
  });

  it('a v4 diagram names the migration command, and says when that command already ran', () => {
    const v4 = plan({ v4SubjectAreas: ['gold/old.json'] });
    const before = buildConvertReview(v4, { display, introLines: [] }).view.sections[0].items[0].text;
    expect(before).toBe(`This diagram is in schema v4. Run ${MIGRATE_TO_V5_COMMAND_TITLE}, then choose Check Again.`);
    const after = buildConvertReview(v4, { display, introLines: [], v4StepRan: true }).view.sections[0].items[0].text;
    expect(after).toBe(`This diagram is still in schema v4 after ${MIGRATE_TO_V5_COMMAND_TITLE}. Open it and check its tables, then choose Check Again.`);
    expect(after).not.toContain('Convert does it for you');
  });

  it('a self-check refusal is ERD Studio\'s problem: no "fix these", and Send Feedback beside Check Again', () => {
    const selfCheck = `Convert would change what gold/sales.json draws (models[0].name). ${DBML_SELF_CHECK_REFUSAL_END}`;
    const { view } = buildConvertReview(plan({ refusals: [selfCheck] }), { display, introLines: [], exists: () => true });
    expect(view.reportable).toBe(true);
    expect(view.heading).toBe("Can't convert this project safely");
    expect(view.intro[0]).toMatch(/^ERD Studio checks the DBML it would write before writing anything, and that check failed\. This is a problem in ERD Studio, not in your files\. Nothing was changed\./);
    expect(view.intro[0]).not.toMatch(/Fix th/);
    const html = buildConvertPanelHtml(view, 'n');
    expect(html).toContain('data-action="sendFeedback">Send Feedback</button>');
    expect(html).toContain('data-action="checkAgain"');
  });
});

describe('isConvertPanelToHost', () => {
  it('accepts the four messages, and an Open only by a whole index into the host list', () => {
    for (const type of ['convert', 'cancel', 'checkAgain', 'sendFeedback']) expect(isConvertPanelToHost({ type }, 0)).toBe(true);
    expect(isConvertPanelToHost({ type: 'open', index: 0 }, 1)).toBe(true);
  });

  it.each([
    null, undefined, 'convert', 42, [], ['convert'], {}, { type: 'apply' }, { type: 'openFile', path: '/etc/passwd' },
    { type: 'open' }, { type: 'open', index: '0' }, { type: 'open', index: -1 }, { type: 'open', index: 0.5 },
    { type: 'open', index: 1 }, { type: 'open', index: Number.NaN }, { type: 'open', path: 'gold/a.json' },
  ])('rejects %j', (message) => {
    expect(isConvertPanelToHost(message, 1)).toBe(false);
  });
});

describe('buildConvertPanelHtml', () => {
  it('has a nonce-only CSP, no remote resources, theme colours only, and escapes every path', () => {
    const { view } = buildConvertReview(plan({
      creates: [{ path: 'tables/<b>&.dbml', text: '' }],
      summary: { tables: 1, diagrams: 0, relationshipsFiles: 0, relationships: 0 },
    }), { display, introLines: ['Commit your work first.'] });
    const html = buildConvertPanelHtml(view, 'abc123');
    expect(buildConvertPanelCsp('abc123')).toBe("default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123';");
    expect(html).toContain('content="default-src &#39;none&#39;; style-src &#39;nonce-abc123&#39;; script-src &#39;nonce-abc123&#39;;"');
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain('<script nonce="abc123">');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(html).toContain('.erd-studio/tables/&lt;b&gt;&amp;.dbml');
    expect(html).not.toContain('<b>&');
    // A scrollable list of collapsible sections, with the buttons outside it.
    expect(html).toMatch(/\.cdb__list \{[^}]*overflow-y: auto/);
    expect(html).toContain('<details class="cdb-section" data-section="tables" open>');
    expect(html.indexOf('class="cdb__actions"')).toBeGreaterThan(html.indexOf('</section>'));
    expect(html).toContain('data-action="cancel">Cancel</button><button type="button" class="cdb__button" data-action="convert">Convert</button>');
    expect(html).toContain(`<title>${CONVERT_PANEL_TITLE}</title>`);
  });
});

describe('ConvertToDbmlPanel', () => {
  let semanticRoot = '';
  const refusedContent = () => {
    const { view, locations } = buildConvertReview(plan({ refusals: [LIAM] }), { display, introLines: [] });
    return { view, locations, semanticRoot };
  };

  beforeEach(() => {
    semanticRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-panel-')), '.erd-studio');
    const file = path.join(semanticRoot, 'logical-models', 'gold', 'gld_fct_controlpro_project_monthly.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `k${i}: v`).join('\n'));
    vscode._resetMockWebviewPanels();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    ConvertToDbmlPanel.close();
    vi.restoreAllMocks();
    fs.rmSync(path.dirname(semanticRoot), { recursive: true, force: true });
  });

  it('opens one editor tab titled Convert to DBML with scripts and no local resources', async () => {
    void ConvertToDbmlPanel.show(refusedContent());
    const panel = vscode.window._webviewPanels[0];
    expect(panel.viewType).toBe(CONVERT_PANEL_VIEW_TYPE);
    expect(panel.title).toBe('Convert to DBML');
    expect(panel.webview.options).toMatchObject({ enableScripts: true, localResourceRoots: [] });
    expect(panel.webview.html).toMatch(/default-src &#39;none&#39;; style-src &#39;nonce-[A-Za-z0-9+/=]+&#39;; script-src &#39;nonce-[A-Za-z0-9+/=]+&#39;;"/);
  });

  it('logs and ignores unknown or invalid messages, and Open sends only the host list entry to the editor', async () => {
    const choice = ConvertToDbmlPanel.show(refusedContent());
    const panel = vscode.window._webviewPanels[0];
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    await panel._simulateMessage({ type: 'convert' }); // not offered on the refused page
    await panel._simulateMessage({ type: 'open', index: 3 });
    await panel._simulateMessage({ type: 'openFile', path: '/etc/passwd' });
    expect(show).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(ConvertToDbmlPanel.currentPanel?.waiting).toBe(true);
    await panel._simulateMessage({ type: 'open', index: 0 });
    expect(show).toHaveBeenCalledTimes(1);
    const doc = show.mock.calls[0][0] as unknown as { uri: vscode.Uri };
    expect(doc.uri.fsPath).toBe(path.join(semanticRoot, 'logical-models', 'gold', 'gld_fct_controlpro_project_monthly.yml'));
    expect(show.mock.calls[0][1]).toMatchObject({ viewColumn: vscode.ViewColumn.Beside });
    expect((show.mock.calls[0][1] as { selection: vscode.Range }).selection.start.line).toBe(292);
    await panel._simulateMessage({ type: 'checkAgain' });
    expect(await choice).toBe('checkAgain');
  });

  it('Send Feedback runs Report Bug with the host\'s prefill, only on a reportable refused page', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const feedback = { kind: 'bug' as const, title: 'Convert Project to DBML failed', description: 'x' };
    void ConvertToDbmlPanel.show({ ...refusedContent(), feedback });
    await vscode.window._webviewPanels[0]._simulateMessage({ type: 'sendFeedback' });
    expect(exec).not.toHaveBeenCalled(); // not a self-check page
    const selfCheck = buildConvertReview(plan({ refusals: [`Convert would write gold/a.dbml so that it no longer loads. ${DBML_SELF_CHECK_REFUSAL_END}`] }), { display, introLines: [] });
    void ConvertToDbmlPanel.show({ view: selfCheck.view, locations: selfCheck.locations, semanticRoot, feedback });
    await vscode.window._webviewPanels[0]._simulateMessage({ type: 'sendFeedback' });
    expect(exec).toHaveBeenCalledWith('erdStudio.reportBug', feedback);
    expect(ConvertToDbmlPanel.currentPanel?.waiting).toBe(true);
  });

  it('never opens a location outside the semantic dir', async () => {
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    void ConvertToDbmlPanel.show({ ...refusedContent(), locations: [{ path: '../../etc/passwd' }] });
    await vscode.window._webviewPanels[0]._simulateMessage({ type: 'open', index: 0 });
    expect(show).not.toHaveBeenCalled();
  });
});

describe('buildConvertReview: what Convert handles, leaves and keeps missing (D26/D27)', () => {
  const partial = plan({
    creates: [{ path: 'tables/dim.dbml', text: '' }, { path: 'gold/commercial.dbml', text: '' }],
    deletes: ['logical-models/dim.yml', 'gold/commercial.json'],
    handled: [{ path: 'gold/commercial.json', text: 'It lists Dim, which is the table dim; the DBML diagram names it dim.' }],
    leftAsIs: [{ path: 'logical-models/gold/gld_fct_x.yml', line: 293, problem: 'The key name is written twice with different values (line 293). Keep the one you mean.' }],
    keptMissing: [{ diagram: 'gold/commercial.dbml', tables: ['gld_fct_risk_child', 'gld_fct_risk_parent'] }],
    notes: ['a note'],
    summary: { tables: 1, diagrams: 1, relationshipsFiles: 0, relationships: 0 },
  });

  it('lists, in order: Handled for you, Left as YAML until fixed (each with Open), Kept as missing, then the files and notes; Convert stays', () => {
    const { view, locations } = buildConvertReview(partial, { display, introLines: ['intro'] });
    expect(view.mode).toBe('review');
    expect(view.summary).toBe('1 table and 1 diagram convert to DBML; 1 file stays as it is until fixed; 2 missing tables stay on its diagram.');
    expect(view.sections.map((x) => [x.id, x.title])).toEqual([
      ['handled', 'Handled for you'],
      ['left', 'Left as YAML until fixed'],
      ['missing', 'Kept as missing on the diagram'],
      ['tables', 'Tables'],
      ['diagrams', 'Diagrams and their .dbdiagram layout files'],
      ['removed', 'Files removed'],
      ['notes', 'Notes'],
    ]);
    const section = (id: string) => view.sections.find((x) => x.id === id)!;
    expect(section('handled').items).toEqual([{ path: '.erd-studio/gold/commercial.json', text: 'It lists Dim, which is the table dim; the DBML diagram names it dim.' }]);
    expect(section('left').items).toEqual([
      { path: '.erd-studio/logical-models/gold/gld_fct_x.yml', line: 293, text: 'The key name is written twice with different values (line 293). Keep the one you mean.', open: 0 },
      { text: 'This file stays exactly as it is, and the diagrams draw it as before. Fix it and run Convert again to finish the job.' },
    ]);
    expect(locations).toEqual([{ path: 'logical-models/gold/gld_fct_x.yml', line: 293 }]);
    expect(section('missing').items).toEqual([
      { path: '.erd-studio/gold/commercial.dbml', text: 'gld_fct_risk_child, gld_fct_risk_parent' },
      { text: 'These tables have no table file. They stay on their diagrams, drawn as missing exactly as before. Create them later with Add from dbt.' },
    ]);
    const html = buildConvertPanelHtml(view, 'n');
    expect(html).toContain('data-action="convert"');
    expect(html).toContain('data-action="open" data-index="0"');
    expect(html).toContain('<p class="cdb__summary">1 table and 1 diagram convert to DBML;');
    expect(isConvertPanelToHost({ type: 'open', index: 0 }, locations.length)).toBe(true);
  });

  it('nothing else can convert until the files are fixed: Check Again, no Convert', () => {
    const waiting = plan({ leftAsIs: partial.leftAsIs, keptMissing: [] });
    const { view, locations } = buildConvertReview(waiting, { display, introLines: [], nothingChanged: 'Nothing was changed.' });
    expect(view.mode).toBe('refused');
    expect(view.heading).toBe('Nothing else to convert yet');
    expect(view.sections.map((x) => x.id)).toEqual(['left']);
    expect(locations).toEqual([{ path: 'logical-models/gold/gld_fct_x.yml', line: 293 }]);
    const html = buildConvertPanelHtml(view, 'n');
    expect(html).not.toContain('data-action="convert"');
    expect(html).toContain('>Check Again</button>');
  });

  it('a true refusal still shows the refusal view, with the files left listed after the problems (their Open after the problems\')', () => {
    const refused = plan({ refusals: ['This project has a layer called "tables". Rename that layer, then convert.'], leftAsIs: partial.leftAsIs });
    const { view, locations } = buildConvertReview(refused, { display, introLines: [] });
    expect(view.mode).toBe('refused');
    expect(view.sections.map((x) => x.id)).toEqual(['problems', 'left']);
    expect(view.sections[1].items[0].open).toBe(0);
    expect(locations).toEqual([{ path: 'logical-models/gold/gld_fct_x.yml', line: 293 }]);
  });
});
