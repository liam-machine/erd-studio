/**
 * Draft-first: the shared contract (spec `docs/dev/draft-first.md`).
 *
 * The moment someone turns to ERD Studio in a folder with no diagram, it
 * shows a **draft** of their logical model, built from what it found (CREATE
 * TABLE scripts, a Power BI / Fabric semantic model, a DBML file, a dbt
 * project) or, when it found nothing, an example — read-only, in an editor
 * tab, with **nothing written** until the user presses Keep. Keep runs the
 * import's (or Draw from dbt's) existing write step: there is no second
 * writer.
 *
 * Three packages code against this file and nothing else of each other's:
 *
 *  - the pure draft services (`src/services/draftModel.ts`,
 *    `draftDisplay.ts`, `draftTriggers.ts`) build a {@link Draft} from an
 *    import plan, a dbt draft or an example;
 *  - the preview (`src/providers/DraftPreviewPanel.ts` + `webview-draft/`)
 *    implements {@link DraftPreview} and the page, speaking
 *    {@link DraftToWebview} / {@link DraftToHost};
 *  - the wiring (commands, triggers, the popup, the start surfaces) calls
 *    {@link DraftPreview.ask} at the point an import used to show its dry
 *    run, and acts on the {@link DraftAnswer}.
 *
 * Pure, vscode-free and Node-free: it is compiled by both tsconfigs (the
 * webview's includes `src/types/**`) and never imports from `services/`.
 * Nothing here leaves the machine; telemetry gets fixed keys only.
 */

import type { DisplaySubjectArea } from './display';

// ---------------------------------------------------------------------------
// Where a draft comes from, and what opened it
// ---------------------------------------------------------------------------

/**
 * What a draft was built from. `sqlDdl`, `semanticModel` and `dbml` are the
 * user's files run through Import DBML's planner; `dbt` is Draw from dbt's
 * draft of one models folder; `example` is the built-in coffee-shop DBML
 * (planned like an import); `exampleProject` is one of the bundled
 * `docs/examples/*` projects, read from memory.
 */
export const DRAFT_SOURCES = ['sqlDdl', 'semanticModel', 'dbml', 'dbt', 'example', 'exampleProject'] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

/**
 * What opened the draft (telemetry and focus only, never shown):
 *  - `sidebar`: the empty Diagrams view was drawn (the ERD Studio icon) and
 *    the folder's draft was due — the one automatic trigger;
 *  - `prompt`: the start suggestion's **Show Me**;
 *  - `start`: a start surface (Welcome, walkthrough, the empty Diagrams view's
 *    button) or the start quick pick;
 *  - `palette`: a step-by-step command (Import DBML…, Import SQL DDL…, …);
 *  - `changeOptions`: the step-by-step flow a draft's Change options… ran;
 *  - `example`: Open an Example….
 */
export const DRAFT_TRIGGERS = ['sidebar', 'prompt', 'start', 'palette', 'changeOptions', 'example'] as const;
export type DraftTrigger = (typeof DRAFT_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// The draft (built by the pure services, shown by the preview)
// ---------------------------------------------------------------------------

/** One schema's table count, biggest first (the schema panel; `''` for tables with no schema). */
export interface DraftSchemaCount {
  schema: string;
  tables: number;
}

/** The counts the banner and the schema panel show. */
export interface DraftSummary {
  /** Tables drawn (new + reused + changed library tables). */
  tables: number;
  /** Relationships drawn, a composite counted once. */
  relationships: number;
  /** Tables Keep creates. */
  newTables: number;
  /** Tables the Table Library already has, used as they are. */
  reusedTables: number;
  /** Library tables Keep changes (they gain a relationship). */
  changedTables: number;
  schemas: DraftSchemaCount[];
  /** Notes worth reading (renames, inferred keys, layout lines that did not read…). */
  notes: number;
  /** Things the source held that the draft leaves out (views, indexes, statements…). */
  leftOut: number;
  /** dbt: models in the chosen folder before the draft's cap (`DRAFT_MODEL_LIMIT`); absent when nothing was capped. */
  available?: number;
}

/** What Keep creates: shown in the banner's detail line, never sent to telemetry. */
export interface DraftTarget {
  /** Layer id (`main`, `gold`). */
  layer: string;
  /** Layer label as `layers.json` names it (`Main`, `Gold`). */
  layerLabel: string;
  /** The diagram's name (a slug: `sales`). */
  name: string;
  /** The diagram file Keep creates, project-relative with `/` (`.erd-studio/main/diagrams/sales.dbml`). */
  diagramFile: string;
}

/** One choice in the banner's switcher (a dbt models folder, one of several semantic models, an example). */
export interface DraftScopeOption {
  /** Opaque to the page; the host validates it against the options it sent. */
  id: string;
  /** `marts/finance`, `Sales.SemanticModel`, `Coffee shop`. */
  label: string;
  /** Short: `12 models`, `6 tables`. */
  description: string;
}

/** The switcher: what the draft shows, and what else it could. Absent: no switcher. */
export interface DraftScopes {
  /** The switcher's label: `Folder`, `Model`, `Example`. */
  label: string;
  /** The current option's id (one of `options`). */
  current: string;
  options: DraftScopeOption[];
}

/**
 * The other starts a draft offers, each a fixed host command (the page sends
 * the id only; the host maps it, never a command from the page):
 *  - `blank`: New Diagram (`erdStudio.createDomain`);
 *  - `import`: Import… (`erdStudio.importModel`, the source picker);
 *  - `guide`: the import guide (`erdStudio.showImportGuide` `{ from: 'draft' }`);
 *  - `example`: the example draft (Open an Example…);
 *  - `openFolder`: VS Code's Open Folder (an empty window).
 */
export const DRAFT_OTHER_STARTS = ['blank', 'import', 'guide', 'example', 'openFolder'] as const;
export type DraftOtherStart = (typeof DRAFT_OTHER_STARTS)[number];

export interface DraftOtherStartItem {
  id: DraftOtherStart;
  /** `New Diagram…`, `Import…`, `Bring In Your Data Model…`, `Open an Example…`, `Open Folder…`. */
  label: string;
}

/** One line of the details drawer (what the old Review All… page listed, as data: the page renders it, never as HTML). */
export interface DraftDetailItem {
  text: string;
  /** A project-relative path or a table name, shown monospace. */
  path?: string;
  /** A short tag after it: `new`, `in your library`, `changed`, `left out`. */
  tag?: string;
}

export interface DraftDetailSection {
  /** Stable: `tables:<schema>` (one per schema, `tables:` for none), `relationships`, `library`, `renamed`, `leftOut`, `notes`. */
  id: string;
  title: string;
  /** The count the title shows, when it is not the number of items. */
  count?: number;
  items: DraftDetailItem[];
  /** One sentence about the whole section. */
  hint?: string;
}

/** The banner across the top of the preview. Every string is final text (built by the pure services). */
export interface DraftBanner {
  /** `Draft from 4 SQL files (PostgreSQL) · 24 tables, 31 relationships · not saved`. */
  headline: string;
  /** `Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml).` */
  detail: string;
  /** Keep's label (`Keep as Diagram`, `Keep This Example`, `Save This Example…`); absent: nothing can be kept here. */
  keepLabel?: string;
  /** Which action is the one primary button: Keep, or one of `otherStarts` (an example: New Diagram…). */
  primary: 'keep' | DraftOtherStart;
  /** Show the `Change options…` link (the step-by-step flow, preselected). */
  changeOptions: boolean;
  /** Other starts drawn as buttons beside the primary; the rest go in `More ways to start ▾`. */
  shownStarts: DraftOtherStart[];
  /** A one-off line under the detail (`Your ERD Studio files changed, so the draft was redrawn. Check it and keep it again.`). */
  notice?: string;
}

/** Everything the page needs: what the host posts (`toDraftView`). Holds no absolute path and nothing to write with. */
export interface DraftView {
  /** Unique per build (a new id for a redrawn draft). */
  id: string;
  source: DraftSource;
  /** The editor tab's title: `Draft: sales`, `Example: Coffee shop`. */
  title: string;
  banner: DraftBanner;
  /** In the order the menu lists them. */
  otherStarts: DraftOtherStartItem[];
  scopes?: DraftScopes;
  summary: DraftSummary;
  /** The diagram, `readOnly: true`, drawn by the renderer's `ErdCanvas` (viewer). */
  display: DisplaySubjectArea;
  /**
   * No table has a stored position: the page runs the canvas's own ELK
   * layout before drawing (the canvas does the same on first open after
   * Keep, so the preview looks like the diagram Keep makes). `display`
   * holds the fallback placement either way.
   */
  autoLayout: boolean;
  /** A folder without dbt (and the empty window): no stage colours (`ErdCanvas` `logicalOnly`). */
  logicalOnly: boolean;
  /** A large draft: the schema the canvas shows first (the panel lists the rest). Absent: every table. */
  focusSchema?: string;
  /** Open the schema panel at first (a large draft). */
  panelOpen: boolean;
  details: DraftDetailSection[];
}

/**
 * What Keep needs to reach the existing writer. The flow that asked holds the
 * plan itself (Keep resolves its waiting {@link DraftPreview.ask}); this
 * records which writer and the answers it chose, so a redraw (files changed
 * since the draft was built) can tell whether the new plan is the same one.
 */
export type DraftKeep =
  /** Import DBML's write step (`importDbml`): a DBML file, converted SQL or semantic model, or the coffee-shop example in a folder. */
  | { writer: 'importDbml'; importSource: 'file' | 'sql' | 'semanticModel' | 'example'; target: DraftTarget; fingerprint: string }
  /** Draw from dbt's write step (`drawFromDbt`). */
  | { writer: 'drawFromDbt'; scopeId: string; target: DraftTarget; fingerprint: string }
  /** Open an Example…'s write step for a bundled project (`openExampleProject`: a folder of its own). */
  | { writer: 'exampleProject'; exampleId: string }
  /** Nothing to keep into (the coffee-shop example with no folder open). */
  | { writer: 'none' };

/** The draft as the host holds it: the view plus what Keep needs and what opened it. */
export interface Draft extends DraftView {
  keep: DraftKeep;
  trigger: DraftTrigger;
}

/** The part of a draft the page may see. */
export function toDraftView(draft: Draft): DraftView {
  const { keep: _keep, trigger: _trigger, ...view } = draft;
  return view;
}

// ---------------------------------------------------------------------------
// The page's protocol (its own, like the Welcome panel's and the import guide's)
// ---------------------------------------------------------------------------

export const DRAFT_PREVIEW_VIEW_TYPE = 'erdStudio.draftPreview';

/** Host → page. */
export type DraftToWebview =
  /** Draw this draft (the first, a redraw, or the next scope's). Re-enables every button. */
  | { type: 'draft'; view: DraftView }
  /** A button was answered and the host is working: `keep` (Saving…) or `scope` (Drawing…). Buttons disabled. */
  | { type: 'busy'; action: 'keep' | 'scope' }
  /** The work stopped without a new draft (a Keep that did not save, a scope that drew nothing): buttons back, with an optional line. */
  | { type: 'idle'; notice?: string };

/** Page → host. Every one is validated by {@link parseDraftToHost} against the draft on show. */
export type DraftToHost =
  | { type: 'ready' }
  | { type: 'keep' }
  | { type: 'changeOptions' }
  | { type: 'discard' }
  | { type: 'otherStart'; start: DraftOtherStart }
  | { type: 'scope'; scopeId: string }
  /** Passive: the schema panel or details drawer was opened (telemetry only). */
  | { type: 'detailsOpened' }
  /** Passive: ELK failed, the fallback placement is drawn (telemetry only). */
  | { type: 'layoutFailed' };

export const DRAFT_TO_HOST_TYPES = [
  'ready', 'keep', 'changeOptions', 'discard', 'otherStart', 'scope', 'detailsOpened', 'layoutFailed',
] as const satisfies readonly DraftToHost['type'][];

/** Messages that are not a choice: they never close the page or answer the flow. */
export const DRAFT_PASSIVE_TYPES: ReadonlySet<DraftToHost['type']> = new Set(['ready', 'detailsOpened', 'layoutFailed']);

/** What the draft on show allows: a message for anything else is dropped. */
export interface DraftMessageAllowance {
  keepable: boolean;
  changeOptions: boolean;
  scopeIds: ReadonlySet<string>;
  otherStarts: ReadonlySet<DraftOtherStart>;
}

export function draftAllowance(view: DraftView): DraftMessageAllowance {
  return {
    keepable: view.banner.keepLabel !== undefined,
    changeOptions: view.banner.changeOptions,
    scopeIds: new Set((view.scopes?.options ?? []).map((o) => o.id)),
    otherStarts: new Set(view.otherStarts.map((s) => s.id)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A message from the page, or undefined for anything malformed or not allowed
 * by the draft on show (a Keep where nothing can be kept, a scope or start the
 * host did not offer, the current scope again). Extra fields are dropped:
 * what is returned is rebuilt from the checked fields only.
 */
export function parseDraftToHost(raw: unknown, allowed: DraftMessageAllowance, currentScope?: string): DraftToHost | undefined {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return undefined;
  switch (raw.type) {
    case 'ready':
    case 'discard':
    case 'detailsOpened':
    case 'layoutFailed':
      return { type: raw.type };
    case 'keep':
      return allowed.keepable ? { type: 'keep' } : undefined;
    case 'changeOptions':
      return allowed.changeOptions ? { type: 'changeOptions' } : undefined;
    case 'otherStart': {
      const start = raw.start;
      return typeof start === 'string' && (DRAFT_OTHER_STARTS as readonly string[]).includes(start)
        && allowed.otherStarts.has(start as DraftOtherStart)
        ? { type: 'otherStart', start: start as DraftOtherStart }
        : undefined;
    }
    case 'scope': {
      const scopeId = raw.scopeId;
      return typeof scopeId === 'string' && allowed.scopeIds.has(scopeId) && scopeId !== currentScope
        ? { type: 'scope', scopeId }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The page's check of what the host posts (light: the host is trusted, this guards against a stale or foreign message). */
export function isDraftToWebview(raw: unknown): raw is DraftToWebview {
  if (!isPlainObject(raw)) return false;
  switch (raw.type) {
    case 'draft':
      return isPlainObject(raw.view) && typeof raw.view.id === 'string' && isPlainObject(raw.view.display);
    case 'busy':
      return raw.action === 'keep' || raw.action === 'scope';
    case 'idle':
      return raw.notice === undefined || typeof raw.notice === 'string';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The host API the wiring calls
// ---------------------------------------------------------------------------

/** How a Keep ended, told back to the page by the flow that asked. */
export type DraftKeepOutcome =
  /** Written; the flow opens the new diagram and the preview closes. */
  | { kept: true }
  /** Not written (the flow already said why, or is about to redraw): the buttons come back, with an optional line. */
  | { kept: false; notice?: string };

/**
 * The viewer's decision on a draft: each of Keep / Change options… /
 * Discard / More ways to start / the switcher is one kind (the "handlers"
 * of the preview, in promise form, so a flow awaits the preview exactly where
 * it awaited its dry run).
 *
 * After the answer the page:
 *  - `keep`: shows Saving… until the flow calls `settle` exactly once
 *    (`{ kept: true }` closes it; `{ kept: false }` brings the buttons back,
 *    and the flow then calls `ask` again with the SAME draft object, so the
 *    buttons keep answering). A flow that redraws (files changed since)
 *    settles `{ kept: false }` and then calls `ask` with the new draft;
 *  - `scope`: shows Drawing… until the flow calls `ask` with the next draft
 *    (or `ask` again with the same draft and a `banner.notice` when that
 *    scope drew nothing: {@link afterScope});
 *  - `changeOptions`, `discard`, `otherStart`: has closed;
 *  - `closed`: the user closed the tab;
 *  - `superseded`: another `ask` took the page over (a newer draft from
 *    another flow); the earlier flow stops quietly, counting nothing.
 */
export type DraftAnswer =
  | { kind: 'keep'; settle(outcome: DraftKeepOutcome): void }
  | { kind: 'changeOptions' }
  | { kind: 'discard' }
  | { kind: 'otherStart'; start: DraftOtherStart }
  | { kind: 'scope'; scopeId: string }
  | { kind: 'closed' }
  | { kind: 'superseded' };

/**
 * The preview: one editor tab at a time (a singleton webview panel, no
 * serializer: it closes on reload). Writes nothing and runs no command: the
 * flow that asked acts on the answer.
 */
export interface DraftPreview {
  /**
   * Show `draft` (opening the tab, or redrawing the open one) and resolve
   * with the viewer's next decision. A pending `ask` from another flow
   * resolves `superseded`. A draft opened by `sidebar` keeps the focus where
   * it was (the Diagrams view).
   */
  ask(draft: Draft): Promise<DraftAnswer>;
  /** Whether the tab is open. */
  isOpen(): boolean;
  /**
   * The id of the draft on show (undefined: no tab). After a switcher choice
   * the flow re-enters, then compares: still its own draft means the
   * re-entry drew nothing, so it asks that draft again with a notice.
   */
  showing?(): string | undefined;
  /** Close the tab; a pending `ask` resolves `closed`. */
  close(): void;
}

/** Passive events the preview reports to the host (the wiring counts them; the preview counts nothing itself). */
export interface DraftPreviewEvents {
  detailsOpened(source: DraftSource): void;
  layoutFailed(source: DraftSource): void;
}
