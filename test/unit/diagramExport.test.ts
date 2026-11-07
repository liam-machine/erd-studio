// @vitest-environment jsdom
/**
 * exportSubjectAreaFile — the host-side export every surface shares (palette
 * command, canvas, `erd-studio export`). It must read a domain exactly as the
 * canvas's logical stage does, so its text matches core's export goldens for
 * every core fixture project, and the real parsers accept it.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildDbtKeyIndex,
  DIAGRAM_EXPORT_FILE_EXTENSIONS,
  SubjectAreaFileError,
  exportDiagram,
  toDbmlRich,
} from '@erd-studio/core';
import { readErdLayoutDbml } from '@erd-studio/core/dbml';
import type { DiagramExportFormat } from '@erd-studio/core';
import {
  exportFileNames,
  exportSubjectAreaFile,
  exportSubjectAreaFiles,
  filesOf,
  type SubjectAreaExport,
} from '../../src/services/diagramExport';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';
import {
  MERMAID_LOAD_TIMEOUT_MS,
  goldenFileName,
  loadMermaidParsers,
  parseMermaid,
  readDbmlEverywhere,
  readDbmlRich,
} from '../../packages/core/test/exportParsers';

// Load both Mermaid releases here, outside any test's timeout (#152).
beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBT_PROJECT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const SHOWCASE = path.join(DBT_PROJECT, '.erd-studio', 'silver', 'showcase.json');
const CORE_FIXTURES = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures');

const layersOf = (root: string) => new LayerService(root, '.erd-studio');

function subjectAreaServiceFor(root: string): SubjectAreaService {
  const subjectAreaService = new SubjectAreaService(new LayerService(root, '.erd-studio'));
  subjectAreaService.setTableLibraryService(new TableLibraryService(root, '.erd-studio'));
  return subjectAreaService;
}

/** Core's own golden cases (packages/core/test/unit/exportDiagram.golden.test.ts). */
const CORE_CASES: Record<string, string> = {
  showcase: '.erd-studio/silver/showcase.json',
  'v4-inline': '.erd-studio/bronze/orders.json',
  'missing-model': '.erd-studio/silver/partial.json',
  'no-layers': '.erd-studio/gold/accounts.json',
  'missing-positions': '.erd-studio/silver/showcase.json',
  'library-relationships': '.erd-studio/gold/sales.json',
  'v4-nameless-column': '.erd-studio/silver/orders.json',
  'composite-and-self': '.erd-studio/gold/vault.json',
  'data-type-alias': '.erd-studio/silver/orders.json',
  'domain-one-to-many': '.erd-studio/gold/sales.json',
  'duplicate-key': '.erd-studio/silver/orders.json',
};

const golden = (name: string) => fs.readFileSync(path.join(CORE_FIXTURES, 'golden', name), 'utf-8');

describe('exportSubjectAreaFile', () => {
  // The fixtures include a broken model file on purpose; its read warnings are expected.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['dbml', 'mermaid'] as const)('exports the showcase domain as %s, built as the canvas builds its logical stage', async (format) => {
    const subjectAreaService = subjectAreaServiceFor(DBT_PROJECT);
    const result = await exportSubjectAreaFile(subjectAreaService, SHOWCASE, format);

    const unified = subjectAreaService.getSubjectArea(SHOWCASE);
    const display = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
    expect(result).toEqual({
      content: exportDiagram(display, format),
      fileName: `showcase.${DIAGRAM_EXPORT_FILE_EXTENSIONS[format]}`,
      domainName: 'showcase',
      layer: 'silver',
    });
    expect(result.content.startsWith(format === 'dbml' ? '// erd-studio dbml-export v1\n' : 'erDiagram\n%% erd-studio mermaid-export v1\n')).toBe(true);

    if (format === 'dbml') {
      // Read alike by the current DBML parser and the old ones most tools embed.
      expect(readDbmlEverywhere(result.content).tables.length).toBe(display.models.length);
    } else {
      const parsed = await parseMermaid(result.content);
      expect(parsed.entities.map((e) => e.name)).toEqual(display.models.map((m) => m.name));
    }
  });

  describe.each(Object.entries(CORE_CASES))('matches core\'s golden for %s', (name, domainPath) => {
    it.each(['dbml', 'mermaid', 'dbml-rich'] as const)('%s', async (format) => {
      const root = path.join(CORE_FIXTURES, name);
      const result = await exportSubjectAreaFile(subjectAreaServiceFor(root), path.join(root, domainPath), format, { layers: layersOf(root) });
      expect(result.content).toBe(golden(goldenFileName(name, format)));
      // One file: no layout file beside it, in any format.
      expect(result).not.toHaveProperty('layout');
    });
  });

  it('the layer colour and label come from the layers given, as the canvas shows them', async () => {
    const root = path.join(CORE_FIXTURES, 'showcase');
    const file = path.join(root, CORE_CASES.showcase);
    const withLayers = await exportSubjectAreaFile(subjectAreaServiceFor(root), file, 'dbml-rich', { layers: layersOf(root) });
    expect(withLayers.content).toContain("TableGroup silver [color: #a0a0a0, note: 'Layer: Silver']");
    const without = await exportSubjectAreaFile(subjectAreaServiceFor(root), file, 'dbml-rich');
    expect(without.content).toContain("TableGroup silver [note: 'Layer: silver']");
    // Portable DBML and Mermaid do not use them.
    for (const format of ['dbml', 'mermaid'] as const) {
      expect((await exportSubjectAreaFile(subjectAreaServiceFor(root), file, format, { layers: layersOf(root) })).content)
        .toBe((await exportSubjectAreaFile(subjectAreaServiceFor(root), file, format)).content);
    }
  });

  it('a rich export is one file, its positions in the Project\'s erd_layout', async () => {
    const subjectAreaService = subjectAreaServiceFor(DBT_PROJECT);
    const result = await exportSubjectAreaFile(subjectAreaService, SHOWCASE, 'dbml-rich');
    const unified = subjectAreaService.getSubjectArea(SHOWCASE);
    const display = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);

    expect(result.fileName).toBe('showcase.dbml');
    expect(result.content).toBe(toDbmlRich(display));
    expect(result.content).not.toContain('dbdiagram');

    // Every 9.1+ parser reads the DBML; erd_layout reads back with every table placed, as the canvas has it.
    expect(readDbmlRich(result.content).tables.length).toBe(display.models.length);
    const layout = readErdLayoutDbml(result.content)!;
    expect(layout.problemsAt).toEqual([]);
    expect(layout.positions).toEqual(unified.viewConfig.positions);
  });

  it('places a table with no stored position as the canvas would, so erd_layout has every table', async () => {
    const root = path.join(CORE_FIXTURES, 'missing-positions');
    const domainPath = path.join(root, CORE_CASES['missing-positions']);
    const result = await exportSubjectAreaFile(subjectAreaServiceFor(root), domainPath, 'dbml-rich');
    const layout = readErdLayoutDbml(result.content)!;
    expect(Object.keys(layout.positions).sort()).toEqual(readDbmlRich(result.content).tables.map((t) => t.name).sort());
  });

  it('merges the model library\'s relationships, as the canvas draws them', async () => {
    const root = path.join(CORE_FIXTURES, 'library-relationships');
    const { content } = await exportSubjectAreaFile(subjectAreaServiceFor(root), path.join(root, CORE_CASES['library-relationships']), 'dbml');
    expect(content).toContain('Ref: gold.fct_order.order_date_key > gold.dim_date.date_key');
  });

  it('passes dbt\'s key evidence to the read when given', async () => {
    const subjectAreaService = subjectAreaServiceFor(DBT_PROJECT);
    const spy = vi.spyOn(subjectAreaService, 'getSubjectArea');
    const dbtKeyIndex = buildDbtKeyIndex([]);
    await exportSubjectAreaFile(subjectAreaService, SHOWCASE, 'dbml', { dbtKeyIndex });
    expect(spy).toHaveBeenCalledWith(SHOWCASE, { dbtKeyIndex });
  });

  it('throws what getSubjectArea throws', async () => {
    const missing = path.join(DBT_PROJECT, '.erd-studio', 'silver', 'no-such-domain.json');
    await expect(exportSubjectAreaFile(subjectAreaServiceFor(DBT_PROJECT), missing, 'dbml')).rejects.toBeInstanceOf(SubjectAreaFileError);
  });

  it('refuses an unknown format before reading anything', async () => {
    const subjectAreaService = subjectAreaServiceFor(DBT_PROJECT);
    const spy = vi.spyOn(subjectAreaService, 'getSubjectArea');
    await expect(exportSubjectAreaFile(subjectAreaService, SHOWCASE, 'svg' as DiagramExportFormat)).rejects.toThrow('Unknown diagram export format: svg');
    expect(spy).not.toHaveBeenCalled();
  });

  it('imports no vscode — dist/cli.js bundles it', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'diagramExport.ts'), 'utf-8');
    expect(source).not.toMatch(/from ['"]vscode['"]|require\(['"]vscode['"]\)/);
  });
});

describe('exportFileNames', () => {
  const sa = (domainName: string, layer = 'silver') => ({ domainName, layer });

  it('names each file after its domain when the names are unique', () => {
    expect(exportFileNames([sa('showcase'), sa('sales', 'gold')], 'dbml')).toEqual(['showcase.dbml', 'sales.dbml']);
    expect(exportFileNames([sa('showcase')], 'mermaid')).toEqual(['showcase.mmd']);
    expect(exportFileNames([], 'dbml')).toEqual([]);
  });

  it('prefixes the layer to every domain that shares a name with another, ignoring case', () => {
    expect(exportFileNames([sa('showcase', 'silver'), sa('Showcase', 'gold'), sa('sales', 'gold')], 'dbml-rich'))
      .toEqual(['silver-showcase.dbml', 'gold-Showcase.dbml', 'sales.dbml']);
  });

  it('numbers a name still taken, in the order given, never taking a name another domain wants', () => {
    // gold/silver-x wants silver-x.dbml for itself; silver/x and gold/x collide, so they become
    // silver-x and gold-x — and silver/x, coming second, is the one numbered.
    expect(exportFileNames([sa('silver-x', 'gold'), sa('x', 'silver'), sa('x', 'gold')], 'dbml'))
      .toEqual(['silver-x.dbml', 'silver-x-2.dbml', 'gold-x.dbml']);
    // A numbered name skips one a later domain asked for.
    expect(exportFileNames([sa('a', 'l'), sa('a', 'l'), sa('l-a-2', 'z')], 'dbml'))
      .toEqual(['l-a.dbml', 'l-a-3.dbml', 'l-a-2.dbml']);
  });

  it('sanitises the prefixed name as it sanitises any export name', () => {
    expect(exportFileNames([sa('a/b', 'x'), sa('a:b', 'y')], 'dbml')).toEqual(['x-a-b.dbml', 'y-a-b.dbml']);
  });

  it('is deterministic', () => {
    const list = [sa('x', 'silver'), sa('x', 'gold'), sa('x', 'silver')];
    expect(exportFileNames(list, 'mermaid')).toEqual(exportFileNames(list, 'mermaid'));
    expect(exportFileNames(list, 'mermaid')).toEqual(['silver-x.mmd', 'gold-x.mmd', 'silver-x-2.mmd']);
  });
});

describe('filesOf', () => {
  const rich = (domainName: string, layer: string): SubjectAreaExport => ({
    content: `dbml ${layer} ${domainName}\n`,
    fileName: `${domainName}.dbml`,
    domainName,
    layer,
  });

  it('gives one file per rich DBML domain, its text unchanged whatever name it gets', () => {
    const files = filesOf([
      { domainPath: '/p/silver/x.json', exported: rich('x', 'silver') },
      { domainPath: '/p/gold/x.json', exported: rich('x', 'gold') },
      { domainPath: '/p/gold/y.json', exported: rich('y', 'gold') },
    ], 'dbml-rich');
    expect(files).toEqual([
      { domainPath: '/p/silver/x.json', fileName: 'silver-x.dbml', content: 'dbml silver x\n' },
      { domainPath: '/p/gold/x.json', fileName: 'gold-x.dbml', content: 'dbml gold x\n' },
      { domainPath: '/p/gold/y.json', fileName: 'y.dbml', content: 'dbml gold y\n' },
    ]);
  });

  it('gives one file per domain for every format', () => {
    const files = filesOf([{ domainPath: '/p/a.json', exported: { content: 'x\n', fileName: 'a.mmd', domainName: 'a', layer: 'silver' } }], 'mermaid');
    expect(files).toEqual([{ domainPath: '/p/a.json', fileName: 'a.mmd', content: 'x\n' }]);
  });
});

describe('exportSubjectAreaFiles', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** The dbt fixture with a second `showcase` in gold and a broken diagram, in a temp copy. */
  function projectWithClash(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-export-all-'));
    fs.cpSync(DBT_PROJECT, root, { recursive: true });
    fs.copyFileSync(path.join(root, '.erd-studio/silver/showcase.json'), path.join(root, '.erd-studio/gold/showcase.json'));
    const gold = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/gold/showcase.json'), 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(root, '.erd-studio/gold/showcase.json'), JSON.stringify({ ...gold, layer: 'gold' }));
    fs.writeFileSync(path.join(root, '.erd-studio/silver/broken.json'), '{ not json');
    return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it('exports every domain by layer then file, skips the unreadable one, and keeps clashing names apart', async () => {
    const { root, cleanup } = projectWithClash();
    try {
      const service = subjectAreaServiceFor(root);
      const paths = service.listSubjectAreas(root, '.erd-studio').map((s) => s.filePath);
      const result = await exportSubjectAreaFiles(service, paths, 'dbml-rich', { layers: layersOf(root) });

      expect(result.skipped.map((s) => path.relative(root, s.domainPath))).toEqual([path.join('.erd-studio', 'silver', 'broken.json')]);
      expect(result.skipped[0].error).toBeInstanceOf(SubjectAreaFileError);

      const names = result.files.map((f) => f.fileName);
      expect(names).toContain('gold-showcase.dbml');
      expect(names).toContain('silver-showcase.dbml');
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
      // One .dbml per domain, no layout file beside it.
      expect(names.every((n) => n.endsWith('.dbml'))).toBe(true);
      expect(new Set(result.files.map((f) => f.domainPath)).size).toBe(result.files.length);
      // Gold sorts before silver.
      const layersInOrder = result.files.map((f) => path.basename(path.dirname(f.domainPath)));
      expect(layersInOrder).toEqual([...layersInOrder].sort());

      // The same text the single export gives, renamed or not.
      const single = await exportSubjectAreaFile(service, path.join(root, '.erd-studio/silver/showcase.json'), 'dbml-rich', { layers: layersOf(root) });
      const silver = result.files.find((f) => f.fileName === 'silver-showcase.dbml')!;
      expect(silver.content).toBe(single.content);
    } finally {
      cleanup();
    }
  });

  it('gives one file per domain for Mermaid, the same bytes as the single export', async () => {
    const service = subjectAreaServiceFor(DBT_PROJECT);
    const result = await exportSubjectAreaFiles(service, [SHOWCASE], 'mermaid');
    expect(result).toEqual({
      files: [{ domainPath: SHOWCASE, fileName: 'showcase.mmd', content: (await exportSubjectAreaFile(service, SHOWCASE, 'mermaid')).content }],
      skipped: [],
    });
  });

  it('refuses an unknown format before reading anything', async () => {
    const service = subjectAreaServiceFor(DBT_PROJECT);
    const spy = vi.spyOn(service, 'getSubjectArea');
    await expect(exportSubjectAreaFiles(service, [SHOWCASE], 'svg' as DiagramExportFormat)).rejects.toThrow('Unknown diagram export format: svg');
    expect(spy).not.toHaveBeenCalled();
  });
});
