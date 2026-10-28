/**
 * ERD Studio: Move Relationships to Model Library (issue #126).
 *
 * The opt-in for an existing project: every relationship its v5 domain files
 * hold is stored once, in the `logical-models/*.yml` of the model holding the
 * foreign key, and taken out of the domain files. A library entry already
 * stored on its "one" side (a `one-to-many`) is moved to that model too
 * (#133), so a new fact never means editing its dimensions. A relationship the domains define in different
 * ways (cardinality, role, or which end of a one-to-one holds the key) is
 * settled by the user — one QuickPick per conflict, naming the diagrams behind
 * each version — or left as it is in each diagram. Prompted.
 *
 * Disk is the one source of truth, and the files are written directly — not
 * through a WorkspaceEdit. 1.6.6 edited them through VS Code's documents and
 * then saved each one; on a large project VS Code had already disposed some of
 * those documents ("Document has been closed"), and an in-memory copy older
 * than disk refused to save ("File Modified Since"), so the move left every
 * file open and unsaved, or half applied. Now each new text is computed from
 * the file's current bytes with the surgical edits in `minimalEdits` (only the
 * relationships change), a file open with unsaved edits stops the move before
 * anything is written, and the writes are all-or-nothing: if one fails, every
 * file already written is put back.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { VALID_CARDINALITIES, linkKey, normaliseCompositeKey, normaliseRelationshipRole, normaliseSubjectAreaDocument, parseTableText } from '@erd-studio/core';
import { dirtyFiles } from '../providers/dirtyDocuments';
import { saveDocumentByUri } from '../providers/documentSave';
import {
  OPEN_FILE_BUTTON,
  RELOAD_WINDOW_BUTTON,
  SAVE_AND_TRY_AGAIN_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  classifyWriteFailure,
  failedPath,
  feedbackPrefill,
  oursMessage,
  projectRelative,
  showErrorWithActions as showErrorWith,
  type ErrorActions,
} from '../services/commandErrors';
import {
  applyMoveToTable,
  describeConflictDefinition,
  describeLeftAlone,
  describeMovePlan,
  moveTargets,
  planMoveToLibrary,
  resolveConflict,
} from '../services/libraryRelationships';
import type { ConflictDefinition } from '../services/libraryRelationships';
import type { DbtKeyIndex } from '@erd-studio/core';
import { relationshipsRewriteLoses, setSubjectAreaRelationships, setYamlRelationships } from '../services/minimalEdits';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';
import { checkLibraryRewrite, moveUsage } from '../services/relationshipHealth';
import { detectSubjectAreaFormat } from '../types/semantic';
import type { Relationship, SemanticTable } from '../types/semantic';
import type { SubjectAreaService } from '../services/domainService';
import type { TableLibraryService } from '../services/logicalModelService';

const TITLE = 'Move Relationships to Table Library';

/** Move Relationships in a DBML project (§5.7): there is nothing a diagram file can hold. */
export const DBML_NOTHING_TO_MOVE_MESSAGE = 'Nothing to move: relationships in a DBML project are already in the table library.';

/** A mixed project's way to move a diagram's relationships onto DBML tables (§6.3). */
const MIXED_DBML_OWNER_HINT = 'Convert the project to DBML (ERD Studio: Convert Project to DBML) to move them.';

export interface MoveRelationshipsDeps {
  workspaceRoot: string;
  semanticDir: string;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>;
  tableLibraryService: Pick<TableLibraryService, 'getTable' | 'listTables' | 'tablePath' | 'invalidateCache' | 'getTablesDir'>
    & Partial<Pick<TableLibraryService, 'findTableNameIgnoringCase' | 'hasTablesLibrary' | 'isTableNamingFile' | 'projectStorage'>>;
  /** Refresh the trees, open canvases and selectors once the files are written. */
  onWritten: (domainPaths: string[]) => Promise<void>;
  /** Test seam: how one file is written. Defaults to {@link writeFileAtomic}. */
  writeFile?: (filePath: string, text: string) => void;
  /** dbt's key evidence (#133 L1), loaded once before planning. Without it, only key flags count. */
  loadDbtKeyIndex?: () => Promise<DbtKeyIndex>;
}

/** A v5 or v6 domain file's models and own relationships, as read from disk (v6 under its v5 keys, #182). */
export interface SubjectAreaRelationships {
  /** `{layer}/{domain}`, as the user knows it. */
  label: string;
  filePath: string;
  models: string[];
  relationships: Relationship[];
}

/**
 * Every readable v5 and v6 domain file's models and `logical.relationships`.
 * A DBML diagram is skipped by its storage, not by failing to parse as JSON:
 * it holds no relationships (they live in the library's relationships files).
 */
export function readSubjectAreaRelationships(
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>,
  workspaceRoot: string,
  semanticDir: string,
): SubjectAreaRelationships[] {
  const domains: SubjectAreaRelationships[] = [];
  for (const summary of subjectAreaService.listSubjectAreas(workspaceRoot, semanticDir)) {
    if (summary.storage === 'dbml') continue;
    try {
      const file = JSON.parse(fs.readFileSync(summary.filePath, 'utf-8')) as Record<string, unknown>;
      const format = detectSubjectAreaFormat(file);
      if (format !== 'v5' && format !== 'v6') continue;
      const raw = format === 'v6' ? normaliseSubjectAreaDocument(file) : file;
      const logical = raw.logical as { models?: unknown; relationships?: unknown } | undefined;
      const models = (Array.isArray(logical?.models) ? logical!.models : []).filter((m): m is string => typeof m === 'string');
      const relationships = (Array.isArray(logical?.relationships) ? logical!.relationships : [])
        .filter((r): r is Relationship => !!r && typeof r === 'object'
          && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string'))
        // An unrecognised cardinality is drawn as many-to-one (core's parseRelationships);
        // the move stores what the diagram shows, never the typo.
        .map((r) => (VALID_CARDINALITIES.has(r.cardinality) ? r : { ...r, cardinality: 'many-to-one' as const }))
        .map(({ role, compositeKey, ...r }) => {
          const label = normaliseRelationshipRole(role);
          const key = normaliseCompositeKey(compositeKey);
          return { ...r, ...(label ? { role: label } : {}), ...(key ? { compositeKey: key } : {}) };
        });
      domains.push({ label: `${summary.layer}/${summary.domain}`, filePath: summary.filePath, models, relationships });
    } catch {
      // An unreadable domain keeps its relationships.
    }
  }
  return domains;
}

/**
 * Write `text` to `filePath` atomically: a unique temp file in the same folder,
 * then a rename over the target, so a reader never sees half a file.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, text, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* the temp file may not exist */ }
    throw err;
  }
}

/** The buttons the move's errors offer (#204); the shared ones live in commandErrors. */
export { TRY_AGAIN_BUTTON, SHOW_FILE_BUTTON, SAVE_AND_TRY_AGAIN_BUTTON, RELOAD_WINDOW_BUTTON };
export const OPEN_SOURCE_CONTROL_BUTTON = 'Open Source Control';

/**
 * The move stopped before writing anything, because of what is in the user's
 * files (one changed while the dialog was open, or no longer reads as a
 * table). Its message is the user's sentence; `filePath` is the file to open.
 */
class MoveStopped extends Error {
  constructor(message: string, readonly filePath?: string) {
    super(message);
    this.name = 'MoveStopped';
  }
}

/**
 * Show an error with its buttons, and run the one the user picks. Never
 * awaited: the command resolves while the toast is still up. A button that
 * fails says so, rather than seeming to do nothing.
 */
function showErrorWithActions(message: string, actions: ErrorActions): void {
  showErrorWith((m, ...items) => vscode.window.showErrorMessage(m, ...items), message, actions, (choice, err) => {
    console.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
    const doing = `while running ${choice}`;
    showErrorWithActions(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
  });
}

/** Send Feedback, prefilled with the redacted failure: for a failure that is ours. */
function sendFeedback(doing: string, err: unknown): () => unknown {
  return () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(TITLE, doing, err));
}

const openFile = (filePath: string) => () => vscode.window.showTextDocument(vscode.Uri.file(filePath));
const openSourceControl = () => vscode.commands.executeCommand('workbench.view.scm');

/**
 * Refuse when any of `filePaths` is open with unsaved edits — the user's work
 * in progress; writing under it would leave VS Code holding a copy that no
 * longer matches disk. Returns true (and has told the user) when refused.
 */
function refuseIfDirty(filePaths: Iterable<string>, relPath: (filePath: string) => string, retry: () => Promise<void>): boolean {
  const dirtyPaths = dirtyFiles(filePaths);
  if (dirtyPaths.length === 0) return false;
  telemetry.error('relMoveDirtyFiles');
  const dirty = dirtyPaths.map(relPath);
  const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ` and ${dirty.length - 5} more` : '');
  const saveAndRetry = async (): Promise<void> => {
    for (const [i, filePath] of dirtyPaths.entries()) {
      if (!(await saveDocumentByUri(vscode.Uri.file(filePath)))) {
        // Nothing to retry: the move would stop on the same file.
        showErrorWithActions(
          `${TITLE}: ERD Studio couldn't save ${dirty[i]}. Save or revert it yourself, then run the move again. Nothing was changed.`,
          { [SHOW_FILE_BUTTON]: openFile(filePath) },
        );
        return;
      }
    }
    await retry();
  };
  showErrorWithActions(
    `${TITLE}: ${dirty.length === 1 ? 'a file it would change has' : `${dirty.length} files it would change have`} unsaved edits — ${shown}. ` +
    'Save or revert these first, then run the move again. Nothing was changed.',
    {
      ...(dirtyPaths.length === 1 ? { [SHOW_FILE_BUTTON]: openFile(dirtyPaths[0]) } : {}),
      [SAVE_AND_TRY_AGAIN_BUTTON]: saveAndRetry,
    },
  );
  return true;
}

/**
 * The command. Never throws: anything unexpected is shown as an error and
 * counted, so neither the palette nor the canvas offer can swallow it. The
 * message never carries the raw exception (#204): a stop caused by the user's
 * files says which file, and anything else is ERD Studio's, with Send Feedback.
 */
export async function moveRelationshipsToLibrary(deps: MoveRelationshipsDeps): Promise<void> {
  const progress = { saved: false };
  const retry = (): Promise<void> => moveRelationshipsToLibrary(deps);
  try {
    await runMove(deps, progress, retry);
  } catch (err) {
    telemetry.error('relMoveFailed');
    console.error('[moveRelationshipsToLibrary] failed:', err);
    if (err instanceof MoveStopped) {
      showErrorWithActions(`${TITLE}: ${err.message}`, {
        ...(err.filePath ? { [OPEN_FILE_BUTTON]: openFile(err.filePath) } : {}),
        [TRY_AGAIN_BUTTON]: retry,
      });
      return;
    }
    if (progress.saved) {
      // Every file is written; only what follows the writes failed.
      const doing = 'after saving the moved relationships';
      showErrorWithActions(oursMessage(TITLE, doing, 'open diagrams may not show the move until you reload the window'), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
        [RELOAD_WINDOW_BUTTON]: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
      });
      return;
    }
    const doing = 'while planning the move';
    showErrorWithActions(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
      [TRY_AGAIN_BUTTON]: retry,
    });
  }
}

async function runMove(deps: MoveRelationshipsDeps, progress: { saved: boolean }, retry: () => Promise<void>): Promise<void> {
  const { workspaceRoot, semanticDir, subjectAreaService, tableLibraryService } = deps;
  const writeFile = deps.writeFile ?? writeFileAtomic;
  telemetry.feature('relMoveStarted');
  // Hidden by its `when` clause in a DBML project, where relationships only live in the library (D5).
  if (tableLibraryService.projectStorage?.() === 'dbml') {
    telemetry.feature('relMoveNothingToMove');
    void vscode.window.showInformationMessage(DBML_NOTHING_TO_MOVE_MESSAGE);
    return;
  }
  // Read the library fresh: a cached copy may predate an edit made on disk.
  tableLibraryService.invalidateCache();
  const domains = readSubjectAreaRelationships(subjectAreaService, workspaceRoot, semanticDir)
    .filter((d) => d.relationships.length > 0);

  // One object per model, whatever the spelling an entry uses (#133 L4):
  // `Dim_Customer` reaches dim_customer.yml on a case-sensitive file system,
  // and both spellings in one plan edit the same copy.
  const models = new Map<string, SemanticTable | null>();
  const libraryModel = (name: string): SemanticTable | null => {
    const key = name.toLowerCase();
    if (!models.has(key)) models.set(key, tableLibraryService.getTable(tableLibraryService.findTableNameIgnoringCase?.(name) ?? name));
    return models.get(key) ?? null;
  };
  /** The model's file, by its real name. */
  const pathOf = (name: string): string => tableLibraryService.tablePath(libraryModel(name)?.name ?? name);
  const libraryRoot = path.dirname(tableLibraryService.getTablesDir());
  const relPath = (filePath: string): string => path.relative(libraryRoot, filePath).split(path.sep).join('/');
  const fileOf = (model: string): string => relPath(pathOf(model));
  // A file whose relationships list holds comments, YAML anchors or unreadable entries is
  // never rewritten: re-rendering the list would lose them.
  const lockedFiles = new Map<string, boolean>();
  const locked = (name: string): boolean => {
    if (!lockedFiles.has(name)) {
      let loses = false;
      try {
        loses = relationshipsRewriteLoses(fs.readFileSync(pathOf(name), 'utf-8'));
      } catch {
        // Unreadable: the plan already leaves a model with no readable file alone.
      }
      lockedFiles.set(name, loses);
    }
    return lockedFiles.get(name)!;
  };
  // dbt's tests orient links between models that flag no key (#133 L1).
  const dbt = deps.loadDbtKeyIndex ? await deps.loadDbtKeyIndex().catch(() => undefined) : undefined;
  let plan = planMoveToLibrary(domains, libraryModel, tableLibraryService.listTables(), locked, { dbt });
  if (plan.removeFromDomains.size === 0 && plan.conflicts.length === 0 && plan.rehome.length === 0) {
    telemetry.feature('relMoveNothingToMove');
    const leftAlone = describeLeftAlone(plan, fileOf);
    if (leftAlone.length > 0) {
      void vscode.window.showInformationMessage(
        `${TITLE}: nothing was moved.`,
        { modal: true, detail: leftAlone.join('\n').replace(/^\n/, '') },
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `${TITLE}: nothing to move — ${domains.length === 0
        ? 'no diagram file holds a relationship of its own, and every relationship in the Table Library is stored with the table holding the foreign key.'
        : 'every relationship in the diagram files starts at a table with no readable file in the Table Library.'}`,
    );
    return;
  }
  // Checked before asking anything, so nobody settles conflicts only to be
  // turned away; checked again before writing, in case a file was edited
  // while the dialog was open.
  const candidates = [
    ...plan.toLibrary.map((r) => pathOf(r.fromModel)),
    // A conflict lands at either end, depending on the cardinality picked.
    ...plan.conflicts.flatMap((c) => [c.relationship.fromModel, c.relationship.toModel]).map(pathOf),
    ...plan.rehome.flatMap((r) => [r.from, r.to.fromModel]).map(pathOf),
    ...domains
      .filter((d) => plan.removeFromDomains.has(d.label) || plan.conflicts.some((c) => c.definitions.some((def) => def.domains.includes(d.label))))
      .map((d) => d.filePath),
  ];
  if (refuseIfDirty(candidates, relPath, retry)) return;

  const onlyRehome = plan.removeFromDomains.size === 0 && plan.conflicts.length === 0;
  const choice = await vscode.window.showInformationMessage(
    onlyRehome
      ? 'Store each relationship with the table that holds the foreign key?'
      : 'Define each relationship once, in the Table Library?',
    {
      modal: true,
      detail: `${describeMovePlan(plan, fileOf)}\n\nThe move saves the files directly — use git (or your source control) to undo it.`,
    },
    plan.conflicts.length > 0 ? 'Continue' : 'Move Relationships',
  );
  if (choice !== 'Continue' && choice !== 'Move Relationships') {
    telemetry.feature('relMoveCancelled');
    return;
  }

  // Each conflict is the user's to settle: which version every diagram draws.
  const conflicts = plan.conflicts;
  if (conflicts.length > 0) telemetry.feature('relMoveConflictShown');
  for (const [index, conflict] of conflicts.entries()) {
    const { fromModel, fromColumn, toModel, toColumn } = conflict.relationship;
    const picked = await vscode.window.showQuickPick(
      [
        ...conflict.definitions.map((d) => ({
          label: describeConflictDefinition(d),
          description: `as in ${d.domains.join(', ')}`,
          detail: `Saved once in ${fileOf(d.relationship.fromModel)}; every diagram with ${fromModel} and ${toModel} draws it this way.`,
          definition: d as ConflictDefinition | undefined,
        })),
        {
          label: 'Leave it as it is in each diagram',
          description: 'decide later',
          detail: 'It stays in the diagram files. Run this command again to settle it.',
          definition: undefined,
        },
      ],
      {
        title: `Conflict ${index + 1} of ${conflicts.length}: ${fromModel}.${fromColumn} ↔ ${toModel}.${toColumn}`,
        placeHolder: 'The diagrams draw this link differently. Which version should every diagram use? (Esc cancels the move)',
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      telemetry.feature('relMoveCancelled');
      void vscode.window.showInformationMessage(`${TITLE}: cancelled — nothing was changed.`);
      return;
    }
    if (picked.definition) plan = resolveConflict(plan, conflict, picked.definition);
  }
  if (plan.removeFromDomains.size === 0 && plan.rehome.length === 0) {
    telemetry.feature('relMoveCancelled');
    void vscode.window.showInformationMessage(`${TITLE}: nothing was changed.`);
    return;
  }

  // The plan is final. Every new text is computed from the file's bytes on
  // disk now — after the modal and the QuickPicks, which may have taken a
  // while — changing only its relationships.
  const writes: Array<{ filePath: string; original: string; text: string }> = [];
  // Every target file as read and as it will be written, for the self-check below.
  const readModels: SemanticTable[] = [];
  const nextModels: SemanticTable[] = [];
  for (const target of moveTargets(plan)) {
    const name = libraryModel(target)?.name ?? target;
    const filePath = tableLibraryService.tablePath(name);
    if (filePath.toLowerCase().endsWith('.dbml')) {
      // A mixed project: a DBML table's relationships are Refs in its folder's relationships file.
      throw new MoveStopped(`${relPath(filePath)} is a DBML table, and this command moves relationships into YAML table files only. ${MIXED_DBML_OWNER_HINT} Nothing was changed.`, filePath);
    }
    const original = fs.readFileSync(filePath, 'utf-8');
    if (relationshipsRewriteLoses(original)) {
      throw new MoveStopped(`${relPath(filePath)} changed while the dialog was open (its relationships list now has comments, YAML anchors or entries it cannot read). Nothing was changed.`, filePath);
    }
    const model = parseTableText(original, name);
    if (!model) throw new MoveStopped(`${relPath(filePath)} could not be read as a table file. Fix it, then try again. Nothing was changed.`, filePath);
    const copy: SemanticTable = { ...model, relationships: model.relationships ? [...model.relationships] : undefined };
    readModels.push(model);
    nextModels.push(copy);
    if (!applyMoveToTable(plan, copy)) continue;
    // A file in `tables/` is written in the v6 naming (#182); otherwise in whichever the file uses.
    const text = setYamlRelationships(original, copy.relationships ?? [], tableLibraryService.isTableNamingFile?.(filePath) || undefined);
    if (text !== original) writes.push({ filePath, original, text });
  }
  const domainPaths: string[] = [];
  for (const domain of domains) {
    const keys = plan.removeFromDomains.get(domain.label);
    if (!keys) continue;
    const original = fs.readFileSync(domain.filePath, 'utf-8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    // A v6 file (#182) is read under its v5 keys; setSubjectAreaRelationships writes it back in v6.
    const raw = (detectSubjectAreaFormat(parsed) === 'v6' ? normaliseSubjectAreaDocument(parsed) : parsed) as { logical?: { relationships?: unknown } };
    const current = Array.isArray(raw.logical?.relationships) ? raw.logical!.relationships as Relationship[] : [];
    const isRelationship = (r: unknown): r is Relationship => !!r && typeof r === 'object'
      && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string');
    const kept = current.filter((r) => !isRelationship(r) || !keys.has(linkKey(r)));
    if (kept.length === current.length) continue;
    const text = setSubjectAreaRelationships(original, kept);
    if (text === original) continue;
    writes.push({ filePath: domain.filePath, original, text });
    domainPaths.push(domain.filePath);
  }

  if (refuseIfDirty(writes.map((w) => w.filePath), relPath, retry)) return;

  // Self-check of the planned rewrite (#133 telemetry): recorded and logged, never blocking it.
  const broken = checkLibraryRewrite(readModels, nextModels, [...plan.toLibrary, ...plan.rehome.map((r) => r.to)]);
  if (broken.length > 0) {
    telemetry.relationshipInvariants(broken);
    console.warn(`[moveRelationshipsToLibrary] relationship self-check: ${broken.join(', ')}`);
  }

  // All or nothing: if one write fails, every file already written is put back.
  const written: typeof writes = [];
  for (const write of writes) {
    try {
      writeFile(write.filePath, write.text);
    } catch (err) {
      const unrestored: string[] = [];
      for (const done of written.reverse()) {
        try {
          writeFile(done.filePath, done.original);
          ownWrites.recordWrite(done.filePath);
        } catch {
          unrestored.push(relPath(done.filePath));
        }
      }
      tableLibraryService.invalidateCache();
      telemetry.error('relMoveWriteFailed');
      if (unrestored.length > 0) telemetry.error('relMoveRestoreFailed');
      showWriteFailure(err, relPath(write.filePath), unrestored, workspaceRoot, retry);
      return;
    }
    written.push(write);
    // Recorded once the bytes are on disk (the tracker stats the file), so
    // the watchers skip this write; the caller issues the refreshes.
    ownWrites.recordWrite(write.filePath);
  }

  progress.saved = writes.length > 0;
  tableLibraryService.invalidateCache();
  try {
    await deps.onWritten(domainPaths);
  } catch (err) {
    // The files are written; a failed refresh must not report the move as failed.
    console.error('[moveRelationshipsToLibrary] refresh after the move failed:', err);
  }

  const moved = plan.toLibrary.length;
  const turned = plan.rehome.length;
  const left = plan.conflicts.length + plan.skippedNoModel.length;
  const unsettled = plan.disagreements.length + plan.lockedFiles.length;
  telemetry.feature('relMoveCompleted');
  if (left + unsettled > 0) telemetry.feature('relMoveLeftover');
  telemetry.relationshipUsage(moveUsage(plan));
  const parts = [
    ...(moved > 0 || !turned ? [`Moved ${moved} relationship${moved === 1 ? '' : 's'} into the Table Library — each is now defined once.`] : []),
    ...(turned > 0 ? [`${turned} relationship${turned === 1 ? ' is' : 's are'} now stored with the table holding the foreign key.`] : []),
  ];
  void vscode.window.showInformationMessage(
    parts.join(' ') +
    (left > 0 ? ` ${left} stayed in the diagram files; run this command again to settle ${left === 1 ? 'it' : 'them'}.` : '') +
    (unsettled > 0 ? ' Some were left as they are for you to fix by hand, as the preview listed.' : ''),
  );
}

/**
 * A write that failed, after every file already written was put back (or
 * not): a folder the user may not write to or a full disk in plain words,
 * anything else as ERD Studio's problem (#204). Never the raw exception.
 */
function showWriteFailure(err: unknown, file: string, unrestored: string[], workspaceRoot: string, retry: () => Promise<void>): void {
  const restored = unrestored.length === 0;
  const outcome = restored
    ? 'Every file was put back as it was; nothing was changed.'
    : `These files could not be put back and are half moved: ${unrestored.join(', ')}. Restore them from source control.`;
  const next: ErrorActions = restored
    ? { [TRY_AGAIN_BUTTON]: retry }
    : { [OPEN_SOURCE_CONTROL_BUTTON]: openSourceControl };
  const failure = classifyWriteFailure(err);
  if (failure === 'other') {
    const doing = `while saving ${file}`;
    showErrorWithActions(
      oursMessage(TITLE, doing, restored ? 'nothing was changed' : `these files are half moved: ${unrestored.join(', ')}. Restore them from source control`),
      { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err), ...next },
    );
    return;
  }
  const failedAt = failedPath(err);
  const why = failure === 'permission'
    ? `ERD Studio isn't allowed to write to ${failedAt ? `${projectRelative(workspaceRoot, path.dirname(failedAt))}/` : 'that folder'}. Check its permissions, then try again.`
    : 'the disk is full. Free up some space, then try again.';
  showErrorWithActions(`${TITLE} couldn't save ${file}: ${why} ${outcome}`, next);
}
