/**
 * computeDomainDiff — the one cross-stage comparison shared by the canvas and
 * the CLI. Checks parity with the provider's previous orchestration (three
 * reads of the file, logical built by the canvas's builder) and that the
 * canvas's toggleDiscrepancy handler actually goes through it.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

vi.mock('../../src/services/stageDiff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stageDiff')>();
  return { ...actual, computeDomainDiff: vi.fn(actual.computeDomainDiff) };
});

import { computeDomainDiff, otherStage } from '../../src/services/stageDiff';
import { buildLogicalDisplayDomain } from '../../src/services/stageDisplay';
import { compare } from '../../src/services/discrepancyService';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';
import type { CatalogData } from '../../src/types/catalog';
import type { Stage } from '../../src/types/semantic';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const SHOWCASE = path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'showcase.json');

function services(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  return { layerService, domainService, logicalModelService };
}

let manifest: ManifestData;
let ymlData: YmlData;
let catalog: CatalogData | undefined;

beforeAll(async () => {
  manifest = await new ManifestService({ parseInProcess: true }).loadManifest(FIXTURE_ROOT);
  ymlData = await new YmlParserService().loadYmlData(FIXTURE_ROOT, undefined);
  catalog = (await new CatalogService().loadCatalog(FIXTURE_ROOT)) ?? undefined;
});

afterEach(() => {
  vi.mocked(computeDomainDiff).mockClear();
});

/** The provider's orchestration before the extraction, verbatim in shape. */
function legacyDiff(domainService: DomainService, file: string, source: Stage, target: Stage) {
  const build = (stage: Stage) => {
    const unified = domainService.getDomain(file);
    if (stage === 'physical') {
      return domainService.buildPhysicalDomain(unified, ymlData, manifest, catalog);
    }
    const domain = domainService.getDomainStage(file);
    return buildLogicalDisplayDomain(domain, unified.viewConfig, unified.stubColumns);
  };
  const s = build(source);
  const t = build(target);
  const unified = domainService.getDomain(file);
  return compare(s, t, new Set(unified.stubColumns ?? []));
}

describe('computeDomainDiff', () => {
  it('otherStage flips logical and physical', () => {
    expect(otherStage('logical')).toBe('physical');
    expect(otherStage('physical')).toBe('logical');
  });

  it.each<Stage>(['logical', 'physical'])('matches the previous orchestration from %s on showcase', (source) => {
    const { domainService } = services(FIXTURE_ROOT);
    const result = computeDomainDiff({ domainService, ymlData, manifest, catalog }, SHOWCASE, source);
    expect(result.report).toEqual(legacyDiff(domainService, SHOWCASE, source, otherStage(source)));
    expect(result.report.sourceStage).toBe(source);
    expect(result.report.targetStage).toBe(otherStage(source));
    expect(result.source.stage).toBe(source);
    expect(result.target.stage).toBe(otherStage(source));
    expect(result.unified.domain).toBe('showcase');
  });

  it('produces a non-trivial showcase report', () => {
    const { domainService } = services(FIXTURE_ROOT);
    const { report } = computeDomainDiff({ domainService, ymlData, manifest, catalog }, SHOWCASE, 'logical');
    expect(report.domain).toBe('showcase');
    expect(report.summary.totalModels).toBeGreaterThan(0);
    expect(report.models.map((m) => m.name)).toContain('dim_customer');
  });

  it('honours stubColumns from the domain file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-diff-'));
    try {
      fs.cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const file = path.join(tmp, '.erd-studio', 'silver', 'showcase.json');
      const { domainService } = services(tmp);
      const before = computeDomainDiff({ domainService, ymlData, manifest, catalog }, file, 'logical').report;
      const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
      json.stubColumns = json.logical.models;
      fs.writeFileSync(file, JSON.stringify(json));
      const after = computeDomainDiff({ domainService, ymlData, manifest, catalog }, file, 'logical').report;
      // Stubbed models hide their missing (physical-only) columns.
      expect(after.summary.missingColumns).toBeLessThanOrEqual(before.summary.missingColumns);
      expect(after.models.flatMap((m) => m.columns).some((c) => c.status === 'missing')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('diffs a v4 domain file without throwing', () => {
    const { domainService } = services(FIXTURE_ROOT);
    const file = path.join(FIXTURE_ROOT, '.erd-studio', 'gold', 'finance.json');
    const { report, unified } = computeDomainDiff({ domainService, ymlData, manifest, catalog }, file, 'logical');
    expect(unified.schemaVersion).toBe(4);
    expect(report.models).toEqual([]);
  });

  it('propagates a missing domain file as an error', () => {
    const { domainService } = services(FIXTURE_ROOT);
    expect(() => computeDomainDiff(
      { domainService, ymlData, manifest }, path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'nope.json'), 'logical',
    )).toThrow(/not found/);
  });
});

describe('SemanticEditorProvider.handleToggleDiscrepancy', () => {
  it('goes through computeDomainDiff and posts its report', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-diff-provider-'));
    try {
      fs.cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const { layerService, domainService, logicalModelService } = services(tmp);
      const context = {
        extensionUri: vscode.Uri.file(REPO_ROOT),
        globalStorageUri: vscode.Uri.file(path.join(tmp, '.global-storage')),
        extension: { packageJSON: { version: '0.0.0-test' } },
        globalState: { get: () => true, update: async () => {} },
        secrets: vscode.createMockSecretStorage(),
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;
      const provider = new SemanticEditorProvider(
        context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
        layerService, tmp, new SelectorsService(domainService, tmp, '.erd-studio'), logicalModelService,
      );

      const file = path.join(tmp, '.erd-studio', 'silver', 'showcase.json');
      const text = fs.readFileSync(file, 'utf-8');
      const doc = {
        uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
        getText: () => text, positionAt: (offset: number) => ({ offset }), save: vi.fn(async () => true),
      };
      const panel = vscode.createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        doc as unknown as import('vscode').TextDocument,
        panel as unknown as import('vscode').WebviewPanel,
        {} as import('vscode').CancellationToken,
      );
      const posted = () => panel._postedMessages as Array<{ type: string; payload?: unknown }>;
      panel._simulateMessage({ type: 'ready' });
      await vi.waitFor(() => expect(posted().some((m) => m.type === 'domainLoaded')).toBe(true), { timeout: 4000 });

      panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
      await vi.waitFor(
        () => expect(posted().some((m) => m.type === 'discrepancyReport' && m.payload)).toBe(true),
        { timeout: 4000 },
      );

      const spy = vi.mocked(computeDomainDiff);
      expect(spy).toHaveBeenCalledTimes(1);
      const [, domainPath, source, target] = spy.mock.calls[0];
      expect(domainPath).toBe(file);
      expect(source).toBe('logical');
      expect(target).toBe('physical');
      const reportMsg = posted().find((m) => m.type === 'discrepancyReport' && m.payload);
      expect(reportMsg!.payload).toBe(spy.mock.results[0].value.report);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
