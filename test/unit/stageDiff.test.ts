/**
 * computeSubjectAreaDiff — the one cross-stage comparison shared by the canvas and
 * the CLI. Checks parity with the provider's previous orchestration (three
 * reads of the file, logical built by the canvas's builder) and that the
 * canvas's toggleDiscrepancy handler actually goes through it. Runs on the
 * dbt fixture in both storages (YAML/JSON and its native-DBML twin).
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

vi.mock('../../src/services/stageDiff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/stageDiff')>();
  return { ...actual, computeSubjectAreaDiff: vi.fn(actual.computeSubjectAreaDiff) };
});

import { computeSubjectAreaDiff, otherStage } from '../../src/services/stageDiff';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';
import { compare } from '../../src/services/discrepancyService';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
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
import { DBT_FIXTURES, copyDbtFixture, dbtFixtureRoot, diagramPath, setStubColumns } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');
// Manifest, schema yml and catalog are the same files in both fixtures.
const DBT_ROOT = dbtFixtureRoot('dbt-project');

function services(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

let manifest: ManifestData;
let ymlData: YmlData;
let catalog: CatalogData | undefined;

beforeAll(async () => {
  manifest = await new ManifestService({ parseInProcess: true }).loadManifest(DBT_ROOT);
  ymlData = await new YmlParserService().loadYmlData(DBT_ROOT, undefined);
  catalog = (await new CatalogService().loadCatalog(DBT_ROOT)) ?? undefined;
});

afterEach(() => {
  vi.mocked(computeSubjectAreaDiff).mockClear();
});

/** The provider's orchestration before the extraction, verbatim in shape. */
function legacyDiff(subjectAreaService: SubjectAreaService, file: string, source: Stage, target: Stage) {
  const build = (stage: Stage) => {
    const unified = subjectAreaService.getSubjectArea(file);
    if (stage === 'physical') {
      return subjectAreaService.buildPhysicalSubjectArea(unified, ymlData, manifest, catalog);
    }
    const domain = subjectAreaService.getSubjectAreaStage(file);
    return buildLogicalDisplaySubjectArea(domain, unified.viewConfig, unified.stubColumns);
  };
  const s = build(source);
  const t = build(target);
  const unified = subjectAreaService.getSubjectArea(file);
  return compare(s, t, new Set(unified.stubColumns ?? []));
}

it('otherStage flips logical and physical', () => {
  expect(otherStage('logical')).toBe('physical');
  expect(otherStage('physical')).toBe('logical');
});

describe.each(DBT_FIXTURES)('computeSubjectAreaDiff (%s storage)', (storage, fixture) => {
  const FIXTURE_ROOT = dbtFixtureRoot(fixture);
  const SHOWCASE = diagramPath(FIXTURE_ROOT, storage, 'silver', 'showcase');

  it.each<Stage>(['logical', 'physical'])('matches the previous orchestration from %s on showcase', (source) => {
    const { subjectAreaService } = services(FIXTURE_ROOT);
    const result = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, SHOWCASE, source);
    expect(result.report).toEqual(legacyDiff(subjectAreaService, SHOWCASE, source, otherStage(source)));
    expect(result.report.sourceStage).toBe(source);
    expect(result.report.targetStage).toBe(otherStage(source));
    expect(result.source.stage).toBe(source);
    expect(result.target.stage).toBe(otherStage(source));
    expect(result.unified.domain).toBe('showcase');
  });

  it('produces a non-trivial showcase report', () => {
    const { subjectAreaService } = services(FIXTURE_ROOT);
    const { report } = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, SHOWCASE, 'logical');
    expect(report.domain).toBe('showcase');
    expect(report.summary.totalModels).toBeGreaterThan(0);
    expect(report.models.map((m) => m.name)).toContain('dim_customer');
  });

  it('honours stubColumns from the domain file', () => {
    const tmp = copyDbtFixture(fixture, 'stage-diff');
    try {
      const file = diagramPath(tmp, storage, 'silver', 'showcase');
      const { subjectAreaService } = services(tmp);
      const before = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, file, 'logical').report;
      // stubColumns: the JSON key on YAML, the Project's erd_stub_columns on DBML.
      const members = subjectAreaService.getSubjectAreaStage(file).models.map((m) => m.name);
      setStubColumns(file, storage, members);
      expect(subjectAreaService.getSubjectArea(file).stubColumns).toEqual(members);
      expect(before.models.flatMap((m) => m.columns).some((c) => c.status === 'missing')).toBe(true);
      const after = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, file, 'logical').report;
      // Stubbed models hide their missing (physical-only) columns.
      expect(after.summary.missingColumns).toBeLessThanOrEqual(before.summary.missingColumns);
      expect(after.models.flatMap((m) => m.columns).some((c) => c.status === 'missing')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // finance is a v4 JSON file on YAML; Convert writes it straight to an empty DBML diagram.
  it('diffs the empty finance diagram without throwing', () => {
    const { subjectAreaService } = services(FIXTURE_ROOT);
    const file = diagramPath(FIXTURE_ROOT, storage, 'gold', 'finance');
    const { report, unified } = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest, catalog }, file, 'logical');
    if (storage === 'yaml') expect(unified.schemaVersion).toBe(4);
    expect(report.models).toEqual([]);
  });

  it('propagates a missing domain file as an error', () => {
    const { subjectAreaService } = services(FIXTURE_ROOT);
    expect(() => computeSubjectAreaDiff(
      { subjectAreaService, ymlData, manifest }, diagramPath(FIXTURE_ROOT, storage, 'silver', 'nope'), 'logical',
    )).toThrow(/not found/);
  });
});

describe.each(DBT_FIXTURES)('SemanticEditorProvider.handleToggleDiscrepancy (%s storage)', (storage, fixture) => {
  it('goes through computeSubjectAreaDiff and posts its report', async () => {
    const tmp = copyDbtFixture(fixture, 'stage-diff-provider');
    try {
      const { layerService, subjectAreaService, tableLibraryService } = services(tmp);
      const context = {
        extensionUri: vscode.Uri.file(REPO_ROOT),
        globalStorageUri: vscode.Uri.file(path.join(tmp, '.global-storage')),
        extension: { packageJSON: { version: '0.0.0-test' } },
        globalState: { get: () => true, update: async () => {} },
        secrets: vscode.createMockSecretStorage(),
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;
      const provider = new SemanticEditorProvider(
        context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
        layerService, tmp, new SelectorsService(subjectAreaService, tmp, '.erd-studio'), tableLibraryService,
      );

      const file = diagramPath(tmp, storage, 'silver', 'showcase');
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

      const spy = vi.mocked(computeSubjectAreaDiff);
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
