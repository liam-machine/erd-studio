/**
 * ERD Studio: Repair Relationships… (issue #133, R10), and the runner
 * "Move Relationships to Model Library" shares with it.
 *
 * The plan comes from `src/services/relationshipRepair.ts` (no `vscode`);
 * this file owns the dialogs and the writes:
 *
 * 1. Read the project fresh and plan the automatic fixes — it never asks a
 *    question. Nothing to fix → say so, listing what is left for the user
 *    (each with **Open File**).
 * 2. Refuse, before the preview, when a file it would change is open with
 *    unsaved edits or cannot be written.
 * 3. One modal preview naming every file and change and everything left for
 *    the user, with one confirm button (plus "Show Full Diff…", a read-only
 *    diff of one file asked about without a modal so the diff can be read,
 *    and "Open File…" to go to a listed item instead). Cancel or Esc writes
 *    nothing.
 * 4. Disk only, like the move since 1.6.7: each new text is computed from the
 *    file's bytes as read, a file changed on disk since is refused, and the
 *    writes are all-or-nothing.
 * 5. Read everything back and check it (`verifyRepair`): if anything outside
 *    the relationships changed, a planned finding is still there, a new one
 *    appeared, or a diagram draws something the plan did not say, every file
 *    is put back.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  RepairEditError,
  checkPlannedTexts,
  describeRepairPlan,
  describeUnreadableEntries,
  planRelationshipRepair,
  readRepairSnapshot,
  repairReportItems,
  reportItemLine,
  verifyRepair,
  type RepairCounts,
  type RepairPlan,
  type RepairReportItem,
  type RepairSnapshot,
  type RepairSnapshotDeps,
} from '../services/relationshipRepair';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';

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
 *
 * A rename replaces whatever sits at the path, so the file it lands on is the
 * real one: a symlinked diagram or model file (a shared checkout) is written
 * through its link — the link stays a link and its target gets the new text —
 * and the temp file is given the original's permission bits before the rename.
 * A file the user cannot write (a read-only `0444` file) is refused rather
 * than silently replaced, which a rename would otherwise allow.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  let target = filePath;
  let mode: number | undefined;
  if (fs.existsSync(filePath)) {
    target = fs.realpathSync(filePath);
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new Error(`${path.basename(filePath)} is read-only`);
    }
    mode = fs.statSync(target).mode & 0o7777;
  }
  const tmpPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, text, 'utf-8');
    if (mode !== undefined) fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* the temp file may not exist */ }
    throw err;
  }
}

/**
 * The files among `filePaths` that cannot be written (read-only, a link to a
 * file that is, or in a folder that is — the atomic write creates its temp
 * file next to the target) — checked before the preview, so nobody confirms a
 * plan the writes would then refuse half-way.
 */
export function unwritableFiles(filePaths: Iterable<string>): string[] {
  const refused: string[] = [];
  for (const filePath of filePaths) {
    try {
      const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
      if (fs.existsSync(target)) fs.accessSync(target, fs.constants.W_OK);
      if (fs.existsSync(path.dirname(target))) fs.accessSync(path.dirname(target), fs.constants.W_OK);
    } catch {
      refused.push(filePath);
    }
  }
  return refused;
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

/** The run in progress, if any: a second click (the banner and the notification, a double-click) never starts another. */
let running: string | null = null;

async function runGuarded(deps: RepairRelationshipsDeps, mode: RunnerMode): Promise<void> {
  if (running) {
    void vscode.window.showInformationMessage(`${running} is already running — confirm or cancel its preview first.`);
    return;
  }
  running = mode.title;
  let closing: ClosingReport | void = undefined;
  try {
    closing = await run(deps, mode);
  } catch (err) {
    telemetry.error('relMoveFailed');
    console.error(`[${mode.title}] failed:`, err);
    void vscode.window.showErrorMessage(`${mode.title} failed: ${errorText(err)}`);
  } finally {
    running = null;
  }
  // The closing message is shown after the lock is released: a notification
  // with an Open File button stays pending (in the notification centre) until
  // it is answered, and a run that has finished must not turn the next one
  // away as "already running" with no dialog on screen (#133 review 8).
  if (closing) {
    try {
      await closing();
    } catch (err) {
      console.error(`[${mode.title}] closing message failed:`, err);
    }
  }
}

/** The run's closing message, shown once the run lock is released. */
type ClosingReport = () => Promise<void>;

/**
 * What the read-back check compares, for every file the run did not plan to
 * change: each model's relationships, read issues and key columns, each
 * diagram's models and relationships. Positions and descriptions are left out,
 * so moving a box while the preview is open does not stop the run.
 */
function relationshipSignature(s: RepairSnapshot): string {
  const models = s.modelFiles.map((m) => JSON.stringify([
    m.filePath,
    m.name,
    m.model.relationships ?? [],
    (m.model.relationshipIssues ?? []).length,
    (m.model.columns ?? []).map((c) => [c.name, !!c.isPrimaryKey, !!c.isNaturalKey, !!c.isForeignKey]),
  ])).sort();
  const domains = s.domains.map((d) => JSON.stringify([d.filePath, d.models, d.relationships, d.readIssues.length])).sort();
  return JSON.stringify({
    mode: s.mode,
    models,
    domains,
    older: s.olderFormat.map((o) => o.file).sort(),
    unreadable: s.unreadable.map((u) => u.file).sort(),
    unchecked: s.unchecked.map((u) => u.file).sort(),
  });
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

async function run(deps: RepairRelationshipsDeps, mode: RunnerMode): Promise<ClosingReport | void> {
  const writeFile = deps.writeFile ?? writeFileAtomic;
  telemetry.feature('relMoveStarted');
  const modelsDir = deps.logicalModelService.getModelsDir();
  const label = (filePath: string): string => path.relative(path.dirname(modelsDir), filePath).split(path.sep).join('/');

  // One plan, asking nothing: the automatic fixes, and a list of everything
  // left for the user.
  const before = readRepairSnapshot(deps);
  let plan: RepairPlan;
  try {
    plan = planRelationshipRepair(before, { moveDomainsToLibrary: mode.move });
  } catch (err) {
    if (!(err instanceof RepairEditError)) throw err;
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(`${mode.title}: ${err.message} Nothing was changed.`);
    return;
  }
  if (plan.changes.length === 0) {
    telemetry.feature('relMoveNothingToMove');
    return () => reportNothingToDo(before, plan, mode);
  }
  // Every file it would write is checked for unsaved edits and write access
  // before the preview, so nobody confirms a plan only to be turned away.
  if (refuseIfDirty(plan.changes.map((c) => c.filePath), label, mode)) return;
  const readOnly = unwritableFiles(plan.changes.map((c) => c.filePath));
  if (readOnly.length > 0) {
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(
      `${mode.title}: ${readOnly.map(label).join(', ')} ${readOnly.length === 1 ? 'is' : 'are'} read-only. ` +
      `Make ${readOnly.length === 1 ? 'it' : 'them'} writable, then run ${mode.noun} again. Nothing was changed.`,
    );
    return;
  }
  const planned = checkPlannedTexts(plan);
  if (planned.length > 0) {
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(`${mode.title}: stopped before writing — ${planned.join('; ')}. Nothing was changed.`);
    return;
  }

  const items = repairReportItems(plan, before);
  const answer = await confirmPlan(plan, items, mode);
  if (answer !== 'confirm') {
    telemetry.feature('relMoveCancelled');
    if (answer === 'open') return () => pickAndOpen(items);
    return;
  }

  // The preview may have been open a while.
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
  // A relationship edited elsewhere meanwhile (another diagram, an
  // assistant) would make the read-back check fail and blame the repair:
  // say what happened instead, before writing anything.
  if (relationshipSignature(readRepairSnapshot(deps)) !== relationshipSignature(before)) {
    telemetry.error('relMoveFailed');
    void vscode.window.showErrorMessage(
      `${mode.title}: relationships in the project changed while the dialog was open. Run ${mode.noun} again. Nothing was changed.`,
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
  let after: RepairSnapshot | undefined;
  try {
    after = readRepairSnapshot(deps);
    problems = verifyRepair(before, after, plan);
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
    .filter((p) => plan.changes.some((c) => c.kind === 'domain' && c.filePath === p));
  try {
    await deps.onWritten(domainPaths);
  } catch (err) {
    // The files are written; a failed refresh must not report the repair as failed.
    console.error(`[${mode.title}] refresh after writing failed:`, err);
  }

  telemetry.feature('relMoveCompleted');
  if (plan.left.length > 0) telemetry.feature('relMoveLeftover');
  // Entries that could not be read are named at their place in the files as
  // written: moving an entry out of a file shifts the ones below it.
  const finalSnapshot = after ?? before;
  const finalPlan: RepairPlan = after
    ? { ...plan, unreadableEntries: after.findings.filter((finding) => finding.code === 'REL008') }
    : plan;
  return () => reportDone(finalSnapshot, finalPlan, mode);
}

/**
 * The one modal preview: every file and change, and everything left for the
 * user. One confirm button; "Show Full Diff…" where the editor supports it,
 * and "Open File…" to go to something it leaves (nothing is written then).
 * Cancel or Esc writes nothing.
 */
async function confirmPlan(plan: RepairPlan, items: readonly RepairReportItem[], mode: RunnerMode): Promise<'confirm' | 'open' | 'cancel'> {
  const movesDomains = mode.move && plan.counts.moved + plan.counts.domainCopiesRemoved > 0;
  const message = mode.move
    ? (movesDomains
      ? 'Define each relationship once, in the model library?'
      : 'Store each relationship with the model that holds the foreign key?')
    : `${REPAIR_TITLE}: change ${plural(plan.changes.length, 'file')}?`;
  const why = movesDomains
    ? ['Why: today each diagram keeps its own copy of a relationship, so two diagrams can draw the same link ' +
      'differently, and a new diagram has to draw it again. After the move each relationship is defined once, in the ' +
      'file of the model that holds the foreign key, and every diagram that holds both models draws it.', '']
    : plan.counts.moved > 0
      // The repair also defines a relationship copied into several diagram
      // files once, in the model library — and then every diagram that holds
      // both models draws it, which the preview below names.
      ? ['Why: a relationship stored in more than one diagram file is defined once, in the file of the model that ' +
        'holds the foreign key, so every diagram that holds both models draws it.', '']
      : [];
  const after = movesDomains
    ? ['', 'Teammates on an older ERD Studio version will not see relationships stored in the model library until they update.']
    : [];
  const detail = [
    ...why,
    'Only fixes that cannot change what a relationship means are made here; anything that needs your judgement is listed and left as it is.',
    '',
    describeRepairPlan(plan),
    ...after,
    '',
    `${mode.move ? 'The move' : 'The repair'} saves the files directly — use git (or your source control) to undo it.`,
  ].join('\n');
  const confirm = mode.move ? 'Move Relationships' : 'Repair Relationships';
  const diff = 'Show Full Diff…';
  const open = 'Open File…';
  const openable = items.some((item) => item.filePath);
  const canDiff = typeof (vscode.workspace as { registerTextDocumentContentProvider?: unknown }).registerTextDocumentContentProvider === 'function';
  const preview = canDiff ? previewProvider(plan) : undefined;
  const another = 'Show Another File…';
  try {
    for (;;) {
      const buttons = [...(preview ? [diff] : []), ...(openable ? [open] : []), confirm];
      const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, ...buttons);
      if (choice === confirm) return 'confirm';
      if (choice === open) return 'open';
      if (choice !== diff || !preview) return 'cancel';
      // While a diff is open the question is asked without a modal: a modal
      // blocks the whole window, so the diff behind it could not be scrolled.
      // A QuickPick that ignores focus loss stays on screen while the diff is
      // read — a notification would hide itself after a few seconds and leave
      // the run waiting on a question nobody can see (#133 review 8).
      for (;;) {
        if (!(await preview.show())) break; // no file picked: back to the preview
        const options = [confirm, ...(plan.changes.length > 1 ? [another] : []), 'Cancel'];
        const picked = await vscode.window.showQuickPick(
          options.map((label) => ({ label })),
          {
            title: `${message} The diff is open — review it, then choose here.`,
            placeHolder: 'Esc cancels — nothing is changed',
            ignoreFocusOut: true,
          },
        );
        const next = picked?.label;
        if (next === confirm) return 'confirm';
        if (next !== another) return 'cancel';
      }
    }
  } finally {
    preview?.dispose();
  }
}

/** A read-only document per planned text, and a picker that diffs one against the file on disk. */
function previewProvider(plan: RepairPlan): { show: () => Promise<boolean>; dispose: () => void } {
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
      if (!picked) return false;
      const change = plan.changes[picked.index];
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(change.filePath),
        vscode.Uri.parse(`${scheme}:/${picked.index}/${path.basename(change.filePath)}`),
        `${change.file} (now ↔ after the change)`,
        { preview: true },
      );
      return true;
    },
    dispose: () => {
      // The preview tabs would show nothing once the files are written (or
      // nothing at all once the provider is gone): close them.
      const groups = (vscode.window as { tabGroups?: { all: ReadonlyArray<{ tabs: readonly vscode.Tab[] }>; close?: (tabs: vscode.Tab[]) => Thenable<boolean> } }).tabGroups;
      const tabs = (groups?.all ?? []).flatMap((g) => g.tabs).filter((tab) => {
        const modified = (tab.input as { modified?: vscode.Uri } | undefined)?.modified;
        return modified?.scheme === scheme;
      });
      if (tabs.length > 0 && groups?.close) void Promise.resolve(groups.close(tabs)).catch(() => undefined);
      registration.dispose();
    },
  };
}

/** Nothing it can fix on its own: say so, and list what is left for the user, each with its file. */
async function reportNothingToDo(snapshot: RepairSnapshot, plan: RepairPlan, mode: RunnerMode): Promise<void> {
  const items = repairReportItems(plan, snapshot);
  // Never an all-clear while something the checks found is left for the
  // user or out of this command's reach.
  const base = items.length > 0
    ? `${mode.title}: nothing it can fix on its own.`
    : mode.move
    ? `${MOVE_TITLE}: nothing to move — ${snapshot.domains.some((d) => d.relationships.length > 0)
      ? 'every relationship in the diagram files is already in the model library, or starts at a model with no readable file in logical-models/.'
      : 'no diagram file holds a relationship of its own, and every relationship in the model library is stored with the model holding the foreign key.'}`
    : `${REPAIR_TITLE}: nothing to repair — every relationship is stored once, in its home.`;
  await showWithItems(`${base}${describeItems(plan)}`, items);
}

/** The closing message: what changed, and what is left for the user. */
async function reportDone(snapshot: RepairSnapshot, plan: RepairPlan, mode: RunnerMode): Promise<void> {
  const c = plan.counts;
  let text: string;
  if (mode.move) {
    const parts = [
      // Only what happened: a run that only removed diagram-file copies of
      // library relationships (or respelled entries) moved nothing.
      ...(c.moved > 0 ? [`Moved ${plural(c.moved, 'relationship')} into the model library — each is now defined once.`] : []),
      ...(c.rehomed > 0 ? [`${c.rehomed} relationship${c.rehomed === 1 ? ' is' : 's are'} now stored with the model holding the foreign key.`] : []),
      ...describeOtherFixes(c, ['moved', 'rehomed']),
    ];
    if (parts.length === 0) parts.push(`${MOVE_TITLE}: changed ${plural(plan.changes.length, 'file')}.`);
    text = parts.join(' ');
  } else {
    text = `${REPAIR_TITLE}: changed ${plural(plan.changes.length, 'file')}. ${describeOtherFixes(c, []).join(' ')}`.trim();
  }
  await showWithItems(`${text}${describeItems(plan)}`, repairReportItems(plan, snapshot));
}

/** " N need your attention: …" for a closing message, or ''. */
function describeItems(plan: RepairPlan): string {
  const parts: string[] = [];
  if (plan.left.length > 0) {
    parts.push(`${plural(plan.left.length, 'relationship')} ${plan.left.length === 1 ? 'needs' : 'need'} your attention and ` +
      `${plan.left.length === 1 ? 'was' : 'were'} left as ${plan.left.length === 1 ? 'it was' : 'they were'}: ` +
      `${plan.left.slice(0, 3).map((i) => i.message).join(' ')}${plan.left.length > 3 ? ` …and ${plan.left.length - 3} more.` : ''}`);
  }
  if (plan.outOfReach.length > 0) {
    parts.push(`Not changed: ${plan.outOfReach.slice(0, 2).map((i) => i.message).join(' ')}${plan.outOfReach.length > 2 ? ` …and ${plan.outOfReach.length - 2} more.` : ''}`);
  }
  if (plan.unreadableEntries.length > 0) parts.push(describeUnreadableEntries(plan.unreadableEntries));
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function describeOtherFixes(c: RepairCounts, skip: ReadonlyArray<keyof RepairCounts>): string[] {
  const sentences: Array<[keyof RepairCounts, (n: number) => string]> = [
    ['moved', (n) => `${plural(n, 'relationship')} moved into the model library.`],
    ['rehomed', (n) => `${plural(n, 'relationship')} now stored with the model holding the foreign key.`],
    ['swapped', (n) => `${plural(n, 'relationship')} saved the wrong way round turned round.`],
    ['foreignKeysCleared', (n) => `${plural(n, 'key column')} no longer marked as a foreign key by mistake.`],
    ['deduplicated', (n) => `${plural(n, 'relationship')} stored more than once now stored once.`],
    ['domainCopiesRemoved', (n) => `${plural(n, 'diagram-file copy', 'diagram-file copies')} of library relationships removed.`],
    ['respelled', (n) => `${plural(n, 'relationship')} respelled to the real model or column names.`],
  ];
  return sentences.filter(([key]) => !skip.includes(key) && c[key] > 0).map(([key, sentence]) => sentence(c[key]));
}

/**
 * Show `text`; when something is left for the user in a file, offer to open
 * it — "Open File" for one, "Show Items…" (a list, each opening its file at
 * the entry) for several.
 */
async function showWithItems(text: string, items: readonly RepairReportItem[]): Promise<void> {
  const located = items.filter((item) => item.filePath);
  if (located.length === 0) {
    void vscode.window.showInformationMessage(text);
    return;
  }
  const button = located.length === 1 ? 'Open File' : 'Show Items…';
  const choice = await vscode.window.showInformationMessage(text, button);
  if (choice !== button) return;
  await pickAndOpen(located);
}

/** Open the one item's file, or let the user pick which (each at its entry's line). */
async function pickAndOpen(items: readonly RepairReportItem[]): Promise<void> {
  const located = items.filter((item) => item.filePath);
  let item: RepairReportItem | undefined = located[0];
  if (located.length > 1) {
    const picked = await vscode.window.showQuickPick(
      located.map((i) => {
        const line = reportItemLine(i);
        return { label: `${i.file ?? i.filePath}${line !== undefined ? `:${line}` : ''}`, detail: i.message, item: i };
      }),
      { title: 'Relationships that need your attention', placeHolder: 'Open which one?', matchOnDetail: true },
    );
    item = picked?.item;
  }
  if (item) await openItem(item);
}

/** Open an item's file at its entry's line (the top when it has none). */
async function openItem(item: RepairReportItem): Promise<void> {
  if (!item.filePath) return;
  const line = Math.max(0, (reportItemLine(item) ?? 1) - 1);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.filePath));
  const at = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
}
