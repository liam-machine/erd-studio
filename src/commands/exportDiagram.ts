/**
 * **Export Diagram…** (`erdStudio.exportDiagram`) — a domain's logical
 * (design) stage as Mermaid or DBML text, one way out. Nothing about how ERD
 * Studio stores a diagram changes: the text comes from `@erd-studio/core`'s
 * `exportDiagram` through `exportDomainFile` (`src/services/diagramExport.ts`),
 * the same read the `erd-studio export` CLI and the canvas's logical stage
 * make, so every host produces the same bytes.
 *
 * Reached from the palette, the domain tree's context menu (the tree passes
 * its domain node) and the canvas toolbar's **Export** button (the provider
 * passes the panel's document Uri). Without an argument it exports the
 * focused canvas's domain, else asks which with the picker
 * `erdStudio.openDomain` uses (or says there is nothing to export yet). Then:
 * format → action (copy, open in an untitled editor, or Save As…). Cancelling
 * any step does nothing.
 *
 * Writes no ERD Studio file. Save As… writes only the file the user named in
 * the save dialog, through `workspace.fs` — an export, not a domain write, so
 * it is not an `applyDomainEdit` and records no own write.
 *
 * Every vscode call goes through `ExportDiagramUi`, so the flow is unit-tested
 * with plain fakes; `vscodeExportUi()` is the real one `activate()` uses.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { DIAGRAM_EXPORT_FILE_EXTENSIONS } from '@erd-studio/core';
import type { DiagramExportFormat } from '@erd-studio/core';

import { telemetry } from '../services/telemetryService';
import type { DomainExport } from '../services/diagramExport';

export const EXPORT_DIAGRAM_COMMAND = 'erdStudio.exportDiagram';

/** Every title says which stage is exported: the canvas also offers it on the physical stage. */
export const EXPORT_TITLE = 'Export Diagram (logical design)';

export const FORMAT_LABELS: Readonly<Record<DiagramExportFormat, string>> = { mermaid: 'Mermaid', dbml: 'DBML' };

/** The format QuickPick, in `DIAGRAM_EXPORT_FORMATS` order. */
export const FORMAT_ITEMS: ReadonlyArray<vscode.QuickPickItem & { format: DiagramExportFormat }> = [
  {
    label: 'Mermaid',
    description: `.${DIAGRAM_EXPORT_FILE_EXTENSIONS.mermaid}`,
    detail: 'Renders in GitHub, GitLab and Markdown docs',
    format: 'mermaid',
  },
  {
    label: 'DBML',
    description: `.${DIAGRAM_EXPORT_FILE_EXTENSIONS.dbml}`,
    detail: 'Opens in dbdiagram.io and other DBML tools',
    format: 'dbml',
  },
];

export type ExportAction = 'copy' | 'open' | 'save';

export const ACTION_ITEMS: ReadonlyArray<vscode.QuickPickItem & { action: ExportAction }> = [
  { label: '$(copy) Copy to Clipboard', action: 'copy' },
  { label: '$(go-to-file) Open in Editor', description: 'as an unsaved document', action: 'open' },
  { label: '$(save) Save As…', action: 'save' },
];

/** The language id an untitled export opens with, when the editor knows it. */
const LANGUAGE_IDS: Readonly<Record<DiagramExportFormat, string>> = { mermaid: 'mermaid', dbml: 'dbml' };

export const MERMAID_COPIED_MESSAGE =
  'Copied the diagram as Mermaid. On GitHub or GitLab, paste it inside a ```mermaid code block to see it drawn.';
export const DBML_COPIED_MESSAGE =
  'Copied the diagram as DBML. Paste it into dbdiagram.io or any other DBML tool.';
export const NO_DIAGRAMS_MESSAGE = 'There are no diagrams to export yet.';

/** Every vscode call the flow makes, injectable for tests. */
export interface ExportDiagramUi {
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  writeClipboard(text: string): Promise<void>;
  getLanguages(): Promise<string[]>;
  /** Open `content` as an untitled document in `language` and show it. */
  openUntitled(content: string, language: string): Promise<void>;
  showSaveDialog(options: vscode.SaveDialogOptions): Promise<vscode.Uri | undefined>;
  writeFile(uri: vscode.Uri, content: string): Promise<void>;
  /** Show a saved export in an editor. */
  openFile(uri: vscode.Uri): Promise<void>;
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showErrorMessage(message: string): void;
}

export interface ExportDiagramDeps {
  /** `exportDomainFile` bound to this window's services. Throws what `getDomain` throws. */
  exportDomain: (domainPath: string, format: DiagramExportFormat) => Promise<DomainExport>;
  /** The domain file of the focused ERD canvas, if one is focused. */
  activeDomainPath: () => string | undefined;
  /** Whether the project has any diagram; asked only before the picker. */
  hasDiagrams: () => boolean;
  /** The picker `erdStudio.openDomain` uses; undefined when cancelled. */
  pickDomain: () => Promise<string | undefined>;
  /** Where Save As… starts (the project root); the domain's own folder without it. */
  defaultSaveFolder?: string;
  ui?: ExportDiagramUi;
}

/** What the export ended in; undefined when the user cancelled or it failed (each already said so). */
export interface ExportDiagramResult {
  format: DiagramExportFormat;
  action: ExportAction;
  fileName: string;
  /** Save As… only. */
  savedTo?: string;
}

/**
 * The domain file an argument names: a Uri (the canvas, the explorer), a path
 * string, or the domain tree's node (`{ type: 'domain', summary: { filePath } }`).
 * Anything else — including the arguments a keybinding passes — is no argument.
 */
export function domainPathFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg.length > 0 ? arg : undefined;
  if (!arg || typeof arg !== 'object') return undefined;
  const candidate = arg as { fsPath?: unknown; scheme?: unknown; type?: unknown; summary?: { filePath?: unknown } };
  if (typeof candidate.fsPath === 'string' && candidate.fsPath.length > 0) {
    // Only a file on disk is a domain file: an untitled or remote-only Uri is not readable here.
    return candidate.scheme === undefined || candidate.scheme === 'file' ? candidate.fsPath : undefined;
  }
  if (candidate.type === 'domain' && typeof candidate.summary?.filePath === 'string' && candidate.summary.filePath) {
    return candidate.summary.filePath;
  }
  return undefined;
}

/** Run the flow. Never throws: a failure is shown and counted. */
export async function exportDiagramCommand(deps: ExportDiagramDeps, arg?: unknown): Promise<ExportDiagramResult | undefined> {
  const ui = deps.ui ?? vscodeExportUi();
  try {
    return await runExportDiagram(deps, ui, arg);
  } catch (err) {
    telemetry.error('exportFailed');
    ui.showErrorMessage(`Could not export the diagram: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function runExportDiagram(
  deps: ExportDiagramDeps,
  ui: ExportDiagramUi,
  arg: unknown,
): Promise<ExportDiagramResult | undefined> {
  let domainPath = domainPathFromArg(arg) ?? deps.activeDomainPath();
  if (!domainPath) {
    // Nothing to pick is a project state, counted apart from a cancel.
    if (!deps.hasDiagrams()) {
      telemetry.feature('exportNoDiagrams');
      void ui.showInformationMessage(NO_DIAGRAMS_MESSAGE);
      return undefined;
    }
    domainPath = await deps.pickDomain();
    if (!domainPath) { return cancelled(); }
  }

  const name = path.basename(domainPath, path.extname(domainPath));
  const formatPick = await ui.showQuickPick(FORMAT_ITEMS, {
    title: EXPORT_TITLE,
    placeHolder: `Export the design of "${name}" as…`,
    ignoreFocusOut: true,
  });
  if (!formatPick) { return cancelled(); }
  const format = formatPick.format;

  // Read before asking what to do with it, so a broken file is reported
  // before another question rather than after.
  const exported = await deps.exportDomain(domainPath, format);

  const actionPick = await ui.showQuickPick(ACTION_ITEMS, {
    title: `${EXPORT_TITLE}: ${FORMAT_LABELS[format]}`,
    placeHolder: `What should happen to ${exported.fileName}?`,
    ignoreFocusOut: true,
  });
  if (!actionPick) { return cancelled(); }
  const action = actionPick.action;
  const result: ExportDiagramResult = { format, action, fileName: exported.fileName };

  switch (action) {
    case 'copy': {
      await ui.writeClipboard(exported.content);
      void ui.showInformationMessage(format === 'mermaid' ? MERMAID_COPIED_MESSAGE : DBML_COPIED_MESSAGE);
      break;
    }
    case 'open': {
      const known = await ui.getLanguages().catch(() => [] as string[]);
      const language = known.includes(LANGUAGE_IDS[format]) ? LANGUAGE_IDS[format] : 'plaintext';
      await ui.openUntitled(exported.content, language);
      break;
    }
    case 'save': {
      const ext = DIAGRAM_EXPORT_FILE_EXTENSIONS[format];
      const folder = deps.defaultSaveFolder ?? path.dirname(domainPath);
      const target = await ui.showSaveDialog({
        title: `${EXPORT_TITLE}: Save ${FORMAT_LABELS[format]}`,
        defaultUri: vscode.Uri.file(path.join(folder, exported.fileName)),
        filters: { [FORMAT_LABELS[format]]: [ext] },
        saveLabel: 'Export',
      });
      if (!target) { return cancelled(); }
      await ui.writeFile(target, exported.content);
      result.savedTo = target.fsPath;
      void ui.showInformationMessage(`Exported ${path.basename(target.fsPath)}.`, 'Open').then((choice) => {
        if (choice === 'Open') { void ui.openFile(target); }
      });
      break;
    }
  }

  telemetry.feature(format === 'mermaid' ? 'exportMermaid' : 'exportDbml');
  return result;
}

function cancelled(): undefined {
  telemetry.feature('exportCancelled');
  return undefined;
}

/** The real `ExportDiagramUi`. */
export function vscodeExportUi(): ExportDiagramUi {
  return {
    showQuickPick: async (items, options) => vscode.window.showQuickPick([...items], options),
    writeClipboard: async (text) => { await vscode.env.clipboard.writeText(text); },
    getLanguages: async () => vscode.languages.getLanguages(),
    openUntitled: async (content, language) => {
      const doc = await vscode.workspace.openTextDocument({ content, language });
      await vscode.window.showTextDocument(doc, { preview: false });
    },
    showSaveDialog: async (options) => vscode.window.showSaveDialog(options),
    writeFile: async (uri, content) => { await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)); },
    openFile: async (uri) => { await vscode.window.showTextDocument(uri, { preview: false }); },
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: (message) => { void vscode.window.showErrorMessage(message); },
  };
}
