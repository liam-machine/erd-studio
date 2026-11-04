/**
 * The import's **Review All…** page: the dry run of any import (Import
 * DBML…, Import SQL DDL…, Import Semantic Model…, the coffee-shop example) in
 * full, for when the modal's ten lines are not enough — every table grouped
 * by schema (with its column count and keys), every relationship, what the
 * Table Library already has or gains, what was renamed, what was left out
 * and why, and every note. Import, Cancel (and Change Options… on a quick
 * import) sit on the page, so the user never hunts for the modal again;
 * closing the tab shows the modal once more.
 *
 * A webview panel rather than a Markdown preview: a preview cannot carry
 * buttons that answer the waiting import (its command links are off for
 * untrusted content), and a modal re-shown over it would block the very
 * scrolling the review is for. It is the Convert to DBML review's pattern
 * and stylesheet (`dbmlConversionReview.ts`): nonce-only CSP, no remote
 * resource, `--vscode-*` colours, its own tiny protocol validated here.
 *
 * Pure and vscode-free; the host half is `src/providers/ImportReviewPanel.ts`.
 * The page writes nothing: the import's own flow writes, after Import.
 */

import {
  REVIEW_PANEL_STYLE,
  escapeHtml,
  renderReviewItem,
  thousands,
  type ConvertReviewItem,
  type ConvertReviewSection,
} from './dbmlConversionReview';
import {
  importLayoutSentence,
  importLeftOut,
  importPlanNotes,
  importSchemaCounts,
  importSchemaOf,
  renameEntries,
  summariseDbmlImportPlan,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from './dbmlImport';
import type { Relationship, SemanticTable } from '../types/semantic';

export const IMPORT_REVIEW_VIEW_TYPE = 'erdStudio.importReview';
export const IMPORT_REVIEW_TITLE = 'Review Import';

/** The dry run's buttons. */
export const REVIEW_ALL_BUTTON = 'Review All…';
export const CHANGE_OPTIONS_BUTTON = 'Change Options…';

export interface ImportReviewView {
  heading: string;
  intro: string[];
  counts: Array<{ label: string; value: number }>;
  sections: ConvertReviewSection[];
  /** A quick import: Change Options… beside Import and Cancel. */
  changeOptions: boolean;
  /** The primary button's label (Import). */
  importLabel: string;
}

export interface ImportReviewOptions extends DescribeDbmlImportOptions {
  /** The diagram file the import creates, as the user sees it (project-relative). */
  diagramFile?: string;
  changeOptions?: boolean;
  importLabel?: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;

/** A table's columns and keys in one short line: `12 columns · primary key id · 2 foreign keys`. */
export function describeImportTable(table: SemanticTable, foreignKeys: number): string {
  const columns = table.columns ?? [];
  const parts = [plural(columns.length, 'column')];
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pk.length > 0) parts.push(`primary key ${pk.join(', ')}`);
  else parts.push('no primary key');
  if (foreignKeys > 0) parts.push(plural(foreignKeys, 'foreign key'));
  return parts.join(' · ');
}

/** Each relationship once (a composite's column pairs together), with the columns it joins. */
export function relationshipLines(relationships: readonly Relationship[]): Array<{ from: string; to: string; label: string; cardinality: string }> {
  const groups = new Map<string, Relationship[]>();
  relationships.forEach((rel, i) => {
    const key = rel.compositeKey !== undefined ? `${rel.fromModel}\u0000${rel.toModel}\u0000${rel.compositeKey}` : `#${i}`;
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  });
  return [...groups.values()].map((rels) => {
    const first = rels[0];
    const cols = (pick: (r: Relationship) => string): string => (rels.length === 1 ? pick(first) : `(${rels.map(pick).join(', ')})`);
    const label = `${first.fromModel}.${cols((r) => r.fromColumn)} → ${first.toModel}.${cols((r) => r.toColumn)}`;
    return { from: first.fromModel, to: first.toModel, label, cardinality: first.cardinality + (first.role ? ` · ${first.role}` : '') };
  });
}

/** The page's content for a plan. Every table, every relationship, everything left out: no cut-off. */
export function buildImportReview(plan: DbmlImportPlan, options: ImportReviewOptions = {}): ImportReviewView {
  const { report } = plan;
  const { headline } = summariseDbmlImportPlan(plan, options);
  const links = relationshipLines(plan.relationships);
  const fkCount = new Map<string, number>();
  for (const l of links) fkCount.set(l.from, (fkCount.get(l.from) ?? 0) + 1);

  // The new tables, a section per schema (most tables first), each table by name.
  const bySchema = new Map<string, SemanticTable[]>();
  for (const t of plan.newTables) bySchema.set(importSchemaOf(t), [...(bySchema.get(importSchemaOf(t)) ?? []), t]);
  const schemaSections: ConvertReviewSection[] = importSchemaCounts(plan).map(({ schema }) => ({
    id: `schema:${schema}`,
    title: schema ? `Schema ${schema}` : (bySchema.size === 1 ? 'New tables' : 'No schema'),
    items: [...(bySchema.get(schema) ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((t): ConvertReviewItem => ({ path: t.name, tag: 'new', text: describeImportTable(t, fkCount.get(t.name) ?? 0) })),
  }));

  const library: ConvertReviewItem[] = [
    ...report.reusedTables.map((r): ConvertReviewItem => ({
      path: r.name,
      tag: 'already in your Table Library',
      text: r.missingColumns.length > 0
        ? `Used as it is. Not added: ${r.missingColumns.join(', ')} (in the import, not in the library's table).`
        : 'Used as it is.',
    })),
    ...plan.changedLibraryTables.map((t): ConvertReviewItem => ({ path: t.name, tag: 'gains relationships', text: 'Its table file gets the new relationships.' })),
  ];

  const leftOut = importLeftOut(plan, options);
  const notes = importPlanNotes(plan, options);
  const renames = renameEntries(report.renamed);
  const sections: ConvertReviewSection[] = [
    ...schemaSections,
    {
      id: 'relationships',
      title: 'Relationships',
      items: links.map((l): ConvertReviewItem => ({ path: l.label, tag: l.cardinality })),
      count: report.relationships,
      ...(report.relationshipsAlreadyInLibrary > 0
        ? { hint: `${plural(report.relationshipsAlreadyInLibrary, 'is', 'are')} already in your Table Library and kept as it has them.` }
        : {}),
    },
    { id: 'library', title: 'Your Table Library', items: library },
    { id: 'renamed', title: 'Renamed to names ERD Studio can use', items: renames.map((text) => ({ text })) },
    {
      id: 'left',
      title: 'Not imported',
      items: leftOut.map((text) => ({ text })),
      ...(leftOut.length > 0 ? { hint: 'These stay in your own files only: the import writes none of them.' } : {}),
    },
    { id: 'notes', title: 'Notes', items: notes.map((text) => ({ text })) },
  ].filter((section) => section.items.length > 0);

  const schemas = importSchemaCounts(plan).length;
  return {
    heading: headline,
    intro: [
      ...(options.diagramFile ? [`The new diagram is saved as ${options.diagramFile}.`] : []),
      importLayoutSentence(plan, options),
      'Nothing is written until you choose Import.',
    ],
    counts: [
      { label: plan.modelNames.length === 1 ? 'table' : 'tables', value: plan.modelNames.length },
      { label: report.relationships === 1 ? 'relationship' : 'relationships', value: report.relationships },
      ...(schemas > 1 ? [{ label: 'schemas', value: schemas }] : []),
      ...(report.reusedTables.length > 0 ? [{ label: 'already in your Table Library', value: report.reusedTables.length }] : []),
      ...(leftOut.length > 0 ? [{ label: leftOut.length === 1 ? 'thing not imported' : 'things not imported', value: leftOut.length }] : []),
      ...(notes.length > 0 ? [{ label: notes.length === 1 ? 'note' : 'notes', value: notes.length }] : []),
    ],
    sections,
    changeOptions: options.changeOptions === true,
    importLabel: options.importLabel ?? 'Import',
  };
}

// ---------------------------------------------------------------------------
// The protocol: the page's choices (webview → host). The host posts nothing.
// ---------------------------------------------------------------------------

export type ImportReviewToHost = { type: 'import' } | { type: 'cancel' } | { type: 'changeOptions' };

/** Every message from the page is checked here before the host acts on it; anything else is ignored. */
export function isImportReviewToHost(value: unknown): value is ImportReviewToHost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'import' || type === 'cancel' || type === 'changeOptions';
}

// ---------------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------------

export function buildImportReviewCsp(nonce: string): string {
  return ["default-src 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ') + ';';
}

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.cdb__button'));
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled) { return; }
    var action = target.getAttribute('data-action');
    if (action !== 'import' && action !== 'cancel' && action !== 'changeOptions') { return; }
    buttons.forEach(function (b) { b.disabled = true; });
    if (action === 'import') { target.textContent = 'Importing\\u2026'; }
    vscode.postMessage({ type: action });
  });
})();
`;

/** The page: the headline, counts, the scrollable sectioned list, and the sticky buttons (bottom-left, clear of notifications). */
export function buildImportReviewHtml(view: ImportReviewView, nonce: string): string {
  const n = escapeHtml(nonce);
  const sections = view.sections.map((section) => `
    <details class="cdb-section" data-section="${escapeHtml(section.id)}" open>
      <summary class="cdb-section__title">${escapeHtml(section.title)}<span class="cdb-section__count">${thousands(section.count ?? section.items.length)}</span></summary>
      <ul class="cdb-section__items">${section.items.map((item) => renderReviewItem(item, false)).join('')}</ul>${section.hint !== undefined ? `
      <p class="cdb-section__hint">${escapeHtml(section.hint)}</p>` : ''}
    </details>`).join('');
  const actions =
    '<button type="button" class="cdb__button cdb__button--secondary" data-action="cancel">Cancel</button>' +
    (view.changeOptions ? `<button type="button" class="cdb__button cdb__button--secondary" data-action="changeOptions">${escapeHtml(CHANGE_OPTIONS_BUTTON)}</button>` : '') +
    `<button type="button" class="cdb__button" data-action="import">${escapeHtml(view.importLabel)}</button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildImportReviewCsp(nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(IMPORT_REVIEW_TITLE)}</title>
<style nonce="${n}">${REVIEW_PANEL_STYLE}</style>
</head>
<body>
<main class="cdb" data-mode="review">
  <header class="cdb__header">
    <h1 class="cdb__heading">${escapeHtml(view.heading)}</h1>
    ${view.intro.map((line) => `<p class="cdb__intro">${escapeHtml(line)}</p>`).join('\n    ')}
    <ul class="cdb__counts">${view.counts.map((c) => `<li class="cdb__count"><span class="cdb__count-value">${thousands(c.value)}</span> ${escapeHtml(c.label)}</li>`).join('')}</ul>
  </header>
  <section class="cdb__list" tabindex="0" aria-label="Everything the import does">${sections}
  </section>
  <footer class="cdb__actions"><p class="cdb__status" role="status" aria-live="polite"></p>${actions}</footer>
</main>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
