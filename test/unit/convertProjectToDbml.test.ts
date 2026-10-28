/**
 * ERD Studio: Convert Project to DBML (native DBML storage §6.2, §6.4, §9.6)
 * on the real services and the stateful vscode mock: the v4 chain, the
 * refusal modal, unsaved files, a project that changes under the dialog, the
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
  CONVERT_GIT_LINE,
  CONVERT_RESUME_LINE,
  CONVERT_TEAMMATES_LINE,
  CONVERT_TO_DBML_BUTTON,
  CONVERT_UNDO_LINE,
  convertProjectToDbml,
  planProjectDbmlConversion,
  type ConvertProjectDeps,
} from '../../src/commands/convertProjectToDbml';
import { DBML_CONVERSION_DECLINED_KEY, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';

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

/** Answer the modal with Convert; any other information message with `other`. */
function answerConvert(other: string | undefined = undefined) {
  return vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (...args: unknown[]) =>
    (args.includes(CONVERT_TO_DBML_BUTTON) ? CONVERT_TO_DBML_BUTTON : other) as never);
}

function useFixture(name: string): void {
  fs.cpSync(path.join(CORE_FIXTURES, name, '.erd-studio'), erd, { recursive: true });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-convert-'));
  erd = path.join(root, '.erd-studio');
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  feature = vi.spyOn(telemetry, 'feature');
  telemetryError = vi.spyOn(telemetry, 'error');
  (vscode.window.tabGroups as { all: unknown[] }).all = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('convertProjectToDbml', () => {
  it('asks once, with the teammate, git-history and undo lines, then writes the plan in one edit, and a second run has nothing to do', async () => {
    useFixture('composite-and-self');
    const d = deps();
    const info = answerConvert();

    expect(await convertProjectToDbml(d)).toBe('converted');

    const dialog = info.mock.calls.find((c) => c.includes(CONVERT_TO_DBML_BUTTON))!;
    expect(dialog[0]).toBe('Convert this project to DBML?');
    const detail = (dialog[1] as { modal: boolean; detail: string }).detail;
    expect((dialog[1] as { modal: boolean }).modal).toBe(true);
    expect(detail).toContain(CONVERT_TEAMMATES_LINE);
    expect(detail).toContain('Everyone who opens this project needs ERD Studio 2.0 or later.');
    expect(detail).toContain(CONVERT_GIT_LINE);
    expect(detail).toContain(CONVERT_UNDO_LINE);
    expect(detail).not.toContain(CONVERT_RESUME_LINE);
    expect(detail).toContain('• create tables/gold/_relationships.dbml');
    // One WorkspaceEdit: one undo step.
    expect(vscode._appliedEdits).toHaveLength(1);
    // The project is now exactly its DBML twin, and logical-models/ is gone.
    expect(snapshot()).toEqual(snapshot(TWIN));
    expect(fs.existsSync(path.join(erd, 'logical-models'))).toBe(false);
    expect(d.onConverted).toHaveBeenCalledTimes(1);
    expect(feature).toHaveBeenCalledWith('convertToDbml');
    expect(info.mock.calls.at(-1)![0]).toMatch(/^Converted to DBML: 3 tables, 1 diagram\. Edit > Undo, straight away, puts every file back\.$/);

    info.mockClear();
    expect(await convertProjectToDbml(deps())).toBe('nothing');
    expect(info).toHaveBeenCalledWith('This project is already stored as DBML.');
    expect(vscode._appliedEdits).toHaveLength(1);
  });

  it('refuses with a modal listing the refusals, writes nothing, and counts it', async () => {
    useFixture('library-relationships');
    const before = snapshot();
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    expect(await convertProjectToDbml(deps())).toBe('refused');
    expect(warn.mock.calls[0][0]).toBe('Convert Project to DBML: Nothing was changed.');
    expect((warn.mock.calls[0][1] as { modal: boolean; detail: string })).toMatchObject({ modal: true });
    expect((warn.mock.calls[0][1] as { detail: string }).detail).toMatch(/^Can't convert yet:\n• gold\/sales\.json defines the relationship/);
    expect(feature).toHaveBeenCalledWith('convertToDbmlRefused');
    expect(vscode._appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
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
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('refused');
    expect(error.mock.calls[0][0]).toBe(
      'Convert Project to DBML: .erd-studio/logical-models/gold/employee.yml has unsaved edits. Save or revert it, then convert. Nothing was changed.',
    );
    expect(error.mock.calls[0].slice(1)).toEqual(['Show File', 'Save and Try Again']);
    expect(info.mock.calls.some((c) => c.includes(CONVERT_TO_DBML_BUTTON))).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('stops when the project changed while the modal was open', async () => {
    useFixture('composite-and-self');
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(async (...args: unknown[]) => {
      if (!args.includes(CONVERT_TO_DBML_BUTTON)) return undefined as never;
      fs.writeFileSync(path.join(erd, 'logical-models', 'gold', 'added.yml'), 'name: added\ncolumns:\n  - name: id\n    dataType: INT\n');
      return CONVERT_TO_DBML_BUTTON as never;
    });
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const before = snapshot();
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(warn.mock.calls[0][0]).toBe('Convert Project to DBML: the project changed while the dialog was open. Nothing was changed. Run it again.');
    expect(vscode._appliedEdits).toHaveLength(0);
    before.set('logical-models/gold/added.yml', 'name: added\ncolumns:\n  - name: id\n    dataType: INT\n');
    expect(snapshot()).toEqual(before);
  });

  it('Cancel writes nothing and is counted', async () => {
    useFixture('composite-and-self');
    const before = snapshot();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    expect(await convertProjectToDbml(deps())).toBe('cancelled');
    expect(feature).toHaveBeenCalledWith('convertToDbmlCancelled');
    expect(snapshot()).toEqual(before);
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
    expect(error.mock.calls[0].slice(1)).toEqual(['Send Feedback', 'Try Again']);
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

  it('a half-applied earlier run: the modal says this finishes it, and the result is the twin', async () => {
    fs.cpSync(path.resolve(__dirname, '../fixtures/dbml-convert/half-converted/.erd-studio'), erd, { recursive: true });
    const info = answerConvert();
    expect(await convertProjectToDbml(deps())).toBe('converted');
    const detail = (info.mock.calls.find((c) => c.includes(CONVERT_TO_DBML_BUTTON))![1] as { detail: string }).detail;
    expect(detail).toContain(CONVERT_RESUME_LINE);
    expect(snapshot()).toEqual(snapshot(TWIN));
  });
});

describe('the canvas offer (§6.4)', () => {
  const YAML_OFFER = 'This project is stored as YAML and JSON. ERD Studio 2.0 stores projects as DBML, an open format.';
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
    provider.setDbmlConversion(() => planProjectDbmlConversion({ workspaceRoot: root, semanticDir: '.erd-studio', tableLibraryService }), run);
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
    return { open, run, namingRun };
  }

  it('is made once a session on a YAML project, before (and instead of) the naming offer, and writes nothing until asked', async () => {
    useFixture('composite-and-self');
    const before = snapshot();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not Now' as never);
    const { open, run, namingRun } = openWith(new Map());
    await open('gold/vault.json');
    const calls = info.mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual([expect.stringMatching(new RegExp(`^${YAML_OFFER.replace(/[.()]/g, '\\$&')}`))]);
    expect(calls[0]).toContain('Everyone who opens it will need ERD Studio 2.0 or later afterwards.');
    expect(info.mock.calls[0].slice(1)).toEqual(['Convert…', 'Not Now', "Don't Ask Again"]);
    expect(feature).toHaveBeenCalledWith('convertToDbmlOffered');
    expect(feature).toHaveBeenCalledWith('convertToDbmlNotNow');
    expect(run).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);

    // The next open: neither offer again (the naming offer is never made in a session the DBML offer was eligible).
    info.mockClear();
    await open('gold/vault.json');
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(YAML_OFFER) || c.startsWith(NAMING_OFFER))).toEqual([]);
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
    expect(info.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith(YAML_OFFER))).toEqual([]);
  });

  it('uses the mixed wording in a mixed project', async () => {
    fs.cpSync(path.resolve(__dirname, '../fixtures/dbml-convert/mixed/.erd-studio'), erd, { recursive: true });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not Now' as never);
    await openWith(new Map()).open('gold/sales.dbml');
    expect(info.mock.calls.map((c) => String(c[0]))).toContain(
      'This project is stored as DBML, but 3 files are YAML or JSON (probably written by an AI helper set up before 2.0). ' +
        "Convert them to DBML? (You'll see the full list first.)",
    );
  });

  it('is not made when the conversion would be refused, and the naming offer is then still made', async () => {
    useFixture('library-relationships');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not Now' as never);
    await openWith(new Map()).open('gold/sales.json');
    const calls = info.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((c) => c.startsWith(YAML_OFFER))).toEqual([]);
    expect(calls.filter((c) => c.startsWith(NAMING_OFFER))).toHaveLength(1);
    expect(feature).not.toHaveBeenCalledWith('convertToDbmlOffered');
  });
});
