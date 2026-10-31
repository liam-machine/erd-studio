/**
 * SubjectAreaService reading native DBML storage in the layer-first tree:
 * `<layer>/diagrams/*.dbml` diagrams listed beside `<layer>/*.json` ones
 * through the single classifier, read into the same Unified shape core's
 * loader builds, and their members read from `use` lines.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeMissingPositions, loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import {
  SubjectAreaService,
  isSubjectAreaFilePath,
  subjectAreaTableNames,
} from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
const OLD = path.resolve(__dirname, '../fixtures/dbml-1.9-tree');

function services(root: string, semanticDir = '.erd-studio'): { subjectAreaService: SubjectAreaService; tableLibraryService: TableLibraryService } {
  const layerService = new LayerService(root, semanticDir);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, semanticDir);
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { subjectAreaService, tableLibraryService };
}

describe('listSubjectAreas', () => {
  let root: string;
  let semantic: string;
  const write = (rel: string, text: string): void => {
    const file = path.join(semantic, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-domains-'));
    semantic = path.join(root, '.erd-studio');
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [
      { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
      { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
      { id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 3 },
    ] }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists <layer>/*.json and <layer>/diagrams/*.dbml with their storage, and marks a stem found in both formats', () => {
    write('gold/diagrams/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n");
    write('gold/sales.json', JSON.stringify({ schemaVersion: 5, domain: 'sales', layer: 'gold', logical: { models: [] } }));
    write('gold/finance.json', JSON.stringify({ schemaVersion: 5, domain: 'finance', layer: 'gold', logical: { models: [] } }));
    write('silver/diagrams/staging.dbml', "Project staging {\n  erd_schema_version: '7'\n}\n");
    write('silver/diagrams/staging.dbdiagram', '{}');
    const summaries = services(root).subjectAreaService.listSubjectAreas(root, '.erd-studio')
      .map((s) => [s.layer, s.domain, s.storage, s.conflict ?? false, path.basename(s.filePath)])
      .sort((a, b) => String(a[4]).localeCompare(String(b[4])) || String(a[0]).localeCompare(String(b[0])));
    expect(summaries).toEqual([
      ['gold', 'finance', 'json', false, 'finance.json'],
      ['gold', 'sales', 'dbml', true, 'sales.dbml'],
      ['gold', 'sales', 'json', true, 'sales.json'],
      ['silver', 'staging', 'dbml', false, 'staging.dbml'],
    ]);
  });

  it('lists no table, relationships, 1.9 or other .dbml as a diagram', () => {
    write('gold/export.dbml', '// erd-studio dbml-export v1\nTable x {\n  id INT\n}\n');
    write('gold/_relationships.dbml', '// stray\n');
    write('gold/old.dbml', "Project old {\n  erd_schema_version: '7'\n}\n");
    write('gold/diagrams/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n");
    write('gold/diagrams/nested/deep.dbml', "Project deep {\n}\n");
    write('gold/tables/gold/dim_x.dbml', 'Table gold.dim_x {\n  id INT\n}\n');
    write('gold/relationships/gold.dbml', '// relationships\n');
    write('tables/dim_x.dbml', 'Table dim_x {\n  id INT\n}\n');
    write('tables/diagrams/t.dbml', "Project t {\n}\n");
    const names = services(root).subjectAreaService.listSubjectAreas(root, '.erd-studio').map((s) => `${s.layer}/${s.domain}`);
    expect(names).toEqual(['gold/sales']);
  });

  it('a YAML project with layers named diagrams and relationships holding JSON is listed exactly as before', () => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [
      { id: 'diagrams', label: 'Diagrams', abbreviation: 'DIA', color: '#a0a0a0', creatable: true, order: 1 },
      { id: 'relationships', label: 'Relationships', abbreviation: 'REL', color: '#d4a800', creatable: true, order: 2 },
    ] }));
    write('diagrams/overview.json', JSON.stringify({ schemaVersion: 5, domain: 'overview', layer: 'diagrams', logical: { models: ['dim_x'] } }));
    write('relationships/links.json', JSON.stringify({ schemaVersion: 5, domain: 'links', layer: 'relationships', logical: { models: [] } }));
    write('logical-models/dim_x.yml', 'name: dim_x\ncolumns:\n  - name: id\n    dataType: INT\n');
    const { subjectAreaService, tableLibraryService } = services(root);
    const summaries = subjectAreaService.listSubjectAreas(root, '.erd-studio')
      .map((s) => [s.layer, s.domain, s.storage, path.relative(semantic, s.filePath).split(path.sep).join('/')]);
    expect(summaries).toEqual([
      ['diagrams', 'overview', 'json', 'diagrams/overview.json'],
      ['relationships', 'links', 'json', 'relationships/links.json'],
    ]);
    expect(isSubjectAreaFilePath(path.join(semantic, 'diagrams/overview.json'))).toBe(true);
    expect(isSubjectAreaFilePath(path.join(semantic, 'relationships/links.json'))).toBe(true);
    expect(tableLibraryService.listTableNames()).toEqual(['dim_x']);
    expect(tableLibraryService.listRelationshipsFiles()).toEqual([]);
    expect(subjectAreaService.getSubjectArea(path.join(semantic, 'diagrams/overview.json')).logical.models.map((m) => m.name)).toEqual(['dim_x']);
  });

  it('counts no relationships in a DBML diagram (D5)', () => {
    // A Note the JSON fallback's text match would count, were the diagram not skipped.
    write('gold/diagrams/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n  Note: '\"relationships\": [x'\n}\n");
    write('gold/finance.json', JSON.stringify({ schemaVersion: 5, domain: 'finance', layer: 'gold', logical: { models: [], relationships: [{}, {}] } }));
    expect(services(root).subjectAreaService.countSubjectAreaFileRelationships(root, '.erd-studio')).toBe(2);
  });
});

describe('getSubjectArea on dbml-native', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml'])('%s draws what core\'s loadDisplaySubjectArea draws', async (relative) => {
    const { subjectAreaService } = services(NATIVE);
    const filePath = path.join(NATIVE, '.erd-studio', relative);
    const unified = subjectAreaService.getSubjectArea(filePath);
    expect(unified.schemaVersion).toBe(7);
    const computed = computeMissingPositions(unified);
    const viewConfig = computed ? { ...unified.viewConfig, positions: { ...(unified.viewConfig.positions ?? {}), ...computed } } : unified.viewConfig;
    const host = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), viewConfig, unified.stubColumns);

    const core = await loadDisplaySubjectArea({
      domainPath: `.erd-studio/${relative}`,
      readFile: async (p) => {
        try { return fs.readFileSync(path.join(NATIVE, p), 'utf-8'); } catch { return null; }
      },
      readOnly: false,
      warn: () => {},
      dbml: dbmlStorageReader,
    });
    const strip = (d: Record<string, unknown>): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
      delete copy.layerConfig;
      return copy;
    };
    expect(strip(host as unknown as Record<string, unknown>)).toEqual(strip(core as unknown as Record<string, unknown>));
  });

  it('reads the sales diagram: version, members in use order, library relationships, Notes with their layout', () => {
    const unified = services(NATIVE).subjectAreaService.getSubjectArea(path.join(NATIVE, '.erd-studio/gold/diagrams/sales.dbml'));
    expect(unified).toMatchObject({ schemaVersion: 7, domain: 'sales', layer: 'gold', description: 'Sales star schema' });
    expect(unified.logical.models.map((m) => m.name)).toEqual(['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty']);
    const relationships = unified.logical.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}:${r.cardinality}${r.role ? `:${r.role}` : ''}`);
    expect(relationships).toEqual(expect.arrayContaining([
      'customer_profile.customer_key>dim_customer.customer_key:one-to-one',
      'customer_profile.preferred_region_code>dim_region.region_code:many-to-many:region',
      'dim_customer.parent_customer_key>dim_customer.customer_key:many-to-one:parent',
      'fct_order.region_code>dim_region.region_code:many-to-one:region',
      'fct_order.country_code>dim_region.country_code:many-to-one:region',
      'dim_date.previous_date_key>dim_date.date_key:many-to-one:previous day',
    ]));
    expect(unified.viewConfig.annotations).toEqual([
      expect.objectContaining({ id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', linkedModel: 'fct_order', x: 1120, y: 40, width: 220, height: 120 }),
      expect.objectContaining({ id: '9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f', text: '', x: 1120, y: 200 }),
    ]);
    expect(unified.viewConfig.positions?.fct_order).toEqual({ x: 400, y: 200 });
  });

  it('refuses a table or relationships file passed as a diagram, with the not-a-diagram text (§1.8)', () => {
    const { subjectAreaService } = services(NATIVE);
    for (const file of ['gold/tables/gold/fct_order.dbml', 'gold/relationships/gold.dbml', 'silver/tables/calendar/dim_date.dbml']) {
      expect(() => subjectAreaService.getSubjectArea(path.join(NATIVE, '.erd-studio', file))).toThrow(/is a DBML table or relationships file, not a diagram\. Open a diagram in (gold|silver)\/diagrams\//);
    }
  });

  it('refuses a 1.9 pre-release file with the 1.9 text, and any other .dbml with where diagrams live', () => {
    const { subjectAreaService } = services(OLD);
    expect(() => subjectAreaService.getSubjectArea(path.join(OLD, '.erd-studio', 'gold/sales.dbml')))
      .toThrow('gold/sales.dbml was written by an ERD Studio 1.9 pre-release');
    expect(() => subjectAreaService.getSubjectArea(path.join(OLD, '.erd-studio', 'tables/gold/_relationships.dbml')))
      .toThrow('tables/gold/_relationships.dbml was written by an ERD Studio 1.9 pre-release');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-other-'));
    try {
      const other = path.join(tmp, '.erd-studio', 'gold', 'Diagrams', 'x.dbml');
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, "Project x {\n  erd_schema_version: '7'\n}\n");
      expect(() => services(tmp).subjectAreaService.getSubjectArea(other)).toThrow(/is not a DBML diagram\. ERD Studio diagrams live in <layer>\/diagrams\/<name>\.dbml/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('names a file relative to a custom semantic dir, so a 1.9 shape gets the 1.9 text there too (as the editor page does)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-custom-'));
    try {
      fs.cpSync(path.join(OLD, '.erd-studio'), path.join(tmp, 'model'), { recursive: true });
      const { subjectAreaService } = services(tmp, 'model');
      expect(() => subjectAreaService.getSubjectArea(path.join(tmp, 'model', 'gold/sales.dbml')))
        .toThrow('gold/sales.dbml was written by an ERD Studio 1.9 pre-release');
      expect(() => subjectAreaService.getSubjectArea(path.join(tmp, 'model', 'tables/gold/_relationships.dbml')))
        .toThrow('tables/gold/_relationships.dbml was written by an ERD Studio 1.9 pre-release');
      fs.mkdirSync(path.join(tmp, 'model', 'gold', 'relationships'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'model', 'gold', 'relationships', 'gold.dbml'), '// ERD Studio relationships: Refs only.\n');
      expect(() => subjectAreaService.getSubjectArea(path.join(tmp, 'model', 'gold/relationships/gold.dbml')))
        .toThrow('gold/relationships/gold.dbml is a DBML table or relationships file, not a diagram. Open a diagram in gold/diagrams/.');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a 1.9 tree is never read as tables', () => {
    const { tableLibraryService } = services(OLD);
    expect(tableLibraryService.listTableFiles()).toEqual([]);
    expect(tableLibraryService.listRelationshipsFiles()).toEqual([]);
    expect(tableLibraryService.findTableFile('fct_order')).toBeNull();
  });
});

describe('isSubjectAreaFilePath and subjectAreaTableNames', () => {
  it('a .dbml in <layer>/diagrams/ is a diagram; a table, relationships, 1.9 or other .dbml is not; JSON keeps develop\'s rule', () => {
    const at = (rel: string): string => path.join(NATIVE, '.erd-studio', rel);
    expect(isSubjectAreaFilePath(at('gold/diagrams/sales.dbml'))).toBe(true);
    expect(isSubjectAreaFilePath(at('diagrams/diagrams/x.dbml'))).toBe(true);
    expect(isSubjectAreaFilePath(at('gold/sales.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/Diagrams/sales.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('Gold/diagrams/sales.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('tables/diagrams/sales.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/diagrams/sales.dbdiagram'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/tables/gold/fct_order.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/relationships/gold.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('tables/dim_date.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('templates/x.dbml'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/sales.json'))).toBe(true);
    expect(isSubjectAreaFilePath(at('tables/report.json'))).toBe(true);
    expect(isSubjectAreaFilePath(at('templates/x.json'))).toBe(false);
    expect(isSubjectAreaFilePath(at('gold/.draft.json'))).toBe(false);
  });

  it('reads a DBML diagram\'s members from its table use lines, and a JSON one\'s from logical.models', () => {
    const sales = fs.readFileSync(path.join(NATIVE, '.erd-studio/gold/diagrams/sales.dbml'), 'utf-8');
    expect(subjectAreaTableNames(sales, 'gold/diagrams/sales.dbml')).toEqual(['fct_order', 'dim_customer', 'dim_date', 'dim_region', 'customer_profile', 'bridge_empty']);
    expect(subjectAreaTableNames('Project x {\n', 'gold/diagrams/x.dbml')).toBeNull();
    expect(subjectAreaTableNames('{"schemaVersion":5,"logical":{"models":["a","b"]}}', 'gold/x.json')).toEqual(['a', 'b']);
    expect(subjectAreaTableNames('{ nope', 'gold/x.json')).toBeNull();
  });
});
