/**
 * Real files for relationshipStateSpace on native DBML storage (§9.5 of
 * docs/plans/native-dbml-storage.md): a model World projected through the
 * DBML codec — diagram copies dropped (a DBML diagram holds no
 * relationships, D5), library entries canonicalised to their foreign-key
 * table (§2.8), ends respelled — then written as `tables/dim.dbml`,
 * `tables/gold/fct.dbml`, their folders' `_relationships.dbml` and DBML
 * diagrams `silver/D1..D3.dbml`, and read back through TableLibraryService.
 *
 * `dim` sits at the top of `tables/` and `fct` in `tables/gold/`, so a link
 * lands in a different relationships file depending on its owner: every
 * write must land in its owner's folder file.
 */

import { vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { canonicalRelationship, editDiagramLayout } from '@erd-studio/core';
import { readRelationshipsDbml, renderNewSubjectAreaDbml, renderNewTableDbml } from '@erd-studio/core/dbml';
import { createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { SelectorsService } from '../../src/services/selectorsService';
import { TemplateService } from '../../src/services/templateService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { planDbmlLibraryWrites } from '../../src/services/dbmlLibraryWrites';
import { writeFilesWithRollback } from '../../src/services/fsFileWrites';
import type { Relationship, TableRelationship } from '../../src/types/semantic';
import { DBT, columnsOf, linkKey } from './relationshipStateSpace.model';
import type { DbtSpec, SubjectAreaName, TableName, World } from './relationshipStateSpace.model';
import { SEMANTIC_DIR } from './relationshipStateSpace.harness';
import type { GWorld } from './relationshipStateSpace.universes';

export const TABLE_PATHS: Record<TableName, string> = { dim: 'tables/dim.dbml', fct: 'tables/gold/fct.dbml' };
export const RELATIONSHIPS_FILES: Record<TableName, string> = { dim: 'tables/_relationships.dbml', fct: 'tables/gold/_relationships.dbml' };

export interface DbmlProject { root: string; tableLibraryService: TableLibraryService; subjectAreaService: SubjectAreaService; diagramPath: (d: SubjectAreaName) => string }

/** One library entry as the reader holds it: owner = the foreign-key table, ends in their real (lower-case) spelling, no composite key. */
export interface ProjectedLink { owner: TableName; rel: TableRelationship }

/**
 * The world as DBML can hold it: no diagram copies, every library entry on
 * its foreign-key table, respelled. Null when the projection changes the
 * state beyond §2.8 for an edit (a link stored twice, which only Convert
 * dedupes).
 */
export function projectWorld(w: World): World | null {
  const links: Relationship[] = [];
  for (const owner of ['dim', 'fct'] as const) {
    for (const entry of w.lib[owner]) {
      const rel = canonicalRelationship({ fromModel: owner, ...entry } as Relationship);
      links.push({
        ...rel,
        fromModel: rel.fromModel.toLowerCase(), fromColumn: rel.fromColumn.toLowerCase(),
        toModel: rel.toModel.toLowerCase(), toColumn: rel.toColumn.toLowerCase(),
      });
    }
  }
  const keys = links.map(linkKey);
  if (new Set(keys).size !== keys.length) return null;
  const lib: World['lib'] = { dim: [], fct: [] };
  for (const rel of links) {
    const { fromModel, compositeKey: _c, ...entry } = rel as Relationship & { compositeKey?: string };
    lib[fromModel as TableName].push(entry);
  }
  return { profile: w.profile, lib, dom: { D1: [], D2: [], D3: [] }, domModels: w.domModels };
}

/** Write `w` (already projected) as a DBML project. Throws when the writer refuses it. */
export function materialiseDbml(w: World): DbmlProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-statespace-dbml-'));
  const semantic = path.join(root, SEMANTIC_DIR);
  for (const name of ['dim', 'fct'] as const) {
    const file = path.join(semantic, TABLE_PATHS[name]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderNewTableDbml({ name, columns: columnsOf(w.profile, name) }));
  }
  fs.writeFileSync(path.join(semantic, 'layers.json'), `${JSON.stringify({ schemaVersion: 1, layers: [
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
  ] }, null, 2)}\n`);
  writeDbtTests(root, DBT[w.profile]);
  const tableLibraryService = new TableLibraryService(root, SEMANTIC_DIR);
  const saves = (['dim', 'fct'] as const).filter((n) => w.lib[n].length > 0).map((name) => ({
    model: { name, columns: columnsOf(w.profile, name), relationships: w.lib[name] },
  }));
  if (saves.length > 0) {
    const plan = planDbmlLibraryWrites(tableLibraryService.dbmlSnapshot(), { save: saves });
    writeFilesWithRollback(plan.writes.map((wr) => ({ ...wr, path: path.join(semantic, wr.path) })));
  }
  tableLibraryService.invalidateCache();
  const diagramPath = (d: SubjectAreaName): string => path.join(semantic, 'silver', `${d}.dbml`);
  fs.mkdirSync(path.join(semantic, 'silver'), { recursive: true });
  for (const d of ['D1', 'D2', 'D3'] as const) {
    const members = w.domModels[d];
    const relationshipsFiles = [...new Set(members.map((m) => RELATIONSHIPS_FILES[m]))].filter((f) => fs.existsSync(path.join(semantic, f)));
    fs.writeFileSync(diagramPath(d), renderNewSubjectAreaDbml({
      filePath: `silver/${d}.dbml`, domain: d,
      members: members.map((name) => ({ name, path: TABLE_PATHS[name] })),
      relationshipsFiles,
    }));
    const layout = editDiagramLayout(null, Object.fromEntries(members.map((m, i) => [m, { x: i * 300, y: 0 }])), []);
    if (layout) fs.writeFileSync(path.join(semantic, 'silver', `${d}.dbdiagram`), layout);
  }
  const subjectAreaService = new SubjectAreaService(new LayerService(root, SEMANTIC_DIR));
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { root, tableLibraryService, subjectAreaService, diagramPath };
}

/** A profile's dbt tests as a schema yml the real YmlParserService reads (#133 L1), as the JSON harness writes them. */
function writeDbtTests(root: string, spec: DbtSpec | undefined): void {
  if (!spec) return;
  const lines = ['version: 2', 'models:'];
  for (const model of ['dim', 'fct']) {
    const other = model === 'dim' ? 'fct' : 'dim';
    lines.push(`  - name: ${model}`);
    const combos = (spec.combos ?? []).filter((c) => c[0].startsWith(`${model}.`));
    if (combos.length > 0) {
      lines.push('    tests:');
      for (const combo of combos) {
        lines.push('      - dbt_utils.unique_combination_of_columns:', `          combination_of_columns: [${combo.map((mc) => mc.split('.')[1]).join(', ')}]`);
      }
    }
    lines.push('    columns:');
    for (const column of ['k', 'k_x', 'id', 'k2']) {
      const tests = [
        ...((spec.unique ?? []).includes(`${model}.${column}`) ? ['          - unique'] : []),
        ...((spec.pointsOut ?? []).includes(`${model}.${column}`) ? ['          - relationships:', `              to: ref('${other}')`, `              field: ${column}`] : []),
      ];
      if (tests.length > 0) lines.push(`      - name: ${column}`, '        tests:', ...tests);
    }
  }
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models', 'schema.yml'), lines.join('\n') + '\n');
}

/** The library as a fresh TableLibraryService reads it, diagrams' members from their use lines. */
export function readBackDbml(p: DbmlProject, w: World): World {
  const lib = new TableLibraryService(p.root, SEMANTIC_DIR);
  const out: World = { profile: w.profile, lib: { dim: [], fct: [] }, dom: { D1: [], D2: [], D3: [] }, domModels: { ...w.domModels } };
  for (const name of ['dim', 'fct'] as const) out.lib[name] = (lib.getTable(name)?.relationships ?? []).map((r) => ({ ...r }));
  return out;
}

/** Every `.dbml` file of the project, relative path → text. */
export function dbmlFiles(p: DbmlProject): Record<string, string> {
  const out: Record<string, string> = {};
  const semantic = path.join(p.root, SEMANTIC_DIR);
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.dbml')) out[path.relative(semantic, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(semantic);
  return out;
}

/** Each Ref in each relationships file: the file, and the canonical owner and link keys of its pairs. */
export function storedRefs(p: DbmlProject): Array<{ file: string; owner: string; links: string[] }> {
  const out: Array<{ file: string; owner: string; links: string[] }> = [];
  for (const [file, text] of Object.entries(dbmlFiles(p))) {
    if (!file.endsWith('_relationships.dbml')) continue;
    for (const ref of readRelationshipsDbml(text).refs) {
      out.push({ file, owner: ref.relationships[0]?.fromModel.toLowerCase() ?? '', links: ref.relationships.map(linkKey) });
    }
  }
  return out;
}

/** Send one canvas message from DBML diagram `d`; returns the error toasts. */
export async function sendToDbmlProvider(p: DbmlProject, message: unknown, d: SubjectAreaName = 'D1'): Promise<{ errors: string[] }> {
  const selectorsService = new SelectorsService(p.subjectAreaService, p.root, SEMANTIC_DIR);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => undefined) as never);
  const context = {
    extensionUri: vscode.Uri.file(p.root),
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => true, update: async () => undefined },
    secrets: (vscode as unknown as { createMockSecretStorage: () => unknown }).createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, p.subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
    new LayerService(p.root, SEMANTIC_DIR), p.root, selectorsService, p.tableLibraryService, new OwnWriteTracker(),
  );
  const document = createMockTextDocument(p.diagramPath(d), fs.readFileSync(p.diagramPath(d), 'utf-8'), { persist: true });
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
  );
  panel._postedMessages.length = 0;
  await panel._simulateMessage(message);
  const errors = panel._postedMessages
    .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
    .map((m) => m.payload.message);
  return { errors };
}

/**
 * The library modulo §2.8: every entry canonicalised to its foreign-key
 * table, ends lower-cased (respelled), composite keys dropped (the
 * universes' links are single-column), `?` marks invisible, sorted by the
 * §4.5 sort key.
 */
export function normaliseLibrary(w: World): string {
  const all: string[] = [];
  for (const owner of ['dim', 'fct'] as const) {
    for (const entry of w.lib[owner]) {
      const rel = canonicalRelationship({ fromModel: owner, ...entry } as Relationship);
      all.push(JSON.stringify([
        rel.fromModel.toLowerCase(), rel.toModel.toLowerCase(), rel.fromColumn.toLowerCase(), rel.toColumn.toLowerCase(),
        rel.cardinality, rel.role ?? null,
      ]));
    }
  }
  return all.sort().join('\n');
}

// ---------------------------------------------------------------------------
// The GROUP and SELF universes (relationshipStateSpace.universes.ts, #133 L2, L3)
// ---------------------------------------------------------------------------

/** Where each table of a universe lives, and its folder's relationships file. */
export interface GLayout { tablePaths: Record<string, string>; relationshipsFiles: Record<string, string> }

/** GROUP: `dim` (keyed by the composite (k, k_x)) at the top of `tables/`, `fct` in `tables/gold/`. */
export const GROUP_LAYOUT: GLayout = {
  tablePaths: { dim: 'tables/dim.dbml', fct: 'tables/gold/fct.dbml' },
  relationshipsFiles: { dim: 'tables/_relationships.dbml', fct: 'tables/gold/_relationships.dbml' },
};

/** SELF: `emp` in `tables/gold/`; its self-reference is a bare `emp.mgr > emp.id`-style Ref. */
export const SELF_LAYOUT: GLayout = {
  tablePaths: { emp: 'tables/gold/emp.dbml' },
  relationshipsFiles: { emp: 'tables/gold/_relationships.dbml' },
};

/**
 * A GROUP or SELF world as DBML can hold it (§2.8): no diagram copies (D5),
 * every library entry on its foreign-key table, ends respelled lower-case,
 * the composite key kept as the grouping. Null when a link would be stored
 * twice (only Convert dedupes that).
 */
export function projectGWorld(w: GWorld): GWorld | null {
  const lib: Record<string, TableRelationship[]> = Object.fromEntries(Object.keys(w.columns).map((m) => [m, []]));
  const keys: string[] = [];
  for (const owner of Object.keys(w.lib)) {
    for (const entry of w.lib[owner]) {
      const rel = canonicalRelationship({ fromModel: owner, ...entry } as Relationship);
      const lowered: Relationship = {
        ...rel,
        fromModel: rel.fromModel.toLowerCase(), fromColumn: rel.fromColumn.toLowerCase(),
        toModel: rel.toModel.toLowerCase(), toColumn: rel.toColumn.toLowerCase(),
      };
      keys.push(linkKey(lowered));
      const { fromModel, ...stored } = lowered;
      lib[fromModel].push(stored);
    }
  }
  if (new Set(keys).size !== keys.length) return null;
  return { columns: w.columns, lib, dom: { D1: [], D2: [], D3: [] }, domModels: w.domModels };
}

/** Write a projected GROUP or SELF world as a DBML project. Throws when the writer refuses it. */
export function materialiseDbmlG(w: GWorld, layout: GLayout): DbmlProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-statespace-dbml-g-'));
  const semantic = path.join(root, SEMANTIC_DIR);
  try {
    for (const name of Object.keys(w.columns)) {
      const file = path.join(semantic, layout.tablePaths[name]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, renderNewTableDbml({ name, columns: w.columns[name] }));
    }
    fs.writeFileSync(path.join(semantic, 'layers.json'), `${JSON.stringify({ schemaVersion: 1, layers: [
      { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
    ] }, null, 2)}\n`);
    const tableLibraryService = new TableLibraryService(root, SEMANTIC_DIR);
    const saves = Object.keys(w.columns).filter((n) => w.lib[n].length > 0).map((name) => ({
      model: { name, columns: w.columns[name], relationships: w.lib[name] },
    }));
    if (saves.length > 0) {
      const plan = planDbmlLibraryWrites(tableLibraryService.dbmlSnapshot(), { save: saves });
      writeFilesWithRollback(plan.writes.map((wr) => ({ ...wr, path: path.join(semantic, wr.path) })));
    }
    tableLibraryService.invalidateCache();
    const diagramPath = (d: SubjectAreaName): string => path.join(semantic, 'silver', `${d}.dbml`);
    fs.mkdirSync(path.join(semantic, 'silver'), { recursive: true });
    for (const d of ['D1', 'D2', 'D3'] as const) {
      const members = w.domModels[d];
      const relationshipsFiles = [...new Set(members.map((m) => layout.relationshipsFiles[m]))].filter((f) => fs.existsSync(path.join(semantic, f)));
      fs.writeFileSync(diagramPath(d), renderNewSubjectAreaDbml({
        filePath: `silver/${d}.dbml`, domain: d,
        members: members.map((name) => ({ name, path: layout.tablePaths[name] })),
        relationshipsFiles,
      }));
      const positions = editDiagramLayout(null, Object.fromEntries(members.map((m, i) => [m, { x: i * 300, y: 0 }])), []);
      if (positions) fs.writeFileSync(path.join(semantic, 'silver', `${d}.dbdiagram`), positions);
    }
    const subjectAreaService = new SubjectAreaService(new LayerService(root, SEMANTIC_DIR));
    subjectAreaService.setTableLibraryService(tableLibraryService);
    return { root, tableLibraryService, subjectAreaService, diagramPath };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** The library a fresh TableLibraryService reads back, in a GWorld. */
export function readBackDbmlG(p: DbmlProject, w: GWorld): GWorld {
  const lib = new TableLibraryService(p.root, SEMANTIC_DIR);
  const out: GWorld = { columns: w.columns, lib: {}, dom: { D1: [], D2: [], D3: [] }, domModels: w.domModels };
  for (const name of Object.keys(w.columns)) out.lib[name] = (lib.getTable(name)?.relationships ?? []).map((r) => ({ ...r }));
  return out;
}

/**
 * A GWorld's library modulo §2.8: entries canonicalised to their foreign-key
 * table, ends lower-cased, `?` marks invisible, and a composite key only as
 * the set of links it groups (a group of one pair, a partial, reads back as
 * a single Ref: its key is dropped), sorted.
 */
export function normaliseLibraryG(w: GWorld): string {
  const entries: Array<{ rel: Relationship; group: string | null }> = [];
  for (const owner of Object.keys(w.lib)) {
    const rels = w.lib[owner].map((e) => ({ fromModel: owner, ...e }) as Relationship);
    for (const r of rels) {
      const members = r.compositeKey
        ? rels.filter((x) => x.compositeKey?.toLowerCase() === r.compositeKey!.toLowerCase() && x.toModel.toLowerCase() === r.toModel.toLowerCase())
        : [];
      const group = members.length >= 2 ? members.map((m) => linkKey(m)).sort().join('+') : null;
      entries.push({ rel: canonicalRelationship(r), group });
    }
  }
  return entries.map(({ rel, group }) => JSON.stringify([
    rel.fromModel.toLowerCase(), rel.toModel.toLowerCase(), rel.fromColumn.toLowerCase(), rel.toColumn.toLowerCase(),
    rel.cardinality, rel.role ?? null, group,
  ])).sort().join('\n');
}
