/**
 * ERD Studio: Repair Relationships… (issue #133, R10), and the runner
 * "Move Relationships to Model Library" shares with it.
 *
 * The plan comes from `src/services/relationshipRepair.ts` (no `vscode`);
 * this file owns the dialogs and the writes:
 *
 * 1. Read the project fresh and plan. Nothing to do → say so (and point at
 *    any entry that could not be read, opening its file at the line).
 * 2. Refuse, before asking anything, when a file the repair might change is
 *    open with unsaved edits.
 * 3. One QuickPick per relationship only the user can settle, each with
 *    "Leave as is"; Esc cancels everything.
 * 4. A modal preview naming every file and change (plus "Show Full Diff…",
 *    a read-only diff of one file); nothing is written until it is confirmed.
 * 5. Disk only, like the move since 1.6.7: each new text is computed from the
 *    file's bytes as read, a file changed on disk since is refused, and the
 *    writes are all-or-nothing.
 * 6. Read everything back and check it (`verifyRepair`): if anything outside
 *    the relationships changed, a planned finding is still there, a new one
 *    appeared, or a diagram draws something the user did not choose, every
 *    file is put back.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  RepairEditError,
  analyseRepair,
  checkPlannedTexts,
  describeRepairPlan,
  describeUnreadableEntries,
  planRelationshipRepair,
  readRepairSnapshot,
  verifyRepair,
  type RepairAsk,
  type RepairCounts,
  type RepairPlan,
  type RepairSnapshot,
  type RepairSnapshotDeps,
} from '../services/relationshipRepair';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';
import type { RelationshipFinding } from '@erd-studio/core';

export const REPAIR_TITLE = 'Repair Relationships';
export const MOVE_TITLE = 'Move Relationships to Model Library';

export interface RepairRelationshipsDeps extends RepairSnapshotDeps {
  /** Refresh the trees, open canvases and selectors once files are written (the domain files written, by path). */
  onWritten: (domainPaths: string[]) => Promise<void>;
  /** Test seam: how one file is written. Defaults to {@link writeFileAtomic}. */
  writeFile?: (filePath: string, text: string) => void;
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What differs between the two commands that share the runner. */
interface RunnerMode {
  title: string;
  move: boolean;
  /** How the refusal messages name a rerun ("the move", "the repair"). */
  noun: string;
}

const REPAIR: RunnerMode = { title: REPAIR_TITLE, move: false, noun: 'the repair' };
const MOVE: RunnerMode = { title: MOVE_TITLE, move: true, noun: 'the move' };

/**
 * ERD Studio: Repair Relationships…. Never throws: anything unexpected is
 * shown as an error and counted, so neither the palette nor the canvas offer
 * can swallow it.
 */
export async function repairRelationships(deps: RepairRelationshipsDeps): Promise<void> {
  await runGuarded(deps, REPAIR);
}

/** ERD Studio: Move Relationships to Model Library — the same engine, moving domain-file relationships too. */
export async function runMoveRelationships(deps: RepairRelationshipsDeps): Promise<void> {
  await runGuarded(deps, MOVE);
}

async function runGuarded(deps: RepairRelationshipsDeps, mode: RunnerMode): Promise<void> {
  try {
    await run(deps, mode);
  } catch (err) {
    telemetry.error('relMoveFailed');
    console.error(`[${mode.title}] failed:`, err);
    void vscode.window.showErrorMessage(`${mode.title} failed: ${errorText(err)}`);
  }
}

/**
 * Refuse when any of `filePaths` is open with unsaved edits — the user's work
 * in progress; writing under it would leave VS Code holding a copy that no
 * longer matches disk. Returns true (and has told the user) when refused.
 */
function refuseIfDirty(filePaths: Iterable<string>, label: (filePath: string) => string, mode: RunnerMode): boolean {
  const targets = new Set([...filePaths].map((p) => path.resolve(p)));
  const dirty = vscode.workspace.textDocuments
    .filter((doc) => doc.isDirty && targets.has(path.resolve(doc.uri.fsPath)))
    .map((doc) => label(doc.uri.fsPath));
  if (dirty.length === 0) return false;
  telemetry.error('relMoveDirtyFiles');
  const shown = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ` and ${dirty.length - 5} more` : '');
  void vscode.window.showErrorMessage(
    `${mode.title}: ${dirty.length === 1 ? 'a file it would change has' : `${dirty.length} files it would change have`} unsaved edits — ${shown}. ` +
    `Save or revert these first, then run ${mode.noun} again. Nothing was changed.`,
  );
  return true;
}

async function run(deps: RepairRelationshipsDeps, mode: RunnerMode): Promise<void> {
  const writeFile = deps.writeFile ?? writeFileAtomic;
  telemetry.feature('relMoveStarted');
  const modelsDir = deps.logicalModelService.getModelsDir();
  const label = (filePath: string): string => path.relative(path.dirname(modelsDir), filePath).split(path.sep).join('/');

  const before = readRepairSnapshot(deps);
  const analysis = analyseRepair(before, { moveDomainsToLibrary: mode.move });
  if (analysis.tasks.length === 0) {
    telemetry.feature('relMoveNothingToMove');
    await reportNothingToDo(before, analysis.unreadableEntries, analysis.blocked, mode);
    return;
  }
  // Checked before asking anything, so nobody settles conflicts only to be
  // turned away; checked again before writing.
  if (refuseIfDirty(analysis.involvedFiles, label, mode)) return;

  const ask: RepairAsk = async (question, position) => {
    const picked = await vscode.window.showQuickPick(
      question.options.map((o) => ({ label: o.label, description: o.description, detail: o.detail, id: o.id })),
      {
        title: `${mode.title} (${position.index} of ${position.total}): ${question.subject}`,
        placeHolder: question.prompt,
        ignoreFocusOut: true,
      },
    );
    return picked?.id;
  };

  let plan: RepairPlan | null;
  try {
    plan = await planRelationshipRepair(before, { moveDomainsToLibrary: mode.move }, ask, analysis);
  } catch (err) {
    if (!(err instanceof RepairEditError)) throw err;
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(`${mode.title}: ${err.message} Nothing was changed.`);
    return;
  }
  if (!plan) {
    telemetry.feature('relMoveCancelled');
    void vscode.window.showInformationMessage(`${mode.title}: cancelled — nothing was changed.`);
    return;
  }
  if (plan.changes.length === 0) {
    telemetry.feature('relMoveCancelled');
    void vscode.window.showInformationMessage(`${mode.title}: nothing was changed.`);
    return;
  }
  const planned = checkPlannedTexts(plan);
  if (planned.length > 0) {
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(`${mode.title}: stopped before writing — ${planned.join('; ')}. Nothing was changed.`);
    return;
  }

  if (!(await confirmPlan(plan, mode))) {
    telemetry.feature('relMoveCancelled');
    return;
  }

  // The plan is final; the dialogs may have taken a while.
  if (refuseIfDirty(plan.changes.map((c) => c.filePath), label, mode)) return;
  const changedOnDisk = plan.changes.filter((c) => {
    try {
      return fs.readFileSync(c.filePath, 'utf-8') !== c.original;
    } catch {
      return true;
    }
  });
  if (changedOnDisk.length > 0) {
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(
      `${mode.title}: ${changedOnDisk.map((c) => c.file).join(', ')} changed on disk while the dialog was open. ` +
      `Run ${mode.noun} again. Nothing was changed.`,
    );
    return;
  }

  // All or nothing: if one write fails, every file already written is put back.
  const written: RepairPlan['changes'] = [];
  const putBack = (): string[] => {
    const unrestored: string[] = [];
    for (const done of [...written].reverse()) {
      try {
        writeFile(done.filePath, done.original);
        ownWrites.recordWrite(done.filePath);
      } catch {
        unrestored.push(done.file);
      }
    }
    deps.logicalModelService.invalidateCache();
    return unrestored;
  };
  const putBackSentence = (unrestored: string[]): string => (unrestored.length === 0
    ? 'Every file was put back as it was; nothing was changed.'
    : `These files could not be put back: ${unrestored.join(', ')}. Restore them from source control.`);

  for (const change of plan.changes) {
    try {
      writeFile(change.filePath, change.text);
    } catch (err) {
      const unrestored = putBack();
      telemetry.error('relMoveWriteFailed');
      void vscode.window.showErrorMessage(
        `${mode.title}: could not write ${change.file} (${errorText(err)}). ${putBackSentence(unrestored)}`,
      );
      return;
    }
    written.push(change);
    // Recorded once the bytes are on disk (the tracker stats the file), so
    // the watchers skip this write; the caller issues the refreshes.
    ownWrites.recordWrite(change.filePath);
  }

  // Read it all back: the result must be exactly what was planned.
  let problems: string[];
  try {
    problems = verifyRepair(before, readRepairSnapshot(deps), plan);
  } catch (err) {
    problems = [`the result could not be checked (${errorText(err)})`];
  }
  if (problems.length > 0) {
    const unrestored = putBack();
    telemetry.error('relMoveWriteFailed');
    console.error(`[${mode.title}] verification failed:`, problems);
    void vscode.window.showErrorMessage(
      `${mode.title}: the result did not check out (${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '; …' : ''}). ` +
      putBackSentence(unrestored),
    );
    return;
  }

  deps.logicalModelService.invalidateCache();
  const domainPaths = before.domains
    .map((d) => d.filePath)
    .filter((p) => plan!.changes.some((c) => c.kind === 'domain' && c.filePath === p));
  try {
    await deps.onWritten(domainPaths);
  } catch (err) {
    // The files are written; a failed refresh must not report the repair as failed.
    console.error(`[${mode.title}] refresh after writing failed:`, err);
  }

  telemetry.feature('relMoveCompleted');
  if (plan.counts.left > 0) telemetry.feature('relMoveLeftover');
  await reportDone(before, plan, mode);
}

/** The modal preview, with "Show Full Diff…" where the editor supports it. True when confirmed. */
async function confirmPlan(plan: RepairPlan, mode: RunnerMode): Promise<boolean> {
  const movesDomains = mode.move && plan.counts.moved + plan.counts.domainCopiesRemoved + plan.counts.noHome > 0;
  const message = mode.move
    ? (movesDomains
      ? 'Define each relationship once, in the model library?'
      : 'Store each relationship with the model that holds the foreign key?')
    : `${REPAIR_TITLE}: change ${plural(plan.changes.length, 'file')}?`;
  const why = movesDomains
    ? ['Why: today each diagram keeps its own copy of a relationship, so two diagrams can draw the same link ' +
      'differently, and a new diagram has to draw it again. After the move each relationship is defined once, in the ' +
      'file of the model that holds the foreign key, and every diagram that holds both models draws it.', '']
    : [];
  const after = movesDomains
    ? ['', 'Teammates on an older ERD Studio version will not see relationships stored in the model library until they update.']
    : [];
  const detail = [
    ...why,
    describeRepairPlan(plan),
    ...after,
    '',
    `${mode.move ? 'The move' : 'The repair'} saves the files directly — use git (or your source control) to undo it.`,
  ].join('\n');
  const confirm = mode.move ? 'Move Relationships' : 'Repair Relationships';
  const diff = 'Show Full Diff…';
  const canDiff = typeof (vscode.workspace as { registerTextDocumentContentProvider?: unknown }).registerTextDocumentContentProvider === 'function';
  const preview = canDiff ? previewProvider(plan) : undefined;
  try {
    for (;;) {
      const buttons = preview ? [diff, confirm] : [confirm];
      const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
      if (choice === confirm) return true;
      if (choice !== diff || !preview) return false;
      await preview.show();
    }
  } finally {
    preview?.dispose();
  }
}

/** A read-only document per planned text, and a picker that diffs one against the file on disk. */
function previewProvider(plan: RepairPlan): { show: () => Promise<void>; dispose: () => void } {
  const scheme = 'erd-studio-repair-preview';
  const texts = new Map(plan.changes.map((c, i) => [`/${i}/${path.basename(c.filePath)}`, c.text]));
  const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: (uri: vscode.Uri) => texts.get(uri.path) ?? '',
  });
  return {
    show: async () => {
      const picked = plan.changes.length === 1
        ? { index: 0 }
        : await vscode.window.showQuickPick(
          plan.changes.map((c, index) => ({ label: c.file, description: plural(c.notes.length, 'change'), index })),
          { title: 'Show the full diff of one file', placeHolder: 'Which file?' },
        );
      if (!picked) return;
      const change = plan.changes[picked.index];
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(change.filePath),
        vscode.Uri.parse(`${scheme}:/${picked.index}/${path.basename(change.filePath)}`),
        `${change.file} (now ↔ after the change)`,
        { preview: true },
      );
    },
    dispose: () => registration.dispose(),
  };
}

/** Nothing to repair: say so, and point at entries that could not be read. */
async function reportNothingToDo(
  snapshot: RepairSnapshot,
  unreadable: readonly RelationshipFinding[],
  blocked: readonly string[],
  mode: RunnerMode,
): Promise<void> {
  const base = mode.move
    ? `${MOVE_TITLE}: nothing to move — ${snapshot.domains.some((d) => d.relationships.length > 0)
      ? 'every relationship in the diagram files is already in the model library, or starts at a model with no readable file in logical-models/.'
      : 'no diagram file holds a relationship of its own, and every relationship in the model library is stored with the model holding the foreign key.'}`
    : `${REPAIR_TITLE}: nothing to repair — every relationship is stored once, in its home.`;
  const extra = [
    ...blocked.slice(0, 2),
    ...(unreadable.length > 0 ? [describeUnreadableEntries(unreadable)] : []),
  ];
  await showWithOpenFile(`${base}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}`, snapshot, unreadable);
}

/** The closing message: what changed, what was left, and entries that could not be read. */
async function reportDone(snapshot: RepairSnapshot, plan: RepairPlan, mode: RunnerMode): Promise<void> {
  const c = plan.counts;
  const leftCount = c.left;
  let text: string;
  if (mode.move) {
    const moved = c.moved;
    const turned = c.rehomed;
    const parts = [
      ...(moved > 0 || !turned ? [`Moved ${moved} relationship${moved === 1 ? '' : 's'} into the model library — each is now defined once.`] : []),
      ...(turned > 0 ? [`${turned} relationship${turned === 1 ? ' is' : 's are'} now stored with the model holding the foreign key.`] : []),
      ...describeOtherFixes(c, ['moved', 'rehomed']),
    ];
    text = parts.join(' ') +
      (leftCount > 0 ? ` ${leftCount} stayed as ${leftCount === 1 ? 'it was' : 'they were'}; run this command again to settle ${leftCount === 1 ? 'it' : 'them'}.` : '');
  } else {
    const fixes = describeOtherFixes(c, []);
    text = `${REPAIR_TITLE}: changed ${plural(plan.changes.length, 'file')}. ${fixes.join(' ')}` +
      (leftCount > 0 ? ` ${leftCount} left as ${leftCount === 1 ? 'it was' : 'they were'}; run Repair Relationships… again to settle ${leftCount === 1 ? 'it' : 'them'}.` : '');
  }
  if (plan.unreadableEntries.length > 0) text += ` ${describeUnreadableEntries(plan.unreadableEntries)}`;
  await showWithOpenFile(text.trim(), snapshot, plan.unreadableEntries);
}

function describeOtherFixes(c: RepairCounts, skip: ReadonlyArray<keyof RepairCounts>): string[] {
  const sentences: Array<[keyof RepairCounts, (n: number) => string]> = [
    ['moved', (n) => `${plural(n, 'relationship')} moved into the model library.`],
    ['rehomed', (n) => `${plural(n, 'relationship')} now stored with the model holding the foreign key.`],
    ['deduplicated', (n) => `${plural(n, 'relationship')} stored more than once now stored once.`],
    ['domainCopiesRemoved', (n) => `${plural(n, 'diagram-file copy', 'diagram-file copies')} of library relationships removed.`],
    ['respelled', (n) => `${plural(n, 'relationship')} respelled to the real model or column names.`],
    ['settled', (n) => `${plural(n, 'disagreement')} settled as you picked.`],
    ['removed', (n) => `${plural(n, 'relationship')} removed.`],
    ['repointed', (n) => `${plural(n, 'relationship')} pointed at another model or column.`],
    ['swapped', (n) => `${plural(n, 'relationship')} turned round.`],
  ];
  return sentences.filter(([key]) => !skip.includes(key) && c[key] > 0).map(([key, sentence]) => sentence(c[key]));
}

/**
 * Show `text`; when entries could not be read, offer to open the file at the
 * entry's line (one entry), or to pick which (several).
 */
async function showWithOpenFile(text: string, snapshot: RepairSnapshot, unreadable: readonly RelationshipFinding[]): Promise<void> {
  const located = unreadable.filter((f) => f.files.length > 0);
  if (located.length === 0) {
    void vscode.window.showInformationMessage(text);
    return;
  }
  const button = located.length === 1 ? 'Open File' : 'Show Entries…';
  const choice = await vscode.window.showInformationMessage(text, button);
  if (choice !== button) return;
  let finding: RelationshipFinding | undefined = located[0];
  if (located.length > 1) {
    const picked = await vscode.window.showQuickPick(
      located.map((f) => ({ label: `${f.files[0]}${f.line !== undefined ? `:${f.line}` : ''}`, detail: f.message, finding: f })),
      { title: 'Relationship entries that could not be read', placeHolder: 'Open which one?' },
    );
    finding = picked?.finding;
  }
  if (finding) await openAtLine(snapshot, finding);
}

/** Open the model file a REL008 finding names, at its line. */
async function openAtLine(snapshot: RepairSnapshot, finding: RelationshipFinding): Promise<void> {
  const file = snapshot.modelFiles.find((m) => m.file === finding.files[0]);
  if (!file) return;
  const line = Math.max(0, (finding.line ?? 1) - 1);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file.filePath));
  const at = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
}
