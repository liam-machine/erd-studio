/**
 * The library keyed by table identity on the shape of
 * the project that asked for it: 869 tables in one layer across 15 schema
 * folders, most names repeated in several folders, every Ref written with
 * its schema qualifier and a `use` line per table (as ERD Studio writes
 * them). Owner decision (D) on performance: identities, library references
 * and Ref-end resolution come from maps built once per listing, so the work
 * stays what the old rule did — each table file read at most once, and a
 * diagram's tables read without the rest of the library.
 *
 * Counts first (they do not drift on a slow runner), then a wall-clock
 * budget with the margin `dbmlPerformance.test.ts` uses (3×, 8× on CI).
 * `DBML_PERF_LOG=1` prints every count and time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire, syncBuiltinESMExports } from 'module';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { relationshipsImportsFor } from '../../src/services/dbmlRelationshipsIndex';
import type { TableId } from '../../src/types/tableId';
import * as vscode from 'vscode';
import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const SCHEMAS = 15;
const TABLES = 869;
/** The pool names are drawn from: 869 tables over 100 names, so most names are in eight or nine schema folders. */
const NAMES = 100;
const MARGIN = process.env.CI ? 8 : 3;
const LOG = Boolean(process.env.DBML_PERF_LOG);

const schemaOf = (k: number): string => `s${String(k).padStart(2, '0')}`;
const nameOf = (n: number): string => `t${String(n).padStart(3, '0')}`;

/** Each schema folder's tables, by name index: 58 a folder (57 in the last), each folder starting at another point of the pool. */
function tablesOf(k: number): number[] {
  const count = k < SCHEMAS - 1 ? 58 : TABLES - 58 * (SCHEMAS - 1);
  return Array.from({ length: count }, (_, j) => (k * 13 + j) % NAMES);
}

let root: string;
let semantic: string;
const ids: TableId[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-schema-scoped-budget-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(path.join(semantic, 'bronze', 'relationships'), { recursive: true });
  fs.writeFileSync(path.join(semantic, 'layers.json'), JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 1 }] }));
  for (let k = 0; k < SCHEMAS; k++) {
    const schema = schemaOf(k);
    const dir = path.join(semantic, 'bronze', 'tables', schema);
    fs.mkdirSync(dir, { recursive: true });
    const names = tablesOf(k).map(nameOf);
    for (const name of names) {
      fs.writeFileSync(path.join(dir, `${name}.dbml`), `Table ${schema}.${name} {\n  id INT [pk]\n  a_id INT\n  b_id INT\n  label VARCHAR\n}\n`);
      ids.push({ schema, name });
    }
    // Each table points at the next two of its folder: Refs of one name in every folder that has it.
    const uses = names.map((n) => `use { table ${schema}.${n} } from '../tables/${schema}/${n}.dbml'`);
    const refs = names.flatMap((n, j) => [
      `Ref: ${schema}.${n}.a_id > ${schema}.${names[(j + 1) % names.length]}.id`,
      `Ref: ${schema}.${n}.b_id > ${schema}.${names[(j + 2) % names.length]}.id`,
    ]);
    fs.writeFileSync(path.join(semantic, 'bronze', 'relationships', `${schema}.dbml`), `// ERD Studio relationships: Refs only.\n${uses.join('\n')}\n\n${refs.join('\n')}\n`);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const library = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');

// Table file reads, counted through the module object the services read with.
const cjsFs = createRequire(__filename)('fs') as typeof fs;
const realReadFileSync = cjsFs.readFileSync;

function measure<T>(label: string, budgetMs: number, fn: () => T): { result: T; tableReads: number; maxReadsOfOneFile: number } {
  const perFile = new Map<string, number>();
  (cjsFs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]) {
    const p = String(args[0]).split(path.sep).join('/');
    if (/\/bronze\/tables\//.test(p)) perFile.set(p, (perFile.get(p) ?? 0) + 1);
    return (realReadFileSync as (...a: unknown[]) => unknown).apply(this, args);
  };
  syncBuiltinESMExports();
  const start = performance.now();
  let result: T;
  try {
    result = fn();
  } finally {
    (cjsFs as { readFileSync: unknown }).readFileSync = realReadFileSync;
    syncBuiltinESMExports();
  }
  const elapsed = performance.now() - start;
  const tableReads = [...perFile.values()].reduce((a, b) => a + b, 0);
  const maxReadsOfOneFile = Math.max(0, ...perFile.values());
  if (LOG || elapsed > budgetMs) {
    console.warn(`[schemaScopedLibrary] ${label}: ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, fails above ${MARGIN}×), ${tableReads} table reads, at most ${maxReadsOfOneFile} of one file`);
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, ${MARGIN}× margin)`).toBeLessThanOrEqual(budgetMs * MARGIN);
  return { result, tableReads, maxReadsOfOneFile };
}

describe(`${TABLES} tables in ${SCHEMAS} schema folders, names repeated across them, told apart by identity`, () => {
  it('the listing, every library reference and every lookup by text, from the listing alone', () => {
    const lib = library();
    const { result, tableReads } = measure('list and resolve', 150, () => {
      const entries = lib.listTableFiles();
      const refs = ids.map((id) => lib.libraryRef(id)!);
      const resolved = refs.map((ref) => lib.resolveLibraryRef(ref));
      const bare = Array.from({ length: NAMES }, (_, n) => lib.resolveLibraryRef(nameOf(n)));
      return { entries, refs, resolved, bare };
    });
    expect(tableReads).toBe(0);
    expect(result.entries.filter((e) => !e.shadowedBy)).toHaveLength(TABLES);
    // Every name is in more than one folder: every reference is qualified, and resolves to its own table.
    expect(result.refs.every((ref, i) => ref === `${ids[i].schema}.${ids[i].name}`)).toBe(true);
    expect(result.resolved.every((m, i) => m.kind === 'found' && m.entry.id!.schema === ids[i].schema && m.entry.id!.name === ids[i].name)).toBe(true);
    expect(result.bare.every((m) => m.kind === 'ambiguous')).toBe(true);
  });

  it('every table with its relationships: each file read once, each Ref on its own schema\'s tables', () => {
    const lib = library();
    const { result, tableReads, maxReadsOfOneFile } = measure('listTables (the whole library attached)', 600, () => lib.listTables());
    expect(tableReads).toBe(TABLES);
    expect(maxReadsOfOneFile).toBe(1);
    expect(result).toHaveLength(TABLES);
    for (const model of result) {
      expect(model.relationships, `${model.schema}.${model.name}`).toHaveLength(2);
      for (const r of model.relationships ?? []) expect(r.toModel.startsWith(`${model.schema}.`), `${model.schema}.${model.name} > ${r.toModel}`).toBe(true);
    }
  });

  it('a 300-table diagram\'s tables read with their own Refs, without the whole library', () => {
    const members = ids.slice(0, 300);
    const whole = library();
    const expected = members.map((id) => whole.getTable(id)?.relationships);
    const lib = library();
    const { result, tableReads, maxReadsOfOneFile } = measure('a diagram\'s tables, scoped', 500, () =>
      lib.readingTables(members.map((id) => id.name), () => members.map((id) => lib.getTable(id)?.relationships)));
    expect(result).toEqual(expected);
    expect(maxReadsOfOneFile).toBe(1);
    // Its members' names and the other ends of their Refs, in every folder that has them: most of the library
    // here (300 members cover almost every name, and most names are in most folders). The test below bounds
    // the reads where that set is a small part of the library.
    expect(tableReads).toBeLessThanOrEqual(TABLES);
  });

  it('a diagram of 20 tables of one schema reads its members\' names and their Refs\' other ends, in every folder that has them, and no other table', () => {
    // Host scoping is by name: the Refs that name a member's name (in any schema folder's file) are
    // attached, each end resolved among every table of its name, so a shared name widens what is read to
    // all tables of the names those Refs join. Every other name is never read.
    const members = ids.slice(0, 20);
    const memberNames = new Set(members.map((id) => id.name));
    const involved = new Set(memberNames);
    for (let k = 0; k < SCHEMAS; k++) {
      const names = tablesOf(k).map(nameOf);
      names.forEach((n, j) => {
        for (const to of [names[(j + 1) % names.length], names[(j + 2) % names.length]]) {
          if (memberNames.has(n) || memberNames.has(to)) {
            involved.add(n);
            involved.add(to);
          }
        }
      });
    }
    const mayRead = ids.filter((id) => involved.has(id.name)).length;
    expect(mayRead).toBeLessThan(TABLES / 2);
    const whole = library();
    const expected = members.map((id) => whole.getTable(id)?.relationships);
    const lib = library();
    const { result, tableReads, maxReadsOfOneFile } = measure('a 20-table diagram\'s tables, scoped', 300, () =>
      lib.readingTables(members.map((id) => id.name), () => members.map((id) => lib.getTable(id)?.relationships)));
    expect(result).toEqual(expected);
    expect(maxReadsOfOneFile).toBe(1);
    expect(tableReads).toBeGreaterThanOrEqual(members.length);
    expect(tableReads).toBeLessThanOrEqual(mayRead);
  });

  it('a 300-table DBML diagram opened by the editor: each member read from its own file, every relationship drawn under the diagram\'s names', () => {
    const members = ids.slice(0, 300);
    const diagramPath = path.join(semantic, 'bronze', 'diagrams', 'big.dbml');
    fs.mkdirSync(path.dirname(diagramPath), { recursive: true });
    fs.writeFileSync(diagramPath, [
      "Project big {\n  erd_schema_version: '8'\n}",
      ...members.map((id) => `use { table ${id.schema}.${id.name} } from '../tables/${id.schema}/${id.name}.dbml'`),
      ...Array.from({ length: SCHEMAS }, (_, k) => `use * from '../relationships/${schemaOf(k)}.dbml'`),
      '',
    ].join('\n'));
    try {
      const subjectAreas = new SubjectAreaService(new LayerService(root, '.erd-studio'));
      subjectAreas.setTableLibraryService(library());
      const { result, maxReadsOfOneFile } = measure('a 300-table diagram opened by the editor, told apart by identity', 1500, () => subjectAreas.getSubjectArea(diagramPath));
      expect(maxReadsOfOneFile).toBe(1);
      const names = new Set(result.logical.models.map((m) => m.name));
      expect(names.size).toBe(300);
      const ends = result.logical.models.flatMap((m) => (m.relationships ?? []).map((r) => r.toModel));
      expect(ends.length).toBeGreaterThan(300);
      // An end on the diagram is named as the diagram names it; an end off it keeps its library reference, never a member's name.
      const shown = ends.filter((end) => names.has(end));
      expect(shown.length).toBeGreaterThan(0);
      for (const model of result.logical.models) {
        for (const rel of model.relationships ?? []) {
          if (!names.has(rel.toModel)) expect(rel.toModel).toMatch(/^s\d\d\.t\d{3}$|^t\d{3}$/);
        }
      }
    } finally {
      fs.rmSync(path.dirname(diagramPath), { recursive: true, force: true });
    }
  });

  it('Add Existing by file in a dbt project: the relationship dbt tests give is routed over its two tables, not the library', async () => {
    _resetMockWorkspace();
    const diagramPath = path.join(semantic, 'bronze', 'diagrams', 'dbt.dbml');
    fs.mkdirSync(path.dirname(diagramPath), { recursive: true });
    const [member, added] = [ids[0], ids[1]];
    fs.writeFileSync(diagramPath, [
      "Project dbt {\n  erd_schema_version: '7'\n}",
      `use { table ${member.schema}.${member.name} } from '../tables/${member.schema}/${member.name}.dbml'`,
      `use * from '../relationships/${member.schema}.dbml'`,
      '',
    ].join('\n'));
    const before = new Map(['tables', 'relationships'].flatMap((d) => fs.readdirSync(path.join(semantic, 'bronze', d), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)))
      .map((f) => [f, fs.readFileSync(f, 'utf-8')] as const));
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreas = new SubjectAreaService(layerService);
    const lib = library();
    subjectAreas.setTableLibraryService(lib);
    const yml = {
      models: new Map([member, added].map((id) => [id.name, { name: id.name, description: '', columns: [], filePath: path.join(root, 'models', 'schema.yml'), tags: [], configSchema: id.schema }])),
      relationshipTests: [{ fromModel: added.name, fromColumn: 'b_id', toModel: member.name, toColumn: 'id' }],
      uniqueColumns: new Map(),
      compositeUniqueGroups: new Map(),
    };
    const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
    const selectors = new SelectorsService(subjectAreas, root, '.erd-studio');
    (selectors as unknown as { scheduleRegenerate: () => void }).scheduleRegenerate = () => undefined;
    const provider = new SemanticEditorProvider(
      {
        extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
        globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
        extension: { packageJSON: { version: '0.0.0-test' } },
        globalState: { get: () => true, update: async () => {} },
        workspaceState: { get: () => true, update: async () => {} },
        subscriptions: [],
      } as unknown as vscode.ExtensionContext,
      subjectAreas,
      { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
      { loadYmlData: async () => yml } as unknown as YmlParserService,
      { loadTemplates: () => [] } as unknown as TemplateService,
      layerService,
      root,
      selectors,
      lib,
      new OwnWriteTracker(),
    );
    provider.setLogicalOnly(true);
    const document = createMockTextDocument(diagramPath, fs.readFileSync(diagramPath, 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    try {
      await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
      await panel._simulateMessage({ type: 'ready' });
      // Every table read once already (the editor's first plan reads the library, as every edit's does): what
      // is measured is the add itself.
      lib.listTables();
      await new Promise((resolve) => setTimeout(resolve, 0));
      panel._postedMessages.length = 0;
      const perFile = new Map<string, number>();
      // Tables turned into models: cached reads hide a walk over the whole library, so count the builds too.
      let tablesBuilt = 0;
      const realGetTable = lib.getTable.bind(lib);
      (lib as { getTable: unknown }).getTable = (...args: Parameters<typeof lib.getTable>) => {
        tablesBuilt++;
        return realGetTable(...args);
      };
      const started = performance.now();
      (cjsFs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]) {
        const p = String(args[0]).split(path.sep).join('/');
        if (/\/bronze\/tables\//.test(p)) perFile.set(p, (perFile.get(p) ?? 0) + 1);
        return (realReadFileSync as (...a: unknown[]) => unknown).apply(this, args);
      };
      syncBuiltinESMExports();
      try {
        await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: added.name, sourcePath: `.erd-studio/bronze/tables/${added.schema}/${added.name}.dbml` } });
      } finally {
        (cjsFs as { readFileSync: unknown }).readFileSync = realReadFileSync;
        syncBuiltinESMExports();
        (lib as { getTable: unknown }).getTable = realGetTable;
      }
      const elapsed = performance.now() - started;
      const tableReads = [...perFile.values()].reduce((a, b) => a + b, 0);
      if (LOG || elapsed > 150) console.warn(`[schemaScopedLibrary] Add Existing by file with dbt: ${elapsed.toFixed(0)} ms (budget 150 ms, fails above ${MARGIN}×), ${tableReads} table reads`);
      // Routing the one relationship to its file works on its two tables; over every table of the library it took ~200 ms.
      expect(elapsed).toBeLessThanOrEqual(150 * MARGIN);
      expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'error')).toEqual([]);
      const rels = fs.readFileSync(path.join(semantic, 'bronze', 'relationships', `${added.schema}.dbml`), 'utf-8');
      expect(rels).toMatch(new RegExp(`^Ref: ${added.schema}\\.${added.name}\\.b_id >\\?? ?${member.schema}\\.${member.name}\\.id$`, 'm'));
      // The two tables (and the files the edit wrote), never every table file.
      expect(tableReads).toBeLessThan(TABLES / 4);
      // Nor every table built as a model to look up the relationship's two ends (it built all 869).
      expect(tablesBuilt).toBeLessThan(TABLES / 4);
    } finally {
      for (const [f, text] of before) fs.writeFileSync(f, text);
      fs.rmSync(path.dirname(diagramPath), { recursive: true, force: true });
    }
  });

  it('the relationships index by identity: build, a placement per table and imports for 50 diagrams', () => {
    const lib = library();
    lib.listTables();
    const { result } = measure('index, placements and imports', 400, () => {
      const index = lib.relationshipsIndex();
      const placed = lib.newRelationshipPlacements(ids);
      const imports = Array.from({ length: 50 }, (_, i) => relationshipsImportsFor(ids.slice(i * 17, i * 17 + 40), index));
      return { index, placed, imports };
    });
    expect(result.index.refs).toHaveLength(TABLES * 2);
    expect(result.index.refs.every((r) => r.ownerId?.split('/')[0] === r.targetId?.split('/')[0])).toBe(true);
    // Each table's new Ref goes to its own schema's file (rule 1, counted by identity).
    for (const id of ids) {
      expect(result.placed.get(`${id.schema}/${id.name}`)?.file).toBe(path.join(semantic, 'bronze', 'relationships', `${id.schema}.dbml`));
    }
    expect(result.imports.every((files) => files.length >= 1 && files.length <= 3)).toBe(true);
  });

  it('the write planner by identity: a rename and a relationship change of one table of a name eight folders share', () => {
    const lib = library();
    const target = ids[0];
    const model = lib.getTable(target)!;
    const { result, maxReadsOfOneFile } = measure('plan a rename and a relationship edit', 400, () => lib.planDbmlBatch({
      ops: {
        save: [
          { model: { ...model, name: 'renamed_one' }, fromName: target.name, from: target },
          { model: { ...lib.getTable(ids[1])!, relationships: [] }, from: ids[1] },
        ],
      },
    }));
    expect(maxReadsOfOneFile).toBeLessThanOrEqual(2);
    // Only the renamed table's file and its own schema folder's relationships file change.
    const written = result.writes.map((w) => path.relative(semantic, w.path).split(path.sep).join('/')).sort();
    expect(written).toEqual([`bronze/relationships/${target.schema}.dbml`, `bronze/tables/${target.schema}/${target.name}.dbml`, `bronze/tables/${target.schema}/renamed_one.dbml`].sort());
  });

  it('one relationships file for the layer (where new Refs go by default): every `use` line and Ref in it, still linear', () => {
    // The same tables and Refs, moved into `bronze/relationships/bronze.dbml`: 869 `use` lines and
    // 1,738 Refs in one file. Each Ref end finds its `use` line from a map built once per file; a
    // scan of the file's `use` lines per end made this quadratic.
    const dir = path.join(semantic, 'bronze', 'relationships');
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
    const texts = files.map((f) => fs.readFileSync(f, 'utf-8'));
    const lines = texts.flatMap((t) => t.split('\n'));
    try {
      for (const f of files) fs.rmSync(f);
      fs.writeFileSync(path.join(dir, 'bronze.dbml'), [...lines.filter((l) => l.startsWith('use ')), '', ...lines.filter((l) => l.startsWith('Ref:')), ''].join('\n'));
      const lib = new TableLibraryService(root, '.erd-studio');
      lib.listTables();
      const { result } = measure('the index over one layer file', 150, () => lib.relationshipsIndex());
      expect(result.refs).toHaveLength(TABLES * 2);
    } finally {
      fs.rmSync(path.join(dir, 'bronze.dbml'));
      files.forEach((f, i) => fs.writeFileSync(f, texts[i]));
    }
  });
});
