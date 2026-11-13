/**
 * The "Convert to DBML" panel's pure half (native DBML storage §6.2, after
 * pre-release 1.9.0): the plan as a scrollable, sectioned list, the panel's
 * own small message protocol and its validation, and the self-contained HTML
 * (nonce-only CSP, no remote resources; the glass look of `glassPageStyle.ts`,
 * so colours only from its tokens and `--vscode-*`).
 *
 * The panel is not the canvas, so its messages are not part of
 * `src/types/messages.ts`. vscode-free: the host half is
 * `src/providers/ConvertToDbmlPanel.ts`. The panel writes nothing: Convert
 * hands the choice back to the command, which applies the plan as before.
 * `erd-studio doctor`'s text preview stays `describeDbmlConversion`.
 */

import { classifySemanticFile } from '@erd-studio/core';

import { dbmlLeftAsIsTitle, isDbmlSelfCheckRefusal, type DbmlConversionPlan } from './dbmlConversion';
import { GLASS_PAGE_STYLE } from '../types/glassPageStyle';

export const CONVERT_PANEL_VIEW_TYPE = 'erdStudio.convertToDbml';
export const CONVERT_PANEL_TITLE = 'Convert to DBML';

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** One row of a section: a path (monospace), a sentence, or both. */
export interface ConvertReviewItem {
  /** Project-relative, shown in a monospace font. */
  path?: string;
  line?: number;
  /** A short tag after the path: new, updated, removed, layout. */
  tag?: string;
  text?: string;
  /** Further project-relative paths after the text, each in the monospace path style. */
  paths?: string[];
  /** Index into the host's list of openable locations (refusals only). */
  open?: number;
}

export interface ConvertReviewSection {
  id: string;
  title: string;
  items: ConvertReviewItem[];
  /** A sentence about the whole section, shown under its items and not counted. */
  hint?: string;
  /** The count its title shows, when it is not the number of items (tables, not diagram rows). */
  count?: number;
}

export interface ConvertReviewView {
  /** `review`: Convert and Cancel. `refused`: Check again and Close, no Convert. */
  mode: 'review' | 'refused';
  /** Refused by ERD Studio's own self-check (its bug): the page offers Send Feedback too. */
  reportable?: boolean;
  /** A review that leaves files as they are: Check Again (after fixing them) beside Convert. */
  checkAgain?: boolean;
  heading: string;
  /** One plain sentence: what converts, what stays as it is, what stays missing. */
  summary?: string;
  intro: string[];
  counts: Array<{ label: string; value: number }>;
  sections: ConvertReviewSection[];
}

/** A refusal's file (relative to the semantic dir) and line, to open on request. */
export interface ConvertRefusalLocation {
  path: string;
  line?: number;
}

const FILE_PATTERN = /(?:^|[\s(,:'"‘“])((?:[^\s,:()'"‘’“”/]+\/)*[^\s,:()'"‘’“”/]+\.(?:yml|yaml|json|dbml|dbdiagram))(?=$|[\s,:().'"’”;])/g;

/**
 * Where a refusal points: the first file it names that `exists` (relative to
 * the semantic dir), and the line it gives (`file:12`, `(line 12)`, `, line 12`).
 * Undefined when it names no existing file. Pure; the host checks existence.
 */
export function locateDbmlRefusal(refusal: string, exists: (relPath: string) => boolean = () => true): ConvertRefusalLocation | undefined {
  for (const match of refusal.matchAll(FILE_PATTERN)) {
    const file = match[1];
    if (file.startsWith('/') || file.split('/').includes('..') || !exists(file)) continue;
    const after = refusal.slice((match.index ?? 0) + match[0].length);
    const colon = /^:(\d+)\b/.exec(after);
    const said = /[(,]\s*line (\d+)\b/.exec(refusal);
    const line = colon ? Number(colon[1]) : said ? Number(said[1]) : undefined;
    return { path: file, ...(line !== undefined && line >= 1 ? { line } : {}) };
  }
  return undefined;
}

export interface ConvertReviewOptions {
  /** A path relative to the semantic dir, as the user sees it (project-relative). */
  display: (relPath: string) => string;
  /** Whether a path relative to the semantic dir is on disk (refusals open only real files). */
  exists?: (relPath: string) => boolean;
  /** The fixed lines of the review's header. */
  introLines: string[];
  /** The refused page's sentence about what was (not) changed. */
  nothingChanged?: string;
  /** Whether a path relative to the semantic dir has unsaved edits in an editor (Check Again reads the disk). */
  unsaved?: (relPath: string) => boolean;
  /** This run already ran Migrate Subject Areas to the Central Table Library, and these diagrams are still v4. */
  v4StepRan?: boolean;
  /** Whether the open folder is a dbt project; default true. Without one, no hint names a dbt command. */
  hasDbt?: boolean;
}

/** The last sentence of the "Kept as missing" hint: Add from dbt only exists in a dbt project. */
function keptMissingNextStep(one: boolean, hasDbt: boolean): string {
  const it = one ? 'it' : 'them';
  return hasDbt
    ? `Create ${it} later with Add from dbt.`
    : `Give ${one ? 'it a table file' : 'each a table file'} later, or remove ${it} from the diagram.`;
}

/** The v4 → v5 command, by its title in the palette. */
export const MIGRATE_TO_V5_COMMAND_TITLE = 'ERD Studio: Migrate Subject Areas to the Central Table Library';

/** The tag on a problem whose file has unsaved edits: Check Again reads what is saved. */
export const UNSAVED_TAG = 'unsaved edits: save, then Check Again';


/** A count as people write it (1,100), as the progress notification and the completion toast show it. */
export const thousands = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;

function kindOf(relPath: string): 'table' | 'relationships' | 'diagram' | 'other' {
  const kind = classifySemanticFile(relPath, { tablesDirIsLayer: false }).kind;
  return kind === 'table' || kind === 'relationships' || kind === 'diagram' ? kind : 'other';
}

/**
 * The plan as the panel shows it, and the refusals' locations (indexed by
 * each item's `open`). A plan with refusals or v4 diagrams is the refused
 * page; any other is the review.
 */
export function buildConvertReview(plan: DbmlConversionPlan, options: ConvertReviewOptions): { view: ConvertReviewView; locations: ConvertRefusalLocation[] } {
  const { display } = options;
  const notes: ConvertReviewSection = { id: 'notes', title: 'Notes', items: plan.notes.map((text) => ({ text })) };

  // Files left as they are until fixed (each with Open), and members kept missing (D26): listed in every view.
  const leftLocations: ConvertRefusalLocation[] = [];
  // What is left, by its own format: YAML tables, JSON diagrams, or a mix (an existing .dbml file included).
  const leftTitle = dbmlLeftAsIsTitle(plan.leftAsIs);
  const leftSection = (offset: number): ConvertReviewSection => ({
    id: 'left',
    title: leftTitle,
    ...(plan.leftAsIs.length > 0 ? { hint: `${plan.leftAsIs.length === 1 ? 'This file stays' : 'These files stay'} exactly as ${plan.leftAsIs.length === 1 ? 'it is' : 'they are'}, and the diagrams draw ${plan.leftAsIs.length === 1 ? 'it' : 'them'} as before. Fix ${plan.leftAsIs.length === 1 ? 'it' : 'them'} and run Convert again to finish the job.` } : {}),
    items: [
      ...plan.leftAsIs.map((l): ConvertReviewItem => {
        leftLocations.push({ path: l.path, ...(l.line !== undefined ? { line: l.line } : {}) });
        return {
          path: display(l.path),
          ...(l.line !== undefined ? { line: l.line } : {}),
          ...(options.unsaved?.(l.path) ? { tag: UNSAVED_TAG } : {}),
          text: l.problem,
          open: offset + leftLocations.length - 1,
        };
      }),
    ],
  });
  const handledSection: ConvertReviewSection = {
    id: 'handled',
    title: 'Handled for you',
    items: plan.handled.map((h) => ({ path: display(h.path), text: h.text })),
  };
  const missingTables = plan.keptMissing.reduce((n, k) => n + k.tables.length, 0);
  const missingSection: ConvertReviewSection = {
    id: 'missing',
    title: 'Kept as missing on their diagrams',
    count: missingTables,
    ...(plan.keptMissing.length > 0 ? { hint: `${missingTables === 1 ? 'This table has' : 'These tables have'} no table file. ${missingTables === 1 ? 'It stays on its diagram' : `They stay on ${plan.keptMissing.length === 1 ? 'their diagram' : 'their diagrams'}`}, drawn as missing exactly as before. ${keptMissingNextStep(missingTables === 1, options.hasDbt !== false)}` } : {}),
    items: plan.keptMissing.map((k) => ({ path: display(k.diagram), text: k.tables.join(', ') })),
  };
  const summaryOf = (): string => {
    const s = plan.summary;
    const parts = [`${plural(s.tables, 'table')} and ${plural(s.diagrams, 'diagram')} convert to DBML`];
    if (plan.leftAsIs.length > 0) parts.push(`${plural(plan.leftAsIs.length, 'file')} ${plan.leftAsIs.length === 1 ? 'stays' : 'stay'} as ${plan.leftAsIs.length === 1 ? 'it is' : 'they are'} until fixed`);
    const missing = missingTables;
    const where = plan.keptMissing.length > 1 ? 'their diagrams' : missing === 1 ? 'its diagram' : 'their diagram';
    if (missing > 0) parts.push(`${plural(missing, 'missing table')} ${missing === 1 ? 'stays' : 'stay'} on ${where}`);
    return `${parts.join('; ')}.`;
  };

  if (plan.refusals.length === 0 && plan.v4SubjectAreas.length === 0 && plan.leftAsIs.length > 0
    && plan.creates.length === 0 && plan.replaces.length === 0 && plan.deletes.length === 0) {
    // Nothing else can convert until these files are fixed: no Convert, only Check Again.
    const left = leftSection(0);
    return {
      view: {
        mode: 'refused',
        heading: 'Nothing else to convert yet',
        intro: [`Fix ${plan.leftAsIs.length === 1 ? 'this file' : 'these files'} and save, then choose Check Again. ${options.nothingChanged ?? 'Nothing was changed.'}`],
        counts: [{ label: plan.leftAsIs.length === 1 ? 'file left as it is' : 'files left as they are', value: plan.leftAsIs.length }],
        sections: [left, ...(missingSection.items.length > 0 ? [missingSection] : []), ...(notes.items.length > 0 ? [notes] : [])],
      },
      locations: leftLocations,
    };
  }

  if (plan.refusals.length > 0 || plan.v4SubjectAreas.length > 0) {
    const locations: ConvertRefusalLocation[] = [];
    const unsavedTag = (rel: string): { tag?: string } => (options.unsaved?.(rel) ? { tag: UNSAVED_TAG } : {});
    const items: ConvertReviewItem[] = plan.refusals.map((text) => {
      const at = locateDbmlRefusal(text, options.exists);
      if (!at) return { text };
      locations.push(at);
      return { path: display(at.path), ...(at.line !== undefined ? { line: at.line } : {}), ...unsavedTag(at.path), text, open: locations.length - 1 };
    });
    for (const v4 of plan.v4SubjectAreas) {
      locations.push({ path: v4 });
      items.push({
        path: display(v4),
        ...unsavedTag(v4),
        text: options.v4StepRan
          ? `This diagram is still in schema v4 after ${MIGRATE_TO_V5_COMMAND_TITLE}. Open it and check its tables, then choose Check Again.`
          : `This diagram is in schema v4. Run ${MIGRATE_TO_V5_COMMAND_TITLE}, then choose Check Again.`,
        open: locations.length - 1,
      });
    }
    const nothingChanged = options.nothingChanged ?? 'Nothing was changed.';
    // The self-check's refusals are ERD Studio's bugs: the user can't fix them, so say so and offer Send Feedback.
    const reportable = plan.refusals.some(isDbmlSelfCheckRefusal);
    return {
      view: {
        mode: 'refused',
        ...(reportable ? { reportable: true } : {}),
        heading: reportable ? "Can't convert this project safely" : "Can't convert yet",
        intro: [
          reportable
            ? `ERD Studio checks the DBML it would write before writing anything, and that check failed. This is a problem in ERD Studio, not in your files. ${nothingChanged} Send Feedback reports it.`
            : `Fix ${items.length === 1 ? 'this' : 'these'} and save, then choose Check Again. ${nothingChanged}`,
        ],
        counts: [{ label: items.length === 1 ? 'problem' : 'problems', value: items.length }],
        sections: [{ id: 'problems', title: 'Problems', items }, ...(() => {
          const left = leftSection(locations.length);
          return left.items.length > 0 ? [left] : [];
        })(), ...(notes.items.length > 0 ? [notes] : [])],
      },
      locations: [...locations, ...leftLocations],
    };
  }

  const tables: Array<ConvertReviewItem & { rel: string }> = [];
  const relationships: Array<ConvertReviewItem & { rel: string }> = [];
  const diagrams: Array<ConvertReviewItem & { rel: string }> = [];
  const other: Array<ConvertReviewItem & { rel: string }> = [];
  const place = (rel: string, tag: string): void => {
    const kind = kindOf(rel);
    const item = { rel, path: display(rel), tag };
    if (kind === 'table') tables.push(item);
    else if (kind === 'relationships') relationships.push(item);
    else if (kind === 'diagram') diagrams.push(item);
    else other.push(item);
  };
  for (const c of plan.creates) place(c.path, 'new');
  for (const r of plan.replaces) place(r.path, 'updated');
  const strip = (items: Array<ConvertReviewItem & { rel: string }>): ConvertReviewItem[] => items.map(({ rel: _rel, ...item }) => item);

  const moved: ConvertReviewItem[] = [];
  // A converted diagram is named by the `.dbml` it becomes (`<layer>/diagrams/<name>.dbml`); an existing one by its own path.
  const targetOf = new Map(plan.targets.map((t) => [t.source, t.target]));
  const also = plan.movedRelationships.filter((m) => m.diagrams.length > 0);
  for (const m of also) moved.push({ text: `${m.from} → ${m.to} also shows in`, paths: m.diagrams.map((d) => display(targetOf.get(d) ?? d)) });
  const only = plan.movedRelationships.length - also.length;
  if (only > 0) moved.push({ text: `${plural(only, also.length > 0 ? 'other relationship' : 'relationship')} ${only === 1 ? 'shows' : 'show'} in the same diagrams as before.` });

  const s = plan.summary;
  const left = leftSection(0);
  const sections: ConvertReviewSection[] = [
    handledSection,
    left,
    missingSection,
    { id: 'tables', title: 'Tables', items: strip(tables.sort((a, b) => a.rel.localeCompare(b.rel))) },
    { id: 'relationships', title: 'Relationships files', items: strip(relationships.sort((a, b) => a.rel.localeCompare(b.rel))) },
    { id: 'diagrams', title: 'Diagrams', items: strip(diagrams.sort((a, b) => a.rel.localeCompare(b.rel))) },
    { id: 'other', title: 'Other files', items: strip(other) },
    { id: 'removed', title: 'Files removed', items: plan.deletes.map((d) => ({ path: display(d), tag: 'removed' })) },
    { id: 'moved', title: 'Relationships moving from diagram files to the table library', items: moved },
    { id: 'resumed', title: 'Already converted by an earlier run', items: plan.resumed.map((p) => ({ path: display(p) })) },
    notes,
  ].filter((section) => section.items.length > 0);
  return {
    view: {
      mode: 'review',
      ...(plan.leftAsIs.length > 0 ? { checkAgain: true } : {}),
      heading: 'Convert this project to DBML?',
      summary: summaryOf(),
      intro: options.introLines,
      counts: [
        { label: s.tables === 1 ? 'table' : 'tables', value: s.tables },
        { label: s.diagrams === 1 ? 'diagram' : 'diagrams', value: s.diagrams },
        { label: s.relationships === 1 ? 'relationship' : 'relationships', value: s.relationships },
        { label: plan.creates.length === 1 ? 'file created' : 'files created', value: plan.creates.length },
        ...(plan.replaces.length > 0 ? [{ label: plan.replaces.length === 1 ? 'file updated' : 'files updated', value: plan.replaces.length }] : []),
        { label: plan.deletes.length === 1 ? 'file removed' : 'files removed', value: plan.deletes.length },
      ],
      sections,
    },
    locations: leftLocations,
  };
}

// ---------------------------------------------------------------------------
// The protocol: the panel's choices (webview → host), and the one thing the
// host posts back, what Convert is doing once the user chose Convert
// ---------------------------------------------------------------------------

/** Host → panel: the phase Convert is in ("Writing 2,266 files…"), shown on the Convert button and in a status line. */
export interface ConvertPanelProgress {
  type: 'progress';
  text: string;
}

export type ConvertPanelToHost =
  | { type: 'convert' }
  | { type: 'cancel' }
  | { type: 'checkAgain' }
  | { type: 'sendFeedback' }
  /** The refused page's Show Logs: opens the ERD Studio output channel. */
  | { type: 'showLogs' }
  | { type: 'open'; index: number };

/**
 * Every message from the panel is checked here before the host acts on it:
 * a known type, and for `open` an integer index into the host's own list
 * (`openable` long). Anything else is rejected, and the host logs and ignores it.
 */
export function isConvertPanelToHost(value: unknown, openable: number): value is ConvertPanelToHost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const msg = value as { type?: unknown; index?: unknown };
  switch (msg.type) {
    case 'convert':
    case 'cancel':
    case 'checkAgain':
    case 'sendFeedback':
    case 'showLogs':
      return true;
    case 'open':
      return typeof msg.index === 'number' && Number.isInteger(msg.index) && msg.index >= 0 && msg.index < openable;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

export function buildConvertPanelCsp(nonce: string): string {
  return ["default-src 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ') + ';';
}

/** Text as HTML (the review pages build no markup from data). Shared with the import review (`importReview.ts`). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The Convert to DBML page's own CSS, after {@link GLASS_PAGE_STYLE} (the
 * glass tokens and the `gp-` kit the markup uses beside these `cdb` classes):
 * the full-height layout (header, the one scrolling list, the sticky button
 * bar) and the review's own pieces. Colours from the glass tokens only.
 */
export const REVIEW_PANEL_STYLE = String.raw`
html, body { height: 100%; }
.cdb {
  display: flex; flex-direction: column; height: 100vh;
  max-width: calc(880px + 2 * var(--space-8)); margin: 0 auto;
}
.cdb__header { flex: none; padding: var(--space-8) var(--space-8) var(--space-5); }
.cdb__heading { margin: 0 0 var(--space-4); }
.cdb__summary { margin: 0 0 var(--space-3); font-weight: var(--weight-semibold); line-height: var(--leading-normal); }
.cdb__intro { margin: 0 0 var(--space-2); color: var(--text-secondary); line-height: var(--leading-normal); }
.cdb__counts { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: var(--space-5) 0 0; padding: 0; list-style: none; }
.cdb__count-value { color: var(--text-primary); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }

/* The one scrolling region: the sections as glass cards. Keyboard users
   reach it with Tab and scroll it with the arrow keys. */
.cdb__list {
  flex: 1 1 auto; min-height: 8em; overflow-y: auto;
  margin: 0; padding: var(--space-2) var(--space-8) var(--space-6);
  border-radius: var(--radius-lg);
}
.cdb__list:focus { outline: none; }
.cdb__list:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }
.cdb-section { margin: 0 0 var(--space-5); padding: var(--space-2) var(--space-5) var(--space-3); }
.cdb-section[data-section='problems'] { border-color: var(--glass-tint-error-edge); }
.cdb-section[data-section='left'] { border-color: var(--glass-tint-warning-edge); }
body.vscode-high-contrast .cdb-section[data-section='problems'],
body.vscode-high-contrast-light .cdb-section[data-section='problems'] { border-color: var(--error-fg); }
body.vscode-high-contrast .cdb-section[data-section='left'],
body.vscode-high-contrast-light .cdb-section[data-section='left'] { border-color: var(--warning-fg); }

/* A section's title: a disclosure row (chevron, title, count badge). */
.cdb-section__title {
  display: flex; align-items: center; gap: var(--space-4);
  min-height: var(--control-height-lg); margin: 0 calc(-1 * var(--space-3)); padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  color: var(--text-primary); font-size: var(--text-md); font-weight: var(--weight-semibold);
  list-style: none; cursor: pointer; user-select: none; -webkit-user-select: none;
  transition: background-color var(--duration-fast) var(--ease-standard);
}
.cdb-section__title::-webkit-details-marker { display: none; }
.cdb-section__title::before {
  content: ''; flex: none; width: 6px; height: 6px; margin: 0 var(--space-1) 0 var(--space-1);
  border-right: 1.5px solid var(--text-tertiary); border-bottom: 1.5px solid var(--text-tertiary);
  transform: rotate(-45deg);
  transition: transform var(--duration-base) var(--ease-standard);
}
.cdb-section[open] > .cdb-section__title::before { transform: rotate(45deg); }
.cdb-section__title:hover { background: var(--control-fill-hover); }
.cdb-section__title:focus-visible { outline: var(--focus-outline); outline-offset: 0; }
body.vscode-high-contrast .cdb-section__title:hover,
body.vscode-high-contrast-light .cdb-section__title:hover { outline: 1px dashed var(--control-border-hover); outline-offset: -1px; }
.cdb-section__count { font-weight: var(--weight-semibold); }

.cdb-section__items { margin: var(--space-1) 0 var(--space-2); padding: 0; list-style: none; }
.cdb-section__hint { margin: 0 0 var(--space-3); line-height: var(--leading-normal); }
.cdb-item { padding: var(--space-3) 0; line-height: var(--leading-normal); overflow-wrap: anywhere; }
.cdb-item + .cdb-item { border-top: 1px solid var(--glass-divider); }
.cdb-item__path { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--text-primary); }
.cdb-item__tag { margin-left: var(--space-4); padding-top: 0; padding-bottom: 0; vertical-align: 1px; }
.cdb-item__text { display: block; margin-top: var(--space-1); color: var(--text-secondary); }
.cdb-item__text:first-child { margin-top: 0; color: var(--text-primary); }
.cdb-item__paths { display: block; }
.cdb-item--problem { padding: var(--space-4) 0; }
.cdb-item--problem .cdb-item__path { color: var(--error-fg); }
.cdb-item--problem .cdb-item__text { color: var(--text-primary); }
.cdb-item__open { margin-left: var(--space-4); font-weight: var(--weight-medium); }

/* The buttons sit bottom-left, the status after them: VS Code's notifications
   stack at the bottom right of the window, over a right-aligned Convert
   (onboarding story 08 pressed a toast's button instead). */
.cdb__actions {
  position: sticky; bottom: 0; flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); justify-content: flex-start;
  padding: var(--space-5) var(--space-8);
  border-top: 1px solid var(--glass-divider);
  background: var(--glass-surface-1);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
}
.cdb__status { order: 1; flex: 1; align-self: center; min-width: 12em; margin: 0 0 0 var(--space-2); color: var(--text-secondary); font-size: var(--text-sm); }
.cdb__status:empty { display: none; }
/* Every button is disabled only while Convert or Check Again runs, and the
   pressed one then carries what it is doing: keep that one readable. */
.cdb__button:disabled { cursor: progress; }
.cdb__button.gp-button--primary:disabled { opacity: 0.75; }

@media (prefers-reduced-motion: reduce) {
  .cdb-section__title, .cdb-section__title::before { transition: none; }
}
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.cdb__button'));
  function lock(button, label) {
    buttons.forEach(function (b) { b.disabled = true; });
    if (label) { button.textContent = label; }
  }
  var status = document.querySelector('.cdb__status');
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'progress' || typeof data.text !== 'string') { return; }
    buttons.forEach(function (b) { b.disabled = true; });
    buttons.forEach(function (b) { if (b.getAttribute('data-action') === 'convert') { b.textContent = data.text; } });
    if (status) { status.textContent = data.text; }
  });
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled) { return; }
    var action = target.getAttribute('data-action');
    if (action === 'open') {
      vscode.postMessage({ type: 'open', index: Number(target.getAttribute('data-index')) });
      return;
    }
    if (action === 'sendFeedback' || action === 'showLogs') {
      vscode.postMessage({ type: action });
      return;
    }
    if (action === 'convert') { lock(target, 'Converting\\u2026'); }
    else if (action === 'checkAgain') { lock(target, 'Checking\\u2026'); }
    else if (action === 'cancel') { lock(target, null); }
    else { return; }
    vscode.postMessage({ type: action });
  });
})();
`;

/** A row tag's tint (the kit's `gp-pill--*`): what happens to the file, at a glance. Any other tag stays neutral. */
const TAG_TINTS: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  new: 'ok',
  updated: 'accent',
  removed: 'error',
  [UNSAVED_TAG]: 'warning',
});

/** One row of a review section (shared with the import review). */
export function renderReviewItem(item: ConvertReviewItem, problem: boolean): string {
  const where = item.path !== undefined
    ? `<code class="cdb-item__path">${escapeHtml(item.path)}${item.line !== undefined ? `:${item.line}` : ''}</code>`
    : '';
  const tag = item.tag ? `<span class="cdb-item__tag gp-pill${TAG_TINTS[item.tag] ? ` gp-pill--${TAG_TINTS[item.tag]}` : ''}">${escapeHtml(item.tag)}</span>` : '';
  const open = item.open !== undefined
    ? `<button type="button" class="cdb-item__open gp-link" data-action="open" data-index="${item.open}">Open</button>`
    : '';
  const text = item.text !== undefined ? `<span class="cdb-item__text">${escapeHtml(item.text)}</span>` : '';
  const paths = item.paths && item.paths.length > 0
    ? `<span class="cdb-item__paths">${item.paths.map((p) => `<code class="cdb-item__path">${escapeHtml(p)}</code>`).join(', ')}</span>`
    : '';
  return `<li class="cdb-item${problem ? ' cdb-item--problem' : ''}">${where}${tag}${open}${text}${paths}</li>`;
}

/** The page: header, counts, the scrollable sectioned list, and the sticky buttons. */
export function buildConvertPanelHtml(view: ConvertReviewView, nonce: string): string {
  const n = escapeHtml(nonce);
  const sections = view.sections.map((section) => `
    <details class="cdb-section gp-card" data-section="${escapeHtml(section.id)}" open>
      <summary class="cdb-section__title">${escapeHtml(section.title)}<span class="cdb-section__count gp-badge">${thousands(section.count ?? section.items.length)}</span></summary>
      <ul class="cdb-section__items">${section.items.map((item) => renderReviewItem(item, section.id === 'problems' || (section.id === 'left' && item.path !== undefined))).join('')}</ul>${section.hint !== undefined ? `
      <p class="cdb-section__hint gp-hint">${escapeHtml(section.hint)}</p>` : ''}
    </details>`).join('');
  const secondary = 'cdb__button cdb__button--secondary gp-button gp-button--lg';
  const primary = 'cdb__button gp-button gp-button--lg gp-button--primary';
  const actions = view.mode === 'review'
    ? `<button type="button" class="${secondary}" data-action="cancel">Cancel</button>` +
      (view.checkAgain ? `<button type="button" class="${secondary}" data-action="checkAgain">Check Again</button>` : '') +
      `<button type="button" class="${primary}" data-action="convert">Convert</button>`
    : `<button type="button" class="${secondary}" data-action="cancel">Close</button>` +
      `<button type="button" class="${secondary}" data-action="showLogs">Show Logs</button>` +
      (view.reportable ? `<button type="button" class="${secondary}" data-action="sendFeedback">Send Feedback</button>` : '') +
      `<button type="button" class="${primary}" data-action="checkAgain">Check Again</button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildConvertPanelCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(CONVERT_PANEL_TITLE)}</title>
<style nonce="${n}">${GLASS_PAGE_STYLE}${REVIEW_PANEL_STYLE}</style>
</head>
<body>
<main class="cdb" data-mode="${view.mode}">
  <header class="cdb__header">
    <h1 class="cdb__heading gp-title">${escapeHtml(view.heading)}</h1>
    ${view.summary ? `<p class="cdb__summary">${escapeHtml(view.summary)}</p>` : ''}
    ${view.intro.map((line) => `<p class="cdb__intro">${escapeHtml(line)}</p>`).join('\n    ')}
    <ul class="cdb__counts">${view.counts.map((c) => `<li class="cdb__count gp-pill"><span class="cdb__count-value">${thousands(c.value)}</span> ${escapeHtml(c.label)}</li>`).join('')}</ul>
  </header>
  <section class="cdb__list" tabindex="0" aria-label="${view.mode === 'review' ? 'Changes' : 'Problems'}">${sections}
  </section>
  <footer class="cdb__actions"><p class="cdb__status" role="status" aria-live="polite"></p>${actions}</footer>
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
