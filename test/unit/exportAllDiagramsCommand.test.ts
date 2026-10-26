/**
 * Export All Diagrams… (`erdStudio.exportAllDiagrams`) — the command flow in
 * src/commands/exportAllDiagrams.ts, driven through its injected UI with
 * fakes: the format picker, the folder picker, the one question before
 * replacing files, skipped subject areas, write failures, every cancel and
 * telemetry. Two cases run the real `exportSubjectAreaFiles` over a copy of
 * the fixture project, so the wiring reaches `@erd-studio/core`'s exporters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SubjectAreaFileError, type DiagramExportFormat } from '@erd-studio/core';

import {
  CHOOSE_ANOTHER_FOLDER_BUTTON,
  EXPORT_ALL_TITLE,
  EXPORT_HERE_LABEL,
  REPLACE_FILES_BUTTON,
  exportAllDiagramsCommand,
  listNames,
  type ExportAllDiagramsDeps,
  type ExportAllDiagramsUi,
} from '../../src/commands/exportAllDiagrams';
import { FORMAT_ITEMS, NO_DIAGRAMS_MESSAGE } from '../../src/commands/exportDiagram';
import type { FeedbackPrefill } from '../../src/services/commandErrors';
import { exportSubjectAreaFiles, type ExportedFile, type SubjectAreaFilesExport } from '../../src/services/diagramExport';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';
import type { SubjectAreaSummary } from '../../src/types/semantic';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type Pickable = vscode.QuickPickItem & { format?: DiagramExportFormat };

interface FakeUi extends ExportAllDiagramsUi {
  picks: Array<{ items: Pickable[]; options: vscode.QuickPickOptions }>;
  openDialogs: vscode.OpenDialogOptions[];
  written: Array<{ fsPath: string; content: string }>;
  modals: Array<{ message: string; detail: string; items: string[] }>;
  infos: string[];
  warnings: Array<{ message: string; items: string[] }>;
  errors: string[];
  errorButtons: string[][];
  feedback: FeedbackPrefill[];
}

/**
 * A UI that answers the format pick with `format` (undefined = Escape), each
 * folder dialog in turn with `folders` (undefined = cancelled), the modal
 * with `modalChoice`, and reports `existing` paths as already on disk.
 */
function fakeUi(answers: {
  format?: DiagramExportFormat;
  folders?: Array<string | undefined>;
  existing?: string[];
  modalChoice?: string;
  errorChoices?: Array<string | undefined>;
  warningChoice?: string;
}): FakeUi {
  const folders = [...(answers.folders ?? [])];
  const errorChoices = [...(answers.errorChoices ?? [])];
  const ui: FakeUi = {
    picks: [], openDialogs: [], written: [], modals: [], infos: [], warnings: [], errors: [], errorButtons: [], feedback: [],
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions) => {
      ui.picks.push({ items: [...items] as Pickable[], options });
      return (items as readonly Pickable[]).find((i) => i.format !== undefined && i.format === answers.format) as T | undefined;
    },
    showOpenDialog: async (options) => {
      ui.openDialogs.push(options);
      const folder = folders.shift();
      return folder ? [vscode.Uri.file(folder) as unknown as vscode.Uri] : undefined;
    },
    fileExists: async (uri) => (answers.existing ?? []).includes(uri.fsPath),
    writeFile: async (uri, content) => { ui.written.push({ fsPath: uri.fsPath, content }); },
    showModalWarning: async (message, detail, ...items) => {
      ui.modals.push({ message, detail, items });
      return answers.modalChoice;
    },
    showInformationMessage: async (message) => { ui.infos.push(message); return undefined; },
    showWarningMessage: async (message, ...items) => { ui.warnings.push({ message, items }); return answers.warningChoice; },
    showErrorMessage: async (message, ...items) => {
      ui.errors.push(message);
      ui.errorButtons.push(items);
      return errorChoices.shift();
    },
    sendFeedback: async (prefill) => { ui.feedback.push(prefill); },
  };
  return ui;
}

const SUMMARIES: SubjectAreaSummary[] = [
  { domain: 'showcase', layer: 'silver', filePath: '/project/.erd-studio/silver/showcase.json' },
  { domain: 'sales', layer: 'gold', filePath: '/project/.erd-studio/gold/sales.json' },
];

const file = (domainPath: string, fileName: string, kind: ExportedFile['kind'] = 'diagram'): ExportedFile =>
  ({ domainPath, kind, fileName, content: `${fileName} text\n` });

/** What the fake exportAll gives for each format: two diagrams, with layout files for rich DBML. */
function fakeExport(format: DiagramExportFormat): SubjectAreaFilesExport {
  const [silver, gold] = SUMMARIES.map((s) => s.filePath);
  if (format === 'dbml-rich') {
    return {
      files: [
        file(gold, 'sales.dbml'), file(gold, 'sales.dbdiagram', 'layout'),
        file(silver, 'showcase.dbml'), file(silver, 'showcase.dbdiagram', 'layout'),
      ],
      skipped: [],
    };
  }
  const ext = format === 'mermaid' ? 'mmd' : 'dbml';
  return { files: [file(gold, `sales.${ext}`), file(silver, `showcase.${ext}`)], skipped: [] };
}

function deps(ui: ExportAllDiagramsUi, overrides: Partial<ExportAllDiagramsDeps> = {}) {
  const exportAll = vi.fn(async (_paths: readonly string[], format: DiagramExportFormat) => fakeExport(format));
  const all: ExportAllDiagramsDeps = {
    listSubjectAreas: () => SUMMARIES,
    exportAll,
    defaultFolder: '/project',
    projectRoot: '/project',
    ui,
    ...overrides,
  };
  return { deps: all, exportAll };
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

// ---------------------------------------------------------------------------

describe('Export All Diagrams', () => {
  it('with nothing to export, says so and counts it apart from a cancel', async () => {
    const ui = fakeUi({ format: 'dbml' });
    expect(await exportAllDiagramsCommand(deps(ui, { listSubjectAreas: () => [] }).deps)).toBeUndefined();
    expect(ui.picks).toEqual([]);
    expect(ui.infos).toEqual([NO_DIAGRAMS_MESSAGE]);
    expect(features()).toEqual(['exportNoDiagrams']);
  });

  it('offers the same formats as Export Diagram, under a title that names the logical design and the count', async () => {
    const ui = fakeUi({});
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.picks).toHaveLength(1);
    expect(ui.picks[0].items).toEqual([...FORMAT_ITEMS]);
    expect(ui.picks[0].options.title).toBe(EXPORT_ALL_TITLE);
    expect(ui.picks[0].options.title).toMatch(/logical design/);
    expect(ui.picks[0].options.placeHolder).toBe('Export all 2 diagrams as…');
  });

  it('says "the 1 diagram" for a project with one', async () => {
    const ui = fakeUi({});
    await exportAllDiagramsCommand(deps(ui, { listSubjectAreas: () => [SUMMARIES[0]] }).deps);
    expect(ui.picks[0].options.placeHolder).toBe('Export the 1 diagram as…');
  });

  it('a cancelled format pick reads and writes nothing', async () => {
    const ui = fakeUi({});
    const d = deps(ui);
    expect(await exportAllDiagramsCommand(d.deps)).toBeUndefined();
    expect(d.exportAll).not.toHaveBeenCalled();
    expect(ui.openDialogs).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('asks for a folder only, starting at the project root', async () => {
    const ui = fakeUi({ format: 'mermaid' });
    const d = deps(ui);
    expect(await exportAllDiagramsCommand(d.deps)).toBeUndefined();
    expect(d.exportAll).toHaveBeenCalledWith(SUMMARIES.map((s) => s.filePath), 'mermaid');
    expect(ui.openDialogs).toHaveLength(1);
    const options = ui.openDialogs[0];
    expect(options).toMatchObject({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: EXPORT_HERE_LABEL });
    expect(options.defaultUri?.fsPath).toBe('/project');
    expect(options.title).toBe(`${EXPORT_ALL_TITLE}: Choose a Folder for the Mermaid Files`);
    // Cancelled there: nothing written.
    expect(ui.written).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('writes one file per subject area into the folder and says how many went where', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/project/exports'] });
    const result = await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.written).toEqual([
      { fsPath: '/project/exports/sales.dbml', content: 'sales.dbml text\n' },
      { fsPath: '/project/exports/showcase.dbml', content: 'showcase.dbml text\n' },
    ]);
    expect(ui.modals).toEqual([]);
    expect(ui.infos).toEqual(['Exported 2 diagrams as DBML to exports.']);
    expect(result).toEqual({
      format: 'dbml', folder: '/project/exports',
      written: ['/project/exports/sales.dbml', '/project/exports/showcase.dbml'], skipped: [],
    });
    expect(features()).toEqual(['exportAll']);
    expect(errors()).toEqual([]);
  });

  it('with DBML for dbdiagram.io, writes each .dbml with its .dbdiagram and says so', async () => {
    const ui = fakeUi({ format: 'dbml-rich', folders: ['/out'] });
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/out/sales.dbml', '/out/sales.dbdiagram', '/out/showcase.dbml', '/out/showcase.dbdiagram']);
    // Outside the project, the folder is named by its own name.
    expect(ui.infos).toEqual(['Exported 2 diagrams as DBML for dbdiagram.io to out, each with its table positions in a .dbdiagram file.']);
    expect(features()).toEqual(['exportAll']);
  });

  it('asks once, with the count and the names, before replacing files already there; Replace writes them all', async () => {
    const ui = fakeUi({
      format: 'dbml-rich', folders: ['/out'], existing: ['/out/sales.dbml', '/out/showcase.dbdiagram'], modalChoice: REPLACE_FILES_BUTTON,
    });
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.modals).toEqual([{
      message: '2 of the 4 files already exist in out. Replace them?',
      detail: 'Already there: sales.dbml, showcase.dbdiagram.',
      items: [REPLACE_FILES_BUTTON],
    }]);
    expect(ui.written).toHaveLength(4);
    expect(features()).toEqual(['exportAll']);
  });

  it('says "1 of the … already exists" for one', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/out'], existing: ['/out/sales.dbml'], modalChoice: REPLACE_FILES_BUTTON });
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.modals[0].message).toBe('1 of the 2 files already exists in out. Replace it?');
  });

  it('cancelling that question writes nothing', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/out'], existing: ['/out/sales.dbml'] });
    expect(await exportAllDiagramsCommand(deps(ui).deps)).toBeUndefined();
    expect(ui.modals).toHaveLength(1);
    expect(ui.written).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('a subject area that cannot be read is skipped and named at the end, not fatal', async () => {
    const broken = '/project/.erd-studio/silver/broken.json';
    const mistake = new SubjectAreaFileError('invalid-json', broken, `Invalid JSON in ${broken}`, { line: 2, column: 3, syntaxProblem: 'missing-comma' });
    const ui = fakeUi({ format: 'dbml', folders: ['/project/exports'] });
    const exportAll = vi.fn(async () => ({ ...fakeExport('dbml'), skipped: [{ domainPath: broken, error: mistake }] }));
    const result = await exportAllDiagramsCommand(deps(ui, { exportAll }).deps);
    expect(ui.written).toHaveLength(2);
    expect(ui.infos).toEqual([]);
    expect(ui.warnings).toEqual([{
      message: 'Exported 2 diagrams as DBML to exports. Skipped 1 diagram that couldn\'t be read: ' +
        '.erd-studio/silver/broken.json (there is a mistake at line 2, column 3: a comma is missing after this value).',
      items: [],
    }]);
    expect(result?.skipped).toEqual([broken]);
    expect(features()).toEqual(['exportAll']);
    // The user's file, not a failure of ours.
    expect(errors()).toEqual([]);
  });

  it('a subject area skipped for a reason of ours is reported with Send Feedback and counted', async () => {
    const odd = '/project/.erd-studio/silver/odd.json';
    const ui = fakeUi({ format: 'mermaid', folders: ['/out'], warningChoice: 'Send Feedback' });
    const exportAll = vi.fn(async () => ({ ...fakeExport('mermaid'), skipped: [{ domainPath: odd, error: new Error('boom at /Users/someone/x') }] }));
    await exportAllDiagramsCommand(deps(ui, { exportAll }).deps);
    expect(ui.warnings[0].message).toContain('.erd-studio/silver/odd.json (ERD Studio hit a problem reading it)');
    expect(ui.warnings[0].items).toEqual(['Send Feedback']);
    await vi.waitFor(() => expect(ui.feedback).toHaveLength(1));
    expect(ui.feedback[0].description).not.toContain('/Users/someone');
    expect(features()).toEqual(['exportAll']);
    expect(errors()).toEqual(['exportFailed']);
  });

  it('when nothing can be read, says why each and writes nothing, before asking for a folder', async () => {
    const broken = '/project/.erd-studio/silver/broken.json';
    const ui = fakeUi({ format: 'dbml', folders: ['/out'] });
    const missing = new SubjectAreaFileError('missing', broken, `Subject area file not found: ${broken}`);
    const exportAll = vi.fn(async () => ({ files: [], skipped: [{ domainPath: broken, error: missing }] }));
    expect(await exportAllDiagramsCommand(deps(ui, { exportAll, listSubjectAreas: () => [SUMMARIES[0]] }).deps)).toBeUndefined();
    expect(ui.openDialogs).toEqual([]);
    expect(ui.written).toEqual([]);
    expect(ui.errors).toEqual([
      'None of the 1 diagram could be exported, so nothing was written: .erd-studio/silver/broken.json (it was deleted or renamed).',
    ]);
    expect(ui.errorButtons).toEqual([[]]);
    expect(features()).toEqual([]);
    // Counted as Export Diagram counts a diagram it cannot read.
    expect(errors()).toEqual(['exportFailed']);
  });

  it('a folder it may not write stops, says what was saved, and offers another folder', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/ro', '/ok'], errorChoices: [CHOOSE_ANOTHER_FOLDER_BUTTON] });
    let writes = 0;
    ui.writeFile = async (uri, content) => {
      writes++;
      if (uri.fsPath.startsWith('/ro/') && writes === 2) throw Object.assign(new Error('denied'), { code: 'NoPermissions' });
      ui.written.push({ fsPath: uri.fsPath, content });
    };
    expect(await exportAllDiagramsCommand(deps(ui).deps)).toBeUndefined();
    expect(ui.errors[0]).toBe("Couldn't save showcase.dbml in ro: ERD Studio isn't allowed to write to that folder. 1 of the 2 files were saved before it.");
    expect(ui.errorButtons[0]).toEqual([CHOOSE_ANOTHER_FOLDER_BUTTON]);
    expect(errors()).toEqual(['exportFailed']);

    // Choose Another Folder starts where the user last tried, and writes everything there.
    await vi.waitFor(() => expect(ui.infos).toEqual(['Exported 2 diagrams as DBML to ok.']));
    expect(ui.openDialogs[1].defaultUri?.fsPath).toBe('/ro');
    expect(ui.written.map((w) => w.fsPath)).toEqual(['/ro/sales.dbml', '/ok/sales.dbml', '/ok/showcase.dbml']);
    expect(features()).toEqual(['exportAll']);
  });

  it('a full disk on the first file says nothing was saved', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/full'] });
    ui.writeFile = async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'Unknown' }); };
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.errors).toEqual(["Couldn't save sales.dbml in full: the disk is full. Nothing was saved."]);
  });

  it('any other failed write is ERD Studio\'s, with Send Feedback carrying the error redacted', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/x'], errorChoices: ['Send Feedback'] });
    ui.writeFile = async () => { throw new Error('boom at /Users/someone/x.dbml'); };
    await exportAllDiagramsCommand(deps(ui).deps);
    expect(ui.errors).toEqual([
      "Export All Diagrams hit a problem in ERD Studio while saving sales.dbml, so nothing was exported. This isn't something you did. Please send us a report.",
    ]);
    await vi.waitFor(() => expect(ui.feedback).toHaveLength(1));
    expect(ui.feedback[0].description).not.toContain('/Users/someone');
    expect(errors()).toEqual(['exportFailed']);
  });

  it('a failure reading the project is ERD Studio\'s, and writes nothing', async () => {
    const ui = fakeUi({ format: 'dbml', folders: ['/x'] });
    const exportAll = vi.fn(async () => { throw new Error('Cannot read properties of undefined'); });
    expect(await exportAllDiagramsCommand(deps(ui, { exportAll }).deps)).toBeUndefined();
    expect(ui.errors).toEqual([
      "Export All Diagrams hit a problem in ERD Studio while exporting the diagrams, so nothing was exported. This isn't something you did. Please send us a report.",
    ]);
    expect(ui.errorButtons).toEqual([['Send Feedback']]);
    expect(ui.written).toEqual([]);
    expect(errors()).toEqual(['exportFailed']);
  });
});

describe('listNames', () => {
  it('lists up to ten names, then how many more', () => {
    expect(listNames(['a'])).toBe('a');
    const twelve = Array.from({ length: 12 }, (_, i) => `f${i}`);
    expect(listNames(twelve)).toBe('f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 2 more');
  });
});

describe('with the real exporter', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-export-all-cmd-'));
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function realDeps(ui: ExportAllDiagramsUi): ExportAllDiagramsDeps {
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
    return {
      listSubjectAreas: () => subjectAreaService.listSubjectAreas(root, '.erd-studio'),
      exportAll: (paths, format) => exportSubjectAreaFiles(subjectAreaService, paths, format, { layers: layerService }),
      defaultFolder: root,
      projectRoot: root,
      ui,
    };
  }

  it('writes every subject area of the fixture, the same bytes exportSubjectAreaFiles gives', async () => {
    const ui = fakeUi({ format: 'dbml-rich', folders: ['/out'] });
    const d = realDeps(ui);
    await exportAllDiagramsCommand(d);
    const expected = await d.exportAll(d.listSubjectAreas().map((s) => s.filePath), 'dbml-rich');
    expect(ui.written).toEqual(expected.files.map((f) => ({ fsPath: path.join('/out', f.fileName), content: f.content })));
    expect(ui.written.map((w) => path.basename(w.fsPath))).toContain('showcase.dbml');
    expect(ui.written.map((w) => path.basename(w.fsPath))).toContain('showcase.dbdiagram');
    expect(ui.errors).toEqual([]);
  });

  it('keeps two subject areas of the same name apart as <layer>-<name>', async () => {
    const domain = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/silver/showcase.json'), 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(root, '.erd-studio/gold/showcase.json'), JSON.stringify({ ...domain, layer: 'gold' }));
    const ui = fakeUi({ format: 'mermaid', folders: ['/out'] });
    await exportAllDiagramsCommand(realDeps(ui));
    const names = ui.written.map((w) => path.basename(w.fsPath));
    expect(names).toContain('gold-showcase.mmd');
    expect(names).toContain('silver-showcase.mmd');
    expect(names).not.toContain('showcase.mmd');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
});
