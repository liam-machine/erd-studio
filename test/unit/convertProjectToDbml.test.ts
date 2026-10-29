/**
 * ERD Studio: Convert Project to DBML (native DBML storage §6.2, §6.4, §9.6)
 * on the real services and the stateful vscode mock: the v4 chain, the
 * refusals in the Convert to DBML panel (Open, Check Again), unsaved files, a project that changes under the dialog, the
 * teammate and git-history lines, one applyFileWrites edit, the reconcile
 * after VS Code applies only part of it, the folder clean-up, the reopened
 * canvas tabs, the telemetry of every outcome, and the canvas offer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  CONVERT_ALREADY_RUNNING_MESSAGE,
  CONVERT_CANCELLED_MESSAGE,
  CONVERT_GIT_LINE,
  CONVERT_OPTIONAL_LINE,
  CONVERT_PROGRESS,
  CONVERTED_TEAMMATES_SENTENCE,
  CONVERT_RESUME_LINE,
  CONVERT_TEAMMATES_LINE,
  CONVERT_UNDO_LINE,
  CONVERT_WHAT_LINE,
  convertedUndoSentence,
  convertProjectToDbml,
  planProjectDbmlConversion,
  type ConvertProjectDeps,
} from '../../src/commands/convertProjectToDbml';
import { ConvertToDbmlPanel } from '../../src/providers/ConvertToDbmlPanel';
import {
  DBML_CONVERSION_DECLINED_KEY,
  DBML_CONVERSION_OFFER_CONVERT,
  DBML_CONVERSION_OFFER_DECLINE,
  DBML_CONVERSION_OFFER_TITLE,
  SemanticEditorProvider,
} from '../../src/providers/SemanticEditorProvider';
import { MIGRATE_TO_V5_COMMAND_TITLE, UNSAVED_TAG, type ConvertReviewView } from '../../src/services/dbmlConversionReview';
import { SubjectAreaService } from '../../src/services/domainService';
import { countDbmlConversionCandidates, dbmlConversionFingerprint } from '../../src/services/dbmlConversionFiles';
import * as dbmlConversion from '../../src/services/dbmlConversion';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';
import { clearLogBuffer, recentLogLines } from '../../src/services/logger';

const CORE_FIXTURES = path.resolve(__dirname, '../../packages/core/test/fixtures');
const TWIN = path.join(CORE_FIXTURES, 'dbml', 'composite-and-self', '.erd-studio');

let root: string;
let erd: string;
let feature: ReturnType<typeof vi.spyOn>;
let telemetryError: ReturnType<typeof vi.spyOn>;

/** Every file under the semantic dir, relative path → text. */
function snapshot(dir = erd): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(dir);
  return out;
}

function deps(overrides: Partial<ConvertProjectDeps> = {}): ConvertProjectDeps & { onConverted: ReturnType<typeof vi.fn> } {
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  return {
    workspaceRoot: root, semanticDir: '.erd-studio', tableLibraryService,
    onConverted: vi.fn(async () => {}), ...overrides,
  } as ConvertProjectDeps & { onConverted: ReturnType<typeof vi.fn> };
}

/**
 * Answer the Convert to DBML panel each time a run shows it: the real panel
 * opens (on the mock webview), then `respond` acts as the user would.
 * Returns the views shown and the panels they were shown in.
 */
function answerPanel(respond: (panel: vscode.MockWebviewPanel, view: ConvertReviewView) => unknown) {
  const real = ConvertToDbmlPanel.show.bind(ConvertToDbmlPanel);
  const shown: Array<{ view: ConvertReviewView; panel: vscode.MockWebviewPanel; html: string }> = [];
  vi.spyOn(ConvertToDbmlPanel, 'show').mockImplementation((content) => {
    const choice = real(content);
    const panel = vscode.window._webviewPanels.at(-1)!;
    shown.push({ view: content.view, panel, html: panel.webview.html });
    setTimeout(() => { void respond(panel, content.view); }, 0);
    return choice;
  });
  return shown;
}

/** Click Convert in the panel; answer any information message with `other`. */
function answerConvert(other: string | undefined = undefined) {
  answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
  return vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async () => other as never);
}

function useFixture(name: string): void {
  fs.cpSync(path.join(CORE_FIXTURES, name, '.erd-studio'), erd, { recursive: true });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-'));
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vscode._resetMockWebviewPanels();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  feature = vi.spyOn(telemetry, 'feature');
  telemetryError = vi.spyOn(telemetry, 'error');
  (vscode.window.tabGroups as { all: unknown[] }).all = [];
});

afterEach(() => {
  ConvertToDbmlPanel.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('convertProjectToDbml', () => {
  it('asks once, in the panel, with the teammate, git-history and undo lines, then writes the plan in one edit, and a second run has nothing to do', async () => {
    useFixture('composite-and-self');
    const d = deps();
    const plan = await planProjectDbmlConversion(d);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const apply = vi.spyOn(vscode.workspace, 'applyEdit');
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));

    expect(await convertProjectToDbml(d)).toBe('converted');

    // The panel, not a modal: one editor tab titled Convert to DBML, closed when Convert finishes.
    expect(info.mock.calls.some((c) => typeof c[1] === 'object' && (c[1] as { modal?: boolean })?.modal)).toBe(false);
    expect(shown).toHaveLength(1);
    const { view, panel, html } = shown[0];
    expect(panel.title).toBe('Convert to DBML');
    expect(panel._disposed).toBe(true);
    expect(view.mode).toBe('review');
    expect(view.heading).toBe('Convert this project to DBML?');
    expect(view.intro).toEqual([CONVERT_OPTIONAL_LINE, CONVERT_WHAT_LINE, CONVERT_TEAMMATES_LINE, CONVERT_GIT_LINE, CONVERT_UNDO_LINE]);
    expect(html).toContain('Converting is optional: if you cancel, your project keeps working exactly as it is.');
    expect(html).toContain('everyone who opens this project needs ERD Studio 1.9 pre-release or 2.0 and later');
    expect(html).not.toContain('2.0 or later');
    expect(html).not.toContain('An earlier conversion stopped part way');
    // Every path of the plan is listed, project-relative.
    for (const p of [...plan.creates.map((c) => c.path), ...plan.replaces.map((r) => r.path), ...plan.deletes]) {
      expect(html).toContain(`<code class="cdb-item__path">.erd-studio/${p}</code>`);
    }
    // One WorkspaceEdit: one undo step, applied once.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(vscode._appliedEdits).toHaveLength(1);
    // The project is now exactly its DBML twin, and logical-models/ is gone.
    expect(snapshot()).toEqual(snapshot(TWIN));
    expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
    expect(d.onConverted).toHaveBeenCalledTimes(1);
    expect(feature).toHaveBeenCalledWith('convertToDbml');
    expect(info.mock.calls.at(-1)![0]).toBe(
      'Converted to DBML: 3 tables, 1 diagram. Edit > Undo, straight away, with this diagram in front, puts every file back. ' +
        "Teammates and other VS Code windows on an older ERD Studio (1.7.x) can't open the converted project until they update.",
    );
    expect(CONVERTED_TEAMMATES_SENTENCE).toContain('1.7.x');

    info.mockClear();
    expect(await convertProjectToDbml(deps())).toBe('nothing');
    expect(info).toHaveBeenCalledWith('This project is already stored as DBML.');
    expect(vscode._appliedEdits).toHaveLength(1);
  });

  it('refuses in the panel, listing the refusals with no Convert button, writes nothing, and counts it', async () => {
    useFixture('library-relationships');
    // A layer called tables: the one refusal a user can fix (D26/D27 leave everything else as it is).
    fs.mkdirSync(path.join(erd, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'old.json'), JSON.stringify({ schemaVersion: 5, domain: 'old', layer: 'tables', logical: { models: [], relationships: [] } }));
    const before = snapshot();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'cancel' }));
    expect(await convertProjectToDbml(deps())).toBe('refused');
    expect(warn).not.toHaveBeenCalled();
    const { view, html, panel } = shown[0];
    expect(view.mode).toBe('refused');
    expect(view.heading).toBe("Can't convert yet");
    expect(view.sections[0].items[0].text).toMatch(/^This project has a layer called "tables"/);
    expect(html).not.toContain('data-action="convert"');
    expect(html).toContain('data-action="checkAgain"');
    expect(panel._disposed).toBe(true);
    expect(feature).toHaveBeenCalledWith('convertToDbmlRefused');
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('a file left as it is: Open opens it at its line from the host\'s own list; Check Again after the fix plans again (D26/D27)', async () => {
    useFixture('composite-and-self');
    const broken = path.join(erd, 'logical-models', 'gold', 'employee.yml');
    const good = fs.readFileSync(broken, 'utf-8');
    fs.writeFileSync(broken, `${good}name: twice\n`);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    let step = 0;
    const shown = answerPanel(async (panel) => {
      step += 1;
      if (step === 1) {
        await panel._simulateMessage({ type: 'open', index: 0 });
        // A path from the webview is never accepted, nor an index past the list.
        await panel._simulateMessage({ type: 'open', path: '/etc/passwd' });
        await panel._simulateMessage({ type: 'open', index: 1 });
        fs.writeFileSync(broken, good);
        await panel._simulateMessage({ type: 'checkAgain' });
      } else {
        await panel._simulateMessage({ type: 'cancel' });
      }
    });
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(shown.map((x) => x.view.mode)).toEqual(['review', 'review']);
    expect(shown.map((x) => x.view.sections.some((sec) => sec.id === 'left'))).toEqual([true, false]);
    expect(shown[0].html).toContain('data-action="checkAgain"');
    expect(shown[0].html).toContain('data-action="convert"');
    // Check Again reused the one panel.
    expect(vscode.window._webviewPanels).toHaveLength(1);
    const item = shown[0].view.sections.find((sec) => sec.id === 'left')!.items[0];
    expect(item).toMatchObject({ path: '.erd-studio/logical-models/gold/employee.yml', open: 0 });
    expect(item.line).toBeGreaterThan(1);
    expect(show).toHaveBeenCalledTimes(1);
    const shownDoc = show.mock.calls[0][0] as unknown as { uri: vscode.Uri };
    expect(shownDoc.uri.fsPath).toBe(broken);
    expect((show.mock.calls[0][1] as { selection: vscode.Range }).selection.start.line).toBe(item.line! - 1);
    expect(feature).toHaveBeenCalledWith('convertToDbmlCancelled');
    expect(vscode._appliedEdits).toHaveLength(0);
  });

  it('chains the v4 → v5 step first, then plans again', async () => {
    useFixture('composite-and-self');
    const v4 = path.join(erd, 'gold', 'old.json');
    fs.writeFileSync(v4, JSON.stringify({ schemaVersion: 4, domain: 'old', layer: 'gold', logical: { models: [{ name: 'inline', columns: [] }], relationships: [] } }));
    // Stands in for the v4 step: the file is no longer v4 afterwards.
    const migrateToV5 = vi.fn(async (): Promise<boolean> => { fs.rmSync(v4); return true; });
    answerConvert();
    expect(await convertProjectToDbml(deps({ migrateToV5 }))).toBe('converted');
    expect(migrateToV5).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(snapshot(TWIN));

    // Declining the v4 step stops, as a cancel.
    fs.writeFileSync(path.join(erd, 'gold', 'old2.json'), JSON.stringify({ schemaVersion: 4, domain: 'old2', layer: 'gold', logical: { models: [{ name: 'inline', columns: [] }], relationships: [] } }));
    fs.writeFileSync(path.join(erd, 'tables', 'gold', 'extra.yml'), 'name: extra\ncolumns:\n  - name: id\n    dataType: INT\n');
    const before = snapshot();
    expect(await convertProjectToDbml(deps({ migrateToV5: vi.fn(async () => false) }))).toBe('cancelled');
    expect(feature).toHaveBeenCalledWith('convertToDbmlCancelled');
    expect(snapshot()).toEqual(before);
  });

  it('refuses, by name, when a file it would change has unsaved edits', async () => {
    useFixture('composite-and-self');
    const before = snapshot();
    const yml = path.join(erd, 'logical-models', 'gold', 'employee.yml');
    const doc = vscode.createMockTextDocument(yml, fs.readFileSync(yml, 'utf-8'));
    doc._setText('name: employee\n');
    vscode.workspace.textDocuments = [doc as never];
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    expect(await convertProjectToDbml(deps())).toBe('refused');
    expect(error.mock.calls[0][0]).toBe(
      'Convert Project to DBML: .erd-studio/logical-models/gold/employee.yml has unsaved edits. Save or revert it, then convert. Nothing was changed.',
    );
    expect(error.mock.calls[0].slice(1)).toEqual(['Show File', 'Save and Try Again']);
    expect(shown).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('stops when the project changed while the panel was open', async () => {
    useFixture('composite-and-self');
    answerPanel((panel) => {
      fs.writeFileSync(path.join(erd, 'logical-models', 'gold', 'added.yml'), 'name: added\ncolumns:\n  - name: id\n    dataType: INT\n');
      return panel._simulateMessage({ type: 'convert' });
    });
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const before = snapshot();
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(warn.mock.calls[0][0]).toBe('Convert Project to DBML: the project changed while the preview was open. Nothing was changed. Run it again.');
    expect(vscode._appliedEdits).toHaveLength(0);
    before.set('logical-models/gold/added.yml', 'name: added\ncolumns:\n  - name: id\n    dataType: INT\n');
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['Cancel', (panel: vscode.MockWebviewPanel) => panel._simulateMessage({ type: 'cancel' })],
    ['closing the tab', (panel: vscode.MockWebviewPanel) => panel.dispose()],
  ])('%s writes nothing and is counted as cancelled', async (_label, respond) => {
    useFixture('composite-and-self');
    const before = snapshot();
    const shown = answerPanel(respond);
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(feature).toHaveBeenCalledWith('convertToDbmlCancelled');
    expect(shown[0].panel._disposed).toBe(true);
    expect(ConvertToDbmlPanel.currentPanel).toBeUndefined();
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('Convert clicked twice applies once; a second run while the panel is open reuses it', async () => {
    useFixture('composite-and-self');
    const apply = vi.spyOn(vscode.workspace, 'applyEdit');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    let runs = 0;
    const shown = answerPanel(async (panel) => {
      runs += 1;
      if (runs === 1) {
        // The command is run again from the palette while the panel waits: one panel, revealed.
        void convertProjectToDbml(deps());
        return;
      }
      await Promise.all([panel._simulateMessage({ type: 'convert' }), panel._simulateMessage({ type: 'convert' })]);
    });
    const first = convertProjectToDbml(deps());
    expect(await first).toBe('cancelled');
    await vi.waitFor(() => expect(feature).toHaveBeenCalledWith('convertToDbml'));
    expect(vscode.window._webviewPanels).toHaveLength(1);
    expect(shown).toHaveLength(2);
    expect(shown[1].panel._reveals).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
    // The superseded run is not counted as a cancel.
    expect(feature).not.toHaveBeenCalledWith('convertToDbmlCancelled');
  });

  it('a run started while another is converting only reveals the panel; the conversion applies once and stays', async () => {
    useFixture('composite-and-self');
    // Hold the first run's edit until the second run has started.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realApply = vscode.workspace.applyEdit.bind(vscode.workspace);
    const apply = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit: vscode.WorkspaceEdit) => {
      if (apply.mock.calls.length === 1) await gate;
      return realApply(edit);
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    let second: Promise<unknown> | undefined;
    const shown = answerPanel(async (panel) => {
      await panel._simulateMessage({ type: 'convert' });
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
      second = convertProjectToDbml(deps());
      expect(await second).toBe('cancelled');
      release();
    });
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(await second).toBe('cancelled');
    expect(shown).toHaveLength(1);
    expect(shown[0].panel._reveals).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(CONVERT_ALREADY_RUNNING_MESSAGE);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(snapshot(TWIN));
    // Once it has returned, the command runs normally again.
    expect(await convertProjectToDbml(deps())).toBe('nothing');
  });

  it('Check Again with the fix still unsaved: the problem says to save it first', async () => {
    useFixture('composite-and-self');
    const broken = path.join(erd, 'logical-models', 'gold', 'employee.yml');
    const good = fs.readFileSync(broken, 'utf-8');
    fs.writeFileSync(broken, `${good}name: twice\n`);
    let step = 0;
    const shown = answerPanel(async (panel) => {
      step += 1;
      if (step === 1) {
        const doc = vscode.createMockTextDocument(broken, `${good}name: twice\n`);
        doc._setText(good); // the user's fix, not saved
        vscode.workspace.textDocuments = [doc as never];
        await panel._simulateMessage({ type: 'checkAgain' });
      } else {
        await panel._simulateMessage({ type: 'cancel' });
      }
    });
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    const left = (view: ConvertReviewView) => view.sections.find((sec) => sec.id === 'left')!.items[0];
    expect(shown.map((x) => left(x.view).tag)).toEqual([undefined, UNSAVED_TAG]);
    expect(left(shown[0].view).text).toMatch(/^The key name is written twice with different values/);
  });

  it('a diagram still v4 after the v4 step: the page names the command that ran and does not claim every v4 diagram converted', async () => {
    useFixture('composite-and-self');
    fs.writeFileSync(path.join(erd, 'gold', 'old.json'), JSON.stringify({ schemaVersion: 4, domain: 'old', layer: 'gold', logical: { models: [{ name: 'inline', columns: [] }], relationships: [] } }));
    const migrateToV5 = vi.fn(async (): Promise<boolean> => true); // ran, but the file is still v4
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'cancel' }));
    expect(await convertProjectToDbml(deps({ migrateToV5 }))).toBe('refused');
    const { view } = shown[0];
    expect(view.sections[0].items[0].text).toBe(`This diagram is still in schema v4 after ${MIGRATE_TO_V5_COMMAND_TITLE}. Open it and check its tables, then choose Check Again.`);
    expect(view.intro[0]).toContain('Migrate Subject Areas to the Central Table Library ran, but nothing else was changed.');
    expect(view.intro[0]).not.toContain('The v4 subject areas were converted');
  });

  it('VS Code applying only part of the edit: applyFileWrites puts it all back, and the failure is counted', async () => {
    useFixture('composite-and-self');
    const before = snapshot();
    answerConvert();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    // Three creates land (a relationships file and two tables), then one fails; the reconcile runs normally.
    vscode._mockWorkspaceState.applyEditPrefixes.push(3, 'ok');
    expect(await convertProjectToDbml(deps())).toBe('failed');
    expect(vscode._appliedEdits).toHaveLength(2);
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(erd, 'tables'))).toBe(false);
    expect(error.mock.calls[0][0]).toMatch(/^Convert Project to DBML: VS Code didn't accept the conversion, so nothing was changed\./);
    expect(telemetryError).toHaveBeenCalledWith('convertToDbmlFailed');
    expect(feature).not.toHaveBeenCalledWith('convertToDbml');
  });

  it('a failure of its own is counted and never shows the raw exception', async () => {
    useFixture('composite-and-self');
    answerConvert();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const holdRefreshes = (): (() => void) => { throw new Error('hold failed at /secret/path'); };
    expect(await convertProjectToDbml(deps({ holdRefreshes }))).toBe('failed');
    expect(telemetryError).toHaveBeenCalledWith('convertToDbmlFailed');
    expect(String(error.mock.calls[0][0])).not.toContain('/secret/path');
    expect(error.mock.calls[0].slice(1)).toEqual(['Send Feedback', 'Try Again', 'Show Logs']);
  });

  it('a failure after the edit applied counts the conversion, not a failure', async () => {
    useFixture('composite-and-self');
    answerConvert();
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const onConverted = vi.fn(async () => { throw new Error('refresh failed at /secret/path'); });
    expect(await convertProjectToDbml(deps({ onConverted }))).toBe('converted');
    expect(feature).toHaveBeenCalledWith('convertToDbml');
    expect(feature.mock.calls.filter((c) => c[0] === 'convertToDbml')).toHaveLength(1);
    expect(telemetryError).not.toHaveBeenCalledWith('convertToDbmlFailed');
    expect(snapshot()).toEqual(snapshot(TWIN));
    expect(String(error.mock.calls[0][0])).not.toContain('/secret/path');
  });

  it('a mixed project: replaced files are saved, and an undo of one is saved too', async () => {
    fs.cpSync(path.resolve(__dirname, '../fixtures/dbml-convert/mixed/.erd-studio'), erd, { recursive: true });
    const plan = await planProjectDbmlConversion(deps());
    answerConvert();
    const relationships = path.join(erd, 'tables', 'gold', '_relationships.dbml');
    const original = fs.readFileSync(relationships, 'utf-8');
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(fs.readFileSync(relationships, 'utf-8')).toBe(plan.replaces.find((r) => r.path === 'tables/gold/_relationships.dbml')!.text);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(relationships)) as unknown as ReturnType<typeof vscode.createMockTextDocument>;
    doc._persist = true;
    doc._setText(original);
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    await new Promise((r) => setTimeout(r, 80));
    expect(fs.readFileSync(relationships, 'utf-8')).toBe(original);
  });

  it('closes the canvas tab of a converted diagram and reopens its .dbml in the canvas', async () => {
    useFixture('composite-and-self');
    const json = vscode.Uri.file(path.join(erd, 'gold', 'vault.json'));
    const tab = { input: new vscode.TabInputCustom(json, 'erdStudio.domainEditor') };
    (vscode.window.tabGroups as { all: unknown[] }).all = [{ tabs: [tab] }];
    const close = vi.fn(async () => true);
    (vscode.window.tabGroups as unknown as { close: typeof close }).close = close;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(close).toHaveBeenCalledWith(tab);
    const openWith = exec.mock.calls.find((c) => c[0] === 'vscode.openWith')!;
    expect((openWith[1] as vscode.Uri).fsPath).toBe(path.join(erd, 'gold', 'vault.dbml'));
    expect(openWith[2]).toBe('erdStudio.domainEditor');
  });

  it('with no canvas open, opens the converted diagram in the canvas, so Edit > Undo has an editor of the edit to undo from', async () => {
    useFixture('composite-and-self');
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    const opens = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect(opens).toHaveLength(1);
    expect((opens[0][1] as vscode.Uri).fsPath).toBe(path.join(erd, 'gold', 'vault.dbml'));
    expect(opens[0][2]).toBe('erdStudio.domainEditor');
    expect(info.mock.calls.at(-1)![0]).toContain('Edit > Undo, straight away, with this diagram in front, puts every file back.');
  });

  it('a project with no JSON diagram: opens its first new .dbml file as text instead, and the toast says "file"', async () => {
    useFixture('composite-and-self');
    fs.rmSync(path.join(erd, 'gold', 'vault.json'));
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(exec.mock.calls.filter((c) => c[0] === 'vscode.openWith')).toEqual([]);
    expect(show).toHaveBeenCalledTimes(1);
    expect((show.mock.calls[0][0] as vscode.Uri).fsPath).toMatch(/\.dbml$/);
    expect(fs.existsSync((show.mock.calls[0][0] as vscode.Uri).fsPath)).toBe(true);
    expect(info.mock.calls.at(-1)![0]).toContain('with this file in front');
  });

  /** Rewrite vault.json's positions: `undefined` drops viewConfig.positions, else keeps only the named tables. */
  function vaultPositions(keep: string[] | undefined): void {
    const file = path.join(erd, 'gold', 'vault.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (keep === undefined) doc.viewConfig = {};
    else doc.viewConfig.positions = Object.fromEntries(Object.entries(doc.viewConfig.positions).filter(([k]) => keep.includes(k)));
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  }

  it.each([
    ['no positions (the canvas would run its ELK auto layout and save it)', undefined],
    ['some positions (the canvas would place and save the rest)', ['pit_customer']],
  ])('a converted diagram with %s is opened as text, never in the canvas, so no layout write lands on top of the conversion', async (_label, keep) => {
    useFixture('composite-and-self');
    vaultPositions(keep);
    const plan = await planProjectDbmlConversion(deps());
    expect(plan.placedDiagrams).toEqual([]);
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue(undefined as never);
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(exec.mock.calls.filter((c) => c[0] === 'vscode.openWith')).toEqual([]);
    expect(show).toHaveBeenCalledTimes(1);
    expect((show.mock.calls[0][0] as vscode.Uri).fsPath).toBe(path.join(erd, 'gold', 'vault.dbml'));
    expect(info.mock.calls.at(-1)![0]).toContain('Edit > Undo, straight away, with this file in front, puts every file back.');
  });

  it('a fully placed converted diagram is in placedDiagrams (the one Convert may open in the canvas)', async () => {
    useFixture('composite-and-self');
    expect((await planProjectDbmlConversion(deps())).placedDiagrams).toEqual(['gold/vault.dbml']);
  });

  it('reopening a canvas whose diagram is not fully placed: the toast does not promise a one-step undo', async () => {
    useFixture('composite-and-self');
    vaultPositions(undefined);
    const json = vscode.Uri.file(path.join(erd, 'gold', 'vault.json'));
    const tab = { input: new vscode.TabInputCustom(json, 'erdStudio.domainEditor') };
    (vscode.window.tabGroups as { all: unknown[] }).all = [{ tabs: [tab] }];
    (vscode.window.tabGroups as unknown as { close: () => Promise<boolean> }).close = vi.fn(async () => true);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    const toast = info.mock.calls.at(-1)![0] as string;
    expect(toast).not.toContain('straight away');
    expect(toast).toContain(convertedUndoSentence('unplacedDiagram'));
  });

  it('when nothing could be opened, the toast still says undo needs a converted file in front', async () => {
    expect(convertedUndoSentence(undefined)).toBe('Edit > Undo, straight away, with a converted file open in front, puts every file back.');
    expect(CONVERT_UNDO_LINE).toContain('with the diagram or file Convert opens (or any converted file) in front');
  });

  it('reopens the .dbml even when VS Code closed the deleted diagram\'s tab itself', async () => {
    useFixture('composite-and-self');
    const json = vscode.Uri.file(path.join(erd, 'gold', 'vault.json'));
    (vscode.window.tabGroups as { all: unknown[] }).all = [{ tabs: [{ input: new vscode.TabInputCustom(json, 'erdStudio.domainEditor') }] }];
    const close = vi.fn(async () => true);
    (vscode.window.tabGroups as unknown as { close: typeof close }).close = close;
    const apply = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      const ok = await apply(edit);
      (vscode.window.tabGroups as { all: unknown[] }).all = [];
      return ok;
    });
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(close).not.toHaveBeenCalled();
    expect((exec.mock.calls.find((c) => c[0] === 'vscode.openWith')![1] as vscode.Uri).fsPath).toBe(path.join(erd, 'gold', 'vault.dbml'));
  });

  it('a half-applied earlier run: the panel says this finishes it, and the result is the twin', async () => {
    fs.cpSync(path.resolve(__dirname, '../fixtures/dbml-convert/half-converted/.erd-studio'), erd, { recursive: true });
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(shown[0].view.intro).toContain(CONVERT_RESUME_LINE);
    expect(shown[0].view.sections.map((x) => x.id)).toContain('resumed');
    expect(snapshot()).toEqual(snapshot(TWIN));
  });
});

describe('the ERD Studio log', () => {
  it('a conversion logs what it read, each planning and writing phase with its time, and the outcome', async () => {
    useFixture('composite-and-self');
    clearLogBuffer();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    expect(await convertProjectToDbml(deps())).toBe('converted');
    const lines = recentLogLines().map((l) => l.replace(/^\S+ \[\w+\] /, '')).filter((l) => l.startsWith('[Convert to DBML]'));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Convert to DBML\] Read \d+ files \(3 tables, 1 diagram\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Convert to DBML\] Plan: Reading the project… took \d+ ms$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Convert to DBML\] Plan: \d+ creates?, \d+ replaces?, \d+ deletes?, 0 refusals, 0 files left as is in \d+ ms$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Convert to DBML\] Applying \d+ file writes$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[Convert to DBML\] Apply: Writing \d+ files… took \d+ ms$/));
    expect(lines.at(-1)).toMatch(/^\[Convert to DBML\] Apply: converted in \d+ ms$/);
  });

  it('a refused conversion logs each problem', async () => {
    useFixture('library-relationships');
    fs.mkdirSync(path.join(erd, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'old.json'), JSON.stringify({ schemaVersion: 5, domain: 'old', layer: 'tables', logical: { models: [], relationships: [] } }));
    clearLogBuffer();
    answerPanel((panel) => panel._simulateMessage({ type: 'cancel' }));
    expect(await convertProjectToDbml(deps())).toBe('refused');
    const lines = recentLogLines();
    expect(lines.some((l) => /\[warn\] \[Convert to DBML\] Stopped before writing: 1 problem/.test(l))).toBe(true);
    expect(lines.some((l) => /\[warn\] \[Convert to DBML\] Problem: This project has a layer called "tables"/.test(l))).toBe(true);
  });
});

describe('the canvas offer (§6.4)', () => {
  const YAML_OFFER = 'Your project keeps working as YAML and JSON — converting is optional.';
  /** The offer's dialogs among the information messages. */
  const offers = (info: { mock: { calls: unknown[][] } }): unknown[][] => info.mock.calls.filter((c) => c[0] === DBML_CONVERSION_OFFER_TITLE);
  const NAMING_OFFER = 'ERD Studio now says "table" and "subject area"';

  function openWith(state: Map<string, unknown>) {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(root, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
    vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
    const context = {
      extensionUri: vscode.Uri.file(root),
      globalState: { get: () => true, update: async () => {} },
      workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
      secrets: vscode.createMockSecretStorage(),
    } as unknown as vscode.ExtensionContext;
    const provider = new SemanticEditorProvider(
      context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, root, selectorsService, tableLibraryService,
    );
    const run = vi.fn(async () => true);
    const namingRun = vi.fn(async () => true);
    const candidates = vi.fn(() => countDbmlConversionCandidates(root, '.erd-studio'));
    provider.setDbmlConversion(candidates, run);
    provider.setNamingMigration(
      () => ({ moves: [{ from: 'logical-models/x.yml', to: 'tables/x.yml', keys: [] }], rewrites: [], refusals: [], v4SubjectAreas: [], notes: [] }),
      () => 'v5',
      namingRun,
      '9.9.9',
    );
    const open = async (relative: string) => {
      const file = path.join(erd, relative);
      const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
      const panel = vscode.createMockWebviewPanel();
      await provider.resolveCustomTextEditor(doc as never, panel as never, {} as vscode.CancellationToken);
      await panel._simulateMessage({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 60));
      return panel;
    };
    return { open, run, namingRun, candidates };
  }

  it('is made once a session on a YAML project, before (and instead of) the naming offer, and writes nothing until asked', async () => {
    useFixture('composite-and-self');
    const before = snapshot();
    // Cancel (VS Code's own button), Escape or closing the dialog: undefined, which is Not Now.
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open, run, namingRun } = openWith(new Map());
    await open('gold/vault.json');
    expect(info.mock.calls).toHaveLength(1);
    expect(info.mock.calls[0][0]).toBe('Convert this project to DBML?');
    // A modal the user must answer, with the explanation as its detail and exactly two buttons of its own.
    const options = info.mock.calls[0][1] as { modal: boolean; detail: string };
    expect(options.modal).toBe(true);
    expect(options.detail.startsWith(YAML_OFFER)).toBe(true);
    expect(options.detail).toContain('Afterwards, everyone who opens it needs ERD Studio 1.9 pre-release or 2.0 and later.');
    expect(options.detail).not.toContain('2.0 or later');
    expect(info.mock.calls[0].slice(2)).toEqual(['Convert…', "Don't Ask Again"]);
    expect([DBML_CONVERSION_OFFER_CONVERT, DBML_CONVERSION_OFFER_DECLINE]).toEqual(['Convert…', "Don't Ask Again"]);
    expect(feature).toHaveBeenCalledWith('convertToDbmlOffered');
    expect(feature).toHaveBeenCalledWith('convertToDbmlNotNow');
    expect(run).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);

    // The next open: neither offer again (the naming offer is never made in a session the DBML offer was eligible).
    info.mockClear();
    await open('gold/vault.json');
    expect(offers(info)).toEqual([]);
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(NAMING_OFFER))).toEqual([]);
    expect(namingRun).not.toHaveBeenCalled();
  });

  it('Convert… runs the command; Don\'t Ask Again is remembered for the workspace', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Convert…' as never);
    const first = openWith(new Map());
    await first.open('gold/vault.json');
    expect(first.run).toHaveBeenCalledTimes(1);

    const state = new Map<string, unknown>();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue("Don't Ask Again" as never);
    await openWith(state).open('gold/vault.json');
    expect(state.get(DBML_CONVERSION_DECLINED_KEY)).toBe(true);
    expect(feature).toHaveBeenCalledWith('convertToDbmlDeclined');
    info.mockClear();
    await openWith(state).open('gold/vault.json');
    expect(offers(info)).toEqual([]);
  });

  it('uses the mixed wording in a mixed project', async () => {
    fs.cpSync(path.resolve(__dirname, '../fixtures/dbml-convert/mixed/.erd-studio'), erd, { recursive: true });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await openWith(new Map()).open('gold/sales.dbml');
    expect(offers(info).map((c) => (c[1] as { modal: boolean; detail: string }))).toContainEqual(expect.objectContaining({ modal: true, detail:
      'Your project keeps working as it is — converting is optional. It is stored as DBML, but 3 files are YAML or JSON ' +
        "(probably written by an AI helper set up with an older ERD Studio, or by a teammate on one). Convert them to DBML? (You'll see the full list first.)" }));
    expect(feature).toHaveBeenCalledWith('convertToDbmlNotNow');
  });

  it('is not made when the conversion would be refused, and the naming offer is then still made', async () => {
    useFixture('library-relationships');
    fs.mkdirSync(path.join(erd, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'old.json'), JSON.stringify({ schemaVersion: 5, domain: 'old', layer: 'tables', logical: { models: [], relationships: [] } }));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not Now' as never);
    await openWith(new Map()).open('gold/sales.json');
    const calls = info.mock.calls.map((c) => String(c[0]));
    expect(offers(info)).toEqual([]);
    expect(calls.filter((c) => c.startsWith(NAMING_OFFER))).toHaveLength(1);
    expect(feature).not.toHaveBeenCalledWith('convertToDbmlOffered');
  });
});

describe('progress, cancel and plan once (pre-release feedback)', () => {
  type Report = { cancellable: boolean; messages: string[] };

  /**
   * Record every progress notification (cancellable or not) and its messages.
   * `cancelAt`: the planning notification's token reports cancelled once this message was shown.
   */
  function recordProgress(cancelAt?: string): Report[] {
    const notes: Report[] = [];
    vi.spyOn(vscode.window, 'withProgress').mockImplementation((async (
      options: { cancellable?: boolean },
      task: (progress: { report: (v: { message?: string }) => void }, token: vscode.CancellationToken) => Promise<unknown>,
    ) => {
      const note: Report = { cancellable: options.cancellable === true, messages: [] };
      notes.push(note);
      const token = {
        get isCancellationRequested() { return cancelAt !== undefined && note.cancellable && note.messages.includes(cancelAt); },
        onCancellationRequested: () => ({ dispose: () => {} }),
      } as unknown as vscode.CancellationToken;
      return task({ report: (v) => { if (v.message) note.messages.push(v.message); } }, token);
    }) as never);
    return notes;
  }

  it('reads and plans in a cancellable notification, then writes in one that cannot be cancelled, naming each phase, also in the panel', async () => {
    useFixture('composite-and-self');
    const notes = recordProgress();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    const plan = await planProjectDbmlConversion(deps());
    expect(await convertProjectToDbml(deps())).toBe('converted');

    const writes = plan.creates.length + plan.replaces.length + plan.deletes.length;
    expect(notes.map((n) => n.cancellable)).toEqual([true, false]);
    expect(notes[0].messages).toEqual([CONVERT_PROGRESS.reading, CONVERT_PROGRESS.planning(3, 1), CONVERT_PROGRESS.checking]);
    expect(notes[1].messages).toEqual([CONVERT_PROGRESS.writing(writes), CONVERT_PROGRESS.reopening, CONVERT_PROGRESS.refreshing]);
    // Once Convert was chosen, the panel shows what it is doing until it closes.
    const posted = shown[0].panel._postedMessages as Array<{ type: string; text: string }>;
    expect(posted).toContainEqual({ type: 'progress', text: CONVERT_PROGRESS.writing(writes) });
    expect(shown[0].html).toContain('class="cdb__status" role="status" aria-live="polite"');
  });

  it('numbers in the messages read as people write them', () => {
    expect(CONVERT_PROGRESS.planning(1100, 21)).toBe('Planning 1,100 tables and 21 diagrams…');
    expect(CONVERT_PROGRESS.planning(1, 1)).toBe('Planning 1 table and 1 diagram…');
    expect(CONVERT_PROGRESS.writing(2266)).toBe('Writing 2,266 files…');
  });

  it.each([
    ['while reading', () => CONVERT_PROGRESS.reading],
    ['while planning', () => CONVERT_PROGRESS.planning(3, 1)],
    ['while checking the DBML', () => CONVERT_PROGRESS.checking],
  ])('Cancel %s writes nothing, shows no panel and says so', async (_label, at) => {
    useFixture('composite-and-self');
    recordProgress(at());
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const shown = answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    const before = snapshot();
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(shown).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(CONVERT_CANCELLED_MESSAGE);
    expect(feature).toHaveBeenCalledWith('convertToDbmlCancelled');
    expect(telemetryError).not.toHaveBeenCalled();
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('Cancel while it plans again after Convert (the project changed) writes nothing', async () => {
    useFixture('composite-and-self');
    const notes = recordProgress();
    let planningNotes = 0;
    // The second planning notification is cancelled straight away.
    vi.mocked(vscode.window.withProgress).mockImplementation((async (options: { cancellable?: boolean }, task: (p: unknown, t: unknown) => Promise<unknown>) => {
      const cancelled = options.cancellable === true && ++planningNotes === 2;
      notes.push({ cancellable: options.cancellable === true, messages: [] });
      return task({ report: () => {} }, { isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose: () => {} }) });
    }) as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => {
      const file = path.join(erd, 'logical-models', 'gold');
      for (const f of fs.readdirSync(file)) fs.utimesSync(path.join(file, f), new Date(), new Date(Date.now() + 5000));
      return panel._simulateMessage({ type: 'convert' });
    });
    const before = snapshot();
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(planningNotes).toBe(2);
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('plans once: Convert applies the plan the panel showed when no file changed meanwhile', async () => {
    useFixture('composite-and-self');
    const notes = recordProgress();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(notes.filter((n) => n.cancellable)).toHaveLength(1);
  });

  it('plans again when a file it reads changed meanwhile (only its time), and still converts when the plan is the same', async () => {
    useFixture('composite-and-self');
    const notes = recordProgress();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => {
      const dir = path.join(erd, 'logical-models', 'gold');
      const first = fs.readdirSync(dir)[0];
      fs.utimesSync(path.join(dir, first), new Date(), new Date(Date.now() + 5000));
      return panel._simulateMessage({ type: 'convert' });
    });
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(notes.filter((n) => n.cancellable)).toHaveLength(2);
    expect(snapshot()).toEqual(snapshot(TWIN));
  });

  it('holds the sidebar views and context keys while it writes, and refreshes each once after onConverted', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    const { RefreshGate } = await import('../../src/services/refreshGate');
    const gate = new RefreshGate();
    const treeRefresh = vi.fn();
    const contextKeys = vi.fn();
    const refreshTree = gate.gate('tree', treeRefresh);
    const refreshKeys = gate.gate('keys', contextKeys);
    // The watcher reports every written file while the edit applies.
    const realApply = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      for (let i = 0; i < 500; i++) { refreshTree(); refreshKeys(); }
      return realApply(edit);
    });
    let heldDuringOnConverted = false;
    const d = deps({
      holdViewRefreshes: () => gate.hold(),
      onConverted: vi.fn(async () => {
        heldDuringOnConverted = gate.held;
        refreshTree();
        refreshKeys();
        expect(treeRefresh).not.toHaveBeenCalled();
      }),
    });
    expect(await convertProjectToDbml(d)).toBe('converted');
    expect(heldDuringOnConverted).toBe(true);
    expect(gate.held).toBe(false);
    expect(treeRefresh).toHaveBeenCalledTimes(1);
    expect(contextKeys).toHaveBeenCalledTimes(1);
  });

  it('announces every file it writes to the own-write tracker while the edit and its saves run, and settles them after', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const plan = await planProjectDbmlConversion(deps());
    const written = [...plan.creates.map((c) => c.path), ...plan.deletes].map((p) => path.join(erd, p));
    expect(written.length).toBeGreaterThan(0);
    let pendingDuringApply: boolean[] = [];
    const realApply = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      // A watcher event handled now (the host busy mid-apply) waits instead of deciding.
      pendingDuringApply = written.map((p) => ownWrites.isPending(p));
      return realApply(edit);
    });
    expect(await convertProjectToDbml(deps())).toBe('converted');
    expect(pendingDuringApply.every(Boolean)).toBe(true);
    expect(written.some((p) => ownWrites.isPending(p))).toBe(false);
  });

  it('settles what it announced when VS Code refuses the edit', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const plan = await planProjectDbmlConversion(deps());
    const written = plan.creates.map((c) => path.join(erd, c.path));
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);
    expect(await convertProjectToDbml(deps())).toBe('failed');
    expect(written.some((p) => ownWrites.isPending(p))).toBe(false);
  });

  it('releases the view hold when VS Code refuses the edit', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    answerPanel((panel) => panel._simulateMessage({ type: 'convert' }));
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);
    const { RefreshGate } = await import('../../src/services/refreshGate');
    const gate = new RefreshGate();
    expect(await convertProjectToDbml(deps({ holdViewRefreshes: () => gate.hold() }))).toBe('failed');
    expect(gate.held).toBe(false);
  });
});

describe('the cheap offer check and the fingerprint', () => {
  it('counts the YAML tables and JSON diagrams from the listing, and none in a DBML project', () => {
    useFixture('composite-and-self');
    expect(countDbmlConversionCandidates(root, '.erd-studio')).toEqual({ files: 4, tablesDirIsLayer: false });
    fs.rmSync(erd, { recursive: true, force: true });
    fs.cpSync(TWIN, erd, { recursive: true });
    expect(countDbmlConversionCandidates(root, '.erd-studio')).toEqual({ files: 0, tablesDirIsLayer: false });
  });

  it('says when a layer is called tables', () => {
    useFixture('library-relationships');
    fs.mkdirSync(path.join(erd, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(erd, 'tables', 'old.json'), '{}');
    expect(countDbmlConversionCandidates(root, '.erd-studio').tablesDirIsLayer).toBe(true);
  });

  it('the fingerprint changes with any file Convert reads: added, removed, rewritten or touched', () => {
    useFixture('composite-and-self');
    const fp = (): string => dbmlConversionFingerprint(root, '.erd-studio');
    const first = fp();
    expect(fp()).toBe(first);
    const yml = path.join(erd, 'logical-models', 'gold', fs.readdirSync(path.join(erd, 'logical-models', 'gold'))[0]);
    fs.utimesSync(yml, new Date(), new Date(Date.now() + 10_000));
    const touched = fp();
    expect(touched).not.toBe(first);
    fs.appendFileSync(yml, '# more\n');
    const rewritten = fp();
    expect(rewritten).not.toBe(touched);
    fs.writeFileSync(path.join(erd, 'gold', 'new.json'), '{}');
    const added = fp();
    expect(added).not.toBe(rewritten);
    fs.rmSync(path.join(erd, 'gold', 'new.json'));
    expect(fp()).not.toBe(added);
    // A file Convert never reads (outside the semantic dir) changes nothing.
    const now = fp();
    fs.writeFileSync(path.join(root, 'README.md'), 'hello');
    expect(fp()).toBe(now);
  });
});

describe('the canvas offer: cheap, and switched off by a setting', () => {
  function openWith(state: Map<string, unknown>) {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(root, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
    vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
    const context = {
      extensionUri: vscode.Uri.file(root),
      globalState: { get: () => true, update: async () => {} },
      workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
      secrets: vscode.createMockSecretStorage(),
    } as unknown as vscode.ExtensionContext;
    const provider = new SemanticEditorProvider(
      context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, root, selectorsService, tableLibraryService,
    );
    const candidates = vi.fn(() => countDbmlConversionCandidates(root, '.erd-studio'));
    provider.setDbmlConversion(candidates, vi.fn(async () => true));
    const open = async (relative: string) => {
      const file = path.join(erd, relative);
      const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
      const panel = vscode.createMockWebviewPanel();
      await provider.resolveCustomTextEditor(doc as never, panel as never, {} as vscode.CancellationToken);
      await panel._simulateMessage({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 60));
      return panel;
    };
    return { open, candidates };
  }

  afterEach(() => vscode._resetMockConfiguration());

  it('decides from the file listing: it never plans or shows progress', async () => {
    useFixture('composite-and-self');
    const progress = vi.spyOn(vscode.window, 'withProgress');
    const plan = vi.spyOn(dbmlConversion, 'planDbmlConversion');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open, candidates } = openWith(new Map());
    await open('gold/vault.json');
    expect(info.mock.calls.filter((c) => c[0] === DBML_CONVERSION_OFFER_TITLE)).toHaveLength(1);
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
  });

  it.each([
    ['in the user settings', { globalValue: false }],
    ['in the workspace settings', { workspaceValue: false }],
  ])('erdStudio.dbml.offerConvert off %s: no offer, and nothing is listed', async (_label, values) => {
    useFixture('composite-and-self');
    vscode._setMockConfiguration('erdStudio', 'dbml.offerConvert', values);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const { open, candidates } = openWith(new Map());
    await open('gold/vault.json');
    expect(info.mock.calls.filter((c) => c[0] === DBML_CONVERSION_OFFER_TITLE)).toEqual([]);
    expect(candidates).not.toHaveBeenCalled();
    expect(feature).not.toHaveBeenCalledWith('convertToDbmlOffered');
  });

  it('the setting is contributed, on by default, with a plain description', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
      contributes: { configuration: { properties: Record<string, { type: string; default: unknown; markdownDescription: string }> } };
    };
    const setting = pkg.contributes.configuration.properties['erdStudio.dbml.offerConvert'];
    expect(setting).toMatchObject({ type: 'boolean', default: true });
    expect(setting.markdownDescription).toMatch(/keeps working as it is/);
  });
});
