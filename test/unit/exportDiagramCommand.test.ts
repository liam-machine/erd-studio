/**
 * Export Diagram… (`erdStudio.exportDiagram`) — the command flow in
 * src/commands/exportDiagram.ts, driven through its injected UI with fakes:
 * which domain it exports (argument, focused canvas, picker), the format and
 * action QuickPicks, each action, every cancel, errors and telemetry. One
 * case runs the real `exportDomainFile` over the fixture project, so the
 * wiring reaches `@erd-studio/core`'s exporter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ACTION_ITEMS,
  DBML_COPIED_MESSAGE,
  EXPORT_TITLE,
  FORMAT_ITEMS,
  MERMAID_COPIED_MESSAGE,
  NO_DIAGRAMS_MESSAGE,
  domainPathFromArg,
  exportDiagramCommand,
  type ExportAction,
  type ExportDiagramDeps,
  type ExportDiagramUi,
} from '../../src/commands/exportDiagram';
import { exportDomainFile } from '../../src/services/diagramExport';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { telemetry } from '../../src/services/telemetryService';
import type { DiagramExportFormat } from '@erd-studio/core';

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
}): FakeUi {
  const ui: FakeUi = {
    picks: [], clipboard: [], untitled: [], saveDialogs: [], written: [], opened: [], infos: [], errors: [],
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
    writeFile: async (uri, content) => { ui.written.push({ fsPath: uri.fsPath, content }); },
    openFile: async (uri) => { ui.opened.push(uri.fsPath); },
    showInformationMessage: async (message) => { ui.infos.push(message); return answers.infoChoice; },
    showErrorMessage: (message) => { ui.errors.push(message); },
  };
  return ui;
}

const EXPORTED = (format: DiagramExportFormat) => ({
  content: format === 'mermaid' ? 'erDiagram\n%% erd-studio mermaid-export v1\n' : '// erd-studio dbml-export v1\n',
  fileName: format === 'mermaid' ? 'showcase.mmd' : 'showcase.dbml',
  domainName: 'showcase',
  layer: 'silver',
});

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

const DOMAIN = '/project/.erd-studio/silver/showcase.json';

// ---------------------------------------------------------------------------

describe('domainPathFromArg', () => {
  it('reads a file Uri, a path string and the domain tree node', () => {
    expect(domainPathFromArg(vscode.Uri.file(DOMAIN))).toBe(DOMAIN);
    expect(domainPathFromArg(DOMAIN)).toBe(DOMAIN);
    expect(domainPathFromArg({ type: 'domain', summary: { filePath: DOMAIN, domain: 'showcase', layer: 'silver' } })).toBe(DOMAIN);
  });

  it('treats anything else as no argument', () => {
    for (const arg of [undefined, null, '', 42, {}, [], { type: 'layer', layer: 'silver' }, { type: 'domain', summary: {} },
      { fsPath: DOMAIN, scheme: 'untitled' }]) {
      expect(domainPathFromArg(arg), JSON.stringify(arg)).toBeUndefined();
    }
  });
});

describe('which domain is exported', () => {
  it('an argument wins over the focused canvas and never asks', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    const d = deps(ui, { activeDomainPath: vi.fn(() => '/project/.erd-studio/gold/other.json') });
    await exportDiagramCommand(d.deps, vscode.Uri.file(DOMAIN));
    expect(d.exportDomain).toHaveBeenCalledWith(DOMAIN, 'dbml');
    expect(d.pickDomain).not.toHaveBeenCalled();
  });

  it('with no argument, exports the focused canvas without asking which', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { activeDomainPath: vi.fn(() => DOMAIN) });
    await exportDiagramCommand(d.deps);
    expect(d.exportDomain).toHaveBeenCalledWith(DOMAIN, 'mermaid');
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
    const d = deps(fakeUi({ format: 'mermaid', action: 'copy' }), { hasDiagrams, activeDomainPath: vi.fn(() => DOMAIN) });
    await exportDiagramCommand(d.deps);
    await exportDiagramCommand(deps(fakeUi({ format: 'dbml', action: 'copy' }), { hasDiagrams }).deps, DOMAIN);
    expect(hasDiagrams).not.toHaveBeenCalled();
    expect(features()).toEqual(['exportMermaid', 'exportDbml']);
  });
});

describe('the QuickPicks', () => {
  it('offers Mermaid then DBML, each with what it is for, under a title that names the logical design', async () => {
    const ui = fakeUi({});
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.picks).toHaveLength(1);
    const [{ items, options }] = ui.picks;
    expect(items.map((i) => i.label)).toEqual(['Mermaid', 'DBML']);
    expect(items[0].detail).toBe('Renders in GitHub, GitLab and Markdown docs');
    expect(items[1].detail).toBe('Opens in dbdiagram.io and other DBML tools');
    expect(items.map((i) => i.description)).toEqual(['.mmd', '.dbml']);
    expect(options.title).toBe(EXPORT_TITLE);
    expect(options.title).toMatch(/logical design/);
    expect(options.placeHolder).toContain('"showcase"');
  });

  it('then offers copy, open and save for the chosen format', async () => {
    const ui = fakeUi({ format: 'dbml' });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
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
  });
});

describe('cancelling', () => {
  it('at the format step reads nothing', async () => {
    const ui = fakeUi({});
    const d = deps(ui);
    expect(await exportDiagramCommand(d.deps, DOMAIN)).toBeUndefined();
    expect(d.exportDomain).not.toHaveBeenCalled();
    expect(features()).toEqual(['exportCancelled']);
  });

  it('at the action step copies, opens and writes nothing', async () => {
    const ui = fakeUi({ format: 'mermaid' });
    expect(await exportDiagramCommand(deps(ui).deps, DOMAIN)).toBeUndefined();
    expect(ui.clipboard).toEqual([]);
    expect(ui.untitled).toEqual([]);
    expect(ui.written).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(features()).toEqual(['exportCancelled']);
  });

  it('in the save dialog writes nothing', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save' });
    expect(await exportDiagramCommand(deps(ui).deps, DOMAIN)).toBeUndefined();
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
    const result = await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.clipboard).toEqual([EXPORTED('mermaid').content]);
    expect(ui.infos).toEqual([MERMAID_COPIED_MESSAGE]);
    expect(MERMAID_COPIED_MESSAGE).toContain('```mermaid');
    expect(MERMAID_COPIED_MESSAGE).toMatch(/GitHub or GitLab/);
    expect(result).toEqual({ format: 'mermaid', action: 'copy', fileName: 'showcase.mmd' });
    expect(features()).toEqual(['exportMermaid']);
  });

  it('copies DBML and points at DBML tools', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'copy' });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.clipboard).toEqual([EXPORTED('dbml').content]);
    expect(ui.infos).toEqual([DBML_COPIED_MESSAGE]);
    expect(features()).toEqual(['exportDbml']);
  });
});

describe('Open in Editor', () => {
  it('uses the format\'s language id when the editor knows it', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'open', languages: ['json', 'mermaid'] });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.untitled).toEqual([{ content: EXPORTED('mermaid').content, language: 'mermaid' }]);
    expect(features()).toEqual(['exportMermaid']);
  });

  it('falls back to plain text when no extension provides the language', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'open', languages: ['json', 'mermaid'] });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.untitled).toEqual([{ content: EXPORTED('dbml').content, language: 'plaintext' }]);
  });

  it('falls back to plain text when the language list cannot be read', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'open', languages: new Error('no') });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.untitled).toEqual([{ content: EXPORTED('dbml').content, language: 'plaintext' }]);
    expect(errors()).toEqual([]);
  });

  it('writes no file', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'open' });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    expect(ui.written).toEqual([]);
    expect(ui.saveDialogs).toEqual([]);
  });
});

describe('Save As…', () => {
  it('suggests the export file name in the project root, filtered to the format, and writes the chosen file', async () => {
    const ui = fakeUi({ format: 'dbml', action: 'save', saveTo: '/elsewhere/model.dbml' });
    const result = await exportDiagramCommand(deps(ui).deps, DOMAIN);
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
    await exportDiagramCommand(d.deps, DOMAIN);
    expect(ui.saveDialogs[0].defaultUri?.fsPath).toBe(path.join(path.dirname(DOMAIN), 'showcase.mmd'));
    expect(ui.saveDialogs[0].filters).toEqual({ Mermaid: ['mmd'] });
  });

  it('opens the saved file from the message\'s Open button', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save', saveTo: '/elsewhere/d.mmd', infoChoice: 'Open' });
    await exportDiagramCommand(deps(ui).deps, DOMAIN);
    await vi.waitFor(() => expect(ui.opened).toEqual(['/elsewhere/d.mmd']));
  });

  it('reports a failed write as an export error', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'save', saveTo: '/read-only/d.mmd' });
    ui.writeFile = async () => { throw new Error('EACCES: permission denied'); };
    expect(await exportDiagramCommand(deps(ui).deps, DOMAIN)).toBeUndefined();
    expect(ui.errors).toEqual(['Could not export the diagram: EACCES: permission denied']);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual([]);
  });
});

describe('errors', () => {
  it('a domain that cannot be read is shown with its message, before the action is asked', async () => {
    const ui = fakeUi({ format: 'mermaid', action: 'copy' });
    const d = deps(ui, { exportDomain: vi.fn(async () => { throw new Error('Domain file not found: x.json'); }) });
    expect(await exportDiagramCommand(d.deps, DOMAIN)).toBeUndefined();
    expect(ui.errors).toEqual(['Could not export the diagram: Domain file not found: x.json']);
    expect(ui.picks).toHaveLength(1);
    expect(ui.clipboard).toEqual([]);
    expect(errors()).toEqual(['exportFailed']);
    expect(features()).toEqual([]);
  });
});

describe('with the real exporter', () => {
  it('copies the fixture showcase domain as versioned Mermaid and DBML text', async () => {
    const layerService = new LayerService(FIXTURE_ROOT, '.erd-studio');
    const domainService = new DomainService(layerService);
    domainService.setLogicalModelService(new LogicalModelService(FIXTURE_ROOT, '.erd-studio'));
    const exportDomain = (p: string, f: DiagramExportFormat) => exportDomainFile(domainService, p, f);

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
});
