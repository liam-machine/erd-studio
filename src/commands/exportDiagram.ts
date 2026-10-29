/**
 * **Export Diagram…** (`erdStudio.exportDiagram`) — a domain's logical
 * (design) stage as Mermaid, DBML or DBML for dbdiagram.io (`dbml-rich`). Nothing about how ERD
 * Studio stores a diagram changes: the text comes from `@erd-studio/core`'s
 * `exportDiagram` through `exportSubjectAreaFile` (`src/services/diagramExport.ts`),
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
 * it is not an `applySubjectAreaEdit` and records no own write. For DBML for
 * dbdiagram.io it also writes the layout file beside it (`<same name>.dbdiagram`,
 * which `dbdiagram push` reads), asking first when that file already exists:
 * the user did not name it, so it is never replaced silently. Copy and Open
 * give the DBML alone, its header naming no layout file.
 *
 * Every vscode call goes through `ExportDiagramUi`, so the flow is unit-tested
 * with plain fakes; `vscodeExportUi()` is the real one `activate()` uses.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { DIAGRAM_EXPORT_FILE_EXTENSIONS } from '@erd-studio/core';
import type { DiagramExportFormat } from '@erd-studio/core';

import {
  OPEN_FILE_BUTTON,
  SEND_FEEDBACK_BUTTON,
  classifyWriteFailure,
  describeDiagramFileProblem,
  feedbackPrefill,
  oursMessage,
  projectRelative,
  showErrorWithActions,
  type ErrorActions,
  type FeedbackPrefill,
} from '../services/commandErrors';
import { telemetry } from '../services/telemetryService';
import { openTableFileAt } from './openModelFile';
import { DBDIAGRAM_LAYOUT_EXTENSION, type SubjectAreaExport } from '../services/diagramExport';
import { log } from '../services/logger';

export const EXPORT_DIAGRAM_COMMAND = 'erdStudio.exportDiagram';

/** Every title says which stage is exported: the canvas also offers it on the physical stage. */
export const EXPORT_TITLE = 'Export Diagram (logical design)';

export const FORMAT_LABELS: Readonly<Record<DiagramExportFormat, string>> = {
  mermaid: 'Mermaid',
  dbml: 'DBML',
  'dbml-rich': 'DBML for dbdiagram.io',
};

/**
 * The format QuickPick, in `DIAGRAM_EXPORT_FORMATS` order. The two DBML
 * choices say what each keeps, so the difference reads at a glance: plain
 * DBML works everywhere; the dbdiagram.io one keeps ERD Studio's fields and
 * the table positions but needs a newer DBML reader.
 */
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
    detail: "Opens in any DBML tool. ERD Studio's fields go in notes; no table positions",
    format: 'dbml',
  },
  {
    label: FORMAT_LABELS['dbml-rich'],
    description: `.${DIAGRAM_EXPORT_FILE_EXTENSIONS['dbml-rich']} + .${DBDIAGRAM_LAYOUT_EXTENSION}`,
    detail: "Keeps ERD Studio's fields and the table positions. Needs DBML 9.1 or later, as dbdiagram.io and dbdocs read",
    format: 'dbml-rich',
  },
];

/** The usage counter each format's export adds to. */
export const FORMAT_FEATURES = {
  mermaid: 'exportMermaid',
  dbml: 'exportDbml',
  'dbml-rich': 'exportDbmlRich',
} as const satisfies Readonly<Record<DiagramExportFormat, string>>;

export type ExportAction = 'copy' | 'open' | 'save';

export const ACTION_ITEMS: ReadonlyArray<vscode.QuickPickItem & { action: ExportAction }> = [
  { label: '$(copy) Copy to Clipboard', action: 'copy' },
  { label: '$(go-to-file) Open in Editor', description: 'as an unsaved document', action: 'open' },
  { label: '$(save) Save As…', action: 'save' },
];

/** The language id an untitled export opens with, when the editor knows it. */
const LANGUAGE_IDS: Readonly<Record<DiagramExportFormat, string>> = { mermaid: 'mermaid', dbml: 'dbml', 'dbml-rich': 'dbml' };

export const MERMAID_COPIED_MESSAGE =
  'Copied the diagram as Mermaid. On GitHub or GitLab, paste it inside a ```mermaid code block to see it drawn.';
export const DBML_COPIED_MESSAGE =
  'Copied the diagram as DBML. Paste it into dbdiagram.io or any other DBML tool.';
export const DBML_RICH_COPIED_MESSAGE =
  'Copied the diagram as DBML for dbdiagram.io. Paste it into dbdiagram.io or any tool that reads DBML 9.1 or later. ' +
  'The clipboard holds no table positions: use Save As… to keep them in a .dbdiagram file.';
export const DBML_RICH_OPENED_MESSAGE =
  'Opened the diagram as DBML for dbdiagram.io, without table positions. Use Save As… to keep them in a .dbdiagram file beside the .dbml.';
export const NO_DIAGRAMS_MESSAGE = 'There are no diagrams to export yet.';

/** The layout file's question's buttons (the modal adds Cancel). */
export const REPLACE_LAYOUT_BUTTON = 'Replace';
export const KEEP_LAYOUT_BUTTON = 'Save .dbml Only';

export { OPEN_FILE_BUTTON };
export const CHOOSE_ANOTHER_LOCATION_BUTTON = 'Choose Another Location';

/** A Save As… target inside the semantic dir (§5.7): refused, in every project. */
export function exportInsideSemanticDirMessage(semanticRoot: string): string {
  return `Save the export outside ${path.basename(semanticRoot)}/: files there are your diagrams' own storage.`;
}

/** Whether `filePath` is `folder` or inside it (compared without case, so a differently cased path on macOS or Windows counts). */
export function isInsideFolder(folder: string, filePath: string): boolean {
  const rel = path.relative(path.resolve(folder).toLowerCase(), path.resolve(filePath).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The name the "ours" message gives the command. */
const COMMAND_NAME = 'Export Diagram';

/** Every vscode call the flow makes, injectable for tests. */
export interface ExportDiagramUi {
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  writeClipboard(text: string): Promise<void>;
  getLanguages(): Promise<string[]>;
  /** Open `content` as an untitled document in `language` and show it. */
  openUntitled(content: string, language: string): Promise<void>;
  showSaveDialog(options: vscode.SaveDialogOptions): Promise<vscode.Uri | undefined>;
  /** Whether a file (or anything) is at `uri`. */
  fileExists(uri: vscode.Uri): Promise<boolean>;
  writeFile(uri: vscode.Uri, content: string): Promise<void>;
  /** Show a saved export in an editor. */
  openFile(uri: vscode.Uri): Promise<void>;
  /** Open a diagram file as text, the cursor at the 1-based line and column when given. */
  openFileAt(filePath: string, line?: number, column?: number): Promise<void>;
  /** Open Send Feedback (`erdStudio.reportBug`) with this prefill. */
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** A modal warning (VS Code adds Cancel): the button picked, undefined when cancelled. */
  showModalWarning(message: string, detail: string, ...items: string[]): Promise<string | undefined>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
}

export interface ExportDiagramDeps {
  /** `exportSubjectAreaFile` bound to this window's services. Throws what `getSubjectArea` throws. */
  exportDomain: (domainPath: string, format: DiagramExportFormat) => Promise<SubjectAreaExport>;
  /** The domain file of the focused ERD canvas, if one is focused. */
  activeDomainPath: () => string | undefined;
  /** Whether the project has any diagram; asked only before the picker. */
  hasDiagrams: () => boolean;
  /** The picker `erdStudio.openDomain` uses; undefined when cancelled. */
  pickDomain: () => Promise<string | undefined>;
  /** Where Save As… starts (the project root); without it, the project root for a diagram in the semantic dir, else the diagram's own folder. */
  defaultSaveFolder?: string;
  /**
   * The semantic dir (`<root>/.erd-studio`), absolute. A Save As… target
   * inside it is refused (§5.7): files there are the diagrams' own storage,
   * and an export saved as `<layer>/<name>.dbml` would overwrite one or show
   * up as a diagram.
   */
  semanticRoot?: string;
  /** The dbt project root, which messages name files relative to; just the file name without it. */
  projectRoot?: string;
  ui?: ExportDiagramUi;
}

/** What the export ended in; undefined when the user cancelled or it failed (each already said so). */
export interface ExportDiagramResult {
  format: DiagramExportFormat;
  action: ExportAction;
  fileName: string;
  /** Save As… only. */
  savedTo?: string;
  /** Save As… of DBML for dbdiagram.io, when its layout file was written. */
  layoutSavedTo?: string;
}

/**
 * The domain file an argument names: a Uri (the canvas, the explorer), a path
 * string, or the domain tree's node (`{ type: 'domain', summary: { filePath } }`).
 * Anything else — including the arguments a keybinding passes — is no argument.
 */
export function subjectAreaPathFromArg(arg: unknown): string | undefined {
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
    showFailure(ui, err instanceof ExportFailure ? err.shown : oursFailure(err, ui));
    return undefined;
  }
}

/** A failure already put in words: the message and its buttons. */
interface ShownFailure {
  message: string;
  actions: ErrorActions;
}

/** Thrown inside the flow for a failure that is already in words, so the one catch shows them. */
class ExportFailure extends Error {
  constructor(readonly shown: ShownFailure) {
    super(shown.message);
  }
}

/** Any failure that is not the user's to fix: ERD Studio's, with Send Feedback carrying the redacted error. */
function oursFailure(err: unknown, ui: ExportDiagramUi, doing = 'while exporting the diagram'): ShownFailure {
  return {
    message: oursMessage(COMMAND_NAME, doing, 'nothing was exported'),
    actions: { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(COMMAND_NAME, doing, err)) },
  };
}

/** Show the failure, and run the button the user picks; never awaited. */
function showFailure(ui: ExportDiagramUi, failure: ShownFailure): void {
  // A button that fails (Open File on a file deleted since) still says so, rather than seeming to do nothing.
  showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), failure.message, failure.actions, (choice, err) => {
    log.error(`[ERD Studio] ${COMMAND_NAME}: "${choice}" failed:`, err);
    showFailure(ui, oursFailure(err, ui, `while running ${choice}`));
  });
}

/**
 * The diagram file could not be read: in words, with Open File, when the
 * file is the user's to fix (#186's reasons); else the failure is ours.
 */
function readFailure(deps: ExportDiagramDeps, ui: ExportDiagramUi, domainPath: string, err: unknown): ShownFailure {
  const shown = deps.projectRoot ? projectRelative(deps.projectRoot, domainPath) : path.basename(domainPath);
  const problem = describeDiagramFileProblem(err, domainPath, shown);
  if (!problem) return oursFailure(err, ui);
  return {
    message: `${shown} can't be exported because the diagram file has a problem: ${problem.reason}.`,
    actions: problem.openable
      ? { [OPEN_FILE_BUTTON]: () => ui.openFileAt(domainPath, problem.line, problem.column) }
      : {},
  };
}

/** Save As… failed: a folder the user may not write or a full disk, with another try; else ours. */
function saveFailure(ui: ExportDiagramUi, target: vscode.Uri, err: unknown, chooseAgain: () => unknown): ShownFailure {
  const failure = classifyWriteFailure(err);
  if (failure === 'other') return oursFailure(err, ui);
  const why = failure === 'permission' ? "ERD Studio isn't allowed to write to that folder" : 'the disk is full';
  return {
    message: `Couldn't save ${path.basename(target.fsPath)}: ${why}.`,
    actions: { [CHOOSE_ANOTHER_LOCATION_BUTTON]: chooseAgain },
  };
}

async function runExportDiagram(
  deps: ExportDiagramDeps,
  ui: ExportDiagramUi,
  arg: unknown,
): Promise<ExportDiagramResult | undefined> {
  let domainPath = subjectAreaPathFromArg(arg) ?? deps.activeDomainPath();
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
  const readPath = domainPath;
  const exported = await deps.exportDomain(readPath, format).catch((err: unknown) => {
    throw new ExportFailure(readFailure(deps, ui, readPath, err));
  });

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
      await ui.writeClipboard(textWithoutLayout(exported));
      void ui.showInformationMessage(COPIED_MESSAGES[format]);
      break;
    }
    case 'open': {
      const known = await ui.getLanguages().catch(() => [] as string[]);
      const language = known.includes(LANGUAGE_IDS[format]) ? LANGUAGE_IDS[format] : 'plaintext';
      await ui.openUntitled(textWithoutLayout(exported), language);
      if (exported.layout) { void ui.showInformationMessage(DBML_RICH_OPENED_MESSAGE); }
      break;
    }
    case 'save': {
      const folder = deps.defaultSaveFolder
        ?? (deps.semanticRoot !== undefined && isInsideFolder(deps.semanticRoot, domainPath)
          ? deps.projectRoot ?? path.dirname(deps.semanticRoot)
          : path.dirname(domainPath));
      const saved = await saveAs(ui, format, exported, vscode.Uri.file(path.join(folder, exported.fileName)), deps.semanticRoot);
      if (!saved) { return cancelled(); }
      result.savedTo = saved.savedTo;
      if (saved.layoutSavedTo) { result.layoutSavedTo = saved.layoutSavedTo; }
      break;
    }
  }

  telemetry.feature(FORMAT_FEATURES[format]);
  return result;
}

const COPIED_MESSAGES: Readonly<Record<DiagramExportFormat, string>> = {
  mermaid: MERMAID_COPIED_MESSAGE,
  dbml: DBML_COPIED_MESSAGE,
  'dbml-rich': DBML_RICH_COPIED_MESSAGE,
};

/** The text for the clipboard or an untitled editor: nothing sits beside it, so a rich export's header names no layout file. */
function textWithoutLayout(exported: SubjectAreaExport): string {
  return exported.layout ? exported.layout.dbmlWithLayoutFileName('') : exported.content;
}

/** Where Save As… put the export. */
interface Saved {
  savedTo: string;
  /** The layout file written beside a rich DBML export; undefined when the user kept the one there. */
  layoutSavedTo?: string;
}

/**
 * The layout file for a rich DBML export saved as `target`: the same name
 * with `.dbdiagram` (what `dbdiagram push` looks for). A target that is
 * itself named `.dbdiagram` gets `.dbdiagram` added rather than being
 * overwritten by its own layout.
 */
export function layoutUriFor(target: vscode.Uri): vscode.Uri {
  const parsed = path.parse(target.fsPath);
  const beside = path.join(parsed.dir, `${parsed.name}.${DBDIAGRAM_LAYOUT_EXTENSION}`);
  return vscode.Uri.file(beside.toLowerCase() === target.fsPath.toLowerCase() ? `${target.fsPath}.${DBDIAGRAM_LAYOUT_EXTENSION}` : beside);
}

/**
 * Save As…, starting at `startAt`: the saved path, or undefined when
 * cancelled. A failed write throws its words, with Choose Another Location
 * reopening the dialog where the user last tried.
 */
async function saveAs(
  ui: ExportDiagramUi,
  format: DiagramExportFormat,
  exported: SubjectAreaExport,
  startAt: vscode.Uri,
  semanticRoot?: string,
): Promise<Saved | undefined> {
  const target = await ui.showSaveDialog({
    title: `${EXPORT_TITLE}: Save ${FORMAT_LABELS[format]}`,
    defaultUri: startAt,
    filters: { [FORMAT_LABELS[format]]: [DIAGRAM_EXPORT_FILE_EXTENSIONS[format]] },
    saveLabel: 'Export',
  });
  if (!target) { return undefined; }
  const name = path.basename(target.fsPath);
  // Never into the diagrams' own storage (§5.7), in every project: nothing is written.
  if (semanticRoot !== undefined && isInsideFolder(semanticRoot, target.fsPath)) {
    const outside = vscode.Uri.file(path.join(path.dirname(semanticRoot), name));
    showFailure(ui, {
      message: exportInsideSemanticDirMessage(semanticRoot),
      actions: { [CHOOSE_ANOTHER_LOCATION_BUTTON]: () => retrySave(ui, format, exported, outside, semanticRoot) },
    });
    return undefined;
  }

  // The layout file goes beside the .dbml under the same name. The save
  // dialog asked about the file the user named; this one they did not, so
  // ask before replacing it — before anything is written.
  let layoutTarget: vscode.Uri | undefined;
  let content = exported.content;
  if (exported.layout) {
    layoutTarget = layoutUriFor(target);
    const layoutName = path.basename(layoutTarget.fsPath);
    if (await ui.fileExists(layoutTarget).catch(() => false)) {
      const choice = await ui.showModalWarning(
        `${layoutName} already exists. Replace it?`,
        `It holds the table positions dbdiagram.io uses for ${name}. Replacing it gives it this diagram's positions.`,
        REPLACE_LAYOUT_BUTTON,
        KEEP_LAYOUT_BUTTON,
      );
      if (choice === undefined) { return undefined; }
      if (choice === KEEP_LAYOUT_BUTTON) { layoutTarget = undefined; }
    }
    // The header names the layout file by the name it has beside this .dbml.
    content = exported.layout.dbmlWithLayoutFileName(layoutName);
  }

  const retry = () => retrySave(ui, format, exported, target, semanticRoot);
  try {
    await ui.writeFile(target, content);
  } catch (err) {
    throw new ExportFailure(saveFailure(ui, target, err, retry));
  }
  if (layoutTarget && exported.layout) {
    try {
      await ui.writeFile(layoutTarget, exported.layout.content);
    } catch (err) {
      throw new ExportFailure(layoutSaveFailure(ui, name, layoutTarget, err, retry));
    }
  }

  const message = !exported.layout
    ? `Exported ${name}.`
    : layoutTarget
      ? `Exported ${name} and its table positions, ${path.basename(layoutTarget.fsPath)}.`
      : `Exported ${name}. ${path.basename(layoutUriFor(target).fsPath)} was left as it was.`;
  void ui.showInformationMessage(message, 'Open').then((choice) => {
    if (choice === 'Open') { void ui.openFile(target); }
  });
  return { savedTo: target.fsPath, ...(layoutTarget ? { layoutSavedTo: layoutTarget.fsPath } : {}) };
}

/** The .dbml was saved but its layout file was not: say both, so the user knows what is on disk. */
function layoutSaveFailure(ui: ExportDiagramUi, savedName: string, layoutTarget: vscode.Uri, err: unknown, chooseAgain: () => unknown): ShownFailure {
  const layoutName = path.basename(layoutTarget.fsPath);
  const failure = classifyWriteFailure(err);
  if (failure === 'other') {
    const doing = 'while saving the table positions';
    return {
      message: oursMessage(COMMAND_NAME, doing, `${savedName} was saved without ${layoutName}`),
      actions: { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(COMMAND_NAME, doing, err)) },
    };
  }
  const why = failure === 'permission' ? "ERD Studio isn't allowed to write it" : 'the disk is full';
  return {
    message: `Saved ${savedName}, but couldn't save its table positions, ${layoutName}: ${why}.`,
    actions: { [CHOOSE_ANOTHER_LOCATION_BUTTON]: chooseAgain },
  };
}

/** Choose Another Location: the save step again, counted and shown as the first one was. */
async function retrySave(ui: ExportDiagramUi, format: DiagramExportFormat, exported: SubjectAreaExport, previous: vscode.Uri, semanticRoot?: string): Promise<void> {
  try {
    if (await saveAs(ui, format, exported, previous, semanticRoot)) {
      telemetry.feature(FORMAT_FEATURES[format]);
    } else {
      cancelled();
    }
  } catch (err) {
    telemetry.error('exportFailed');
    showFailure(ui, err instanceof ExportFailure ? err.shown : oursFailure(err, ui));
  }
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
    fileExists: async (uri) => vscode.workspace.fs.stat(uri).then(() => true, () => false),
    writeFile: async (uri, content) => { await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)); },
    openFile: async (uri) => { await vscode.window.showTextDocument(uri, { preview: false }); },
    openFileAt: (filePath, line, column) => openTableFileAt(filePath, line, column),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showModalWarning: async (message, detail, ...items) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...items),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
  };
}
