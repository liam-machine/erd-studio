/**
 * Export Diagram… (`erdStudio.exportDiagram`) — the command flow in
 * src/commands/exportDiagram.ts, driven through its injected UI with fakes:
 * which domain it exports (argument, focused canvas, picker), the format and
 * action QuickPicks, each action, every cancel, errors and telemetry. One
 * case runs the real `exportSubjectAreaFile` over the fixture project, so the
 * wiring reaches `@erd-studio/core`'s exporter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ACTION_ITEMS,
  CHOOSE_ANOTHER_LOCATION_BUTTON,
  OPEN_FILE_BUTTON,
  DBML_COPIED_MESSAGE,
  DBML_RICH_COPIED_MESSAGE,
  DBML_RICH_OPENED_MESSAGE,
  EXPORT_TITLE,
  FORMAT_FEATURES,
  FORMAT_ITEMS,
  FORMAT_LABELS,
  KEEP_LAYOUT_BUTTON,
  MERMAID_COPIED_MESSAGE,
  NO_DIAGRAMS_MESSAGE,
  REPLACE_LAYOUT_BUTTON,
  layoutUriFor,
  subjectAreaPathFromArg,
  exportDiagramCommand,
  type ExportAction,
  type ExportDiagramDeps,
  type ExportDiagramUi,
} from '../../src/commands/exportDiagram';
import { exportSubjectAreaFile, type SubjectAreaExport } from '../../src/services/diagramExport';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';
import { SubjectAreaFileError, SubjectAreaValidationError, type DiagramExportFormat } from '@erd-studio/core';
import type { FeedbackPrefill } from '../../src/services/commandErrors';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const SHOWCASE = path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'showcase.json');

type Pickable = vscode.QuickPickItem & { format?: DiagramExportFormat; action?: ExportAction };

interface FakeUi extends ExportDiagramUi {
  picks: Array<{ items: Pickable[]; options: vscode.QuickPickOptions }>;
  clipboard: string[];
  untitled: Array<{ content: string; language: string }>;
  saveDialogs: vscode.SaveDialogOptions[];
  written: Array<{ fsPath: string; content: string }>;
  opened: string[];
  infos: string[];
  errors: string[];
  /** The buttons each error message offered, in order. */
  errorButtons: string[][];
  openedAt: Array<{ filePath: string; line?: number; column?: number }>;
  feedback: FeedbackPrefill[];
  /** Every modal warning: its message, detail and buttons. */
  modals: Array<{ message: string; detail: string; items: string[] }>;
  /** Every path `fileExists` was asked about. */
  existsAsked: string[];
}

/**
 * A UI that answers the format and action QuickPicks with `format` / `action`
 * (undefined = Escape), the save dialog with `saveTo`, and the info message's
 * button with `infoChoice`.
 */
function fakeUi(answers: {
  format?: DiagramExportFormat;
  action?: ExportAction;
  saveTo?: string;
  languages?: string[] | Error;
  infoChoice?: string;
  /** The button picked on each error message, in turn (undefined = dismissed). */
  errorChoices?: Array<string | undefined>;
  /** Paths that already exist on disk. */
  existing?: string[];
  /** The button picked on the modal warning (undefined = Cancel). */
  modalChoice?: string;
}): FakeUi {
  const errorChoices = [...(answers.errorChoices ?? [])];
  const ui: FakeUi = {
    picks: [], clipboard: [], untitled: [], saveDialogs: [], written: [], opened: [], infos: [], errors: [],
    errorButtons: [], openedAt: [], feedback: [], modals: [], existsAsked: [],
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions) => {
      ui.picks.push({ items: [...items] as Pickable[], options });
      const list = items as readonly Pickable[];
      const hit = list.find((i) => (i.format !== undefined && i.format === answers.format)
        || (i.action !== undefined && i.action === answers.action));
      return hit as T | undefined;
    },
    writeClipboard: async (text) => { ui.clipboard.push(text); },
    getLanguages: async () => {
      if (answers.languages instanceof Error) throw answers.languages;
      return answers.languages ?? [];
    },
    openUntitled: async (content, language) => { ui.untitled.push({ content, language }); },
    showSaveDialog: async (options) => {
      ui.saveDialogs.push(options);
      return answers.saveTo ? vscode.Uri.file(answers.saveTo) as unknown as vscode.Uri : undefined;
    },
    fileExists: async (uri) => {
      ui.existsAsked.push(uri.fsPath);
      return (answers.existing ?? []).includes(uri.fsPath);
    },
    showModalWarning: async (message, detail, ...items) => {
      ui.modals.push({ message, detail, items });
      return answers.modalChoice;
    },
    writeFile: async (uri, content) => { ui.written.push({ fsPath: uri.fsPath, content }); },
    openFile: async (uri) => { ui.opened.push(uri.fsPath); },
    showInformationMessage: async (message) => { ui.infos.push(message); return answers.infoChoice; },
    openFileAt: async (filePath, line, column) => { ui.openedAt.push({ filePath, line, column }); },
    sendFeedback: async (prefill) => { ui.feedback.push(prefill); },
    showErrorMessage: async (message, ...items) => {
      ui.errors.push(message);
      ui.errorButtons.push(items);
      return errorChoices.shift();
    },
  };
  return ui;
}

/** The rich DBML text, its header naming `layoutFileName` (none for ''). */
const RICH = (layoutFileName: string) =>
  `// erd-studio dbml-export v2 (DBML 9.1+)\n${layoutFileName ? `// Table positions: ${layoutFileName}\n` : ''}`;
const LAYOUT_JSON = '{ "version": "3.0.0" }\n';

const EXPORTED = (format: DiagramExportFormat): SubjectAreaExport => {
  if (format === 'dbml-rich') {
    return {
      content: RICH('showcase.dbdiagram'),
      fileName: 'showcase.dbml',
      domainName: 'showcase',
      layer: 'silver',
      layout: { fileName: 'showcase.dbdiagram', content: LAYOUT_JSON, dbmlWithLayoutFileName: RICH },
    };
  }
  return {
    content: format === 'mermaid' ? 'erDiagram\n%% erd-studio mermaid-export v1\n' : '// erd-studio dbml-export v1\n',
    fileName: format === 'mermaid' ? 'showcase.mmd' : 'showcase.dbml',
    domainName: 'showcase',
    layer: 'silver',
  };
};

function deps(ui: ExportDiagramUi, overrides: Partial<ExportDiagramDeps> = {}) {
  const exportDomain = vi.fn(async (_p: string, format: DiagramExportFormat) => EXPORTED(format));
  const activeDomainPath = vi.fn((): string | undefined => undefined);
  const pickDomain = vi.fn(async (): Promise<string | undefined> => '/project/.erd-studio/gold/picked.json');
  const hasDiagrams = vi.fn(() => true);
  const all: ExportDiagramDeps = {
    exportDomain, activeDomainPath, hasDiagrams, pickDomain, defaultSaveFolder: '/project', ui, ...overrides,
  };
  return { deps: all, exportDomain, activeDomainPath, pickDomain };
}

let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const features = () => feature.mock.calls.map((c) => c[0]);
const errors = () => error.mock.calls.map((c) => c[0]);

beforeEach(() => {
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
});
afterEach(() => { vi.restoreAllMocks(); });

const SUBJECT_AREA = '/project/.erd-studio/silver/showcase.json';

// ---------------------------------------------------------------------------

describe('subjectAreaPathFromArg', () => {
  it('reads a file Uri, a path string and the domain tree node', () => {
    expect(subjectAreaPathFromArg(vscode.Uri.file(SUBJECT_AREA))).toBe(SUBJECT_AREA);
    expect(subjectAreaPathFromArg(SUBJECT_AREA)).toBe(SUBJECT_AREA);
    expect(subjectAreaPathFromArg({ type: 'domain', summary: { filePath: SUBJECT_AREA, domain: 'showcase', layer: 'silver' } })).toBe(SUBJECT_AREA);
  });

  it('treats anything else as no argument', () => {
    for (const arg of [undefined, null, '', 42, {}, [], { type: 'layer', layer: 'silver' }, { type: 'domain', summary: {} },
      { fsPath: SUBJECT_AREA, scheme: 'untitled' }]) {
      expect(subjectAreaPathFromArg(arg), JSON.stringify(arg)).toBeUndefined();
    }
  });
});

describe('which domain is exported', () => {
  it('an argument wins over the focused canvas and never asks', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    const d = deps(ui, { activeDomainPath: vi.fn(() => '/project/.erd-studio/gold/other.json') });
    await exportDiagramCommand(d.deps, vscode.Uri.file(SUBJECT_AREA));
    expect(d.exportDomain).toHaveBeenCalledWith(SUBJECT_AREA, 'dbml');
    expect(d.pickDomain).not.toHaveBeenCalled();
  });

  it('with no argument, exports the focused canvas without asking which', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { activeDomainPath: vi.fn(() => SUBJECT_AREA) });
    await exportDiagramCommand(d.deps);
    expect(d.exportDomain).toHaveBeenCalledWith(SUBJECT_AREA, 'mermaid');
    expect(d.pickDomain).not.toHaveBeenCalled();
  });

  it('with no argument and no canvas, asks with the domain picker', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui);
    await exportDiagramCommand(d.deps);
    expect(d.pickDomain).toHaveBeenCalledTimes(1);
    expect(d.exportDomain).toHaveBeenCalledWith('/project/.erd-studio/gold/picked.json', 'mermaid');
  });

  it('a cancelled domain pick does nothing else', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { pickDomain: vi.fn(async () => undefined) });
    expect(await exportDiagramCommand(d.deps)).toBeUndefined();
    expect(ui.picks).toHaveLength(0);
    expect(d.exportDomain).not.toHaveBeenCalled();
    expect(features()).toEqual(['exportCancelled']);
  });

  // A project state, not a cancel: counted apart so it does not inflate the cancel rate.
  it('with nothing to export, says so and counts it apart from a cancel', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { hasDiagrams: vi.fn(() => false) });
    expect(await exportDiagramCommand(d.deps)).toBeUndefined();
    expect(d.pickDomain).not.toHaveBeenCalled();
    expect(ui.picks).toHaveLength(0);
    expect(ui.infos).toEqual([NO_DIAGRAMS_MESSAGE]);
    expect(features()).toEqual(['exportNoDiagrams']);
  });

  it('a focused canvas or an argument is exported without asking whether there are diagrams', async () => {
    const hasDiagrams = vi.fn(() => false);
    const d = deps(fakeUi({ format: 'mermaid', action: 'copy' }), { hasDiagrams, activeDomainPath: vi.fn(() => SUBJECT_AREA) });
    await exportDiagramCommand(d.deps);
    await exportDiagramCommand(deps(fakeUi({ format: 'dbml', action: 'copy' }), { hasDiagrams }).deps, SUBJECT_AREA);
    expect(hasDiagrams).not.toHaveBeenCalled();
    expect(features()).toEqual(['exportMermaid', 'exportDbml']);
  });
});

describe('the QuickPicks', () => {
  it('offers Mermaid, DBML and DBML for dbdiagram.io, each with what it is for, under a title that names the logical design', async () => {
    const ui = fakeUi({});
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.picks).toHaveLength(1);
    const [{ items, options }] = ui.picks;
    expect(items.map((i) => i.label)).toEqual(['Mermaid', 'DBML', 'DBML for dbdiagram.io']);
    expect(items[0].detail).toBe('Renders in GitHub, GitLab and Markdown docs');
    expect(items[1].detail).toBe("Opens in any DBML tool. ERD Studio's fields go in notes; no table positions");
    expect(items[2].detail).toBe("Keeps ERD Studio's fields and the table positions. Needs DBML 9.1 or later, as dbdiagram.io and dbdocs read");
    expect(items.map((i) => i.description)).toEqual(['.mmd', '.dbml', '.dbml + .dbdiagram']);
    expect(options.title).toBe(EXPORT_TITLE);
    expect(options.title).toMatch(/logical design/);
    expect(options.placeHolder).toContain('"showcase"');
  });

  it('then offers copy, open and save for the chosen format', async () => {
    const ui = fakeUi({ format: 'dbml' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.picks).toHaveLength(2);
    expect(ui.picks[1].items.map((i) => i.action)).toEqual(['copy', 'open', 'save']);
    expect(ui.picks[1].items.map((i) => i.label)).toEqual(ACTION_ITEMS.map((i) => i.label));
    expect(ui.picks[1].items.map((i) => i.label).join(' ')).toMatch(/Copy to Clipboard.*Open in Editor.*Save As…/);
    expect(ui.picks[1].options.title).toBe(`${EXPORT_TITLE}: DBML`);
    expect(ui.picks[1].options.placeHolder).toContain('showcase.dbml');
  });

  it('FORMAT_ITEMS follows the core format list', async () => {
    const { DIAGRAM_EXPORT_FORMATS } = await import('@erd-studio/core');
    expect(FORMAT_ITEMS.map((i) => i.format)).toEqual([...DIAGRAM_EXPORT_FORMATS]);
    expect(Object.keys(FORMAT_LABELS)).toEqual([...DIAGRAM_EXPORT_FORMATS]);
    expect(FORMAT_ITEMS.map((i) => i.label)).toEqual(DIAGRAM_EXPORT_FORMATS.map((f) => FORMAT_LABELS[f]));
  });

  it('counts each format under its own feature', () => {
    expect(FORMAT_FEATURES).toEqual({ mermaid: 'exportMermaid', dbml: 'exportDbml', 'dbml-rich': 'exportDbmlRich' });
  });
});

describe('cancelling', () => {
  it('at the format step reads nothing', async () => {
    const ui = fakeUi({});
    const d = deps(ui);
    expect(await exportDiagramCommand(d.deps, SUBJECT_AREA)).toBeUndefined();
    expect(d.exportDomain).not.toHaveBeenCalled();
    expect(features()).toEqual(['exportCancelled']);
  });

  it('at the action step copies, opens and writes nothing', async () => {
    const ui = fakeUi({ format: 'mermaid' });
    expect(await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.clipboard).toEqual([]);
    expect(ui.untitled).toEqual([]);
    expect(ui.written).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('in the save dialog writes nothing', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save' });
    expect(await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.saveDialogs).toHaveLength(1);
    expect(ui.written).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
    expect(errors()).toEqual([]);
  });
});

describe('Copy to Clipboard', () => {
  it('copies Mermaid and says to paste it in a ```mermaid block', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.clipboard).toEqual([EXPORTED('mermaid').content]);
    expect(ui.infos).toEqual([MERMAID_COPIED_MESSAGE]);
    expect(MERMAID_COPIED_MESSAGE).toContain('```mermaid');
    expect(MERMAID_COPIED_MESSAGE).toMatch(/GitHub or GitLab/);
    expect(result).toEqual({ format: 'mermaid', action: 'copy', fileName: 'showcase.mmd' });
    expect(features()).toEqual(['exportMermaid']);
  });

  it('copies DBML and points at DBML tools', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.clipboard).toEqual([EXPORTED('dbml').content]);
    expect(ui.infos).toEqual([DBML_COPIED_MESSAGE]);
    expect(features()).toEqual(['exportDbml']);
  });
});

describe('Open in Editor', () => {
  it('uses the format\'s language id when the editor knows it', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'open', languages: ['json', 'mermaid'] });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.untitled).toEqual([{ content: EXPORTED('mermaid').content, language: 'mermaid' }]);
    expect(features()).toEqual(['exportMermaid']);
  });

  it('falls back to plain text when no extension provides the language', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'open', languages: ['json', 'mermaid'] });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.untitled).toEqual([{ content: EXPORTED('dbml').content, language: 'plaintext' }]);
  });

  it('falls back to plain text when the language list cannot be read', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'open', languages: new Error('no') });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.untitled).toEqual([{ content: EXPORTED('dbml').content, language: 'plaintext' }]);
    expect(errors()).toEqual([]);
  });

  it('writes no file', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'open' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.written).toEqual([]);
    expect(ui.saveDialogs).toEqual([]);
  });
});

describe('Save As…', () => {
  it('suggests the export file name in the project root, filtered to the format, and writes the chosen file', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save', saveTo: '/elsewhere/model.dbml' });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.saveDialogs).toHaveLength(1);
    const options = ui.saveDialogs[0];
    expect(options.defaultUri?.fsPath).toBe(path.join('/project', 'showcase.dbml'));
    expect(options.filters).toEqual({ DBML: ['dbml'] });
    expect(options.title).toMatch(/logical design/);
    expect(ui.written).toEqual([{ fsPath: '/elsewhere/model.dbml', content: EXPORTED('dbml').content }]);
    expect(ui.infos).toEqual(['Exported model.dbml.']);
    expect(result).toEqual({ format: 'dbml', action: 'save', fileName: 'showcase.dbml', savedTo: '/elsewhere/model.dbml' });
    expect(features()).toEqual(['exportDbml']);
  });

  it('starts in the domain\'s folder when no project root is given', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save' });
    const d = deps(ui);
    delete d.deps.defaultSaveFolder;
    await exportDiagramCommand(d.deps, SUBJECT_AREA);
    expect(ui.saveDialogs[0].defaultUri?.fsPath).toBe(path.join(path.dirname(SUBJECT_AREA), 'showcase.mmd'));
    expect(ui.saveDialogs[0].filters).toEqual({ Mermaid: ['mmd'] });
  });

  it('opens the saved file from the message\'s Open button', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save', saveTo: '/elsewhere/d.mmd', infoChoice: 'Open' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    await vi.waitFor(() => expect(ui.opened).toEqual(['/elsewhere/d.mmd']));
  });

  // workspace.fs reports a folder the user may not write as a FileSystemError
  // coded NoPermissions, never EACCES (#189).
  it('says a folder it may not write is the reason, and offers another location', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save', saveTo: '/read-only/showcase.dbml' });
    ui.writeFile = async () => {
      throw Object.assign(new Error('EACCES: permission denied, open \'/read-only/showcase.dbml\''), { name: 'FileSystemError', code: 'NoPermissions' });
    };
    expect(await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.errors).toEqual(["Couldn't save showcase.dbml: ERD Studio isn't allowed to write to that folder."]);
    expect(ui.errorButtons).toEqual([[CHOOSE_ANOTHER_LOCATION_BUTTON]]);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual([]);
  });

  it('says a full disk is the reason', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save', saveTo: '/full/d.mmd' });
    ui.writeFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'Unknown' }); };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual(["Couldn't save d.mmd: the disk is full."]);
    expect(ui.errorButtons).toEqual([[CHOOSE_ANOTHER_LOCATION_BUTTON]]);
  });

  it('Choose Another Location reopens Save As… where the user last tried, and saves there', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save', saveTo: '/read-only/showcase.dbml', errorChoices: [CHOOSE_ANOTHER_LOCATION_BUTTON] });
    let refused = false;
    ui.writeFile = async (uri, content) => {
      if (!refused) { refused = true; throw Object.assign(new Error('denied'), { code: 'NoPermissions' }); }
      ui.written.push({ fsPath: uri.fsPath, content });
    };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    await vi.waitFor(() => expect(ui.written).toHaveLength(1));
    expect(ui.saveDialogs).toHaveLength(2);
    expect(ui.saveDialogs[1].defaultUri?.fsPath).toBe('/read-only/showcase.dbml');
    expect(ui.infos).toEqual(['Exported showcase.dbml.']);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual(['exportDbml']);
  });

  it('calls any other failed write ERD Studio\'s, without its raw text, and offers Send Feedback with it redacted', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save', saveTo: '/x/d.mmd', errorChoices: ['Send Feedback'] });
    ui.writeFile = async () => { throw new Error('boom at /Users/someone/project/.erd-studio/x.mmd'); };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual([
      "Export Diagram hit a problem in ERD Studio while exporting the diagram, so nothing was exported. This isn't something you did. Please send us a report.",
    ]);
    expect(ui.errorButtons).toEqual([['Send Feedback']]);
    await vi.waitFor(() => expect(ui.feedback).toHaveLength(1));
    expect(ui.feedback[0].kind).toBe('bug');
    expect(ui.feedback[0].description).toContain('boom at');
    expect(ui.feedback[0].description).not.toContain('/Users/someone');
  });
});

describe('DBML for dbdiagram.io', () => {
  it('Copy gives the DBML alone, its header naming no layout file, and says the clipboard has no positions', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'copy' });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.clipboard).toEqual([RICH('')]);
    expect(ui.infos).toEqual([DBML_RICH_COPIED_MESSAGE]);
    expect(DBML_RICH_COPIED_MESSAGE).toMatch(/no table positions/);
    expect(DBML_RICH_COPIED_MESSAGE).toMatch(/Save As…/);
    expect(ui.written).toEqual([]);
    expect(result).toEqual({ format: 'dbml-rich', action: 'copy', fileName: 'showcase.dbml' });
    expect(features()).toEqual(['exportDbmlRich']);
  });

  it('Open gives the DBML alone, as dbml, and says where the positions would go', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'open', languages: ['dbml'] });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.untitled).toEqual([{ content: RICH(''), language: 'dbml' }]);
    expect(ui.infos).toEqual([DBML_RICH_OPENED_MESSAGE]);
    expect(DBML_RICH_OPENED_MESSAGE).toMatch(/\.dbdiagram/);
    expect(ui.written).toEqual([]);
    expect(features()).toEqual(['exportDbmlRich']);
  });

  it('the action step names the format plainly', async () => {
    const ui = fakeUi({ format: 'dbml-rich' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.picks[1].options.title).toBe(`${EXPORT_TITLE}: DBML for dbdiagram.io`);
  });

  it('Save As writes the .dbml and its .dbdiagram side by side, the header naming the layout by the name chosen', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/elsewhere/model.dbml' });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.saveDialogs[0].defaultUri?.fsPath).toBe(path.join('/project', 'showcase.dbml'));
    expect(ui.saveDialogs[0].filters).toEqual({ 'DBML for dbdiagram.io': ['dbml'] });
    expect(ui.existsAsked).toEqual(['/elsewhere/model.dbdiagram']);
    expect(ui.modals).toEqual([]);
    expect(ui.written).toEqual([
      { fsPath: '/elsewhere/model.dbml', content: RICH('model.dbdiagram') },
      { fsPath: '/elsewhere/model.dbdiagram', content: LAYOUT_JSON },
    ]);
    expect(ui.infos).toEqual(['Exported model.dbml and its table positions, model.dbdiagram.']);
    expect(result).toEqual({
      format: 'dbml-rich', action: 'save', fileName: 'showcase.dbml',
      savedTo: '/elsewhere/model.dbml', layoutSavedTo: '/elsewhere/model.dbdiagram',
    });
    expect(features()).toEqual(['exportDbmlRich']);
  });

  it('keeps the suggested name\'s header when the user keeps the suggested name', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/project/showcase.dbml' });
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/project/showcase.dbml', '/project/showcase.dbdiagram']);
    expect(ui.written[0].content).toBe(EXPORTED('dbml-rich').content);
  });

  it('asks before replacing a .dbdiagram that is already there, and Replace writes both', async () => {
    const ui = fakeUi({
      format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml', existing: ['/x/model.dbdiagram'], modalChoice: REPLACE_LAYOUT_BUTTON,
    });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.modals).toEqual([{
      message: 'model.dbdiagram already exists. Replace it?',
      detail: "It holds the table positions dbdiagram.io uses for model.dbml. Replacing it gives it this diagram's positions.",
      items: [REPLACE_LAYOUT_BUTTON, KEEP_LAYOUT_BUTTON],
    }]);
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/x/model.dbml', '/x/model.dbdiagram']);
    expect(result?.layoutSavedTo).toBe('/x/model.dbdiagram');
  });

  it('Save .dbml Only leaves the existing .dbdiagram untouched and says so', async () => {
    const ui = fakeUi({
      format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml', existing: ['/x/model.dbdiagram'], modalChoice: KEEP_LAYOUT_BUTTON,
    });
    const result = await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.written).toEqual([{ fsPath: '/x/model.dbml', content: RICH('model.dbdiagram') }]);
    expect(ui.infos).toEqual(['Exported model.dbml. model.dbdiagram was left as it was.']);
    expect(result).toEqual({ format: 'dbml-rich', action: 'save', fileName: 'showcase.dbml', savedTo: '/x/model.dbml' });
    expect(features()).toEqual(['exportDbmlRich']);
  });

  it('cancelling that question writes nothing at all', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml', existing: ['/x/model.dbdiagram'] });
    expect(await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.modals).toHaveLength(1);
    expect(ui.written).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('a .dbdiagram it cannot check for is treated as absent', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml' });
    ui.fileExists = async () => { throw new Error('stat failed'); };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/x/model.dbml', '/x/model.dbdiagram']);
  });

  it('Mermaid and plain DBML never look for a layout file', async () => {
    for (const format of ['mermaid', 'dbml'] as const) {
      const ui = fakeUi({ format, action: 'save', saveTo: `/x/d.${format === 'mermaid' ? 'mmd' : 'dbml'}` });
      await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
      expect(ui.existsAsked).toEqual([]);
      expect(ui.written).toHaveLength(1);
    }
  });

  it('a .dbml it may not write saves nothing, and offers another location', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/ro/model.dbml' });
    ui.writeFile = async () => { throw Object.assign(new Error('denied'), { code: 'NoPermissions' }); };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual(["Couldn't save model.dbml: ERD Studio isn't allowed to write to that folder."]);
    expect(ui.errorButtons).toEqual([[CHOOSE_ANOTHER_LOCATION_BUTTON]]);
    expect(errors()).toEqual(['exportFailed']);
  });

  it('a .dbdiagram it may not write says the .dbml was saved without it, and offers another location', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml' });
    ui.writeFile = async (uri, content) => {
      if (uri.fsPath.endsWith('.dbdiagram')) throw Object.assign(new Error('denied'), { code: 'NoPermissions' });
      ui.written.push({ fsPath: uri.fsPath, content });
    };
    expect(await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/x/model.dbml']);
    expect(ui.errors).toEqual(["Saved model.dbml, but couldn't save its table positions, model.dbdiagram: ERD Studio isn't allowed to write it."]);
    expect(ui.errorButtons).toEqual([[CHOOSE_ANOTHER_LOCATION_BUTTON]]);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual([]);
  });

  it('any other failure writing the .dbdiagram is ERD Studio\'s, and says the .dbml was saved', async () => {
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/x/model.dbml' });
    ui.writeFile = async (uri) => { if (uri.fsPath.endsWith('.dbdiagram')) throw new Error('boom'); };
    await exportDiagramCommand(deps(ui).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual([
      "Export Diagram hit a problem in ERD Studio while saving the table positions, so model.dbml was saved without model.dbdiagram. This isn't something you did. Please send us a report.",
    ]);
    expect(ui.errorButtons).toEqual([['Send Feedback']]);
  });

  it('layoutUriFor puts the layout beside the file under the same name, never on the file itself', () => {
    expect(layoutUriFor(vscode.Uri.file('/x/model.dbml')).fsPath).toBe('/x/model.dbdiagram');
    expect(layoutUriFor(vscode.Uri.file('/x/model')).fsPath).toBe('/x/model.dbdiagram');
    expect(layoutUriFor(vscode.Uri.file('/x/a.b.dbml')).fsPath).toBe('/x/a.b.dbdiagram');
    expect(layoutUriFor(vscode.Uri.file('/x/model.dbdiagram')).fsPath).toBe('/x/model.dbdiagram.dbdiagram');
    expect(layoutUriFor(vscode.Uri.file('/x/Model.DBDIAGRAM')).fsPath).toBe('/x/Model.DBDIAGRAM.dbdiagram');
  });
});

describe('errors', () => {
  const jsonMistake = () => new SubjectAreaFileError('invalid-json', SUBJECT_AREA,
    `Invalid JSON in subject area file ${SUBJECT_AREA}: Expected double-quoted property name in JSON at position 45`,
    { line: 4, column: 1, syntaxProblem: 'trailing-comma' });

  it('a diagram file with a mistake is named project-relative, says where, and opens there — before the action is asked', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy', errorChoices: [OPEN_FILE_BUTTON] });
    const d = deps(ui, { projectRoot: '/project', exportDomain: vi.fn(async () => { throw jsonMistake(); }) });
    expect(await exportDiagramCommand(d.deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.errors).toEqual([
      ".erd-studio/silver/showcase.json can't be exported because the diagram file has a problem: there is a mistake at line 4, " +
        'column 1: there is a comma after the last item, before a closing } or ].',
    ]);
    expect(ui.errorButtons).toEqual([[OPEN_FILE_BUTTON]]);
    await vi.waitFor(() => expect(ui.openedAt).toEqual([{ filePath: SUBJECT_AREA, line: 4, column: 1 }]));
    expect(ui.picks).toHaveLength(1);
    expect(ui.clipboard).toEqual([]);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual([]);
  });

  it('an Open File that fails (the file was deleted since) says so, with Send Feedback', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy', errorChoices: [OPEN_FILE_BUTTON] });
    ui.openFileAt = async () => { throw new Error('cannot open /Users/someone/x.json'); };
    await exportDiagramCommand(deps(ui, { projectRoot: '/project', exportDomain: vi.fn(async () => { throw jsonMistake(); }) }).deps, SUBJECT_AREA);
    await vi.waitFor(() => expect(ui.errors).toHaveLength(2));
    expect(ui.errors[1]).toBe(
      "Export Diagram hit a problem in ERD Studio while running Open File, so nothing was exported. This isn't something you did. Please send us a report.",
    );
    expect(ui.errorButtons[1]).toEqual(['Send Feedback']);
  });

  it('a diagram file this version cannot load names it without its absolute path', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    const err = new SubjectAreaValidationError(`Subject area file ${SUBJECT_AREA} has invalid layer "bronze".`);
    await exportDiagramCommand(deps(ui, { projectRoot: '/project', exportDomain: vi.fn(async () => { throw err; }) }).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual([
      '.erd-studio/silver/showcase.json can\'t be exported because the diagram file has a problem: ' +
        'Subject area file .erd-studio/silver/showcase.json has invalid layer "bronze".',
    ]);
    expect(ui.errorButtons).toEqual([[OPEN_FILE_BUTTON]]);
  });

  it('a diagram file from a newer ERD Studio offers nothing to open: editing it is not the fix', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    const err = new SubjectAreaValidationError('This file uses schema version 99. Please update the extension.');
    await exportDiagramCommand(deps(ui, { exportDomain: vi.fn(async () => { throw err; }) }).deps, SUBJECT_AREA);
    expect(ui.errorButtons).toEqual([[]]);
  });

  it('a diagram file that is gone offers nothing to open', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    const err = new SubjectAreaFileError('missing', SUBJECT_AREA, `Subject area file not found: ${SUBJECT_AREA}`);
    await exportDiagramCommand(deps(ui, { exportDomain: vi.fn(async () => { throw err; }) }).deps, SUBJECT_AREA);
    expect(ui.errors).toEqual(["showcase.json can't be exported because the diagram file has a problem: it was deleted or renamed."]);
    expect(ui.errorButtons).toEqual([[]]);
  });

  it('any other read failure is ERD Studio\'s: no raw text, and Send Feedback', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { exportDomain: vi.fn(async () => { throw new Error('Cannot read properties of undefined'); }) });
    expect(await exportDiagramCommand(d.deps, SUBJECT_AREA)).toBeUndefined();
    expect(ui.errors).toEqual([
      "Export Diagram hit a problem in ERD Studio while exporting the diagram, so nothing was exported. This isn't something you did. Please send us a report.",
    ]);
    expect(ui.errorButtons).toEqual([['Send Feedback']]);
    expect(errors()).toEqual(['exportFailed']);
  });
});

describe('with the real exporter', () => {
  it('copies the fixture showcase domain as versioned Mermaid and DBML text', async () => {
    const layerService = new LayerService(FIXTURE_ROOT, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(FIXTURE_ROOT, '.erd-studio'));
    const exportDomain = (p: string, f: DiagramExportFormat) => exportSubjectAreaFile(subjectAreaService, p, f);

    for (const format of ['mermaid', 'dbml'] as const) {
      const ui = fakeUi({ format, action: 'copy' });
      await exportDiagramCommand({ exportDomain, activeDomainPath: () => undefined, hasDiagrams: () => true, pickDomain: async () => undefined, ui }, SHOWCASE);
      const golden = fs.readFileSync(
        path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'golden', `showcase.${format === 'mermaid' ? 'mmd' : 'dbml'}`),
        'utf-8',
      );
      expect(ui.clipboard).toEqual([golden]);
      expect(ui.errors).toEqual([]);
    }
  });
  it('saves the fixture showcase domain as rich DBML plus its .dbdiagram, the bytes the shared export gives', async () => {
    const layerService = new LayerService(FIXTURE_ROOT, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(FIXTURE_ROOT, '.erd-studio'));
    const exportDomain = (p: string, f: DiagramExportFormat) => exportSubjectAreaFile(subjectAreaService, p, f);
    const ui = fakeUi({ format: 'dbml-rich', action: 'save', saveTo: '/out/showcase.dbml' });
    await exportDiagramCommand({ exportDomain, activeDomainPath: () => undefined, hasDiagrams: () => true, pickDomain: async () => undefined, ui }, SHOWCASE);
    expect(ui.errors).toEqual([]);
    // This project's showcase is not core's fixture, so the bytes are the
    // shared export's (cli.export.test checks those against core's goldens).
    const direct = await exportDomain(SHOWCASE, 'dbml-rich');
    expect(direct.content.startsWith('// erd-studio dbml-export v2 (DBML 9.1+)\n// Table positions: showcase.dbdiagram')).toBe(true);
    expect(ui.written).toEqual([
      { fsPath: '/out/showcase.dbml', content: direct.content },
      { fsPath: '/out/showcase.dbdiagram', content: direct.layout!.content },
    ]);
    expect(JSON.parse(ui.written[1].content)).toMatchObject({ version: '3.0.0', defaultView: { tablePositions: expect.any(Array) } });

    // Copied, the header names no layout file; otherwise the text is the same.
    const copy = fakeUi({ format: 'dbml-rich', action: 'copy' });
    await exportDiagramCommand({ exportDomain, activeDomainPath: () => undefined, hasDiagrams: () => true, pickDomain: async () => undefined, ui: copy }, SHOWCASE);
    const withoutLayoutLine = direct.content.split('\n').filter((l) => !l.startsWith('// Table positions:')).join('\n');
    expect(copy.clipboard).toEqual([withoutLayoutLine]);
  });
});
