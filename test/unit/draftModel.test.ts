/**
 * Draft-first: building a Draft (docs/dev/draft-first.md §2, §13 P1) from an
 * import plan (the 257-table SQL fixture, the coffee shop), from Import from
 * dbt's draft, from every bundled example project, and the page protocol's
 * validation (`parseDraftToHost`, in the contract).
 */
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS, linkKey } from '@erd-studio/core';
import { EXAMPLE_DBML, EXAMPLE_DBML_FILE_NAME } from '../../src/commands/openExampleDiagram';
import { countLinks, planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml, readDbmlImportLayout } from '../../src/services/dbmlImportParse';
import { buildDbtDraft, listDraftScopes, suggestSubjectAreaName } from '../../src/services/dbtDraft';
import {
  DRAFT_LARGE_TABLES,
  DRAFT_OTHER_START_LABELS,
  DRAFT_REDRAWN_NOTICE,
  DRAFT_SCOPE_LIMIT,
  EXAMPLE_COFFEE_SHOP_TABLES,
  KEEP_AS_DIAGRAM,
  KEEP_THIS_EXAMPLE,
  SAVE_THIS_EXAMPLE,
  dbtDraftFingerprint,
  dbtDraftScopes,
  draftDetail,
  draftFromDbt,
  draftFromExampleProject,
  draftFromImportPlan,
  draftHeadline,
  exampleDbmlDraft,
  exampleScopes,
  importPlanFingerprint,
  parseExampleScope,
  type ImportPlanDraftInput,
} from '../../src/services/draftModel';
import { EXAMPLE_PROJECTS, exampleFiles } from '../../src/services/exampleProjects';
import { ManifestService } from '../../src/services/manifestService';
import * as engine from '../../src/services/sqlImportEngine';
import { YmlParserService } from '../../src/services/ymlParserService';
import {
  draftAllowance,
  parseDraftToHost,
  toDraftView,
  type Draft,
  type DraftTarget,
  type DraftView,
} from '../../src/types/draft';
import type { DraftScope } from '../../src/services/dbtDraft';
import type { YmlData } from '../../src/types/ymlData';
import type { ManifestData } from '../../src/types/manifest';

const LARGE = path.join(__dirname, '../fixtures/sql-ddl/large');
const DBT_ROOT = path.join(__dirname, '../fixtures/dbt-project');
const GOLDEN = path.join(__dirname, '../golden/examples');

const target = (name: string, layer = 'main', layerLabel = 'Main'): DraftTarget => ({
  layer, layerLabel, name, diagramFile: `.erd-studio/${layer}/diagrams/${name}.dbml`,
});

function planOf(dbml: string, name: string, layer: string, libraryRelationships = true): DbmlImportPlan {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
  const layout = readDbmlImportLayout(dbml);
  return planDbmlImport({
    model: read.model,
    ...(layout ? { layout } : {}),
    layer,
    subjectAreaName: name,
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships,
    ...(libraryRelationships ? { diagramHoldsNoRelationships: true } : {}),
  });
}

function importInput(plan: DbmlImportPlan, over: Partial<ImportPlanDraftInput> = {}): ImportPlanDraftInput {
  return {
    plan,
    importSource: 'file',
    trigger: 'sidebar',
    target: target(plan.subjectAreaName),
    fileName: `${plan.subjectAreaName}.dbml`,
    describe: { layerLabel: 'Main' },
    libraryTable: () => undefined,
    layers: [{ id: 'main', label: 'Main', abbreviation: 'MN', color: '#888888', creatable: true, order: 1 }],
    logicalOnly: true,
    hasFolder: true,
    changeOptions: true,
    ...over,
  };
}

/** Every string a viewer reads on the page (ids and the diagram's own names aside). */
function shownStrings(view: DraftView): string[] {
  return [
    view.title,
    view.banner.headline,
    view.banner.detail,
    view.banner.keepLabel ?? '',
    view.banner.notice ?? '',
    ...view.otherStarts.map((s) => s.label),
    view.scopes?.label ?? '',
    ...(view.scopes?.options ?? []).flatMap((o) => [o.label, o.description]),
    ...view.details.flatMap((s) => [s.title, s.hint ?? '', ...s.items.flatMap((i) => [i.text, i.tag ?? ''])]),
  ];
}

const noDbtWord = (draft: Draft): void => {
  for (const text of shownStrings(toDraftView(draft))) expect(text, text).not.toMatch(/\bdbt\b/i);
};

// ---------------------------------------------------------------------------

describe('the 257-table SQL draft (large)', () => {
  let plan: DbmlImportPlan;
  let draft: Draft;
  const origin = { from: 'from 8 SQL files (PostgreSQL)', notes: [] as string[], skipped: [] as string[] };

  beforeAll(() => {
    const files = fs.readdirSync(LARGE).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, text: fs.readFileSync(path.join(LARGE, name), 'utf-8') }));
    const converted = engine.sqlDdlToDbml({ files, dialect: 'postgres' });
    if (!converted.ok) throw new Error(JSON.stringify(converted.problems));
    origin.notes = converted.notes;
    origin.skipped = converted.skipped;
    plan = planOf(converted.dbml, 'warehouse', 'main');
    draft = draftFromImportPlan(importInput(plan, {
      importSource: 'sql',
      fileName: 'warehouse.dbml',
      origin,
      describe: { layerLabel: 'Main', origin, dbml: { relationshipsFiles: ['main/relationships/main.dbml'] } },
    }));
  });

  it('counts what plan.report counts', () => {
    expect(draft.summary.tables).toBe(257);
    expect(draft.summary.tables).toBe(plan.report.newTables.length + plan.report.reusedTables.length);
    expect(draft.summary.relationships).toBe(plan.report.relationships);
    expect(draft.summary.newTables).toBe(plan.newTables.length);
    expect(draft.display.models).toHaveLength(257);
  });

  it('draws each relationship once', () => {
    expect(countLinks(draft.display.relationships)).toBe(plan.report.relationships);
    const keys = draft.display.relationships.map(linkKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.report.relationships).toBeGreaterThan(0);
  });

  it('opens the schema panel on the biggest schema', () => {
    expect(draft.summary.tables).toBeGreaterThanOrEqual(DRAFT_LARGE_TABLES);
    expect(draft.panelOpen).toBe(true);
    expect(draft.summary.schemas[0]).toEqual({ schema: 'sales', tables: 80 });
    expect(draft.focusSchema).toBe('sales');
    expect(draft.summary.schemas.map((s) => s.tables).reduce((a, b) => a + b, 0)).toBe(257);
  });

  it('says where it came from and where Keep saves it', () => {
    expect(draft.source).toBe('sqlDdl');
    expect(draft.title).toBe('Draft: warehouse');
    expect(draft.banner.headline).toBe(`Draft from 8 SQL files (PostgreSQL) · 257 tables, ${plan.report.relationships.toLocaleString('en-US')} relationships · not saved`);
    expect(draft.banner.detail).toBe('Keep saves it as warehouse in the Main layer (.erd-studio/main/diagrams/warehouse.dbml).');
    expect(draft.banner.primary).toBe('keep');
    expect(draft.banner.keepLabel).toBe(KEEP_AS_DIAGRAM);
    expect(draft.banner.changeOptions).toBe(true);
    expect(draft.otherStarts.map((s) => s.label)).toEqual(['New Diagram…', 'Import…', 'Bring In Your Data Model…', 'Open an Example…']);
    expect(draft.keep).toMatchObject({ writer: 'importDbml', importSource: 'sql', target: target('warehouse') });
    expect(draft.autoLayout).toBe(true);
    expect(draft.trigger).toBe('sidebar');
  });

  it('lists every table and what was left out in the drawer, as text', () => {
    const tableItems = draft.details.filter((s) => s.id.startsWith('tables:')).flatMap((s) => s.items);
    expect(tableItems).toHaveLength(257);
    expect(tableItems.every((i) => i.tag === 'new')).toBe(true);
    const leftOut = draft.details.find((s) => s.id === 'leftOut');
    expect(leftOut?.items.length).toBe(draft.summary.leftOut);
    expect(draft.summary.leftOut).toBeGreaterThan(0);
    expect(draft.details.find((s) => s.id === 'relationships')?.count).toBe(plan.report.relationships);
  });

  it('holds no dbt word', () => noDbtWord(draft));

  it('the page view holds nothing Keep uses', () => {
    const view = toDraftView(draft) as Partial<Draft>;
    expect(view.keep).toBeUndefined();
    expect(view.trigger).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(LARGE);
  });
});

describe('the coffee shop', () => {
  it('in a folder: New Diagram… leads, Keep This Example is quiet', () => {
    const plan = planOf(EXAMPLE_DBML, 'coffee-shop', 'gold');
    const draft = draftFromImportPlan(importInput(plan, {
      importSource: 'example',
      trigger: 'example',
      target: target('coffee-shop', 'gold', 'Gold'),
      fileName: EXAMPLE_DBML_FILE_NAME,
      changeOptions: false,
    }));
    expect(draft.source).toBe('example');
    expect(draft.title).toBe('Example: Coffee shop');
    expect(draft.banner.headline).toBe(`Example: a coffee-shop star schema · 6 tables, ${plan.report.relationships} relationships · not saved`);
    expect(draft.banner.primary).toBe('blank');
    expect(draft.banner.keepLabel).toBe(KEEP_THIS_EXAMPLE);
    expect(draft.banner.shownStarts).toEqual(['guide']);
    expect(draft.otherStarts.map((s) => s.id)).toEqual(['blank', 'guide', 'import']);
    expect(draft.keep).toMatchObject({ writer: 'importDbml', importSource: 'example' });
    expect(draft.summary.tables).toBe(EXAMPLE_COFFEE_SHOP_TABLES);
    noDbtWord(draft);
  });

  it('with no folder: Open Folder…, nothing to keep', async () => {
    const scopes = exampleScopes('example:coffee-shop', EXAMPLE_PROJECTS.map((p) => ({ id: p.id, title: p.label })));
    const draft = await exampleDbmlDraft({ dbmlText: EXAMPLE_DBML, fileName: EXAMPLE_DBML_FILE_NAME, trigger: 'example', scopes });
    expect(draft.keep).toEqual({ writer: 'none' });
    expect(draft.banner.keepLabel).toBeUndefined();
    expect(draft.banner.primary).toBe('openFolder');
    expect(draft.banner.detail).toBe('Open a folder to keep a copy of it.');
    expect(draft.otherStarts.map((s) => s.id)).toEqual(['openFolder']);
    expect(draft.summary.tables).toBe(EXAMPLE_COFFEE_SHOP_TABLES);
    expect(draft.display.models).toHaveLength(EXAMPLE_COFFEE_SHOP_TABLES);
    expect(draft.logicalOnly).toBe(true);
    expect(draft.scopes?.current).toBe('example:coffee-shop');
    // Nothing to read beyond the diagram: no notes, nothing left out.
    expect(draft.summary.notes).toBe(0);
    expect(draft.summary.leftOut).toBe(0);
    expect(draftAllowance(toDraftView(draft)).keepable).toBe(false);
    noDbtWord(draft);
  });
});

describe('every bundled example project', () => {
  const scopes = exampleScopes('example:coffee-shop', EXAMPLE_PROJECTS.map((p) => ({ id: p.id, title: p.label })));

  it.each(EXAMPLE_PROJECTS.map((p) => [p.id, p] as const))('%s draws its first diagram as the golden has it', async (_id, project) => {
    const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${project.id}.json`), 'utf-8')) as {
      diagrams: Array<{ file: string; tables: string[]; relationships: string[] }>;
    };
    const diagram = golden.diagrams.find((d) => `.erd-studio/${d.file}` === project.startDiagram)!;
    expect(diagram).toBeDefined();
    const draft = await draftFromExampleProject({
      id: project.id,
      title: project.label,
      files: exampleFiles(project.id),
      startDiagram: project.startDiagram,
      trigger: 'example',
      hasFolder: true,
      scopes: { ...scopes, current: `exampleProject:${project.id}` },
    });
    expect(draft.summary.tables).toBe(diagram.tables.length);
    expect(draft.display.relationships).toHaveLength(diagram.relationships.length);
    expect(draft.summary.relationships).toBe(countLinks(draft.display.relationships));
    expect(draft.keep).toEqual({ writer: 'exampleProject', exampleId: project.id });
    expect(draft.banner.keepLabel).toBe(SAVE_THIS_EXAMPLE);
    expect(draft.banner.primary).toBe('keep');
    expect(draft.banner.shownStarts).toEqual(['blank', 'guide']);
    expect(draft.title).toBe(`Example: ${project.label}`);
    expect(draft.banner.headline.startsWith(`Example: ${project.label} · `)).toBe(true);
    expect(draft.banner.detail).toBe('Save This Example… copies it to a folder of its own and opens it there.');
    noDbtWord(draft);
  });

  it('with no folder, Save This Example… stays and Open Folder… is offered', async () => {
    const project = EXAMPLE_PROJECTS[0];
    const draft = await draftFromExampleProject({
      id: project.id, title: project.label, files: exampleFiles(project.id), startDiagram: project.startDiagram,
      tableCount: 999, trigger: 'example', hasFolder: false, scopes,
    });
    expect(draft.banner.shownStarts).toEqual(['openFolder']);
    expect(draft.banner.detail).toContain(`This diagram shows ${draft.summary.tables} of its 999 tables.`);
  });

  it('the switcher lists the coffee shop then each project; ids parse back', () => {
    expect(scopes.label).toBe('Example');
    expect(scopes.options[0]).toEqual({ id: 'example:coffee-shop', label: 'Coffee shop', description: '6 tables' });
    expect(scopes.options.slice(1).map((o) => o.id)).toEqual(EXAMPLE_PROJECTS.map((p) => `exampleProject:${p.id}`));
    expect(parseExampleScope('example:coffee-shop')).toEqual({ kind: 'example' });
    expect(parseExampleScope('exampleProject:medallion')).toEqual({ kind: 'exampleProject', id: 'medallion' });
    expect(parseExampleScope('exampleProject:../x')).toBeUndefined();
    expect(parseExampleScope('folder:gold')).toBeUndefined();
    expect(exampleScopes('nope', []).current).toBe('example:coffee-shop');
  });
});

describe('a dbt draft', () => {
  let ymlData: YmlData;
  let manifest: ManifestData | undefined;
  let scopes: DraftScope[];

  beforeAll(async () => {
    ymlData = await new YmlParserService().loadYmlData(DBT_ROOT);
    manifest = await new ManifestService({ parseInProcess: true }).loadManifest(DBT_ROOT);
    scopes = listDraftScopes({ ymlData, manifest, projectRoot: DBT_ROOT, modelPaths: ['models'] });
  });

  const draw = (scope: DraftScope, limit?: number): Draft => {
    const built = buildDbtDraft({ modelNames: scope.modelNames, ymlData, manifest, libraryHas: () => false, ...(limit ? { limit } : {}) });
    const name = suggestSubjectAreaName(scope);
    return draftFromDbt({
      draft: built, relationships: built.relationships, scope, scopes, trigger: 'prompt',
      target: target(name, 'gold', 'Gold'), libraryTable: () => undefined, layers: DEFAULT_LAYERS,
    });
  };

  it('starts on the presentation folder, named after it, with a Folder switcher', () => {
    const { scopes: switcher, defaultScope } = dbtDraftScopes(scopes);
    expect(defaultScope?.id).toBe('folder:gold');
    expect(switcher?.label).toBe('Folder');
    expect(switcher?.options.map((o) => o.id)).toEqual(['folder:gold', 'folder:silver', 'folder:staging']);
    expect(switcher!.options.every((o) => /^\d+ models?$/.test(o.description))).toBe(true);
    const draft = draw(defaultScope!);
    expect(draft.source).toBe('dbt');
    expect(draft.title).toBe('Draft: gold');
    expect(draft.scopes?.current).toBe('folder:gold');
    expect(draft.banner.headline).toMatch(/^Draft from your dbt models in gold · \d+ tables?, (no|\d+) relationships? · not saved$/);
    // Keep also regenerates the dbt project's selectors.yml (I1): the banner says so.
    expect(draft.banner.detail).toBe("Keep saves it as gold in the Gold layer (.erd-studio/gold/diagrams/gold.dbml). Keep also adds a selector for it to selectors.yml at your dbt project's root.");
    expect(draft.otherStarts.map((s) => s.id)).toEqual(['blank', 'import', 'example']);
    expect(draft.keep).toMatchObject({ writer: 'drawFromDbt', scopeId: 'folder:gold' });
    expect(draft.summary.available).toBeUndefined();
    expect(draft.logicalOnly).toBe(false);
  });

  it('over the cap: available and the cap sentence', () => {
    const silver = scopes.find((s) => s.id === 'folder:silver')!;
    expect(silver.count).toBeGreaterThan(2);
    const draft = draw(silver, 2);
    expect(draft.summary.tables).toBe(2);
    expect(draft.summary.available).toBe(silver.count);
    expect(draft.banner.detail).toContain(`Drew the 2 best-connected of ${silver.count} models; add the rest from the canvas.`);
    // One line per model over the cap, and one per relationship test from a drawn model to one of them (B2).
    const items = draft.details.find((s) => s.id === 'leftOut')?.items ?? [];
    expect(items.filter((i) => i.tag === 'left out')).toHaveLength(silver.count - 2);
    expect(items.filter((i) => i.tag !== 'left out').every((i) => i.tag === 'relationship' && /^Drawn when you add /.test(i.text))).toBe(true);
  });

  it('ranks folders and caps the switcher at the limit', () => {
    const many: DraftScope[] = Array.from({ length: 20 }, (_, i) => ({
      id: `folder:f${i}`, kind: 'folder', label: `f${i}`, description: '', detail: '', modelNames: ['m'], count: i + 1, folder: `f${i}`,
    }));
    many.push({ id: 'folder:staging', kind: 'folder', label: 'staging', description: '', detail: '', modelNames: ['m'], count: 100, folder: 'staging' });
    many.push({ id: 'folder:marts', kind: 'folder', label: 'marts', description: '', detail: '', modelNames: ['m'], count: 1, folder: 'marts' });
    many.push({ id: 'cluster:x', kind: 'cluster', label: 'Models connected to x', description: '', detail: '', modelNames: ['x', 'y'], count: 2 });
    const { scopes: switcher } = dbtDraftScopes(many);
    expect(switcher!.options).toHaveLength(DRAFT_SCOPE_LIMIT);
    expect(switcher!.options[0].id).toBe('folder:marts');
    expect(switcher!.options[1].id).toBe('folder:f19');
    expect(switcher!.options.some((o) => o.id === 'cluster:x' || o.id === 'folder:staging')).toBe(false);
    expect(dbtDraftScopes([many[0]]).scopes).toBeUndefined();
    expect(dbtDraftScopes([])).toEqual({});
  });
});

describe('fingerprints', () => {
  const plan = planOf(EXAMPLE_DBML, 'coffee-shop', 'gold');

  const reversed = (p: DbmlImportPlan): DbmlImportPlan => ({
    ...p,
    newTables: [...p.newTables].reverse().map((t) => ({ ...t, columns: [...(t.columns ?? [])].reverse() })),
    relationships: [...p.relationships].reverse().map((r) => ({ ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn })),
  });

  it('an import plan: stable under reordering, changed by a column type or the diagram', () => {
    const fp = importPlanFingerprint(plan);
    expect(importPlanFingerprint(reversed(plan))).toBe(fp);
    expect(importPlanFingerprint(planOf(EXAMPLE_DBML, 'coffee-shop', 'gold'))).toBe(fp);
    const retyped: DbmlImportPlan = {
      ...plan,
      newTables: plan.newTables.map((t, i) => (i === 0 ? { ...t, columns: t.columns!.map((c, j) => (j === 0 ? { ...c, dataType: 'bigint' } : c)) } : t)),
    };
    expect(importPlanFingerprint(retyped)).not.toBe(fp);
    expect(importPlanFingerprint(plan, '.erd-studio/gold/diagrams/other.dbml')).not.toBe(importPlanFingerprint(plan, '.erd-studio/gold/diagrams/coffee-shop.dbml'));
    expect(importPlanFingerprint({ ...plan, relationships: plan.relationships.slice(1) })).not.toBe(fp);
  });

  it('a dbt draft: stable under reordering, changed by a column type', () => {
    const draft = {
      modelNames: ['a', 'b'],
      newModels: [
        { name: 'a', columns: [{ name: 'id', dataType: 'int', isPrimaryKey: true }, { name: 'b_id', dataType: 'int' }] },
        { name: 'b', columns: [{ name: 'id', dataType: 'int', isPrimaryKey: true }] },
      ],
      reusedModels: [],
      relationships: [{ fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' as const }],
      skipped: [],
      truncated: false,
    };
    const fp = dbtDraftFingerprint(draft, draft.relationships, 'x');
    expect(dbtDraftFingerprint({ ...draft, newModels: [...draft.newModels].reverse() }, draft.relationships, 'x')).toBe(fp);
    const retyped = { ...draft, newModels: [{ ...draft.newModels[0], columns: [{ name: 'id', dataType: 'text', isPrimaryKey: true }, draft.newModels[0].columns[1]] }, draft.newModels[1]] };
    expect(dbtDraftFingerprint(retyped, draft.relationships, 'x')).not.toBe(fp);
    expect(dbtDraftFingerprint(draft, [], 'x')).not.toBe(fp);
  });

  it('Keep carries the plan fingerprint for the target', () => {
    const draft = draftFromImportPlan(importInput(plan, { target: target('coffee-shop', 'gold', 'Gold') }));
    expect(draft.keep).toMatchObject({ fingerprint: importPlanFingerprint(plan, '.erd-studio/gold/diagrams/coffee-shop.dbml') });
  });
});

describe('banner strings', () => {
  it('counts: singular, none, thousands', () => {
    expect(draftHeadline({ source: 'dbml', fileName: 'sales.dbml', tables: 1, relationships: 0 })).toBe('Draft from sales.dbml · 1 table, no relationships · not saved');
    expect(draftHeadline({ source: 'dbml', fileName: 'sales.dbml', tables: 1204, relationships: 1 })).toBe('Draft from sales.dbml · 1,204 tables, 1 relationship · not saved');
    expect(draftHeadline({ source: 'semanticModel', origin: 'from the semantic model Sales', tables: 12, relationships: 11 }))
      .toBe('Draft from the semantic model Sales · 12 tables, 11 relationships · not saved');
    expect(draftHeadline({ source: 'dbt', folder: 'marts/finance', tables: 12, relationships: 9 }))
      .toBe('Draft from your dbt models in marts/finance · 12 tables, 9 relationships · not saved');
    expect(draftHeadline({ source: 'exampleProject', title: 'Data mesh', tables: 31, relationships: 30 })).toBe('Example: Data mesh · 31 tables, 30 relationships · not saved');
  });

  it('detail: library tables, singular and plural, and the cap', () => {
    const keep = target('sales');
    expect(draftDetail({ keep, reusedTables: 1, changedTables: 1 })).toBe(
      'Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml). 1 table is already in your Table Library and is used as it is. 1 table in your Table Library gains a relationship.');
    expect(draftDetail({ keep, reusedTables: 3, changedTables: 2 })).toBe(
      'Keep saves it as sales in the Main layer (.erd-studio/main/diagrams/sales.dbml). 3 tables are already in your Table Library and are used as they are. 2 tables in your Table Library gain a relationship.');
    expect(draftDetail({ keep, cap: { drawn: 15, available: 40 } })).toContain(' Drew the 15 best-connected of 40 models; add the rest from the canvas.');
    expect(draftDetail({ noFolderExample: true })).toBe('Open a folder to keep a copy of it.');
  });

  it('a notice is carried on the banner', () => {
    const plan = planOf(EXAMPLE_DBML, 'coffee-shop', 'gold');
    const draft = draftFromImportPlan(importInput(plan, { notice: DRAFT_REDRAWN_NOTICE }));
    expect(draft.banner.notice).toBe('Your ERD Studio files changed, so the draft was redrawn. Check it and keep it again.');
    expect(draftFromImportPlan(importInput(plan)).banner.notice).toBeUndefined();
    expect(DRAFT_OTHER_START_LABELS.openFolder).toBe('Open Folder…');
  });

  it('every draft gets a fresh id', () => {
    const plan = planOf(EXAMPLE_DBML, 'coffee-shop', 'gold');
    expect(draftFromImportPlan(importInput(plan)).id).not.toBe(draftFromImportPlan(importInput(plan)).id);
  });
});

describe('parseDraftToHost (the contract)', () => {
  const plan = planOf(EXAMPLE_DBML, 'coffee-shop', 'gold');
  const scopes = { label: 'Model', current: 'm1', options: [{ id: 'm1', label: 'A', description: '' }, { id: 'm2', label: 'B', description: '' }] };
  const find = toDraftView(draftFromImportPlan(importInput(plan, { scopes })));
  const noFolder = toDraftView(draftFromImportPlan(importInput(plan, { importSource: 'example', hasFolder: false, changeOptions: false })));

  it('passes what the draft offers, rebuilt without extra fields', () => {
    const allowed = draftAllowance(find);
    expect(parseDraftToHost({ type: 'keep', extra: 1 }, allowed)).toEqual({ type: 'keep' });
    expect(parseDraftToHost({ type: 'changeOptions' }, allowed)).toEqual({ type: 'changeOptions' });
    expect(parseDraftToHost({ type: 'otherStart', start: 'guide', command: 'x' }, allowed)).toEqual({ type: 'otherStart', start: 'guide' });
    expect(parseDraftToHost({ type: 'scope', scopeId: 'm2', more: true }, allowed, 'm1')).toEqual({ type: 'scope', scopeId: 'm2' });
    for (const type of ['ready', 'discard', 'detailsOpened', 'layoutFailed']) expect(parseDraftToHost({ type, x: 1 }, allowed)).toEqual({ type });
  });

  it('drops what the draft does not offer', () => {
    const allowed = draftAllowance(noFolder);
    expect(parseDraftToHost({ type: 'keep' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'changeOptions' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'otherStart', start: 'blank' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'otherStart', start: 'openFolder' }, allowed)).toEqual({ type: 'otherStart', start: 'openFolder' });
    expect(parseDraftToHost({ type: 'scope', scopeId: 'm2' }, allowed)).toBeUndefined();
  });

  it('drops the current scope sent again, unknown starts and malformed messages', () => {
    const allowed = draftAllowance(find);
    expect(parseDraftToHost({ type: 'scope', scopeId: 'm1' }, allowed, 'm1')).toBeUndefined();
    expect(parseDraftToHost({ type: 'scope', scopeId: 'nope' }, allowed, 'm1')).toBeUndefined();
    expect(parseDraftToHost({ type: 'scope', scopeId: 3 }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'otherStart', start: 'rm -rf' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'otherStart', start: 'openFolder' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'run', command: 'x' }, allowed)).toBeUndefined();
    for (const raw of [null, undefined, 'keep', 3, [], { type: 7 }]) expect(parseDraftToHost(raw, allowed)).toBeUndefined();
  });
});
