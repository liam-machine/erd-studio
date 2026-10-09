// @vitest-environment jsdom
/**
 * exportDomainFile — the host-side export every surface shares (palette
 * command, canvas, `erd-studio export`). It must read a domain exactly as the
 * canvas's logical stage does, so its text matches core's export goldens for
 * every core fixture project, and the real parsers accept it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { buildDbtKeyIndex, DomainFileError, exportDiagram } from '@erd-studio/core';
import type { DiagramExportFormat } from '@erd-studio/core';
import { exportDomainFile } from '../../src/services/diagramExport';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { buildLogicalDisplayDomain } from '../../src/services/stageDisplay';
import { parseMermaid, readDbmlEverywhere } from '../../packages/core/test/exportParsers';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBT_PROJECT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const SHOWCASE = path.join(DBT_PROJECT, '.erd-studio', 'silver', 'showcase.json');
const CORE_FIXTURES = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures');

function domainServiceFor(root: string): DomainService {
  const domainService = new DomainService(new LayerService(root, '.erd-studio'));
  domainService.setLogicalModelService(new LogicalModelService(root, '.erd-studio'));
  return domainService;
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
};

const EXTENSIONS: Record<DiagramExportFormat, string> = { mermaid: 'mmd', dbml: 'dbml' };

describe('exportDomainFile', () => {
  // The fixtures include a broken model file on purpose; its read warnings are expected.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['dbml', 'mermaid'] as const)('exports the showcase domain as %s, built as the canvas builds its logical stage', async (format) => {
    const domainService = domainServiceFor(DBT_PROJECT);
    const result = await exportDomainFile(domainService, SHOWCASE, format);

    const unified = domainService.getDomain(SHOWCASE);
    const display = buildLogicalDisplayDomain(DomainService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
    expect(result).toEqual({
      content: exportDiagram(display, format),
      fileName: `showcase.${EXTENSIONS[format]}`,
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
    it.each(['dbml', 'mermaid'] as const)('%s', async (format) => {
      const root = path.join(CORE_FIXTURES, name);
      const result = await exportDomainFile(domainServiceFor(root), path.join(root, domainPath), format);
      const golden = fs.readFileSync(path.join(CORE_FIXTURES, 'golden', `${name}.${EXTENSIONS[format]}`), 'utf-8');
      expect(result.content).toBe(golden);
    });
  });

  it('merges the model library\'s relationships, as the canvas draws them', async () => {
    const root = path.join(CORE_FIXTURES, 'library-relationships');
    const { content } = await exportDomainFile(domainServiceFor(root), path.join(root, CORE_CASES['library-relationships']), 'dbml');
    expect(content).toContain('Ref: gold.fct_order.order_date_key > gold.dim_date.date_key');
  });

  it('passes dbt\'s key evidence to the read when given', async () => {
    const domainService = domainServiceFor(DBT_PROJECT);
    const spy = vi.spyOn(domainService, 'getDomain');
    const dbtKeyIndex = buildDbtKeyIndex([]);
    await exportDomainFile(domainService, SHOWCASE, 'dbml', { dbtKeyIndex });
    expect(spy).toHaveBeenCalledWith(SHOWCASE, { dbtKeyIndex });
  });

  it('throws what getDomain throws', async () => {
    const missing = path.join(DBT_PROJECT, '.erd-studio', 'silver', 'no-such-domain.json');
    await expect(exportDomainFile(domainServiceFor(DBT_PROJECT), missing, 'dbml')).rejects.toBeInstanceOf(DomainFileError);
  });

  it('refuses an unknown format before reading anything', async () => {
    const domainService = domainServiceFor(DBT_PROJECT);
    const spy = vi.spyOn(domainService, 'getDomain');
    await expect(exportDomainFile(domainService, SHOWCASE, 'svg' as DiagramExportFormat)).rejects.toThrow('Unknown diagram export format: svg');
    expect(spy).not.toHaveBeenCalled();
  });

  it('imports no vscode — dist/cli.js bundles it', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'diagramExport.ts'), 'utf-8');
    expect(source).not.toMatch(/from ['"]vscode['"]|require\(['"]vscode['"]\)/);
  });
});
