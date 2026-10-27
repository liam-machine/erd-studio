/**
 * Golden output of the extension host's domain -> DisplaySubjectArea pipeline.
 *
 * Drives the real SubjectAreaService, LayerService and TableLibraryService (and a
 * real SemanticEditorProvider) over the fixture projects in
 * packages/core/test/fixtures, and pins exactly what the host posts to the
 * webview. The same files are the parity target for @erd-studio/core: once the
 * host delegates to core, this test must still pass with no golden changes,
 * and core's own golden test compares its output against these files.
 *
 * Outputs (packages/core/test/fixtures/golden):
 *   <case>.host.json                 posted[0] of sendSubjectAreaData (logical stage)
 *   <case>.unified.json              subjectAreaService.getSubjectArea(), JSON round-tripped
 *   missing-positions.persist.json   sendSubjectAreaData with persistPositions: the
 *                                    posted message plus the WorkspaceEdit applied
 *   showcase.stage-logical.json      the stageData reply of a switch to logical
 *   dbt-project.stage-physical.json  the stageData reply of a switch to physical
 *   dbt-project.physical.host.json   sendSubjectAreaData on a panel showing physical
 *   errors.<name>.host.json          the posted `error` message (payload { message, kind? })
 *   logs.json                        console.warn / console.error text per output
 *
 * The manifest, dbt yml and template services are stubbed empty for every
 * case except the dbt-project ones, which use the real ManifestService,
 * YmlParserService and CatalogService on test/fixtures/dbt-project.
 *
 * Absolute fixture paths are written as `<root>`, and the ` (line N column M)`
 * suffix newer Node versions add to JSON.parse messages is stripped on both the
 * write and the compare side, so the files match on every supported Node.
 *
 * Regenerate with: UPDATE_GOLDEN=1 npx vitest run test/unit/displayDomainGolden.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createMockWebviewPanel,
  createMockTextDocument,
  _resetMockWorkspace,
  _appliedEdits,
  type MockEditOp,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

const UPDATE = process.env.UPDATE_GOLDEN === '1';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures');
const GOLDEN_DIR = path.join(FIXTURES, 'golden');
const DBT_PROJECT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const SEMANTIC_DIR = '.erd-studio';

/** Fixture projects that load successfully: name -> domain file under the project root. */
const SUBJECT_AREA_CASES: Record<string, string> = {
  showcase: 'silver/showcase.json',
  'v4-inline': 'bronze/orders.json',
  'missing-model': 'silver/partial.json',
  'no-layers': 'gold/accounts.json',
  'missing-positions': 'silver/showcase.json',
  // Old shapes a released extension wrote and core must keep reading:
  // model-library relationships stored one-to-many and backwards (1.6.6 /
  // 1.6.7), and a hand-edited v4 file whose columns have no text name.
  'library-relationships': 'gold/sales.json',
  'v4-nameless-column': 'silver/orders.json',
  // #133 L2–L4: a composite foreign key, a lone compositeKey, self-references, a mis-cased end.
  'composite-and-self': 'gold/vault.json',
  // #144: column types spelled dbt's way (`data_type:`), alone and beside a `dataType`.
  'data-type-alias': 'silver/orders.json',
  // #163: a domain file's one-to-many from the "one" side badges the to end as the foreign key.
  'domain-one-to-many': 'gold/sales.json',
  // #164: a key written twice, read with the last copy winning and a loadWarning.
  'duplicate-key': 'silver/orders.json',
};

/** Domain files under packages/core/test/fixtures/errors that must fail to load. */
const ERROR_CASES: Record<string, string> = {
  legacy: 'silver/legacy.json',
  hybrid: 'silver/hybrid.json',
  future: 'silver/future.json',
  noversion: 'silver/noversion.json',
  array: 'silver/array.json',
  empty: 'silver/empty.json',
  invalid: 'silver/invalid.json',
  badlayer: 'platinum/badlayer.json',
  // #145: unresolved git merge conflicts, in positions only and in the model list.
  'conflict-positions': 'silver/conflict-positions.json',
  'conflict-models': 'silver/conflict-models.json',
};

const EXPECTED_FILES = [
  ...Object.keys(SUBJECT_AREA_CASES).flatMap((c) => [`${c}.host.json`, `${c}.unified.json`]),
  'missing-positions.persist.json',
  'showcase.stage-logical.json',
  'dbt-project.stage-physical.json',
  'dbt-project.physical.host.json',
  ...Object.keys(ERROR_CASES).map((c) => `errors.${c}.host.json`),
  // Native DBML storage's error goldens: held by core's loader
  // (packages/core/test/unit/loadDisplayDomain.golden.test.ts) until the host
  // reads DBML diagrams (S4), which adds them to ERROR_CASES above.
  'errors.dbml-syntax.host.json',
  'errors.dbml-future.host.json',
  'errors.dbml-conflict.host.json',
  'errors.dbml-not-a-diagram.host.json',
  'logs.json',
  // The diagram export goldens, owned by packages/core/test/unit/exportDiagram.golden.test.ts.
  ...Object.keys(SUBJECT_AREA_CASES).flatMap((c) => [`${c}.dbml`, `${c}.mmd`]),
  // The rich DBML goldens and their layout files, owned by exportDiagram.golden.test.ts and exportDbmlRich.test.ts.
  ...Object.keys(SUBJECT_AREA_CASES).flatMap((c) => [`${c}.rich.dbml`, `${c}.dbdiagram`]),
  'rich-features.rich.dbml',
  'rich-features.dbdiagram',
].sort();

const LINE_COLUMN = / \(line \d+ column \d+\)/g;

/** Serialise, replace the fixture root with `<root>` and drop Node's line/column suffix. */
function normalise(value: unknown, root: string): unknown {
  const text = JSON.stringify(value).split(root).join('<root>').replace(LINE_COLUMN, '');
  return JSON.parse(text);
}

function normaliseText(text: string, root: string): string {
  return text.split(root).join('<root>').replace(LINE_COLUMN, '');
}

function readGolden(file: string): unknown {
  const full = path.join(GOLDEN_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing golden file ${file}. Run with UPDATE_GOLDEN=1 to create it.`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf-8'));
}

function writeGolden(file: string, value: unknown): void {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(GOLDEN_DIR, file), JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

/** Write the golden file under UPDATE_GOLDEN=1, otherwise compare against it. */
function matchGolden(file: string, actual: unknown): void {
  if (UPDATE) {
    writeGolden(file, actual);
    return;
  }
  expect(actual).toEqual(readGolden(file));
}

// ---------------------------------------------------------------------------
// Console capture — the log text is part of the golden output
// ---------------------------------------------------------------------------

let logLines: string[] = [];
const collectedLogs: Record<string, string[]> = {};

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  return JSON.stringify(arg);
}

function captureConsole(): void {
  logLines = [];
  for (const level of ['warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logLines.push(`${level}: ${args.map(formatArg).join(' ')}`);
    });
  }
}

/** Record (or compare) the console output produced for one golden output. */
function matchLogs(key: string, root: string): void {
  const lines = logLines.map((line) => normaliseText(line, root));
  logLines = [];
  if (UPDATE) {
    collectedLogs[key] = lines;
    return;
  }
  const golden = readGolden('logs.json') as Record<string, string[]>;
  expect(lines).toEqual(golden[key]);
}

// ---------------------------------------------------------------------------
// Host construction
// ---------------------------------------------------------------------------

function emptyManifest(): ManifestData {
  return {
    models: new Map(),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
    disabledModels: new Set(),
  };
}

function emptyYml(): YmlData {
  return {
    models: new Map(),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
  };
}

interface Host {
  provider: SemanticEditorProvider;
  subjectAreaService: SubjectAreaService;
}

/**
 * Build the real provider and services on `root`. With `dbt: true` the dbt
 * project services are real; otherwise they (and the templates) are empty.
 */
function buildHost(root: string, options: { dbt?: boolean } = {}): Host {
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, SEMANTIC_DIR);
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, root, SEMANTIC_DIR);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  const manifestService = options.dbt
    ? new ManifestService()
    : ({ loadManifest: async () => emptyManifest() } as unknown as ManifestService);
  const ymlParserService = options.dbt
    ? new YmlParserService()
    : ({ loadYmlData: async () => emptyYml() } as unknown as YmlParserService);
  const templateService = { loadTemplates: () => [] } as unknown as TemplateService;

  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    root,
    selectorsService,
    tableLibraryService,
    new OwnWriteTracker(),
  );
  if (options.dbt) {
    provider.setCatalogService(new CatalogService());
  }
  return { provider, subjectAreaService };
}

function subjectAreaFile(root: string, relative: string): string {
  return path.join(root, SEMANTIC_DIR, relative);
}

function openDocument(filePath: string, options: { persist?: boolean } = {}) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  return createMockTextDocument(filePath, text, options);
}

type Posted = { type: string; payload?: unknown };

/** Run sendSubjectAreaData once and return what was posted, round-tripped through JSON. */
async function sendSubjectAreaData(
  host: Host,
  filePath: string,
  options: { stage?: 'logical' | 'physical'; persistPositions?: boolean; persistDocument?: boolean } = {},
): Promise<Posted[]> {
  const panel = createMockWebviewPanel();
  const doc = openDocument(filePath, { persist: options.persistDocument });
  const internals = host.provider as any;
  let panelKey: string | undefined;
  if (options.stage) {
    panelKey = 'golden-panel';
    internals.openPanels.set(panelKey, { document: doc, webview: panel.webview, activeStage: options.stage });
  }
  await internals.sendSubjectAreaData(doc, panel.webview, panelKey, { persistPositions: options.persistPositions });
  return JSON.parse(JSON.stringify(panel._postedMessages)) as Posted[];
}

/** Run the switchStage handler once and return what was posted. */
async function switchStage(host: Host, filePath: string, target: 'logical' | 'physical'): Promise<Posted[]> {
  const panel = createMockWebviewPanel();
  const doc = openDocument(filePath);
  const internals = host.provider as any;
  const panelKey = 'golden-panel';
  const initial = target === 'logical' ? 'physical' : 'logical';
  internals.openPanels.set(panelKey, { document: doc, webview: panel.webview, activeStage: initial });
  await internals.handleSwitchStage(panelKey, doc, panel.webview, target);
  return JSON.parse(JSON.stringify(panel._postedMessages)) as Posted[];
}

// ---------------------------------------------------------------------------

beforeAll(() => {
  if (UPDATE && fs.existsSync(GOLDEN_DIR)) {
    for (const file of fs.readdirSync(GOLDEN_DIR)) {
      if (!EXPECTED_FILES.includes(file)) fs.rmSync(path.join(GOLDEN_DIR, file));
    }
  }
});

afterAll(() => {
  if (UPDATE) {
    // Merge, so regenerating a filtered subset (-t) keeps the other entries.
    const existing = fs.existsSync(path.join(GOLDEN_DIR, 'logs.json'))
      ? (readGolden('logs.json') as Record<string, string[]>)
      : {};
    const merged: Record<string, string[]> = { ...existing, ...collectedLogs };
    const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
    writeGolden('logs.json', sorted);
  }
});

beforeEach(() => {
  _resetMockWorkspace();
  captureConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DisplaySubjectArea golden output (extension host)', () => {
  describe.each(Object.entries(SUBJECT_AREA_CASES))('%s', (name, relative) => {
    const root = path.join(FIXTURES, name);

    it('posts the logical DisplaySubjectArea from sendSubjectAreaData', async () => {
      const posted = await sendSubjectAreaData(buildHost(root), subjectAreaFile(root, relative));
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('domainLoaded');
      matchGolden(`${name}.host.json`, normalise(posted[0], root));
      matchLogs(`${name}.host`, root);
    });

    it('reads the UnifiedSubjectArea with getSubjectArea', () => {
      const { subjectAreaService } = buildHost(root);
      const unified = JSON.parse(JSON.stringify(subjectAreaService.getSubjectArea(subjectAreaFile(root, relative))));
      matchGolden(`${name}.unified.json`, normalise(unified, root));
      matchLogs(`${name}.unified`, root);
    });
  });

  describe('missing-positions with persistPositions', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-golden-'));
      fs.cpSync(path.join(FIXTURES, 'missing-positions'), tmpRoot, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('posts the domain and writes the computed positions through one WorkspaceEdit', async () => {
      const file = subjectAreaFile(tmpRoot, SUBJECT_AREA_CASES['missing-positions']);
      const posted = await sendSubjectAreaData(buildHost(tmpRoot), file, {
        persistPositions: true,
        persistDocument: true,
      });
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('domainLoaded');
      expect(_appliedEdits).toHaveLength(1);

      const applyEdit = _appliedEdits.map((edit) =>
        edit._ops.map((op: MockEditOp) => {
          if (op.kind !== 'replace') return { kind: op.kind };
          return { kind: op.kind, uri: op.uri.fsPath, range: op.range, newText: op.newText };
        }),
      );
      matchGolden(
        'missing-positions.persist.json',
        normalise({ posted: posted[0], applyEdit }, tmpRoot),
      );
      matchLogs('missing-positions.persist', tmpRoot);
    });
  });

  describe('stage switching', () => {
    it('replies to a switch to the logical stage with stageData', async () => {
      const root = path.join(FIXTURES, 'showcase');
      const posted = await switchStage(buildHost(root), subjectAreaFile(root, SUBJECT_AREA_CASES.showcase), 'logical');
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('stageData');
      matchGolden('showcase.stage-logical.json', normalise(posted[0], root));
      matchLogs('showcase.stage-logical', root);
    });

    it('replies to a switch to the physical stage with stageData (real dbt project)', async () => {
      const posted = await switchStage(
        buildHost(DBT_PROJECT, { dbt: true }),
        subjectAreaFile(DBT_PROJECT, 'silver/showcase.json'),
        'physical',
      );
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('stageData');
      matchGolden('dbt-project.stage-physical.json', normalise(posted[0], DBT_PROJECT));
      matchLogs('dbt-project.stage-physical', DBT_PROJECT);
    });

    it('posts the physical domain from sendSubjectAreaData on a panel showing physical', async () => {
      const posted = await sendSubjectAreaData(
        buildHost(DBT_PROJECT, { dbt: true }),
        subjectAreaFile(DBT_PROJECT, 'silver/showcase.json'),
        { stage: 'physical' },
      );
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('domainLoaded');
      matchGolden('dbt-project.physical.host.json', normalise(posted[0], DBT_PROJECT));
      matchLogs('dbt-project.physical.host', DBT_PROJECT);
    });
  });

  describe.each(Object.entries(ERROR_CASES))('errors/%s', (name, relative) => {
    const root = path.join(FIXTURES, 'errors');

    it('posts an error message', async () => {
      const posted = await sendSubjectAreaData(buildHost(root), subjectAreaFile(root, relative));
      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('error');
      matchGolden(`errors.${name}.host.json`, normalise(posted[0], root));
      matchLogs(`errors.${name}.host`, root);
    }, 10_000);
  });

  // #181: the same projects in the v6 file naming (`tables/`, `logical.tables`,
  // `subjectArea`, `fromTable` / `toTable`, `tableRole`) and half-way between
  // the two draw exactly what the v5 goldens pin. Only `schemaVersion` (the
  // file's own) differs; since #182 a v6 canvas is editable like a v5 one.
  // These fixtures have no goldens of their own: the v5 ones are the expectation.
  describe.each([
    ['naming-v6/showcase', 'silver/showcase.json', 'showcase', 6],
    ['naming-v6/library-relationships', 'gold/sales.json', 'library-relationships', 6],
    ['naming-mixed/library-relationships', 'gold/sales.json', 'library-relationships', 6],
    ['naming-mixed/library-relationships', 'gold/sales_v5.json', 'library-relationships', 5],
  ] as const)('%s %s draws the %s golden', (project, relative, golden, schemaVersion) => {
    const root = path.join(FIXTURES, project);

    it('posts the v5 DisplaySubjectArea', async () => {
      const posted = await sendSubjectAreaData(buildHost(root), subjectAreaFile(root, relative));
      expect(posted).toHaveLength(1);
      const expected = readGolden(`${golden}.host.json`) as { payload: Record<string, unknown> };
      expect(normalise(posted[0], root)).toEqual({
        ...expected,
        payload: { ...expected.payload, schemaVersion },
      });
    });

    it('reads the v5 UnifiedSubjectArea', () => {
      const unified = JSON.parse(JSON.stringify(buildHost(root).subjectAreaService.getSubjectArea(subjectAreaFile(root, relative))));
      expect(normalise(unified, root)).toEqual({ ...(readGolden(`${golden}.unified.json`) as object), schemaVersion });
    });
  });

  describe('a v6 subject area is written in v6 (#182)', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-v6-'));
      fs.cpSync(path.join(FIXTURES, 'naming-v6', 'showcase'), tmpRoot, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('opens with a model missing its position, and saves it into the v6 file under the v6 keys', async () => {
      const file = subjectAreaFile(tmpRoot, 'silver/showcase.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      delete doc.viewConfig.positions.dim_task;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      const posted = await sendSubjectAreaData(buildHost(tmpRoot), file, { persistPositions: true, persistDocument: true });
      expect(posted[posted.length - 1].type).toBe('domainLoaded');
      const payload = posted[posted.length - 1].payload as { readOnly: boolean; viewConfig: { positions: Record<string, unknown> } };
      expect(payload.readOnly).toBe(false);
      expect(_appliedEdits).toHaveLength(1);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Only the new position: the file keeps the v6 keys, in their order.
      expect(after.viewConfig.positions.dim_task).toEqual(payload.viewConfig.positions.dim_task);
      delete after.viewConfig.positions.dim_task;
      expect(JSON.stringify(after)).toBe(JSON.stringify(doc));
    });
  });

  it('the golden directory holds exactly the expected files', () => {
    if (UPDATE) return;
    expect(fs.readdirSync(GOLDEN_DIR).sort()).toEqual(EXPECTED_FILES);
  });
});
