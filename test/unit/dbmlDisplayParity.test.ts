/**
 * Canvas–core parity for DBML diagrams (ERD Studio 2.0, §2.3): what the
 * editor draws for a DBML diagram (SubjectAreaService and the canvas
 * payload) equals what `@erd-studio/core`'s `loadDisplaySubjectArea` draws
 * for the same files — the tables, their columns, the edges and the
 * positions — for every DBML diagram of `test/fixtures/dbml-native` and of
 * the core twins (`packages/core/test/fixtures/dbml/*`).
 *
 * Two cases where the host's library lookups by name would differ from the
 * diagram's own files are pinned too:
 *
 * - **drift**: a relationships file holding a Ref between two of the
 *   diagram's tables that the diagram does not import. Core never reads it,
 *   so neither side draws the Ref; the canvas warns, once per file. The Ref
 *   stays in its file: the filter is display-only, so the library the edit
 *   planner reads still holds it.
 * - **a name in two layers**: a member resolves by its `use` path first, so
 *   the canvas shows the copy the diagram imports, as core does, not the
 *   copy the library would pick by name.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const TWINS = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'dbml');
const SEMANTIC_DIR = '.erd-studio';

/** Every DBML diagram of a project, semantic-relative. */
function diagramsOf(project: string): string[] {
  const semantic = path.join(project, SEMANTIC_DIR);
  return fs.readdirSync(semantic, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(semantic, d.name, 'diagrams')))
    .flatMap((d) => fs.readdirSync(path.join(semantic, d.name, 'diagrams')).filter((f) => f.endsWith('.dbml')).map((f) => `${d.name}/diagrams/${f}`))
    .sort();
}

const CASES: Array<[string, string, string]> = [
  ...diagramsOf(NATIVE).map((d): [string, string, string] => ['dbml-native', NATIVE, d]),
  ...fs.readdirSync(TWINS).sort().flatMap((twin) => diagramsOf(path.join(TWINS, twin)).map((d): [string, string, string] => [`twin ${twin}`, path.join(TWINS, twin), d])),
];

let root: string;
let warnings: string[];
/** The last canvas {@link canvasOf} opened. */
let lastPanel: ReturnType<typeof createMockWebviewPanel>;
const at = (rel: string): string => path.join(root, SEMANTIC_DIR, rel);

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-parity-'));
  warnings = [];
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function buildProvider(): { provider: SemanticEditorProvider; subjectAreaService: SubjectAreaService; tables: TableLibraryService } {
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, SEMANTIC_DIR);
  subjectAreaService.setTableLibraryService(tables);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, SEMANTIC_DIR);
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    new OwnWriteTracker(),
  );
  provider.setLogicalOnly(true);
  return { provider, subjectAreaService, tables };
}

/** What a display holds that both sides must agree on: tables and columns, edges, positions. */
function drawn(display: Record<string, unknown>): Record<string, unknown> {
  const d = JSON.parse(JSON.stringify(display)) as Record<string, unknown>;
  const view = (d.viewConfig ?? {}) as Record<string, unknown>;
  return { models: d.models, relationships: d.relationships, positions: view.positions ?? {} };
}

/** The canvas: the diagram opened in the real editor, its posted logical payload. */
async function canvasOf(diagram: string): Promise<Record<string, unknown>> {
  const { provider } = buildProvider();
  const document = createMockTextDocument(at(diagram), fs.readFileSync(at(diagram), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  lastPanel = panel;
  const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: Record<string, unknown> } | undefined;
  expect(loaded, `${diagram} loads on the canvas`).toBeDefined();
  return loaded!.payload;
}

/** Core: the same diagram read by `loadDisplaySubjectArea` over the project's files. */
async function coreOf(diagram: string): Promise<Record<string, unknown>> {
  const display = await loadDisplaySubjectArea({
    domainPath: `${SEMANTIC_DIR}/${diagram}`,
    readFile: async (p) => {
      try {
        return fs.readFileSync(path.join(root, p), 'utf-8');
      } catch {
        return null;
      }
    },
    readOnly: false,
    warn: () => {},
    dbml: dbmlStorageReader,
  });
  return display as unknown as Record<string, unknown>;
}

describe('the canvas draws what core draws, for every DBML diagram', () => {
  it.each(CASES)('%s: %s', async (_project, source, diagram) => {
    fs.cpSync(source, root, { recursive: true });
    const core = drawn(await coreOf(diagram));
    // The ready load saves auto-placed positions into erd_layout (core places them the same way, in memory).
    const canvas = drawn(await canvasOf(diagram));
    expect(canvas).toEqual(core);
  });
});

/** sales.dbml without its import of customers.dbml (which holds three Refs between its tables). */
function withDrift(): void {
  fs.cpSync(NATIVE, root, { recursive: true });
  const file = at('gold/diagrams/sales.dbml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace("use * from '../relationships/customers.dbml'\n", ''));
}

describe('drift: a Ref between two of the diagram\'s tables in a file it does not import', () => {
  it('is drawn by neither side, and the canvas warns once for that file', async () => {
    withDrift();
    const core = drawn(await coreOf('gold/diagrams/sales.dbml'));
    const canvas = drawn(await canvasOf('gold/diagrams/sales.dbml'));
    expect(canvas).toEqual(core);
    const edges = (canvas.relationships as Array<{ fromModel: string; toModel: string }>).map((r) => `${r.fromModel}>${r.toModel}`);
    expect(edges).not.toContain('customer_profile>dim_region');
    expect(edges).not.toContain('dim_customer>dim_customer');
    expect(edges).toContain('fct_order>dim_customer');
    expect(warnings.filter((w) => w.includes('customers.dbml'))).toEqual([
      'gold/relationships/customers.dbml holds a relationship between tables of this diagram, but the diagram does not import it; '
      + 'other DBML tools do not draw it. Any edit to this diagram adds the import.',
    ]);
    // Once per file and diagram, not on every refresh.
    await lastPanel._simulateMessage({ type: 'ready' });
    expect(lastPanel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded')).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('customers.dbml'))).toHaveLength(1);
  });

  it('the filter is display-only: the library (what an edit plans against) still holds the hidden Refs', async () => {
    withDrift();
    const { subjectAreaService, tables } = buildProvider();
    const unified = subjectAreaService.getSubjectArea(at('gold/diagrams/sales.dbml'));
    const profile = unified.logical.models.find((m) => m.name === 'customer_profile');
    expect(profile?.relationships?.some((r) => r.toModel === 'dim_region') ?? false).toBe(false);
    expect(tables.getTable('customer_profile')?.relationships?.some((r) => r.toModel === 'dim_region')).toBe(true);
    expect(subjectAreaService.relationshipsImportDrift(at('gold/diagrams/sales.dbml'))).toEqual(['gold/relationships/customers.dbml']);
  });
});

describe('a table name in two layers', () => {
  it('a member resolves by the diagram\'s use path first, as core does, not by the library\'s choice by name', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    // A second dim_region, in silver, with its own columns; gold's copy comes first in the library.
    fs.mkdirSync(at('silver/tables/silver'), { recursive: true });
    fs.writeFileSync(at('silver/tables/silver/dim_region.dbml'), 'Table silver.dim_region {\n  region_id INT [pk]\n  name VARCHAR\n}\n');
    fs.writeFileSync(at('silver/diagrams/regions.dbml'), [
      'Project regions {',
      "  erd_schema_version: '7'",
      "  erd_layout: '''",
      '    dim_date 40 40',
      '    dim_region 400 40',
      "  '''",
      '}',
      '',
      "use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'",
      "use { table silver.dim_region } from '../tables/silver/dim_region.dbml'",
      '',
    ].join('\n'));
    const { tables } = buildProvider();
    expect(tables.findTableFile('dim_region')).toBe(at('gold/tables/gold/dim_region.dbml'));
    const core = drawn(await coreOf('silver/diagrams/regions.dbml'));
    const canvas = drawn(await canvasOf('silver/diagrams/regions.dbml'));
    expect(canvas).toEqual(core);
    const region = (canvas.models as Array<{ name: string; columns: Array<{ name: string }> }>).find((m) => m.name === 'dim_region');
    expect(region?.columns.map((c) => c.name)).toEqual(['region_id', 'name']);
  });
});

describe('a relationship stored twice, once in a file the diagram imports and once in one it does not', () => {
  it('is drawn on both sides, whichever copy the library keeps, and raises no drift warning', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    // a_dup.dbml sorts before customers.dbml, so the library keeps its copy of the link.
    fs.writeFileSync(at('gold/relationships/a_dup.dbml'), [
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
      '',
      'Ref parent: gold.dim_customer.parent_customer_key >? gold.dim_customer.customer_key',
      '',
    ].join('\n'));
    const core = drawn(await coreOf('gold/diagrams/sales.dbml'));
    const canvas = drawn(await canvasOf('gold/diagrams/sales.dbml'));
    expect(canvas).toEqual(core);
    const edges = (canvas.relationships as Array<{ fromModel: string; toModel: string }>).map((r) => `${r.fromModel}>${r.toModel}`);
    expect(edges).toContain('dim_customer>dim_customer');
    expect(warnings.filter((w) => w.includes('does not import'))).toEqual([]);
  });
});

describe('a pending line between two of the diagram\'s tables in a file it does not import', () => {
  it('is drawn by neither side, and raises the drift warning: the next edit imports its file (§2.4, pending lines count)', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    fs.writeFileSync(at('gold/relationships/extra.dbml'), [
      '// erd-studio pending: Ref: gold.fct_order.region_code >? gold.dim_customer.customer_key',
      '',
    ].join('\n'));
    const core = drawn(await coreOf('gold/diagrams/sales.dbml'));
    const canvas = drawn(await canvasOf('gold/diagrams/sales.dbml'));
    expect(canvas).toEqual(core);
    const edges = (canvas.relationships as Array<{ fromModel: string; fromColumn: string; toModel: string }>).map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}`);
    expect(edges).not.toContain('fct_order.region_code>dim_customer');
    const { subjectAreaService } = buildProvider();
    subjectAreaService.getSubjectArea(at('gold/diagrams/sales.dbml'));
    expect(subjectAreaService.relationshipsImportDrift(at('gold/diagrams/sales.dbml'))).toEqual(['gold/relationships/extra.dbml']);
  });

  it('once the diagram imports the file, both sides draw it and nothing drifts', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    fs.writeFileSync(at('gold/relationships/extra.dbml'), [
      '// erd-studio pending: Ref: gold.fct_order.region_code >? gold.dim_customer.customer_key',
      '',
    ].join('\n'));
    const diagram = at('gold/diagrams/sales.dbml');
    const text = fs.readFileSync(diagram, 'utf-8');
    const anchor = "use * from '../relationships/";
    expect(text).toContain(anchor);
    fs.writeFileSync(diagram, text.replace(anchor, `use * from '../relationships/extra.dbml'\n${anchor}`));
    const core = drawn(await coreOf('gold/diagrams/sales.dbml'));
    const canvas = drawn(await canvasOf('gold/diagrams/sales.dbml'));
    expect(canvas).toEqual(core);
    const edges = (canvas.relationships as Array<{ fromModel: string; fromColumn: string; toModel: string }>).map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}`);
    expect(edges).toContain('fct_order.region_code>dim_customer');
    const { subjectAreaService } = buildProvider();
    subjectAreaService.getSubjectArea(diagram);
    expect(subjectAreaService.relationshipsImportDrift(diagram)).toEqual([]);
  });
});

describe('an unlinked member whose table has a .dbml file now', () => {
  it('counts as a member for its live Refs: a file holding one it does not import drifts, as the next edit imports it (D26, §2.4)', () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    const regionRef = 'Ref region: gold.fct_order.(region_code, country_code) >? gold.dim_region.(region_code, country_code)\n';
    const gold = fs.readFileSync(at('gold/relationships/gold.dbml'), 'utf-8');
    expect(gold).toContain(regionRef);
    fs.writeFileSync(at('gold/relationships/gold.dbml'), gold.replace(regionRef, ''));
    fs.writeFileSync(at('gold/relationships/region.dbml'), [
      "use { table gold.dim_region } from '../tables/gold/dim_region.dbml'",
      "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'",
      '',
      regionRef,
    ].join('\n'));
    const diagram = at('gold/diagrams/sales.dbml');
    const regionUse = "use { table gold.dim_region } from '../tables/gold/dim_region.dbml'\n";
    const text = fs.readFileSync(diagram, 'utf-8');
    expect(text).toContain(regionUse);
    fs.writeFileSync(diagram, text.replace(regionUse, '').replace('  erd_layout_options', "  erd_unlinked_tables: 'dim_region'\n  erd_layout_options"));
    const { subjectAreaService } = buildProvider();
    subjectAreaService.getSubjectArea(diagram);
    expect(subjectAreaService.relationshipsImportDrift(diagram)).toEqual(['gold/relationships/region.dbml']);
  });
});

describe('an unlinked member whose .dbml table sits outside the folders the diagram\'s use lines name', () => {
  /** silver's diagram draws fct (a use line) and dim_x (erd_unlinked_tables), whose file is in gold. */
  function seed(): string {
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), text);
    };
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }] }));
    write('silver/tables/silver/fct.dbml', 'Table silver.fct {\n  id int [pk]\n}\n');
    write('gold/tables/gold/dim_x.dbml', 'Table gold.dim_x {\n  x_key int [pk]\n}\n');
    write('silver/diagrams/d.dbml', "use { table silver.fct } from '../tables/silver/fct.dbml'\n\nProject d {\n  erd_schema_version: '7'\n  erd_unlinked_tables: 'dim_x'\n}\n");
    return 'silver/diagrams/d.dbml';
  }

  it('is drawn missing by both sides (core cannot list folders), until an edit gives it a use line', async () => {
    const diagram = seed();
    const core = drawn(await coreOf(diagram));
    const canvas = drawn(await canvasOf(diagram));
    expect(canvas).toEqual(core);
    const dimX = (canvas.models as Array<{ name: string; columns?: unknown[] }>).find((m) => m.name === 'dim_x');
    expect(dimX?.columns ?? []).toEqual([]);
  });

  it('one in a folder a use line names is drawn with its columns by both sides', async () => {
    const diagram = seed();
    fs.mkdirSync(at('silver/tables/silver'), { recursive: true });
    fs.renameSync(at('gold/tables/gold/dim_x.dbml'), at('silver/tables/silver/dim_x.dbml'));
    fs.writeFileSync(at('silver/tables/silver/dim_x.dbml'), 'Table silver.dim_x {\n  x_key int [pk]\n}\n');
    const core = drawn(await coreOf(diagram));
    const canvas = drawn(await canvasOf(diagram));
    expect(canvas).toEqual(core);
    const dimX = (canvas.models as Array<{ name: string; columns?: unknown[] }>).find((m) => m.name === 'dim_x');
    expect(dimX?.columns).toHaveLength(1);
  });
});
