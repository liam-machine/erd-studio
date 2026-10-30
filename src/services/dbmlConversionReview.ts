/**
 * The "Convert to DBML" panel's pure half (native DBML storage §6.2, after
 * pre-release 1.9.0): the plan as a scrollable, sectioned list, the panel's
 * own small message protocol and its validation, and the self-contained HTML
 * (nonce-only CSP, no remote resources, colours only from `--vscode-*`).
 *
 * The panel is not the canvas, so its messages are not part of
 * `src/types/messages.ts`. vscode-free: the host half is
 * `src/providers/ConvertToDbmlPanel.ts`. The panel writes nothing: Convert
 * hands the choice back to the command, which applies the plan as before.
 * `erd-studio doctor`'s text preview stays `describeDbmlConversion`.
 */

import { classifySemanticFile } from '@erd-studio/core';

import { dbmlLeftAsIsTitle, isDbmlSelfCheckRefusal, type DbmlConversionPlan } from './dbmlConversion';

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
}

/** The v4 → v5 command, by its title in the palette. */
export const MIGRATE_TO_V5_COMMAND_TITLE = 'ERD Studio: Migrate Subject Areas to the Central Table Library';

/** The tag on a problem whose file has unsaved edits: Check Again reads what is saved. */
export const UNSAVED_TAG = 'unsaved edits: save, then Check Again';

/** A converted diagram's path: its `.json` becomes the `.dbml` beside it (an existing `.dbml` stays). */
function diagramTarget(relPath: string): string {
  return relPath.endsWith('.json') ? `${relPath.slice(0, -'.json'.length)}.dbml` : relPath;
}

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
    ...(plan.keptMissing.length > 0 ? { hint: `${missingTables === 1 ? 'This table has' : 'These tables have'} no table file. ${missingTables === 1 ? 'It stays on its diagram' : `They stay on ${plan.keptMissing.length === 1 ? 'their diagram' : 'their diagrams'}`}, drawn as missing exactly as before. Create ${missingTables === 1 ? 'it' : 'them'} later with Add from dbt.` } : {}),
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
  const also = plan.movedRelationships.filter((m) => m.diagrams.length > 0);
  for (const m of also) moved.push({ text: `${m.from} → ${m.to} also shows in`, paths: m.diagrams.map((d) => display(diagramTarget(d))) });
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; padding: 0; }
body {
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
.cdb { display: flex; flex-direction: column; height: 100vh; max-width: 960px; margin: 0 auto; }
.cdb__header { flex: none; padding: 20px 24px 8px; }
.cdb__heading { margin: 0 0 8px; font-size: 1.4em; font-weight: 600; }
.cdb__summary { margin: 0 0 8px; line-height: 1.45; font-weight: 600; }
.cdb__intro { margin: 0 0 6px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
.cdb__counts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 10px 0 0; padding: 0; list-style: none; }
.cdb__count-value { font-weight: 600; color: var(--vscode-foreground); }
.cdb__count { color: var(--vscode-descriptionForeground); }
.cdb__list {
  flex: 1 1 auto; min-height: 8em; overflow-y: auto; margin: 8px 24px 0; padding: 0 4px 12px 0;
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
}
.cdb__list:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.cdb-section { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); }
.cdb-section__title { cursor: pointer; padding: 6px 2px; font-weight: 600; }
.cdb-section__title:focus { outline: 1px solid var(--vscode-focusBorder); }
.cdb-section__count {
  margin-left: 6px; padding: 0 6px; border-radius: 8px; font-weight: 400;
  color: var(--vscode-badge-foreground); background: var(--vscode-badge-background);
}
.cdb-section__items { margin: 2px 0 6px; padding: 0 0 0 18px; list-style: none; }
.cdb-section__hint { margin: 0 0 6px; padding: 0 0 0 18px; color: var(--vscode-descriptionForeground); }
.cdb-item { padding: 3px 0; line-height: 1.4; overflow-wrap: anywhere; }
.cdb-item__path { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.cdb-item__tag { margin-left: 8px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
.cdb-item__text { display: block; color: var(--vscode-foreground); }
.cdb-item__paths { display: block; }
.cdb-item--problem { padding: 6px 0; }
.cdb-item--problem .cdb-item__path { color: var(--vscode-errorForeground); }
.cdb-item__open {
  margin-left: 8px; padding: 0; border: none; background: none; cursor: pointer;
  font: inherit; color: var(--vscode-textLink-foreground);
}
.cdb-item__open:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.cdb-item__open:focus { outline: 1px solid var(--vscode-focusBorder); }
.cdb__status { flex: 1; align-self: center; margin: 0; color: var(--vscode-descriptionForeground); }
.cdb__status:empty { display: none; }
.cdb__actions {
  position: sticky; bottom: 0; flex: none; display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 24px; background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
}
.cdb__button {
  padding: 6px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
  font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
.cdb__button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.cdb__button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.cdb__button--secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.cdb__button--secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.cdb__button:disabled { opacity: 0.5; cursor: default; }
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

function renderItem(item: ConvertReviewItem, problem: boolean): string {
  const where = item.path !== undefined
    ? `<code class="cdb-item__path">${escapeHtml(item.path)}${item.line !== undefined ? `:${item.line}` : ''}</code>`
    : '';
  const tag = item.tag ? `<span class="cdb-item__tag">${escapeHtml(item.tag)}</span>` : '';
  const open = item.open !== undefined
    ? `<button type="button" class="cdb-item__open" data-action="open" data-index="${item.open}">Open</button>`
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
    <details class="cdb-section" data-section="${escapeHtml(section.id)}" open>
      <summary class="cdb-section__title">${escapeHtml(section.title)}<span class="cdb-section__count">${thousands(section.count ?? section.items.length)}</span></summary>
      <ul class="cdb-section__items">${section.items.map((item) => renderItem(item, section.id === 'problems' || (section.id === 'left' && item.path !== undefined))).join('')}</ul>${section.hint !== undefined ? `
      <p class="cdb-section__hint">${escapeHtml(section.hint)}</p>` : ''}
    </details>`).join('');
  const actions = view.mode === 'review'
    ? '<button type="button" class="cdb__button cdb__button--secondary" data-action="cancel">Cancel</button>' +
      (view.checkAgain ? '<button type="button" class="cdb__button cdb__button--secondary" data-action="checkAgain">Check Again</button>' : '') +
      '<button type="button" class="cdb__button" data-action="convert">Convert</button>'
    : '<button type="button" class="cdb__button cdb__button--secondary" data-action="cancel">Close</button>' +
      '<button type="button" class="cdb__button cdb__button--secondary" data-action="showLogs">Show Logs</button>' +
      (view.reportable ? '<button type="button" class="cdb__button cdb__button--secondary" data-action="sendFeedback">Send Feedback</button>' : '') +
      '<button type="button" class="cdb__button" data-action="checkAgain">Check Again</button>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildConvertPanelCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(CONVERT_PANEL_TITLE)}</title>
<style nonce="${n}">${STYLE}</style>
</head>
<body>
<main class="cdb" data-mode="${view.mode}">
  <header class="cdb__header">
    <h1 class="cdb__heading">${escapeHtml(view.heading)}</h1>
    ${view.summary ? `<p class="cdb__summary">${escapeHtml(view.summary)}</p>` : ''}
    ${view.intro.map((line) => `<p class="cdb__intro">${escapeHtml(line)}</p>`).join('\n    ')}
    <ul class="cdb__counts">${view.counts.map((c) => `<li class="cdb__count"><span class="cdb__count-value">${thousands(c.value)}</span> ${escapeHtml(c.label)}</li>`).join('')}</ul>
  </header>
  <section class="cdb__list" tabindex="0" aria-label="${view.mode === 'review' ? 'Changes' : 'Problems'}">${sections}
  </section>
  <footer class="cdb__actions"><p class="cdb__status" role="status" aria-live="polite"></p>${actions}</footer>
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
