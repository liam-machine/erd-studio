/**
 * Sample rows (D37) on the canvas, through the real editor: the one place
 * the extension asks for a table's rows (`TableLibraryService`'s table read)
 * puts them on the `domainLoaded` payload, and only there.
 *
 * - Positive control: the payload carries a table's rows (the sentinel is in
 *   it), and so does a twin table (one of two same-named tables from
 *   different schema folders, whose display is spread under its diagram name).
 * - Refresh: a script-style edit that changes only a table file's rows reaches
 *   the watcher's refresh, and the next payload carries the new rows.
 * - A block that does not read: the table is drawn with its columns and
 *   without rows, and the "Not shown" strip names its file and line
 *   (`sampleDataNotRead`) in fixed words; no payload holds a value.
 * - The physical stage carries no rows (its stageData reply).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider, TABLE_REFRESH_BATCH_MS } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { DisplaySubjectArea, DisplayTable } from '@erd-studio/core';
import type { FileNote } from '../../src/types/filesNotShown';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const TWINS = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'dbml', 'same-name-two-schemas');
const SALES = 'gold/diagrams/sales.dbml';
const DIM_REGION = 'gold/tables/gold/dim_region.dbml';
const SENTINEL = 'zqSENTX7';
const LEAK = /SENTX7/;

let root: string;

function buildProvider(): SemanticEditorProvider {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    {
      loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }),
      invalidate: () => {},
    } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
/** As a script writes a file: the bytes land, and the clock moves on. */
const write = (rel: string, text: string): void => {
  fs.writeFileSync(at(rel), text, 'utf-8');
  const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000));
  fs.utimesSync(at(rel), later, later);
};

/** dim_region with a records block holding `rows` (each a line of values). */
function withRows(rows: string[]): string {
  const text = fs.readFileSync(path.join(NATIVE, '.erd-studio', DIM_REGION), 'utf-8');
  const end = text.lastIndexOf('}');
  return `${text.slice(0, end)}\n  records (region_code, region_name) {\n${rows.map((r) => `    ${r}\n`).join('')}  }\n}\n`;
}

type Panel = ReturnType<typeof createMockWebviewPanel>;

async function open(provider: SemanticEditorProvider, rel: string) {
  const doc = createMockTextDocument(at(rel), read(rel), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(doc);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await settle();
  return { doc, panel };
}

async function settle(ms = 0): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const posted = (panel: Panel, type: string): Array<{ type: string; payload: any }> =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === type) as Array<{ type: string; payload: any }>;

function lastLoaded(panel: Panel): DisplaySubjectArea {
  const all = posted(panel, 'domainLoaded');
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1].payload as DisplaySubjectArea;
}

const tableOf = (area: DisplaySubjectArea, name: string): DisplayTable => area.models.find((m) => m.name === name)!;

function notes(panel: Panel): FileNote[] {
  const all = posted(panel, 'filesNotShown');
  return all.length === 0 ? [] : all[all.length - 1].payload.items;
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sample-rows-')));
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async () => undefined) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the canvas payload (positive control)', () => {
  it('carries a table\'s rows as written, and nothing else on the canvas names them', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    write(DIM_REGION, withRows([`'N1', '${SENTINEL} north'`, "'S2', null"]));
    const { panel } = await open(buildProvider(), SALES);
    const region = tableOf(lastLoaded(panel), 'dim_region');
    expect(region.sampleData).toEqual({
      columns: ['region_code', 'region_name'],
      rows: [
        [{ text: 'N1', kind: 'string' }, { text: `${SENTINEL} north`, kind: 'string' }],
        [{ text: 'S2', kind: 'string' }, null],
      ],
      totalRows: 2,
    });
    expect(JSON.stringify(posted(panel, 'domainLoaded'))).toMatch(LEAK);
    // A table with no block carries none.
    expect('sampleData' in tableOf(lastLoaded(panel), 'dim_customer')).toBe(false);
    // Every other message the canvas got holds no value.
    const others = panel._postedMessages.filter((m) => (m as { type: string }).type !== 'domainLoaded');
    expect(JSON.stringify(others)).not.toMatch(LEAK);
    expect(notes(panel)).toEqual([]);
  });

  it('a twin table carries its rows under its diagram name', async () => {
    fs.cpSync(TWINS, root, { recursive: true });
    const kunde = 'bronze/tables/bqs/kunde.dbml';
    const text = read(kunde);
    const end = text.lastIndexOf('}');
    write(kunde, `${text.slice(0, end)}\n  records (id, name) {\n    1, '${SENTINEL}'\n  }\n}\n`);
    const { panel } = await open(buildProvider(), 'bronze/diagrams/kunden.dbml');
    const area = lastLoaded(panel);
    expect(tableOf(area, 'bqs.kunde').sampleData?.rows).toEqual([[{ text: '1', kind: 'number' }, { text: SENTINEL, kind: 'string' }]]);
    expect('sampleData' in tableOf(area, 'ccc.kunde')).toBe(false);
  });

  it('the physical stage carries none', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    write(DIM_REGION, withRows([`'N1', '${SENTINEL}'`]));
    const { panel } = await open(buildProvider(), SALES);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    await settle();
    const replies = posted(panel, 'stageData');
    expect(replies.length).toBeGreaterThan(0);
    const physical = replies[replies.length - 1].payload as DisplaySubjectArea;
    expect(physical.stage).toBe('physical');
    expect(physical.models.filter((m) => 'sampleData' in m)).toEqual([]);
    expect(JSON.stringify(replies)).not.toMatch(LEAK);
  });
});

describe('a script changes only the rows', () => {
  it('the watcher\'s refresh posts the new rows', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    write(DIM_REGION, withRows(["'N1', 'North'"]));
    const provider = buildProvider();
    const { panel } = await open(provider, SALES);
    expect(tableOf(lastLoaded(panel), 'dim_region').sampleData?.totalRows).toBe(1);
    const loads = posted(panel, 'domainLoaded').length;

    // Only the rows change: the columns, the diagram and every other file stay as they were.
    write(DIM_REGION, withRows(["'N1', 'North'", "'S2', 'South'", "'E3', 'East'"]));
    // What the table-file watcher does with a change (extension.ts): drop the cached reading, queue the redraw.
    provider['tableLibraryService'].invalidateTables(['dim_region'], [at(DIM_REGION)]);
    provider.queueTableRefresh('dim_region');
    await settle(TABLE_REFRESH_BATCH_MS + 50);

    expect(posted(panel, 'domainLoaded').length).toBeGreaterThan(loads);
    const region = tableOf(lastLoaded(panel), 'dim_region');
    expect(region.sampleData?.totalRows).toBe(3);
    expect(region.sampleData?.rows.map((r) => r[1]?.text)).toEqual(['North', 'South', 'East']);
  });
});

describe('a block that does not read', () => {
  it('draws the table without rows, and the strip names the file and line in fixed words', async () => {
    fs.cpSync(NATIVE, root, { recursive: true });
    // A dotted bare word: the parser reads it as an Enum reference and quotes it.
    write(DIM_REGION, withRows([`'N1', ${SENTINEL}.north`]));
    const { panel } = await open(buildProvider(), SALES);
    const region = tableOf(lastLoaded(panel), 'dim_region');
    expect(region.loadError).toBeUndefined();
    expect(region.columns.map((c) => c.name)).toEqual(['region_code', 'country_code', 'region_name']);
    expect('sampleData' in region).toBe(false);

    const line = read(DIM_REGION).split('\n').findIndex((l) => l.trim().startsWith('records')) + 1;
    expect(notes(panel)).toEqual([{
      code: 'sampleDataNotRead',
      message: `gold/tables/gold/dim_region.dbml line ${line}: the sample data (records) does not read as DBML, so it is not shown, `
        + 'and ERD Studio will not edit this table until it is fixed or removed.',
      file: '.erd-studio/gold/tables/gold/dim_region.dbml',
      line,
    }]);
    expect(JSON.stringify(panel._postedMessages)).not.toMatch(LEAK);
  });
});
