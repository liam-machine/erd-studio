/**
 * Draft-first: build a {@link Draft} — the read-only preview of a logical
 * model, with nothing written — from what the flows already make (spec
 * `docs/dev/draft-first.md` §2, §13 P1):
 *
 *  - an import plan (`planDbmlImport`: a DBML file, converted SQL, a
 *    converted semantic model, or the coffee-shop example in a folder),
 *    {@link draftFromImportPlan};
 *  - Import from dbt's draft of one models folder, {@link draftFromDbt};
 *  - a bundled example project, {@link draftFromExampleProject};
 *  - the coffee-shop example with no folder open, {@link exampleDbmlDraft}.
 *
 * Every string the banner shows is final text built here. Keep runs the
 * flow's own writer; nothing here writes, reads a file or runs a command.
 *
 * Pure: no `vscode`, no Node built-ins (`test/unit/draftNoVscode.test.ts`).
 */

import { DEFAULT_LAYERS, linkKey } from '@erd-studio/core';
import type {
  Draft,
  DraftBanner,
  DraftDetailItem,
  DraftDetailSection,
  DraftKeep,
  DraftOtherStart,
  DraftOtherStartItem,
  DraftPreview,
  DraftScopes,
  DraftSource,
  DraftSummary,
  DraftTarget,
  DraftTrigger,
} from '../types/draft';
import type { DisplaySubjectArea } from '../types/display';
import { createLogger } from './logger';
import { ledgerLeftOut, ledgerNotes, savedOptionalNote, type LedgerEntry } from './importLedger';
import type { LayerConfig } from '../types/layer';
import type { ColumnDef, Relationship, SemanticTable } from '../types/semantic';
import {
  countLinks,
  importLeftOut,
  importPlanNotes,
  planDbmlImport,
  suggestDbmlSubjectAreaName,
  dedupeLines,
  type DbmlImportOriginDescription,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
} from './dbmlImport';
import { IMPORT_GUIDE_LABEL, OPEN_FOLDER_LABEL, START_ACTION_LABELS } from '../types/startActions';
import { readDbml, readDbmlImportLayout } from './dbmlImportParse';
import { folderRank, type DbtDraft, type DraftScope, type DraftSkipped } from './dbtDraft';
import { describeImportTable, relationshipLines, buildImportReview } from './importReview';
import { displayFromFiles, displayFromTables, draftSchemas } from './draftDisplay';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** At or above this many tables a draft is large: the schema panel starts open (§2.3). */
export const DRAFT_LARGE_TABLES = 60;

/** Most options the switcher lists (§2.2). */
export const DRAFT_SCOPE_LIMIT = 12;

/** The other starts' labels, as the banner and its menu show them. */
export const DRAFT_OTHER_START_LABELS: Readonly<Record<DraftOtherStart, string>> = Object.freeze({
  // One label per action (src/types/startActions.ts): the same words as every other surface.
  blank: START_ACTION_LABELS.blank,
  import: START_ACTION_LABELS.import,
  guide: IMPORT_GUIDE_LABEL,
  example: START_ACTION_LABELS.example,
  openFolder: OPEN_FOLDER_LABEL,
});

export const KEEP_AS_DIAGRAM = 'Keep as Diagram';
export const KEEP_THIS_EXAMPLE = 'Keep This Example';
export const SAVE_THIS_EXAMPLE = 'Save This Example…';

/** The notice a redrawn draft carries (Keep found the files changed since it was drawn, §5.1). */
export const DRAFT_REDRAWN_NOTICE = 'Your ERD Studio files changed, so the draft was redrawn. Check it and keep it again.';

/** The notice a draft carries when a switcher choice drew nothing (§2.2): the draft before it stays. */
export const DRAFT_SCOPE_EMPTY_NOTICE = 'Nothing could be drawn from that choice, so this draft is still the one on show.';

const draftLog = createLogger('Draft');

/**
 * A switcher choice (`scope`, §2.2): run the flow's re-entry for it, then
 * say whether the flow asks again. The page shows Drawing… until someone
 * asks; a re-entry that asked nothing (nothing to draw, a problem it
 * reported, a question cancelled, a throw) would leave it there with every
 * button off, so `shown` comes back with {@link DRAFT_SCOPE_EMPTY_NOTICE}
 * for the flow to ask again. Undefined when the re-entry showed a draft of
 * its own or the tab closed: the flow stops.
 */
export async function afterScope(preview: DraftPreview, shown: Draft, reenter: () => unknown): Promise<Draft | undefined> {
  try {
    await reenter();
  } catch (err) {
    draftLog.error('A switcher choice failed:', err instanceof Error ? err.message : String(err));
  }
  if (!preview.showing || preview.showing() !== shown.id) return undefined;
  return { ...shown, banner: { ...shown.banner, notice: DRAFT_SCOPE_EMPTY_NOTICE } };
}

/** The coffee-shop example's switcher entry. */
export const EXAMPLE_COFFEE_SHOP_SCOPE_ID = 'example:coffee-shop';
export const EXAMPLE_COFFEE_SHOP_LABEL = 'Coffee shop';
/** The coffee shop's table count, for its switcher entry (`test/unit/draftModel.test.ts` checks it against the plan). */
export const EXAMPLE_COFFEE_SHOP_TABLES = 6;
/** A bundled example project's switcher id prefix: `exampleProject:<id>`. */
export const EXAMPLE_PROJECT_SCOPE_PREFIX = 'exampleProject:';

/** The layer the no-folder coffee shop is planned in (the folder's `EXAMPLE_LAYER`), when the default layers have it. */
const EXAMPLE_LAYER = 'gold';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const thousands = (n: number): string => n.toLocaleString('en-US');
const count = (n: number, one: string, many = `${one}s`): string => `${thousands(n)} ${n === 1 ? one : many}`;
/** `no relationships`, `1 relationship`, `1,204 relationships`. */
const countOrNo = (n: number, one: string, many = `${one}s`): string => (n === 0 ? `no ${many}` : count(n, one, many));

export interface DraftHeadlineInput {
  source: DraftSource;
  tables: number;
  relationships: number;
  /** A conversion's own phrase (`from 4 SQL files (PostgreSQL)`, `from the semantic model Sales`). */
  origin?: string;
  /** A DBML file's name (`sales.dbml`). */
  fileName?: string;
  /** A dbt models folder (`marts/finance`; `''` for the top level). */
  folder?: string;
  /** An example project's title. */
  title?: string;
}

/** What the draft is, the headline's first part. */
function draftWhat(input: DraftHeadlineInput): string {
  switch (input.source) {
    case 'sqlDdl': return input.origin ? `Draft ${input.origin}` : 'Draft from your SQL scripts';
    case 'semanticModel': return input.origin ? `Draft ${input.origin}` : 'Draft from your semantic model';
    case 'dbml': return input.origin ? `Draft ${input.origin}` : `Draft from ${input.fileName ?? 'your DBML file'}`;
    case 'dbt': return input.folder ? `Draft from your dbt models in ${input.folder}` : 'Draft from your dbt models';
    case 'example': return 'Example: a coffee-shop star schema';
    case 'exampleProject': return `Example: ${input.title ?? 'a data model'}`;
  }
}

/** The source phrase alone (`from 4 SQL files (PostgreSQL)`), for a find; undefined for an example. */
export function draftFrom(input: DraftHeadlineInput): string | undefined {
  const what = draftWhat(input);
  return what.startsWith('Draft from ') ? what.slice('Draft '.length) : undefined;
}

/** `<what> · <n> tables, <m> relationships · not saved` (§2.1). */
export function draftHeadline(input: DraftHeadlineInput): string {
  const counts = `${countOrNo(input.tables, 'table')}, ${countOrNo(input.relationships, 'relationship')}`;
  return `${draftWhat(input)} · ${counts} · not saved`;
}

export interface DraftDetailInput {
  /** Keep is possible: where it saves. */
  keep?: DraftTarget;
  /** Library tables used as they are. */
  reusedTables?: number;
  /** Library tables that gain a relationship. */
  changedTables?: number;
  /** dbt over the cap: drawn of available. */
  cap?: { drawn: number; available: number };
  /** The coffee shop with no folder open. */
  noFolderExample?: boolean;
  /** A bundled example project (Save This Example…), with the project's table count when the diagram shows fewer. */
  exampleProject?: { shown: number; total?: number };
}

/** The banner's detail line (§2.1). */
export function draftDetail(input: DraftDetailInput): string {
  if (input.noFolderExample) return 'Open a folder to keep a copy of it.';
  if (input.exampleProject) {
    const { shown, total } = input.exampleProject;
    const part = total !== undefined && total > shown ? ` This diagram shows ${thousands(shown)} of its ${count(total, 'table')}.` : '';
    return `${SAVE_THIS_EXAMPLE} copies it to a folder of its own and opens it there.${part}`;
  }
  const parts: string[] = [];
  if (input.keep) {
    const { name, layerLabel, diagramFile } = input.keep;
    parts.push(`Keep saves it as ${name} in the ${layerLabel} layer (${diagramFile}).`);
  }
  const reused = input.reusedTables ?? 0;
  if (reused > 0) {
    parts.push(reused === 1
      ? '1 table is already in your Table Library and is used as it is.'
      : `${thousands(reused)} tables are already in your Table Library and are used as they are.`);
  }
  const changed = input.changedTables ?? 0;
  if (changed > 0) {
    parts.push(changed === 1
      ? '1 table in your Table Library gains a relationship.'
      : `${thousands(changed)} tables in your Table Library gain a relationship.`);
  }
  if (input.cap && input.cap.available > input.cap.drawn) {
    parts.push(`Drew the ${thousands(input.cap.drawn)} best-connected of ${thousands(input.cap.available)} models; add the rest from the canvas.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

let nextDraftId = 0;

/** Unique per build: a redrawn draft gets a new id. */
function newDraftId(source: DraftSource): string {
  nextDraftId += 1;
  return `draft-${source}-${nextDraftId}-${Date.now().toString(36)}`;
}

function otherStartItems(ids: readonly DraftOtherStart[]): DraftOtherStartItem[] {
  return ids.map((id) => ({ id, label: DRAFT_OTHER_START_LABELS[id] }));
}

/** The other starts of a find (`sqlDdl`, `semanticModel`, `dbml`), menu order. */
const FIND_STARTS: readonly DraftOtherStart[] = ['blank', 'import', 'guide', 'example'];
/** dbt's: the import guide is not offered (the folder is a dbt project). */
const DBT_STARTS: readonly DraftOtherStart[] = ['blank', 'import', 'example'];

/** The large-draft fields (§2.3). */
function largeDraft(summary: DraftSummary): { panelOpen: boolean; focusSchema?: string } {
  const panelOpen = summary.tables >= DRAFT_LARGE_TABLES;
  return panelOpen && summary.schemas.length > 1 ? { panelOpen, focusSchema: summary.schemas[0].schema } : { panelOpen };
}

/** The ConvertReviewItem tags as the drawer names them. */
const REVIEW_TAGS: Readonly<Record<string, string>> = {
  'already in your Table Library': 'in your library',
  'gains relationships': 'changed',
};

/** `buildImportReview`'s sections as the drawer's (§2.4): plain data, the page renders text only. */
function detailsFromImportReview(plan: DbmlImportPlan, describe: DescribeDbmlImportOptions, diagramFile: string): DraftDetailSection[] {
  const review = buildImportReview(plan, { ...describe, diagramFile });
  return review.sections.map((section): DraftDetailSection => {
    const id = section.id.startsWith('schema:') ? `tables:${section.id.slice('schema:'.length)}` : section.id === 'left' ? 'leftOut' : section.id;
    return {
      id,
      title: section.title,
      ...(section.count !== undefined ? { count: section.count } : {}),
      items: section.items.map((item): DraftDetailItem => ({
        text: item.text ?? '',
        ...(item.path !== undefined ? { path: item.path } : {}),
        ...(item.tag !== undefined ? { tag: REVIEW_TAGS[item.tag] ?? item.tag } : {}),
      })),
      ...(section.hint !== undefined ? { hint: section.hint } : {}),
    };
  });
}

/**
 * The table sections (one per schema, biggest first) and the relationships section, for drafts that are not imports.
 * `undrawnForeignKeys`: per table, its foreign keys to tables the draft does not draw (counted in its line).
 */
function tableAndRelationshipSections(
  tables: ReadonlyArray<{ name: string; schema?: string; columns?: ReadonlyArray<Pick<ColumnDef, 'name' | 'isPrimaryKey'>> }>,
  relationships: readonly Relationship[],
  tagOf: (name: string) => string | undefined,
  undrawnForeignKeys: ReadonlyMap<string, number> = new Map(),
): DraftDetailSection[] {
  const links = relationshipLines(relationships);
  const fkCount = new Map<string, number>();
  for (const l of links) fkCount.set(l.from, (fkCount.get(l.from) ?? 0) + 1);
  const schemas = draftSchemas(tables);
  const sections: DraftDetailSection[] = schemas.map(({ schema }) => ({
    id: `tables:${schema}`,
    title: schema ? `Schema ${schema}` : (schemas.length === 1 ? 'Tables' : 'No schema'),
    items: tables
      .filter((t) => (t.schema ?? '') === schema)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((t): DraftDetailItem => {
        const tag = tagOf(t.name);
        const described = describeImportTable({ name: t.name, columns: (t.columns ?? []).map((c) => ({ name: c.name, isPrimaryKey: c.isPrimaryKey })) } as SemanticTable, fkCount.get(t.name) ?? 0, undrawnForeignKeys.get(lc(t.name)) ?? 0);
        return { path: t.name, text: described, ...(tag ? { tag } : {}) };
      }),
  }));
  if (links.length > 0) {
    sections.push({
      id: 'relationships',
      title: 'Relationships',
      count: countLinks(relationships),
      items: links.map((l): DraftDetailItem => ({ path: l.label, tag: l.cardinality, text: '' })),
    });
  }
  return sections.filter((s) => s.items.length > 0);
}

/** `name`'s table among `lists`, first match (exact, then ignoring case), else the library's, else an empty placeholder. */
function resolveTables(
  names: readonly string[],
  lists: ReadonlyArray<readonly SemanticTable[]>,
  libraryTable: (name: string) => SemanticTable | undefined,
): SemanticTable[] {
  const exact = new Map<string, SemanticTable>();
  const lower = new Map<string, SemanticTable>();
  for (const list of lists) {
    for (const t of list) {
      if (!exact.has(t.name)) exact.set(t.name, t);
      if (!lower.has(t.name.toLowerCase())) lower.set(t.name.toLowerCase(), t);
    }
  }
  return names.map((name) => exact.get(name) ?? lower.get(name.toLowerCase()) ?? libraryTable(name) ?? { name, columns: [] });
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** cyrb53: a fast 53-bit string hash (no Node `crypto`: this module is pure). */
function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** One order-free fingerprint of `parts`. */
function fingerprintOf(parts: string[]): string {
  const text = [...parts].sort().join('\n');
  return `fp1-${cyrb53(text, 1)}-${cyrb53(text, 7)}-${parts.length.toString(36)}`;
}

const lc = (s: string): string => `${s}`.trim().toLowerCase();

function tableParts(kind: string, table: SemanticTable): string[] {
  const name = lc(table.name);
  return [
    `${kind}:${name}:${lc(table.schema ?? '')}`,
    ...(table.columns ?? []).map((c) =>
      `column:${name}.${lc(c.name)}:${c.dataType ?? ''}:${c.isPrimaryKey ? 'pk' : ''}${c.isForeignKey ? 'fk' : ''}${c.isNaturalKey ? 'nk' : ''}`),
  ];
}

/**
 * An import plan's fingerprint: the same for the same tables (names,
 * schemas, columns' names, types and keys), relationships (core's
 * `linkKey`) and diagram, whatever their order; different when any of them
 * changes. `diagramFile` (the target's) defaults to the plan's layer and name.
 */
export function importPlanFingerprint(plan: DbmlImportPlan, diagramFile?: string): string {
  return fingerprintOf([
    `diagram:${diagramFile ?? `${plan.layer}/${plan.subjectAreaName}`}`,
    ...plan.newTables.flatMap((t) => tableParts('new', t)),
    ...plan.reusedTables.map((name) => `reused:${lc(name)}`),
    ...plan.changedLibraryTables.map((t) => `changed:${lc(t.name)}`),
    ...plan.relationships.map((r) => `link:${linkKey(r)}`),
  ]);
}

/** A dbt draft's fingerprint, as {@link importPlanFingerprint}: tables, columns, links (`relationships`, every one drawn) and the diagram. */
export function dbtDraftFingerprint(draft: DbtDraft, relationships: readonly Relationship[], diagramFile?: string): string {
  return fingerprintOf([
    `diagram:${diagramFile ?? ''}`,
    ...draft.newModels.flatMap((t) => tableParts('new', t)),
    ...draft.reusedModels.map((name) => `reused:${lc(name)}`),
    ...relationships.map((r) => `link:${linkKey(r)}`),
  ]);
}

// ---------------------------------------------------------------------------
// Import plans
// ---------------------------------------------------------------------------

/**
 * `ImportDbmlOrigin`'s shape: what a conversion says about itself, its
 * ledger (`importLedger.ts`, rendered into the drawer's Notes and Not
 * imported) and a `notice` for the banner when the input gives none.
 */
export type DraftImportOrigin = DbmlImportOriginDescription;

export interface ImportPlanDraftInput {
  plan: DbmlImportPlan;
  /** Import DBML's source: `file` (a DBML file), `sql`, `semanticModel`, or the coffee-shop `example` in a folder. */
  importSource: 'file' | 'sql' | 'semanticModel' | 'example';
  trigger: DraftTrigger;
  target: DraftTarget;
  /** The source file's name (`sales.dbml`; the example's `coffee-shop.dbml`). */
  fileName: string;
  origin?: DraftImportOrigin;
  /** The dry run's describe options (layer label, the DBML project's relationships files, the origin). */
  describe: DescribeDbmlImportOptions;
  /** A Table Library table by name (reused tables are drawn from it). */
  libraryTable(name: string): SemanticTable | undefined;
  layers: readonly LayerConfig[];
  /** A folder without dbt: no stage colours. */
  logicalOnly: boolean;
  hasFolder: boolean;
  /** Offer Change options… (the quick paths). */
  changeOptions: boolean;
  scopes?: DraftScopes;
  notice?: string;
  /** Offer Show Import Report (the import recorded its report). Never on an example. */
  importReport?: boolean;
}

const IMPORT_SOURCE_DRAFT: Readonly<Record<ImportPlanDraftInput['importSource'], DraftSource>> = {
  file: 'dbml',
  sql: 'sqlDdl',
  semanticModel: 'semanticModel',
  example: 'example',
};

/** The banner for a coffee-shop example (in a folder, Keep This Example; without one, Open Folder…). */
function exampleBanner(headline: string, detail: string, hasFolder: boolean, notice?: string): { banner: DraftBanner; otherStarts: DraftOtherStartItem[] } {
  if (!hasFolder) {
    return {
      banner: { headline, detail, primary: 'openFolder', changeOptions: false, shownStarts: [], ...(notice ? { notice } : {}) },
      otherStarts: otherStartItems(['openFolder']),
    };
  }
  return {
    banner: { headline, detail, keepLabel: KEEP_THIS_EXAMPLE, primary: 'blank', changeOptions: false, shownStarts: ['guide'], ...(notice ? { notice } : {}) },
    otherStarts: otherStartItems(['blank', 'guide', 'import']),
  };
}

/**
 * The draft of an import plan, as the import's dry run would describe it:
 * every table the diagram draws (new, reused and changed library tables),
 * every relationship once, the file's positions and sticky notes; the
 * summary from `plan.report`; the drawer from `buildImportReview`. Keep runs
 * Import DBML's write step.
 */
export function draftFromImportPlan(input: ImportPlanDraftInput): Draft {
  const { plan, target } = input;
  const source = IMPORT_SOURCE_DRAFT[input.importSource];
  const describe: DescribeDbmlImportOptions = {
    ...input.describe,
    ...(input.origin && !input.describe.origin ? { origin: input.origin } : {}),
  };
  const tables = resolveTables(plan.modelNames, [plan.newTables, plan.changedLibraryTables], input.libraryTable);
  const { display, autoLayout } = displayFromTables({
    name: plan.subjectAreaName,
    layer: plan.layer,
    description: plan.document.description,
    tables,
    relationships: plan.relationships,
    viewConfig: plan.document.viewConfig,
    layers: input.layers,
  });
  const { report } = plan;
  const summary: DraftSummary = {
    tables: plan.modelNames.length,
    relationships: report.relationships,
    newTables: plan.newTables.length,
    // Used as they are: the reused tables that gain no relationship (a changed one is reused too).
    reusedTables: Math.max(0, report.reusedTables.length - plan.changedLibraryTables.length),
    changedTables: plan.changedLibraryTables.length,
    schemas: draftSchemas(tables),
    notes: importPlanNotes(plan, describe).length,
    leftOut: importLeftOut(plan, describe).length,
  };
  const headlineInput: DraftHeadlineInput = {
    source,
    tables: summary.tables,
    relationships: summary.relationships,
    ...(describe.origin ? { origin: describe.origin.from } : {}),
    fileName: input.fileName,
  };
  const headline = draftHeadline(headlineInput);
  const from = draftFrom(headlineInput);
  const detail = draftDetail({ keep: target, reusedTables: summary.reusedTables, changedTables: summary.changedTables });
  const notice = input.notice ?? describe.origin?.notice;
  const { banner, otherStarts } = source === 'example'
    ? exampleBanner(headline, detail, input.hasFolder, notice)
    : {
      banner: {
        headline,
        ...(from ? { from } : {}),
        detail,
        keepLabel: KEEP_AS_DIAGRAM,
        primary: 'keep' as const,
        changeOptions: input.changeOptions,
        shownStarts: [],
        ...(notice ? { notice } : {}),
        ...(input.importReport ? { importReport: true } : {}),
      },
      otherStarts: otherStartItems(FIND_STARTS),
    };
  const keep: DraftKeep = { writer: 'importDbml', importSource: input.importSource, target, fingerprint: importPlanFingerprint(plan, target.diagramFile) };
  return {
    id: newDraftId(source),
    source,
    title: source === 'example' ? `Example: ${EXAMPLE_COFFEE_SHOP_LABEL}` : `Draft: ${target.name}`,
    banner,
    otherStarts,
    ...(input.scopes ? { scopes: input.scopes } : {}),
    summary,
    display,
    autoLayout,
    logicalOnly: input.logicalOnly,
    ...largeDraft(summary),
    details: detailsFromImportReview(plan, describe, target.diagramFile),
    keep,
    trigger: input.trigger,
  };
}

// ---------------------------------------------------------------------------
// dbt
// ---------------------------------------------------------------------------

/**
 * The switcher over dbt models folders (§2.2): folder scopes only (each
 * already holds drawable models), ranked by `folderRank` (marts / gold
 * first, staging last), then by model count, then by path; at most
 * {@link DRAFT_SCOPE_LIMIT}. `defaultScope` is the first. No switcher when
 * there is only one folder.
 */
export function dbtDraftScopes(scopes: readonly DraftScope[]): { scopes?: DraftScopes; defaultScope?: DraftScope } {
  const folders = scopes
    .filter((s) => s.kind === 'folder' && s.count > 0)
    .slice()
    .sort((a, b) => folderRank(a.folder ?? '') - folderRank(b.folder ?? '')
      || b.count - a.count
      || (a.folder ?? a.label).localeCompare(b.folder ?? b.label))
    .slice(0, DRAFT_SCOPE_LIMIT);
  const defaultScope = folders[0];
  if (!defaultScope) return {};
  if (folders.length < 2) return { defaultScope };
  return {
    defaultScope,
    scopes: {
      label: 'Folder',
      current: defaultScope.id,
      options: folders.map((s) => ({ id: s.id, label: s.label, description: count(s.count, 'model') })),
    },
  };
}

export interface DbtDraftInput {
  draft: DbtDraft;
  /** Every relationship the diagram draws (before routing: library and diagram alike). */
  relationships: readonly Relationship[];
  /** The scope drawn. */
  scope: DraftScope;
  /** Every scope the project offers (`listDraftScopes`): the switcher's folders come from them. */
  scopes: readonly DraftScope[];
  trigger: DraftTrigger;
  target: DraftTarget;
  libraryTable(name: string): SemanticTable | undefined;
  layers: readonly LayerConfig[];
  /** Library tables that gain a relationship (`routeToLibrary`'s `changed`): drawn as they will be. */
  changedTables?: readonly SemanticTable[];
  /** Offer Change options… (Import from dbt's picker). Default true. */
  changeOptions?: boolean;
  notice?: string;
  /** Offer Show Import Report (Import from dbt recorded its report). */
  importReport?: boolean;
  /**
   * The project's models dbt declares no columns for (`modelsWithoutColumns`):
   * no folder offers them, and Not drawn says why in one line.
   */
  modelsWithoutColumns?: readonly string[];
}

/** What Keep writes beyond the diagram and its tables: Import from dbt regenerates the project's selectors (SelectorsService). */
export const DBT_KEEP_SELECTORS_SENTENCE = "Keep also adds a selector for it to selectors.yml at your dbt project's root.";

/** A few names, the rest counted: `a, b, c and 4 more`. */
function someNames(names: readonly string[], shown = 3): string {
  const head = names.slice(0, shown).join(', ');
  return names.length > shown ? `${head} and ${thousands(names.length - shown)} more` : head;
}

/** A dbt draft's link to a model it does not draw, as Not drawn says it. */
function undrawnLinkLine(link: NonNullable<DbtDraft['undrawnLinks']>[number]): string {
  switch (link.why) {
    case 'addable': return `Drawn when you add ${link.toModel} (Add Existing Model).`;
    case 'noColumns': return `${link.toModel} has no columns in your schema yml, so it can't be drawn.`;
    case 'notAModel': return `${link.toModel} is not a model in this project (a package's or a source?), so it can't be drawn.`;
    case 'source': return `${link.toModel} is a dbt source, not a model, so it can't be drawn.`;
  }
}

/** The ledger's D18 count (`savedOptional`), and the ledger without it (its note is said in its own words). */
function splitSavedOptional(entries: readonly LedgerEntry[]): { required: number; rest: LedgerEntry[] } {
  let required = 0;
  const rest: LedgerEntry[] = [];
  for (const e of entries) {
    if (e.cause === 'savedOptional') required += e.count;
    else rest.push(e);
  }
  return { required, rest };
}

/** Why a dbt model was left out, as the drawer says it (`duplicate` and `already-in-domain` are not worth a line). */
function skippedLine(s: DraftSkipped): string | undefined {
  switch (s.reason) {
    case 'over-limit': return 'Left out to keep the diagram readable. Add it from the canvas.';
    case 'invalid-name': return s.message ?? 'Not a name ERD Studio can use.';
    case 'not-found': return 'Found no columns for it in your dbt project.';
    case 'disabled': return 'Disabled in dbt.';
    case 'yaml-table': return "A YAML table can't join a DBML diagram; convert the project first.";
    default: return undefined;
  }
}

/**
 * A dbt draft for a DBML diagram writes each new table with no custom schema
 * (`configuredSchema`) in its layer's schema (§2.4): said once, with the
 * schema dbt builds them in when the manifest names one (it differs per
 * target), so the schema never changes without a word. '' when every new
 * table has a custom schema.
 */
export function dbtLayerSchemaNote(draft: Pick<DbtDraft, 'newModels'>, layer: string): string {
  const unset = draft.newModels.filter((t) => !t.configuredSchema);
  if (unset.length === 0) return '';
  const built = [...new Set(unset.map((t) => t.schema).filter((s): s is string => !!s))];
  const where = built.length === 1 ? ` (dbt builds ${unset.length === 1 ? 'it' : 'them'} in ${built[0]} with this target)` : '';
  return `${count(unset.length, 'model sets', 'models set')} no custom schema in dbt, so ${unset.length === 1 ? 'it is' : 'they are'} written in schema ${layer}, the layer's name${where}: ${someNames(unset.map((t) => t.name))}.`;
}

/** The draft of one dbt models folder (Import from dbt's `buildDbtDraft`). Keep runs Import from dbt's write step. */
export function draftFromDbt(input: DbtDraftInput): Draft {
  const { draft, scope, target } = input;
  // `routeToLibrary`'s `changed` can hold new models too (their relationships are on them already): only library tables count.
  const newNames = new Set(draft.newModels.map((t) => lc(t.name)));
  const changed = (input.changedTables ?? []).filter((t) => !newNames.has(lc(t.name)));
  const tables = resolveTables(draft.modelNames, [draft.newModels, changed], input.libraryTable);
  const { display, autoLayout } = displayFromTables({
    name: target.name,
    layer: target.layer,
    tables,
    relationships: input.relationships,
    layers: input.layers,
  });
  const available = draft.truncated ? Math.max(scope.count, draft.modelNames.length) : undefined;
  const leftOut = draft.skipped
    .map((s) => ({ s, line: skippedLine(s) }))
    .filter((x): x is { s: DraftSkipped; line: string } => x.line !== undefined);
  // What the draft changed or could not keep (`DbtDraft.ledger`): Notes, and lines of Not drawn.
  const { required, rest: ledger } = splitSavedOptional(draft.ledger ?? []);
  const dbmlTarget = target.diagramFile.toLowerCase().endsWith('.dbml');
  const schemaNote = dbmlTarget ? dbtLayerSchemaNote(draft, target.layer) : '';
  const ledgerNoteLines = dedupeLines([
    ...(required > 0 ? [savedOptionalNote(required, countLinks(input.relationships))] : []),
    ...(schemaNote ? [schemaNote] : []),
    ...ledgerNotes(ledger),
  ]);
  const ledgerLostLines = dedupeLines(ledgerLeftOut(ledger));
  const undrawnLinks = draft.undrawnLinks ?? [];
  const noColumns = input.modelsWithoutColumns ?? [];
  const noColumnsLine = noColumns.length === 0 ? undefined
    : `${count(noColumns.length, 'model has', 'models have')} no columns in your schema yml, so ${noColumns.length === 1 ? "it can't" : "they can't"} be drawn: ${someNames(noColumns, 4)}. Add columns: to ${noColumns.length === 1 ? 'its' : 'their'} yml to draw ${noColumns.length === 1 ? 'it' : 'them'}.`;
  const summary: DraftSummary = {
    tables: draft.modelNames.length,
    relationships: countLinks(input.relationships),
    newTables: draft.newModels.length,
    // Used as they are: the library's tables that gain no relationship.
    reusedTables: Math.max(0, draft.reusedModels.length - changed.length),
    changedTables: changed.length,
    schemas: draftSchemas(tables),
    notes: ledgerNoteLines.length,
    leftOut: leftOut.length + ledgerLostLines.length + undrawnLinks.length + (noColumnsLine ? 1 : 0),
    ...(available !== undefined ? { available } : {}),
  };
  const switcher = dbtDraftScopes(input.scopes).scopes;
  const scopes = switcher && switcher.options.some((o) => o.id === scope.id) ? { ...switcher, current: scope.id } : undefined;
  const headlineInput: DraftHeadlineInput = { source: 'dbt', tables: summary.tables, relationships: summary.relationships, folder: scope.kind === 'folder' ? scope.folder : undefined };
  const headline = draftHeadline(headlineInput);
  const from = draftFrom(headlineInput);
  const detail = [draftDetail({
    keep: target,
    reusedTables: summary.reusedTables,
    changedTables: summary.changedTables,
    ...(available !== undefined ? { cap: { drawn: draft.modelNames.length, available } } : {}),
  }), DBT_KEEP_SELECTORS_SENTENCE].filter(Boolean).join(' ');
  const reused = new Set(draft.reusedModels.map(lc));
  const changedNames = new Set(changed.map((t) => lc(t.name)));
  const undrawnFks = new Map<string, number>();
  for (const l of undrawnLinks) undrawnFks.set(lc(l.fromModel), (undrawnFks.get(lc(l.fromModel)) ?? 0) + 1);
  const details = tableAndRelationshipSections(tables, input.relationships, (name) =>
    changedNames.has(lc(name)) ? 'changed' : reused.has(lc(name)) ? 'in your library' : 'new', undrawnFks);
  if (leftOut.length > 0 || ledgerLostLines.length > 0 || undrawnLinks.length > 0 || noColumnsLine) {
    details.push({
      id: 'leftOut',
      title: 'Not drawn',
      items: [
        ...leftOut.map(({ s, line }) => ({ path: s.name, text: line, tag: 'left out' })),
        ...undrawnLinks.map((l) => ({ path: `${l.fromModel}.${l.fromColumn} → ${l.toModel}`, text: undrawnLinkLine(l), tag: 'relationship' })),
        ...(noColumnsLine ? [{ text: noColumnsLine, tag: 'no columns' }] : []),
        ...ledgerLostLines.map((text) => ({ text, tag: 'not imported' })),
      ],
    });
  }
  if (ledgerNoteLines.length > 0) {
    details.push({ id: 'notes', title: 'Notes', items: ledgerNoteLines.map((text) => ({ text })) });
  }
  return {
    id: newDraftId('dbt'),
    source: 'dbt',
    title: `Draft: ${target.name}`,
    banner: {
      headline,
      ...(from ? { from } : {}),
      detail,
      keepLabel: KEEP_AS_DIAGRAM,
      primary: 'keep',
      changeOptions: input.changeOptions ?? true,
      shownStarts: [],
      ...(input.notice ? { notice: input.notice } : {}),
      ...(input.importReport ? { importReport: true } : {}),
    },
    otherStarts: otherStartItems(DBT_STARTS),
    ...(scopes ? { scopes } : {}),
    summary,
    display,
    autoLayout,
    logicalOnly: false,
    ...largeDraft(summary),
    details,
    keep: { writer: 'drawFromDbt', scopeId: scope.id, target, fingerprint: dbtDraftFingerprint(draft, input.relationships, target.diagramFile) },
    trigger: input.trigger,
  };
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/** One bundled example project, as the switcher lists it. */
export interface ExampleScopeProject {
  id: string;
  title: string;
  tables?: number;
}

/** The `Example` switcher: the coffee shop, then each project (`exampleProject:<id>`). */
export function exampleScopes(current: string, projects: readonly ExampleScopeProject[]): DraftScopes {
  const options = [
    { id: EXAMPLE_COFFEE_SHOP_SCOPE_ID, label: EXAMPLE_COFFEE_SHOP_LABEL, description: count(EXAMPLE_COFFEE_SHOP_TABLES, 'table') },
    ...projects.map((p) => ({
      id: `${EXAMPLE_PROJECT_SCOPE_PREFIX}${p.id}`,
      label: p.title,
      description: p.tables !== undefined ? count(p.tables, 'table') : '',
    })),
  ];
  return { label: 'Example', current: options.some((o) => o.id === current) ? current : EXAMPLE_COFFEE_SHOP_SCOPE_ID, options };
}

/** What an `Example` switcher id names, or undefined for anything else. */
export function parseExampleScope(id: string): { kind: 'example' } | { kind: 'exampleProject'; id: string } | undefined {
  if (id === EXAMPLE_COFFEE_SHOP_SCOPE_ID) return { kind: 'example' };
  if (id.startsWith(EXAMPLE_PROJECT_SCOPE_PREFIX)) {
    const project = id.slice(EXAMPLE_PROJECT_SCOPE_PREFIX.length);
    return /^[a-z0-9][a-z0-9-]*$/.test(project) ? { kind: 'exampleProject', id: project } : undefined;
  }
  return undefined;
}

export interface ExampleProjectDraftInput {
  /** The example's id (`medallion`). */
  id: string;
  /** Its title (`Medallion lakehouse`). */
  title: string;
  /** Every file of the example, by posix path inside it (`exampleFiles(id)`). */
  files: Readonly<Record<string, string>>;
  /** The diagram drawn, a key of `files` (`.erd-studio/gold/diagrams/sales.dbml`). */
  startDiagram: string;
  /** The project's table count, when the detail line should say the diagram shows fewer. */
  tableCount?: number;
  trigger: DraftTrigger;
  hasFolder: boolean;
  scopes: DraftScopes;
}

/** Details for a display that is not an import: its tables by schema and its relationships. */
function displayDetails(display: DisplaySubjectArea): DraftDetailSection[] {
  return tableAndRelationshipSections(
    display.models.map((m) => ({ name: m.name, schema: m.schema, columns: m.columns })),
    display.relationships,
    () => undefined,
  );
}

/** The draft of a bundled example project's first diagram. Keep (Save This Example…) runs Open an Example's write step. */
export async function draftFromExampleProject(input: ExampleProjectDraftInput): Promise<Draft> {
  const { display, autoLayout } = await displayFromFiles({ files: input.files, domainPath: input.startDiagram });
  const tables = display.models.length;
  const relationships = countLinks(display.relationships);
  const summary: DraftSummary = {
    tables,
    relationships,
    newTables: tables,
    reusedTables: 0,
    changedTables: 0,
    schemas: draftSchemas(display.models),
    notes: 0,
    leftOut: 0,
  };
  const shown: DraftOtherStart[] = input.hasFolder ? ['blank', 'guide'] : ['openFolder'];
  return {
    id: newDraftId('exampleProject'),
    source: 'exampleProject',
    title: `Example: ${input.title}`,
    banner: {
      headline: draftHeadline({ source: 'exampleProject', tables, relationships, title: input.title }),
      detail: draftDetail({ exampleProject: { shown: tables, ...(input.tableCount !== undefined ? { total: input.tableCount } : {}) } }),
      keepLabel: SAVE_THIS_EXAMPLE,
      primary: 'keep',
      changeOptions: false,
      shownStarts: shown,
    },
    otherStarts: otherStartItems(shown),
    scopes: input.scopes,
    summary,
    display,
    autoLayout,
    logicalOnly: true,
    ...largeDraft(summary),
    details: displayDetails(display),
    keep: { writer: 'exampleProject', exampleId: input.id },
    trigger: input.trigger,
  };
}

export interface ExampleDbmlDraftInput {
  /** The coffee-shop DBML (`EXAMPLE_DBML`). */
  dbmlText: string;
  /** Its file name (`coffee-shop.dbml`). */
  fileName: string;
  trigger: DraftTrigger;
  scopes?: DraftScopes;
}

/**
 * The coffee shop with no folder open: planned in memory as Import DBML would
 * plan it into a new project (an empty Table Library, the default layers),
 * nothing to keep into; the primary is Open Folder…. Rejects when the DBML
 * does not read (the bundled example always does).
 */
export async function exampleDbmlDraft(input: ExampleDbmlDraftInput): Promise<Draft> {
  const read = readDbml(input.dbmlText);
  if (!read.ok) {
    throw new Error(`The example DBML does not read: ${read.diagnostics.map((d) => `line ${d.line}: ${d.message}`).join('; ')}`);
  }
  const layers = DEFAULT_LAYERS;
  const layer = layers.find((l) => l.id === EXAMPLE_LAYER) ?? layers[0];
  const layout = readDbmlImportLayout(input.dbmlText);
  const plan = planDbmlImport({
    model: read.model,
    ...(layout ? { layout } : {}),
    layer: layer.id,
    subjectAreaName: suggestDbmlSubjectAreaName(read.model, input.fileName),
    fileName: input.fileName,
    library: { findTableName: () => null, getTable: () => null },
    // A new project stores DBML: every relationship goes to the library.
    libraryRelationships: true,
    diagramHoldsNoRelationships: true,
  });
  const target: DraftTarget = {
    layer: layer.id,
    layerLabel: layer.label,
    name: plan.subjectAreaName,
    diagramFile: `.erd-studio/${layer.id}/diagrams/${plan.subjectAreaName}.dbml`,
  };
  // No `dbml` describe: nothing is saved here, so where relationships would be saved (and their `?`) is not worth a note.
  const describe: DescribeDbmlImportOptions = { layerLabel: layer.label };
  const built = draftFromImportPlan({
    plan,
    importSource: 'example',
    trigger: input.trigger,
    target,
    fileName: input.fileName,
    describe,
    libraryTable: () => undefined,
    layers,
    logicalOnly: true,
    hasFolder: false,
    changeOptions: false,
    ...(input.scopes ? { scopes: input.scopes } : {}),
  });
  return {
    ...built,
    banner: { ...built.banner, detail: draftDetail({ noFolderExample: true }) },
    keep: { writer: 'none' },
  };
}
