/**
 * The onboarding guide, **Show Me Around** (`erdStudio.showMeAround`): a few
 * coach marks — a small callout anchored to the real control, with "N of M",
 * Back / Next, Skip guide and Esc — that walk a new user through ERD Studio
 * with their own tables. Two phases on the two webviews ERD Studio owns:
 *
 *  - **A, on the draft page** (`webview-draft/`): what the draft is, where
 *    the other ways to bring a data model in are, and Keep (the step waits
 *    for the click);
 *  - **B, on the canvas** (`webview/`): a real table, a real relationship,
 *    the toolbar, the Logical / Physical switch (dbt projects only), the
 *    sidebar, the files and the AI helper, and a finish with Star on GitHub.
 *
 * This module is the pure part both pages and the host share: the steps and
 * their text (built from the draft view or the diagram on show, naming the
 * user's tables, relationships, counts and source), the fixed action ids a
 * page may send, and the guide's progress on this machine. It writes
 * nothing, runs nothing and holds no URL: the host maps each action id to a
 * fixed command or URL (`src/providers/guideWiring.ts`).
 *
 * Pure, vscode-free and Node-free: compiled by both tsconfigs (the webview's
 * includes `src/types/**`); never imports from `services/`.
 */

import type { DisplayRelationship, DisplaySubjectArea } from './display';
import type { DraftOtherStart, DraftView } from './draft';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const SHOW_ME_AROUND_COMMAND = 'erdStudio.showMeAround';
/** The command's title without the category, and every button that runs it. */
export const SHOW_ME_AROUND_LABEL = 'Show Me Around';

/**
 * Where to run the guide again: a small note on its last card, and the
 * status bar's few seconds after Skip guide or Esc.
 */
export const GUIDE_RERUN_NOTE = 'Show Me Around in Help & Feedback runs this guide again.';
/** The status bar's version, with VS Code's compass icon (the Help & Feedback row's). */
export const GUIDE_RERUN_STATUS = '$(compass) Show Me Around in Help & Feedback runs the guide again';
/** How long the status bar shows it. */
export const GUIDE_RERUN_STATUS_MS = 8000;

/** The guide's progress on this machine (`globalState`): {@link GuideStatus}. */
export const GUIDE_STATE_KEY = 'erdStudio.onboardingGuide';

/**
 * Where the guide is on this machine. Each is written **before** the phase
 * it names shows, so a crash never makes it repeat:
 *  - absent: never started — the first draft shown runs phase A;
 *  - `draft`: phase A has started — the next diagram opened runs phase B;
 *  - `canvas`: phase B has started (it is not shown again by itself);
 *  - `done`: finished (Done or Star on GitHub on the last step);
 *  - `skipped`: Skip guide or Esc, on either page: it ends for good.
 * **Show Me Around** runs it again whatever the status.
 */
export type GuideStatus = 'draft' | 'canvas' | 'done' | 'skipped';
export const GUIDE_STATUSES: readonly GuideStatus[] = ['draft', 'canvas', 'done', 'skipped'];

export function isGuideStatus(value: unknown): value is GuideStatus {
  return typeof value === 'string' && (GUIDE_STATUSES as readonly string[]).includes(value);
}

/** Phase A runs on this draft: the first draft on this machine, or the command asked. */
export function guideDraftDue(status: GuideStatus | undefined, requested: boolean): boolean {
  return requested || status === undefined;
}

/** Phase B runs on this canvas: the first diagram opened after phase A, or the command asked. */
export function guideCanvasDue(status: GuideStatus | undefined, requested: boolean): boolean {
  return requested || status === 'draft';
}

/** Phase B is still owed: activation holds back the prompts that would pop over its canvas. */
export function guideCanvasOwed(status: GuideStatus | undefined): boolean {
  return status === 'draft';
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export const GUIDE_STEP_IDS = [
  'draftBanner', 'draftMoreWays', 'draftKeep',
  'canvasTable', 'canvasRelationship', 'canvasToolbar', 'canvasStages', 'canvasSidebar', 'canvasFiles', 'canvasFinish',
] as const;
export type GuideStepId = (typeof GUIDE_STEP_IDS)[number];

export function isGuideStepId(value: unknown): value is GuideStepId {
  return typeof value === 'string' && (GUIDE_STEP_IDS as readonly string[]).includes(value);
}

/**
 * The `data-guide` attribute of each control a step points at (the pages set
 * them on their own elements, never inside the renderer package).
 */
export const GUIDE_TARGETS = {
  draftBanner: 'draft-banner',
  draftMore: 'draft-more',
  draftGuideStart: 'draft-start-guide',
  draftPrimary: 'draft-primary',
  draftKeep: 'draft-keep',
  canvasAdd: 'canvas-add',
  canvasLayout: 'canvas-layout',
  canvasStages: 'canvas-stages',
  canvasFile: 'canvas-file',
} as const;
export type GuideTarget = (typeof GUIDE_TARGETS)[keyof typeof GUIDE_TARGETS];

/** A CSS selector for a `data-guide` target. */
export function guideTargetSelector(target: GuideTarget): string {
  return `[data-guide="${target}"]`;
}

/** What a step's callout points at. */
export type GuideAnchor =
  /** The first of these `data-guide` targets on the page. */
  | { kind: 'target'; targets: GuideTarget[] }
  /** A table node on the canvas (its React Flow node, by the table's name). */
  | { kind: 'table'; table: string }
  /** A relationship line on the canvas (its edge, by its two tables). */
  | { kind: 'relationship'; from: string; to: string }
  /** The canvas's left edge, pointing out of the editor at the sidebar. */
  | { kind: 'leftEdge' }
  /** Nothing: a centred card. */
  | { kind: 'none' };

/** A button a step adds beside Back / Next; the page posts the action id. */
export interface GuideStepButton {
  action: 'aiHelper' | 'star';
  label: string;
}

export interface GuideStep {
  id: GuideStepId;
  title: string;
  /** Final text (plain, never HTML). */
  text: string;
  /** A quieter line under the text (plain): the last card's {@link GUIDE_RERUN_NOTE}. */
  note?: string;
  anchor: GuideAnchor;
  /**
   * The step ends when the user presses the control it points at (Keep):
   * no Next. Back and Skip guide stay.
   */
  waitsForClick?: true;
  /** The last step: **Done** instead of Next (and Esc finishes rather than skips). */
  finish?: true;
  buttons?: GuideStepButton[];
  /** The host does this when the step shows (the page posts the action id). */
  onShow?: 'revealSidebar';
}

export const GUIDE_LABELS = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  skip: 'Skip guide',
  star: 'Star on GitHub',
  aiHelper: 'Set Up My AI Helper',
} as const;

/** "2 of 5". */
export function guideProgress(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

const thousands = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
const countOrNo = (n: number, one: string, many = `${one}s`): string => (n === 0 ? `no ${many}` : plural(n, one, many));

/** `4 tables, 3 relationships` (`1 table, no relationships`): the draft banner's own counting. */
export function guideCounts(tables: number, relationships: number): string {
  return `${countOrNo(tables, 'table')}, ${countOrNo(relationships, 'relationship')}`;
}

/**
 * The draft's own source phrase, `from 2 SQL files (PostgreSQL)`: the
 * banner's `from` when the host set it, else the headline's first part
 * (`Draft from … · counts · not saved`); undefined for an example.
 */
export function draftSourcePhrase(view: Pick<DraftView, 'banner' | 'source'>): string | undefined {
  if (view.source === 'example' || view.source === 'exampleProject') return undefined;
  if (view.banner.from) return view.banner.from;
  const what = view.banner.headline.split(' · ')[0] ?? '';
  return what.startsWith('Draft from ') ? what.slice('Draft '.length) : undefined;
}

export interface DraftGuideInput {
  view: DraftView;
  /**
   * The example is shown because the folder held nothing to draw (the
   * automatic draft, or Show Me Around in such a folder), not because the
   * user asked for an example.
   */
  nothingFound?: boolean;
  /** The semantic dir (`.erd-studio`). */
  semanticDir?: string;
}

const DIR = (semanticDir: string | undefined): string => `${(semanticDir ?? '.erd-studio').replace(/\/+$/, '')}/`;

/** The More ways to start sentence, naming only the starts this draft offers. */
function moreWaysText(starts: ReadonlySet<DraftOtherStart>): string | undefined {
  const parts: string[] = [];
  if (starts.has('import')) parts.push('Import… reads SQL scripts, Power BI and Fabric models, and DBML.');
  if (starts.has('guide')) parts.push('Bring In Your Data Model… shows how to get it out of Databricks, Snowflake, SQL Server, Fabric and more, into an open format.');
  if (parts.length === 0) return undefined;
  return `Is your data model somewhere else? ${parts.join(' ')}`;
}

/**
 * Phase A's steps for the draft on show (1–3): the banner, More ways to
 * start (when the draft offers Import… or the import guide), and the control
 * that keeps it (the step waits for the click).
 */
export function draftGuideSteps(input: DraftGuideInput): GuideStep[] {
  const { view } = input;
  const dir = DIR(input.semanticDir);
  const counts = guideCounts(view.summary.tables, view.summary.relationships);
  const example = view.source === 'example' || view.source === 'exampleProject';
  const noFolder = view.banner.primary === 'openFolder';
  const steps: GuideStep[] = [];

  // 1. The banner: what this is, from what, and that nothing is saved.
  let text: string;
  if (!example) {
    const from = draftSourcePhrase(view) ?? 'from your files';
    text = `This is a draft of your model, drawn ${from}: ${counts}. Nothing is saved yet.`;
  } else if (noFolder) {
    text = `No folder is open, so this is an example: ${counts}. Nothing is saved yet.`;
  } else if (input.nothingFound) {
    text = `Nothing here to draw from yet, so this is an example: ${counts}. Nothing is saved yet.`;
  } else {
    text = `This is an example data model: ${counts}. Nothing is saved yet.`;
  }
  steps.push({ id: 'draftBanner', title: example ? 'An example' : 'Your draft', text, anchor: { kind: 'target', targets: [GUIDE_TARGETS.draftBanner] } });

  // 2. More ways to start: where to import their data from.
  const offered = new Set(view.otherStarts.map((s) => s.id));
  const more = moreWaysText(offered);
  if (more) {
    steps.push({
      id: 'draftMoreWays',
      title: 'More ways to start',
      text: more,
      anchor: { kind: 'target', targets: [GUIDE_TARGETS.draftMore, GUIDE_TARGETS.draftGuideStart] },
    });
  }

  // 3. Keep: the step waits for the click.
  const keepLabel = view.banner.keepLabel;
  if (noFolder || keepLabel === undefined) {
    steps.push({
      id: 'draftKeep',
      title: 'Open your folder',
      text: `Open Folder… opens the folder your data model lives in. ERD Studio draws what it finds there, and keeping it saves your first logical model as DBML files in ${dir}, ready to commit. Press it to continue.`,
      anchor: { kind: 'target', targets: [GUIDE_TARGETS.draftPrimary] },
      waitsForClick: true,
    });
  } else if (view.source === 'exampleProject') {
    steps.push({
      id: 'draftKeep',
      title: 'Keep it',
      text: `${keepLabel} copies it to a folder of its own and opens it there, ready to explore. Press it to continue.`,
      anchor: { kind: 'target', targets: [GUIDE_TARGETS.draftKeep, GUIDE_TARGETS.draftPrimary] },
      waitsForClick: true,
    });
  } else {
    const what = view.source === 'example' ? 'a diagram in this folder' : 'your first logical model';
    steps.push({
      id: 'draftKeep',
      title: 'Keep it',
      text: `${keepLabel} makes it ${what}: one DBML file per table in ${dir}, ready to commit. Press it to continue.`,
      anchor: { kind: 'target', targets: [GUIDE_TARGETS.draftKeep, GUIDE_TARGETS.draftPrimary] },
      waitsForClick: true,
    });
  }
  return steps;
}

/** Relationships per table name (both ends), each link once. */
function connections(relationships: readonly DisplayRelationship[]): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const r of relationships) {
    const key = `${r.fromModel}\u0000${r.toModel}\u0000${r.compositeKey ?? `${r.fromColumn}\u0000${r.toColumn}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(r.fromModel, (counts.get(r.fromModel) ?? 0) + 1);
    if (r.toModel !== r.fromModel) counts.set(r.toModel, (counts.get(r.toModel) ?? 0) + 1);
  }
  return counts;
}

/** Relationships counted once each (a composite's column pairs together). */
export function countRelationships(relationships: readonly DisplayRelationship[]): number {
  const seen = new Set<string>();
  for (const r of relationships) {
    seen.add(r.compositeKey !== undefined ? `${r.fromModel}\u0000${r.toModel}\u0000${r.compositeKey}` : `${r.fromModel}\u0000${r.fromColumn}\u0000${r.toModel}\u0000${r.toColumn}`);
  }
  return seen.size;
}

/**
 * The table step 4 points at: the best-connected of the tables in view (all
 * of them when none is said to be), ties by the diagram's order.
 */
export function guideTable(display: Pick<DisplaySubjectArea, 'models' | 'relationships'>, visibleTables?: readonly string[]): string | undefined {
  const names = display.models.map((m) => m.name);
  const visible = visibleTables && visibleTables.length > 0 ? names.filter((n) => visibleTables.includes(n)) : [];
  const pool = visible.length > 0 ? visible : names;
  const counts = connections(display.relationships);
  let best: string | undefined;
  let bestCount = -1;
  for (const name of pool) {
    const c = counts.get(name) ?? 0;
    if (c > bestCount) { best = name; bestCount = c; }
  }
  return best;
}

/** The relationship step 5 points at: one of `table`'s, else the first. */
export function guideRelationship(display: Pick<DisplaySubjectArea, 'relationships'>, table: string | undefined): DisplayRelationship | undefined {
  const rels = display.relationships;
  return rels.find((r) => r.fromModel === table && r.toModel !== table)
    ?? rels.find((r) => r.toModel === table && r.fromModel !== table)
    ?? rels[0];
}

export interface CanvasGuideInput {
  display: Pick<DisplaySubjectArea, 'models' | 'relationships'>;
  /** The Physical tab exists (a dbt project). */
  hasDbt: boolean;
  /** The project stores its model as DBML (the native format); else YAML/JSON from before 2.0. */
  dbml: boolean;
  semanticDir?: string;
  /** The tables whose nodes are in view now (step 4 prefers one of them). */
  visibleTables?: readonly string[];
}

/**
 * Phase B's steps for the diagram on show (4–10). Step 5 only with a
 * relationship, step 7 only in a dbt project, steps 4–5 only with a table.
 */
export function canvasGuideSteps(input: CanvasGuideInput): GuideStep[] {
  const { display } = input;
  const dir = DIR(input.semanticDir);
  const steps: GuideStep[] = [];
  const total = display.models.length;
  const table = guideTable(display, input.visibleTables);

  if (table !== undefined) {
    const of = total === 1 ? `${table} is your one table so far.` : `${table} is one of your ${thousands(total)} tables.`;
    steps.push({
      id: 'canvasTable',
      title: 'A table',
      text: `${of} Click a table to change its columns, types and keys, or to add a column, in the panel that opens. Double-click a column's name or type to change it in place.`,
      anchor: { kind: 'table', table },
    });
  }

  const rel = table !== undefined ? guideRelationship(display, table) : undefined;
  if (rel) {
    steps.push({
      id: 'canvasRelationship',
      title: 'A relationship',
      text: `${rel.fromModel} → ${rel.toModel} (${rel.cardinality}). Press and hold a column, then drag it onto a column of another table to add a relationship.`,
      anchor: { kind: 'relationship', from: rel.fromModel, to: rel.toModel },
    });
  }

  steps.push({
    id: 'canvasToolbar',
    title: 'Add and arrange',
    text: total === 0
      ? '+ Add puts your first table on the diagram, or a relationship or a note. Layout arranges the tables for you (Shift+L).'
      : '+ Add puts a new table, tables from your Table Library, a relationship or a note on the diagram. Layout arranges the tables for you (Shift+L).',
    anchor: { kind: 'target', targets: [GUIDE_TARGETS.canvasAdd, GUIDE_TARGETS.canvasLayout] },
  });

  if (input.hasDbt) {
    steps.push({
      id: 'canvasStages',
      title: 'Logical and Physical',
      text: 'Logical is your design. Physical is what your dbt project builds; switch to compare them and sync the differences.',
      anchor: { kind: 'target', targets: [GUIDE_TARGETS.canvasStages] },
    });
  }

  steps.push({
    id: 'canvasSidebar',
    title: 'The ERD Studio sidebar',
    text: 'On the left, in ERD Studio: Diagrams lists your diagrams, Table Library every table, Relationships every link. Use + on Diagrams to start a diagram, a layer or an import.',
    anchor: { kind: 'leftEdge' },
    onShow: 'revealSidebar',
  });

  steps.push({
    id: 'canvasFiles',
    title: 'Your files and your AI',
    text: input.dbml
      ? `Your model is plain DBML in ${dir} — commit it with your code. Your AI assistant can read and edit it; Set Up My AI Helper teaches it the format.`
      : `Your model is plain text files in ${dir} — commit them with your code. Your AI assistant can read and edit them; Set Up My AI Helper teaches it the format.`,
    anchor: { kind: 'target', targets: [GUIDE_TARGETS.canvasFile] },
    buttons: [{ action: 'aiHelper', label: GUIDE_LABELS.aiHelper }],
  });

  steps.push({
    id: 'canvasFinish',
    title: 'One last thing',
    text: "You're set up. If ERD Studio helps you, a star on GitHub helps other modellers find it.",
    note: GUIDE_RERUN_NOTE,
    anchor: { kind: 'none' },
    buttons: [{ action: 'star', label: GUIDE_LABELS.star }],
    finish: true,
  });
  return steps;
}

// ---------------------------------------------------------------------------
// What a page may send (fixed ids only; the host maps each)
// ---------------------------------------------------------------------------

/**
 * - `step`: a step was shown (logged; with its `step` id);
 * - `skip`: Skip guide or Esc — the guide ends for good on this machine;
 * - `complete`: Done on the last step;
 * - `star`: Star on GitHub (the host opens its own fixed URL; also completes);
 * - `aiHelper`: Set Up My AI Helper (the host runs the existing command);
 * - `revealSidebar`: the sidebar step showed (the host reveals the ERD Studio view container).
 */
export const GUIDE_ACTIONS = ['step', 'skip', 'complete', 'star', 'aiHelper', 'revealSidebar'] as const;
export type GuideAction = (typeof GUIDE_ACTIONS)[number];

/** The draft page sends only these (phase A ends by Keep, not by a guide message). */
export const DRAFT_GUIDE_ACTIONS: readonly GuideAction[] = ['step', 'skip'];

export interface GuideActionPayload {
  action: GuideAction;
  /** With `step`: which step showed. */
  step?: GuideStepId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A guide action from a page, rebuilt from its checked fields, or undefined:
 * an unknown action, an action this page may not send, a `step` without a
 * known step id, or a step id on anything else.
 */
export function parseGuideAction(raw: unknown, allowed: readonly GuideAction[] = GUIDE_ACTIONS): GuideActionPayload | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { action, step } = raw;
  if (typeof action !== 'string' || !(GUIDE_ACTIONS as readonly string[]).includes(action)) return undefined;
  if (!allowed.includes(action as GuideAction)) return undefined;
  if (action === 'step') return isGuideStepId(step) ? { action: 'step', step } : undefined;
  if (step !== undefined) return undefined;
  return { action: action as GuideAction };
}

/** What starts phase B on a canvas (`guideStart`'s payload). */
export interface CanvasGuideStart {
  /** The project stores its model as DBML. */
  dbml: boolean;
  /** The semantic dir, project-relative (`.erd-studio`). */
  semanticDir: string;
}

export function isCanvasGuideStart(value: unknown): value is CanvasGuideStart {
  return isPlainObject(value) && typeof value.dbml === 'boolean' && typeof value.semanticDir === 'string' && value.semanticDir.length <= 200;
}
