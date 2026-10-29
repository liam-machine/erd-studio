/**
 * Guards against the slowdowns a 1,100-table pre-release project hit (a
 * "Canvas disconnected" on every open, ten seconds of sidebar redraw after
 * every drag). They came from work that grew with the library, not from slow
 * code: every table lookup listed whole library folders again, the trees
 * resolved every diagram to count it, and every write dropped every cached
 * reading.
 *
 * So these tests count work, not time: directory listings, file reads and
 * DBML compiles, through the real services and editor provider on a
 * 1,100-table library generated here (three layer folders, a relationships
 * file per folder, a 500-table diagram). Counts do not drift on a slow CI
 * runner; the bounds sit far below what the quadratic versions did (tens of
 * thousands of listings) and far above what the current code does. Each
 * operation also gets a wall-clock budget with the same 3× (8× on CI) margin
 * as `dbmlPerformance.test.ts`. `DBML_PERF_LOG=1` prints every count and time.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as vscode from 'vscode';
import * as dbmlParse from '@dbml/parse';

import { _appliedEdits, _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider, type SubjectAreaWriteEvent } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaTreeProvider } from '../../src/providers/DomainTreeProvider';
import { TableLibraryTreeProvider } from '../../src/providers/ModelLibraryTreeProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const TABLES = 1_100;
const MEMBERS = 500;
const SMALL_DIAGRAMS_PER_LAYER = 3;
const LAYERS = ['bronze', 'silver', 'gold'] as const;
const MARGIN = process.env.CI ? 8 : 3;
const LOG = Boolean(process.env.DBML_PERF_LOG);

// ── the library ─────────────────────────────────────────────────────────────

const tableName = (i: number): string => `t${String(i).padStart(4, '0')}`;
const folderOf = (i: number): string => LAYERS[i % LAYERS.length];
/**
 * Every table has one foreign key, every third table a second: ~1.33 Refs a
 * table, joining tables in different folders (a table's folder is `i % 3`).
 * Refs join near neighbours, as a real model's do, so a diagram of related
 * tables reaches few tables outside it.
 */
const refsOf = (i: number): Array<{ column: string; to: number }> => [
  { column: 'fk_a', to: (i + 1) % TABLES },
  ...(i % 3 === 0 ? [{ column: 'fk_b', to: (i + 5) % TABLES }] : []),
];
/** The big diagram: the first 500 tables, in all three folders. */
const bigMembers = Array.from({ length: MEMBERS }, (_, k) => k);

const LAYERS_JSON = JSON.stringify({
  schemaVersion: 1,
  layers: LAYERS.map((id, order) => ({ id, label: id[0].toUpperCase() + id.slice(1), abbreviation: id.slice(0, 3).toUpperCase(), color: '#a0a0a0', creatable: true, order })),
}, null, 2);

function layoutText(members: readonly number[]): string {
  return `${JSON.stringify({
    version: '3.0.0',
    gridEnabling: false,
    currentViewName: null,
    defaultView: {
      detailLevel: 'All',
      relationshipMode: 'All',
      tablePositions: members.map((i, k) => ({ name: tableName(i), schemaName: 'public', x: 60 + (k % 25) * 420, y: 60 + Math.floor(k / 25) * 320 })),
      tableGroupCollapseStates: [],
      stickyNoteLayouts: [],
      referencePaths: [],
    },
    views: {},
  }, null, 2)}\n`;
}

function diagramText(name: string, members: readonly number[]): string {
  const uses = members.map((i) => `use { table ${tableName(i)} } from '../tables/${folderOf(i)}/${tableName(i)}.dbml'`);
  const rels = LAYERS.map((f) => `use * from '../tables/${f}/_relationships.dbml'`);
  return `Project ${name} {\n  erd_schema_version: '7'\n  erd_show_fk_edges: 'true'\n}\n\n${uses.join('\n')}\n${rels.join('\n')}\n`;
}

/** Writes the library and its diagrams under `root/.erd-studio`. */
function writeDbmlProject(root: string): void {
  const sem = path.join(root, '.erd-studio');
  for (const f of LAYERS) fs.mkdirSync(path.join(sem, 'tables', f), { recursive: true });
  for (const f of LAYERS) fs.mkdirSync(path.join(sem, f), { recursive: true });
  fs.writeFileSync(path.join(sem, 'layers.json'), LAYERS_JSON);
  const refLines = new Map<string, string[]>(LAYERS.map((f) => [f, []]));
  const named = new Map<string, Set<number>>(LAYERS.map((f) => [f, new Set()]));
  for (let i = 0; i < TABLES; i++) {
    const refs = refsOf(i);
    const columns = ['  id BIGINT [pk]', ...refs.map((r) => `  ${r.column} BIGINT`), "  label VARCHAR [note: 'a label']"];
    fs.writeFileSync(path.join(sem, 'tables', folderOf(i), `${tableName(i)}.dbml`), `Table ${tableName(i)} {\n${columns.join('\n')}\n  Note: 'Table ${i}'\n}\n`);
    for (const r of refs) {
      refLines.get(folderOf(i))!.push(`Ref: ${tableName(i)}.${r.column} >? ${tableName(r.to)}.id`);
      named.get(folderOf(i))!.add(i).add(r.to);
    }
  }
  for (const f of LAYERS) {
    const uses = [...named.get(f)!].sort((a, b) => a - b).map((i) => {
      const from = folderOf(i) === f ? `./${tableName(i)}.dbml` : `../${folderOf(i)}/${tableName(i)}.dbml`;
      return `use { table ${tableName(i)} } from '${from}'`;
    });
    fs.writeFileSync(path.join(sem, 'tables', f, '_relationships.dbml'), `// ERD Studio relationships.\n${uses.join('\n')}\n\n${refLines.get(f)!.join('\n')}\n`);
  }
  fs.writeFileSync(path.join(sem, 'gold', 'big.dbml'), diagramText('big', bigMembers));
  fs.writeFileSync(path.join(sem, 'gold', 'big.dbdiagram'), layoutText(bigMembers));
  LAYERS.forEach((f, li) => {
    for (let d = 0; d < SMALL_DIAGRAMS_PER_LAYER; d++) {
      const members = Array.from({ length: 30 }, (_, k) => (li * 300 + d * 40 + k * 3) % TABLES);
      fs.writeFileSync(path.join(sem, f, `${f}_area_${d}.dbml`), diagramText(`${f}_area_${d}`, members));
      fs.writeFileSync(path.join(sem, f, `${f}_area_${d}.dbdiagram`), layoutText(members));
    }
  });
}

/** The same shape in YAML/JSON storage (schema v5, relationships in the FK side's yml). */
function writeYamlProject(root: string): void {
  const sem = path.join(root, '.erd-studio');
  for (const f of LAYERS) fs.mkdirSync(path.join(sem, 'logical-models', f), { recursive: true });
  for (const f of LAYERS) fs.mkdirSync(path.join(sem, f), { recursive: true });
  fs.writeFileSync(path.join(sem, 'layers.json'), LAYERS_JSON);
  for (let i = 0; i < TABLES; i++) {
    const refs = refsOf(i);
    const columns = [
      '  - name: id\n    dataType: BIGINT\n    isPrimaryKey: true',
      ...refs.map((r) => `  - name: ${r.column}\n    dataType: BIGINT`),
      '  - name: label\n    dataType: VARCHAR\n    description: a label',
    ];
    const rels = refs.map((r) => `  - fromColumn: ${r.column}\n    toModel: ${tableName(r.to)}\n    toColumn: id\n    cardinality: many-to-one`);
    fs.writeFileSync(path.join(sem, 'logical-models', folderOf(i), `${tableName(i)}.yml`),
      `name: ${tableName(i)}\ndescription: Table ${i}\ncolumns:\n${columns.join('\n')}\nrelationships:\n${rels.join('\n')}\n`);
  }
  const domain = (name: string, layer: string, members: readonly number[]): string => `${JSON.stringify({
    schemaVersion: 5,
    domain: name,
    layer,
    logical: { models: members.map(tableName), relationships: [] },
    viewConfig: { showFkEdges: true, positions: Object.fromEntries(members.map((i, k) => [tableName(i), { x: 60 + (k % 25) * 420, y: 60 + Math.floor(k / 25) * 320 }])) },
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(sem, 'gold', 'big.json'), domain('big', 'gold', bigMembers));
  LAYERS.forEach((f, li) => {
    for (let d = 0; d < SMALL_DIAGRAMS_PER_LAYER; d++) {
      const members = Array.from({ length: 30 }, (_, k) => (li * 300 + d * 40 + k * 3) % TABLES);
      fs.writeFileSync(path.join(sem, f, `${f}_area_${d}.json`), domain(`${f}_area_${d}`, f, members));
    }
  });
}

// ── counting ────────────────────────────────────────────────────────────────

/**
 * Counts `fs` calls made by the code under test. The services use the ESM
 * namespace of `fs`, whose bindings follow the CommonJS module once
 * `syncBuiltinESMExports()` runs, so patching that module reaches them.
 */
interface Counts {
  readdir: number;
  stat: number;
  /** Reads of library table files (`tables/**.dbml` or `logical-models/**.yml`, not `_relationships.dbml`). */
  tableReads: number;
  /** The most times any one file was read. */
  maxReadsOfOneFile: number;
  diagramReads: number;
  relationshipsReads: number;
  /** DBML texts handed to @dbml/parse (each a compile that missed core's cache), by kind. */
  tableCompiles: number;
  diagramCompiles: number;
}

const cjsFs = createRequire(__filename)('fs') as typeof fs;
const real = { readdirSync: cjsFs.readdirSync, statSync: cjsFs.statSync, readFileSync: cjsFs.readFileSync };
// The parser instance core compiles with (imported the way core imports it, not required).
const parseLayout = (dbmlParse as unknown as { MemoryProjectLayout: { prototype: { setSource(fp: unknown, text: string): unknown } } }).MemoryProjectLayout.prototype;
const realSetSource = parseLayout.setSource;

let current: { counts: Counts; perFile: Map<string, number> } | undefined;

function startCounting(): void {
  const counts: Counts = { readdir: 0, stat: 0, tableReads: 0, maxReadsOfOneFile: 0, diagramReads: 0, relationshipsReads: 0, tableCompiles: 0, diagramCompiles: 0 };
  const perFile = new Map<string, number>();
  current = { counts, perFile };
  (cjsFs as { readdirSync: unknown }).readdirSync = function (this: unknown, ...args: unknown[]) {
    counts.readdir++;
    return (real.readdirSync as (...a: unknown[]) => unknown).apply(this, args);
  };
  (cjsFs as { statSync: unknown }).statSync = function (this: unknown, ...args: unknown[]) {
    counts.stat++;
    return (real.statSync as (...a: unknown[]) => unknown).apply(this, args);
  };
  (cjsFs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]) {
    const p = String(args[0]).split(path.sep).join('/');
    if (/\/\.erd-studio\//.test(p)) {
      perFile.set(p, (perFile.get(p) ?? 0) + 1);
      if (/_relationships\.dbml$/i.test(p)) counts.relationshipsReads++;
      else if (/\/\.erd-studio\/(tables|logical-models)\//.test(p)) counts.tableReads++;
      else if (/\.(dbml|json)$/i.test(p) && !p.endsWith('/layers.json')) counts.diagramReads++;
    }
    return (real.readFileSync as (...a: unknown[]) => unknown).apply(this, args);
  };
  syncBuiltinESMExports();
  parseLayout.setSource = function (fp: unknown, text: string) {
    if (/^\s*Table\s/.test(text)) counts.tableCompiles++;
    else if (/^\s*Project\s/m.test(text)) counts.diagramCompiles++;
    return realSetSource.call(this, fp, text);
  };
}

function stopCounting(): Counts {
  Object.assign(cjsFs, real);
  syncBuiltinESMExports();
  parseLayout.setSource = realSetSource;
  const done = current!;
  current = undefined;
  done.counts.maxReadsOfOneFile = Math.max(0, ...done.perFile.values());
  return done.counts;
}

/** Runs `fn` while counting, checks its time against `budgetMs` (with the margin), and returns the counts and result. */
async function measure<T>(label: string, budgetMs: number, fn: () => T | Promise<T>): Promise<{ counts: Counts; result: T }> {
  startCounting();
  const start = performance.now();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    stopCounting();
    throw err;
  }
  const elapsed = performance.now() - start;
  const counts = stopCounting();
  if (LOG || elapsed > budgetMs) {
    console.warn(`[largeLibraryScaling] ${label}: ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, fails above ${MARGIN}×) ${JSON.stringify(counts)}`);
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, ${MARGIN}× margin)`).toBeLessThanOrEqual(budgetMs * MARGIN);
  return { counts, result };
}

// ── harness ─────────────────────────────────────────────────────────────────

function services(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

function buildProvider(root: string) {
  const s = services(root);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const provider = new SemanticEditorProvider(
    context,
    s.subjectAreaService,
    { loadManifest: async () => empty, getManifestPath: () => path.join(root, 'target', 'manifest.json') } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    s.layerService,
    root,
    new SelectorsService(s.subjectAreaService, root, '.erd-studio'),
    s.tableLibraryService,
    new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  const writes: SubjectAreaWriteEvent[] = [];
  provider.onDidWriteSubjectArea((e) => writes.push(e));
  return { ...s, provider, writes };
}

async function openCanvas(provider: SemanticEditorProvider, file: string) {
  const doc = createMockTextDocument(file, real.readFileSync(file, 'utf-8') as string, { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(doc as never, panel as never, {} as never);
  return panel;
}

type Posted = { type: string; payload?: any };
const posted = (panel: { _postedMessages: unknown[] }): Posted[] => panel._postedMessages as Posted[];

/** What VS Code does after a tree refresh: getChildren of every expanded node, getTreeItem of every child. */
function renderTree<T>(tp: { getChildren(e?: T): T[] | undefined | Thenable<T[] | undefined>; getTreeItem(e: T): vscode.TreeItem }): number {
  let items = 0;
  const walk = (e: T | undefined): void => {
    const children = tp.getChildren(e) as T[] | undefined;
    for (const child of children ?? []) {
      const item = tp.getTreeItem(child);
      items++;
      if (item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded) walk(child);
    }
  };
  walk(undefined);
  return items;
}

/** The big diagram's members plus every table a Ref joins to one of them: what a scoped open may read. */
function scopedReadSet(): Set<number> {
  const members = new Set(bigMembers);
  const out = new Set(bigMembers);
  for (let i = 0; i < TABLES; i++) {
    for (const r of refsOf(i)) {
      if (members.has(i)) out.add(r.to);
      if (members.has(r.to)) out.add(i);
    }
  }
  return out;
}

let dbmlRoot: string;
let yamlRoot: string;

/**
 * Dates every directory a minute back. The library index does not trust a
 * directory changed in the last few milliseconds (a coarse file-system clock
 * could hide a second change), and lists it again on every use until it is
 * older, which would make the listing counts depend on how fast the test runs.
 */
function ageDirectories(dir: string): void {
  const then = new Date(Date.now() - 60_000);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) ageDirectories(path.join(dir, entry.name));
  }
  fs.utimesSync(dir, then, then);
}

beforeAll(() => {
  dbmlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-scale-dbml-'));
  yamlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-scale-yaml-'));
  writeDbmlProject(dbmlRoot);
  writeYamlProject(yamlRoot);
  ageDirectories(dbmlRoot);
  ageDirectories(yamlRoot);
}, 60_000);

afterAll(() => {
  fs.rmSync(dbmlRoot, { recursive: true, force: true });
  fs.rmSync(yamlRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetMockWorkspace();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (LOG || String(args[0]).startsWith('[largeLibraryScaling]')) process.stderr.write(`${args.map(String).join(' ')}\n`);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  if (current) stopCounting();
  vi.restoreAllMocks();
});

// ── table lookups ───────────────────────────────────────────────────────────

describe(`table lookups in a ${TABLES}-table library`, () => {
  it.each([
    ['DBML', () => dbmlRoot],
    ['YAML', () => yamlRoot],
  ])('%s: finding every table lists the library once, not once per lookup', async (_kind, rootOf) => {
    const lib = new TableLibraryService(rootOf(), '.erd-studio');
    const names = Array.from({ length: TABLES }, (_, i) => tableName(i));
    const { counts, result } = await measure(`${_kind}: ${TABLES} × findTableFile, resolveTablePath, tableStorage, findTableNameIgnoringCase`, 300, () =>
      names.map((n) => [lib.findTableFile(n), lib.resolveTablePath(n), lib.tableStorage(n), lib.findTableNameIgnoringCase(n.toUpperCase())]));
    expect(result.every(([file, resolved, storage, found], i) => file !== null && resolved === file && storage !== undefined && found === names[i])).toBe(true);
    // One listing of the library (root, the three folders and the other library
    // root at most); the quadratic lookup listed folders on every call (~18,000
    // listings for one diagram open).
    expect(counts.readdir).toBeLessThanOrEqual(12);
    // The index checks itself with a stat per directory it listed, once per
    // lookup at most: linear, a handful per name.
    expect(counts.stat).toBeLessThanOrEqual(names.length * 4 * 10);
    expect(counts.tableReads).toBe(0);
  });

  it('a file added outside ERD Studio is found without any invalidate call (the index checks itself)', () => {
    const lib = new TableLibraryService(dbmlRoot, '.erd-studio');
    expect(lib.findTableFile('t_added_later')).toBeNull();
    const file = path.join(dbmlRoot, '.erd-studio', 'tables', 'silver', 't_added_later.dbml');
    fs.writeFileSync(file, 'Table t_added_later {\n  id INT [pk]\n}\n');
    // Make the folder's change visible even on a file system with a coarse
    // clock, with a time in the past so no later test sees a "racy" folder.
    const age = (seconds: number): void => {
      const then = new Date(Date.now() - seconds * 1000);
      fs.utimesSync(path.dirname(file), then, then);
    };
    age(60);
    try {
      expect(lib.findTableFile('t_added_later')).toBe(file);
    } finally {
      fs.rmSync(file);
      age(120);
    }
    expect(lib.findTableFile('t_added_later')).toBeNull();
  });
});

// ── the sidebar trees ───────────────────────────────────────────────────────

describe('rendering both sidebar trees', () => {
  it.each([
    ['DBML', () => dbmlRoot],
    ['YAML', () => yamlRoot],
  ])('%s: lists folders a fixed number of times and reads no table file while rendering', async (_kind, rootOf) => {
    const root = rootOf();
    const s = services(root);
    const subjectAreas = new SubjectAreaTreeProvider(s.subjectAreaService, s.layerService, root, '.erd-studio');
    const library = new TableLibraryTreeProvider(s.tableLibraryService, s.subjectAreaService, root, '.erd-studio', () => s.layerService.getAllLayers());
    try {
      const diagrams = LAYERS.length * SMALL_DIAGRAMS_PER_LAYER + 1;
      const sa = await measure(`${_kind}: Subject Areas render (cold)`, 500, () => renderTree(subjectAreas));
      expect(sa.result).toBeGreaterThanOrEqual(diagrams);
      // Counts come from each diagram's own text: no table file read, no
      // folder listed per table (the old count resolved every diagram: ~28,000 listings).
      expect(sa.counts.tableReads).toBe(0);
      expect(sa.counts.readdir).toBeLessThanOrEqual(30);
      expect(sa.counts.diagramReads).toBeLessThanOrEqual(diagrams);

      const tl = await measure(`${_kind}: Table Library render (cold)`, 500, () => renderTree(library));
      expect(tl.result).toBeGreaterThanOrEqual(TABLES);
      // Unread table files are shown at once and read in the background later;
      // a render that reads a file per table (or lists a folder per table, as
      // the old error lookup did: ~24,000 listings) is the regression.
      expect(tl.counts.readdir).toBeLessThanOrEqual(30);
      expect(tl.counts.tableReads).toBeLessThan(TABLES / 4);
      expect(tl.counts.diagramReads).toBeLessThanOrEqual(diagrams);

      // A second render of unchanged files reads no diagram again (cached by mtime and size).
      subjectAreas.refresh();
      library.refresh();
      const again = await measure(`${_kind}: both trees rendered again`, 500, () => renderTree(subjectAreas) + renderTree(library));
      expect(again.counts.diagramReads).toBe(0);
      expect(again.counts.tableReads).toBe(0);
      expect(again.counts.readdir).toBeLessThanOrEqual(30);
    } finally {
      library.dispose();
      subjectAreas.dispose();
    }
  });
});

// ── opening the big diagram, then moving a table ────────────────────────────

describe(`opening a ${MEMBERS}-table DBML diagram in a ${TABLES}-table library, then moving a table`, () => {
  it('cold: reads only the diagram\'s tables (and the other ends of their Refs), each once; compiles the diagram once', async () => {
    const h = buildProvider(dbmlRoot);
    const panel = await openCanvas(h.provider, path.join(dbmlRoot, '.erd-studio', 'gold', 'big.dbml'));

    const cold = await measure('DBML: ready → domainLoaded (cold)', 2_000, () => panel._simulateMessage({ type: 'ready' }));
    const loaded = posted(panel).find((m) => m.type === 'domainLoaded')?.payload;
    expect(loaded?.models).toHaveLength(MEMBERS);
    expect(posted(panel)[0].type).toBe('loading');
    const mayRead = scopedReadSet().size;
    expect(mayRead).toBeLessThan(TABLES);
    expect(cold.counts.tableReads).toBeLessThanOrEqual(mayRead);
    expect(cold.counts.tableReads).toBeGreaterThanOrEqual(MEMBERS);
    expect(cold.counts.tableCompiles).toBeLessThanOrEqual(mayRead);
    // No file read over and over (a lookup per member re-reading the folder or the diagram).
    expect(cold.counts.maxReadsOfOneFile).toBeLessThanOrEqual(4);
    expect(cold.counts.relationshipsReads).toBeLessThanOrEqual(LAYERS.length);
    // The diagram is compiled for the read and reused by everything after it
    // in the same open. (One more compile is the member count for `loading`.)
    expect(cold.counts.diagramCompiles).toBeLessThanOrEqual(2);
    // The library is listed once, not per member (~18,000 listings before).
    expect(cold.counts.readdir).toBeLessThanOrEqual(30);

    // Warm (Retry, a reopen, a refresh): nothing is read or compiled again.
    panel._postedMessages.length = 0;
    const warm = await measure('DBML: ready again (warm)', 1_000, () => panel._simulateMessage({ type: 'ready' }));
    expect(posted(panel).find((m) => m.type === 'domainLoaded')?.payload?.models).toHaveLength(MEMBERS);
    expect(warm.counts.tableReads).toBe(0);
    expect(warm.counts.relationshipsReads).toBe(0);
    expect(warm.counts.tableCompiles).toBe(0);
    expect(warm.counts.diagramCompiles).toBe(0);
    expect(warm.counts.readdir).toBeLessThanOrEqual(30);

    // A drag writes the layout only: no table re-read or compiled, no
    // library listing, one edit, and the write says layout-only (so
    // extension.ts refreshes neither tree).
    const victim = tableName(bigMembers[MEMBERS / 2]);
    _appliedEdits.length = 0;
    h.writes.length = 0;
    panel._postedMessages.length = 0;
    const move = await measure('DBML: one table moved', 200, () =>
      panel._simulateMessage({ type: 'updatePositions', payload: { positions: { [victim]: { x: 4321, y: 1234 } } } }));
    expect(posted(panel).filter((m) => m.type === 'error')).toEqual([]);
    expect(move.counts.tableReads).toBe(0);
    expect(move.counts.relationshipsReads).toBe(0);
    expect(move.counts.tableCompiles).toBe(0);
    expect(move.counts.readdir).toBe(0);
    expect(_appliedEdits).toHaveLength(1);
    const touched = new Set((_appliedEdits[0] as unknown as { _ops: Array<{ uri: { fsPath: string } }> })._ops.map((op) => path.basename(op.uri.fsPath)));
    expect([...touched].sort()).toEqual(['big.dbdiagram', 'big.dbml']);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].layoutOnly).toBe(true);
    expect(fs.readFileSync(path.join(dbmlRoot, '.erd-studio', 'gold', 'big.dbdiagram'), 'utf-8')).toContain('"x": 4321');

    // The move dropped no cached reading: the next open still reads nothing.
    panel._postedMessages.length = 0;
    const after = await measure('DBML: ready after the move', 1_000, () => panel._simulateMessage({ type: 'ready' }));
    expect(after.counts.tableReads).toBe(0);
    expect(after.counts.tableCompiles).toBe(0);
    const moved = posted(panel).find((m) => m.type === 'domainLoaded')?.payload?.viewConfig?.positions?.[victim];
    expect(moved).toMatchObject({ x: 4321, y: 1234 });
  }, 60_000);

  it('an edit to one table re-reads that table only, not the library', async () => {
    const h = buildProvider(dbmlRoot);
    h.tableLibraryService.listTables();
    const victim = tableName(bigMembers[3]);
    const file = h.tableLibraryService.findTableFile(victim)!;
    const before = fs.readFileSync(file, 'utf-8');
    try {
      fs.writeFileSync(file, before.replace(`Note: 'Table ${bigMembers[3]}'`, "Note: 'Changed'"));
      h.tableLibraryService.invalidatePaths([file]);
      const { counts } = await measure('DBML: listTables after one table changed', 500, () => h.tableLibraryService.listTables());
      expect(counts.tableReads).toBe(1);
      expect(counts.readdir).toBeLessThanOrEqual(12);
      expect(h.tableLibraryService.getTable(victim)?.description).toBe('Changed');
    } finally {
      fs.writeFileSync(file, before);
    }
  }, 60_000);
});

describe(`opening a ${MEMBERS}-table JSON diagram in a ${TABLES}-table YAML library, then moving a table`, () => {
  it('reads each member once, lists the library a fixed number of times; a drag reads nothing and is layout-only', async () => {
    const h = buildProvider(yamlRoot);
    const file = path.join(yamlRoot, '.erd-studio', 'gold', 'big.json');
    const panel = await openCanvas(h.provider, file);
    const cold = await measure('YAML: ready → domainLoaded (cold)', 2_000, () => panel._simulateMessage({ type: 'ready' }));
    expect(posted(panel).find((m) => m.type === 'domainLoaded')?.payload?.models).toHaveLength(MEMBERS);
    expect(cold.counts.tableReads).toBeLessThanOrEqual(TABLES);
    expect(cold.counts.maxReadsOfOneFile).toBeLessThanOrEqual(2);
    expect(cold.counts.readdir).toBeLessThanOrEqual(30);

    panel._postedMessages.length = 0;
    const warm = await measure('YAML: ready again (warm)', 1_000, () => panel._simulateMessage({ type: 'ready' }));
    expect(warm.counts.tableReads).toBe(0);
    expect(warm.counts.readdir).toBeLessThanOrEqual(30);

    const victim = tableName(bigMembers[7]);
    _appliedEdits.length = 0;
    h.writes.length = 0;
    const move = await measure('YAML: one table moved', 200, () =>
      panel._simulateMessage({ type: 'updatePositions', payload: { positions: { [victim]: { x: 999, y: 111 } } } }));
    expect(move.counts.tableReads).toBe(0);
    expect(move.counts.readdir).toBe(0);
    expect(_appliedEdits).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].layoutOnly).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).viewConfig.positions[victim]).toEqual({ x: 999, y: 111 });
  }, 60_000);
});
