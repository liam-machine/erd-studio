/**
 * ERD Studio: Move Relationships to Model Library — saves (#126, v1.6.6).
 *
 * 1.6.6 edited every file through VS Code documents and then saved the
 * handles it held. On a large project VS Code had disposed some of them
 * ("Document has been closed"), so nothing was saved and every file was left
 * open and dirty; and a document older than disk saved `false`, which was
 * ignored, half-applying the move. The move now reads and writes disk only,
 * changes nothing but the relationships, refuses to run over unsaved edits,
 * and puts every file back if one write fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createMockTextDocument,
  createMockWebviewPanel,
  _closeMockDocument,
  _failMockSave,
  _mockDocuments,
  _resetMockWorkspace,
} from '../__mocks__/vscode';
import { moveRelationshipsToLibrary, readDomainRelationships, writeFileAtomic } from '../../src/commands/moveRelationshipsToLibrary';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { SelectorsService } from '../../src/services/selectorsService';
import { TemplateService } from '../../src/services/templateService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { telemetry } from '../../src/services/telemetryService';
import type { Relationship } from '../../src/types/semantic';
import { buildDbtKeyIndex } from '@erd-studio/core';

const SEMANTIC_DIR = '.erd-studio';
const MODEL_COUNT = 70;
const DOMAIN_COUNT = 10;
const PER_DOMAIN = MODEL_COUNT / DOMAIN_COUNT;

const modelName = (i: number): string => `model_${String(i).padStart(2, '0')}`;

/** A hand-written model file: comments, a folded scalar, odd quoting, CRLF on every third. */
function messyModelYaml(i: number): string {
  const lines = [
    `# ${modelName(i)} — written by hand, keep these comments`,
    `name: ${modelName(i)}    # the model`,
    'description: >',
    '  A folded description that runs over',
    '  two lines and must survive the move.',
    "tags: [core,   'finance']",
    'columns:   # every column',
    '  - name: id',
    "    dataType: 'string'",
    '    isPrimaryKey: yes',
    '  - name: parent_id',
    '    dataType: "string"   # points at the first model of the diagram',
    '    isForeignKey: true',
    '',
    '# trailing comment',
    '',
  ];
  return lines.join(i % 3 === 0 ? '\r\n' : '\n');
}

/** A hand-formatted domain file: 4-space indent, one-line positions, odd key order. */
function messyDomainJson(name: string, models: string[], relationships: Relationship[]): string {
  const rels = relationships
    .map((r) => `            { "fromModel": "${r.fromModel}", "fromColumn": "${r.fromColumn}", "toModel": "${r.toModel}", "toColumn": "${r.toColumn}", "cardinality": "${r.cardinality}" }`)
    .join(',\n');
  const positions = models.map((m, i) => `            "${m}": { "x": ${i * 300}, "y": 0 }`).join(',\n');
  return `{
    "schemaVersion": 5,
    "layer": "silver",
    "domain": "${name}",
    "description": "Hand formatted — keep me",
    "logical": {
        "models": [${models.map((m) => `"${m}"`).join(', ')}],
        "relationships": [
${rels}
        ]
    },
    "viewConfig": {
        "positions": {
${positions}
        }
    }
}
`;
}

/** The text before and after `"relationships": [ … ]` (bracket-matched). */
function outsideRelationships(json: string): [string, string] {
  const start = json.indexOf('"relationships"');
  const open = json.indexOf('[', start);
  let depth = 0;
  let i = open;
  for (; i < json.length; i++) {
    if (json[i] === '[') depth++;
    if (json[i] === ']' && --depth === 0) break;
  }
  return [json.slice(0, start), json.slice(i + 1)];
}

/** Remove the top-level `relationships:` block from a model yml. */
function withoutRelationshipsBlock(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^relationships:/.test(line)) { skipping = true; continue; }
    if (skipping && /^(?:[ \t]|- )/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join('');
}

interface Project {
  root: string;
  domainService: DomainService;
  logicalModelService: LogicalModelService;
  domainPaths: string[];
  modelPath: (i: number) => string;
  /** Every file's bytes when the project was created. */
  originals: Map<string, string>;
  onWritten: ReturnType<typeof vi.fn>;
  run: (writeFile?: (filePath: string, text: string) => void) => Promise<void>;
}

/**
 * Ten domains of seven models each. In every domain each model's `parent_id`
 * points at the domain's first model; domain 1 also holds model_00 and
 * model_01 and draws their relationship too, so it is in two domain files.
 */
function createProject(): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-move-rels-'));
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  const originals = new Map<string, string>();

  const modelsDir = logicalModelService.getModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });
  const modelPath = (i: number) => path.join(modelsDir, `${modelName(i)}.yml`);
  for (let i = 0; i < MODEL_COUNT; i++) {
    fs.writeFileSync(modelPath(i), messyModelYaml(i));
    originals.set(modelPath(i), messyModelYaml(i));
  }

  const domainDir = path.join(root, SEMANTIC_DIR, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPaths: string[] = [];
  for (let d = 0; d < DOMAIN_COUNT; d++) {
    const models = Array.from({ length: PER_DOMAIN }, (_, j) => modelName(d * PER_DOMAIN + j));
    const relationships: Relationship[] = models.slice(1).map((m) => ({
      fromModel: m, fromColumn: 'parent_id', toModel: models[0], toColumn: 'id', cardinality: 'many-to-one',
    }));
    if (d === 1) {
      models.push(modelName(0), modelName(1));
      relationships.push({ fromModel: modelName(1), fromColumn: 'parent_id', toModel: modelName(0), toColumn: 'id', cardinality: 'many-to-one' });
    }
    const filePath = path.join(domainDir, `domain_${d}.json`);
    const text = messyDomainJson(`domain_${d}`, models, relationships);
    fs.writeFileSync(filePath, text);
    originals.set(filePath, text);
    domainPaths.push(filePath);
  }

  const onWritten = vi.fn(async () => undefined);
  return {
    root, domainService, logicalModelService, domainPaths, modelPath, originals, onWritten,
    run: (writeFile) => moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService, onWritten, writeFile,
    }),
  };
}

/** Accept the move's modal; every other information message is dismissed. */
function acceptModal() {
  return vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
    const options = args[1] as { modal?: boolean } | undefined;
    return options && typeof options === 'object' && options.modal ? args[args.length - 1] : undefined;
  }) as never);
}

const messages = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0]));
const SUCCESS = /^Moved \d+ relationships? into the model library/;

describe('moveRelationshipsToLibrary — writes disk directly (#126)', () => {
  let p: Project;
  beforeEach(() => {
    _resetMockWorkspace();
    p = createProject();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(p.root, { recursive: true, force: true });
  });

  it('moves every relationship of a large project, changing only the relationships, and leaves nothing dirty', async () => {
    // Some files are open in VS Code (unchanged), some of those then disposed —
    // what broke 1.6.6. None of it matters to a move that never edits a document.
    for (let i = 0; i < MODEL_COUNT; i += 5) {
      createMockTextDocument(p.modelPath(i), p.originals.get(p.modelPath(i))!, { persist: true });
    }
    for (let i = 0; i < MODEL_COUNT; i += 10) _closeMockDocument(p.modelPath(i));
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const feature = vi.spyOn(telemetry, 'feature');

    await p.run();

    expect(messages(error)).toEqual([]);
    expect(messages(info).filter((m) => SUCCESS.test(m))).toHaveLength(1);
    expect(messages(info).find((m) => SUCCESS.test(m))).toContain(`Moved ${DOMAIN_COUNT * (PER_DOMAIN - 1)} relationships`);
    expect(feature).toHaveBeenCalledWith('relMoveCompleted');
    expect(p.onWritten).toHaveBeenCalledWith(p.domainPaths);

    for (let i = 0; i < MODEL_COUNT; i++) {
      const before = p.originals.get(p.modelPath(i))!;
      const after = fs.readFileSync(p.modelPath(i), 'utf-8');
      if (i % PER_DOMAIN === 0) {
        expect(after).toBe(before); // a diagram's first model points at nothing
        continue;
      }
      expect(after).not.toBe(before);
      expect(withoutRelationshipsBlock(after)).toBe(before);
      if (i % 3 === 0) expect(after.replace(/\r\n/g, '')).not.toMatch(/\n/); // CRLF stays CRLF
      const first = modelName(Math.floor(i / PER_DOMAIN) * PER_DOMAIN);
      expect(p.logicalModelService.getModel(modelName(i))?.relationships).toEqual([
        { fromColumn: 'parent_id', toModel: first, toColumn: 'id', cardinality: 'many-to-one' },
      ]);
    }
    for (const domainPath of p.domainPaths) {
      const before = p.originals.get(domainPath)!;
      const after = fs.readFileSync(domainPath, 'utf-8');
      expect(outsideRelationships(after)).toEqual(outsideRelationships(before));
      expect(JSON.parse(after).logical.relationships).toEqual([]);
    }
    expect([..._mockDocuments.values()].filter((d) => d.isDirty)).toEqual([]);
    // No temp file is left behind.
    expect(fs.readdirSync(p.logicalModelService.getModelsDir()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the domain file\'s hand formatting — only the moved entries go', async () => {
    acceptModal();
    // domain_0 keeps one relationship whose from-model has no file.
    const kept = { fromModel: 'not_in_library', fromColumn: 'a', toModel: modelName(0), toColumn: 'id', cardinality: 'many-to-one' };
    const original = p.originals.get(p.domainPaths[0])!.replace(
      '"relationships": [\n',
      `"relationships": [\n            ${JSON.stringify(kept)},\n`,
    );
    fs.writeFileSync(p.domainPaths[0], original);

    await p.run();

    const after = fs.readFileSync(p.domainPaths[0], 'utf-8');
    expect(outsideRelationships(after)).toEqual(outsideRelationships(original));
    expect(after).toContain('"positions": {\n            "model_00": { "x": 0, "y": 0 },');
    expect(after.startsWith('{\n    "schemaVersion": 5,\n    "layer": "silver",')).toBe(true);
    expect(JSON.parse(after).logical.relationships).toEqual([kept]);
  });

  it('refuses to run over a target file open with unsaved edits, writing nothing', async () => {
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const telemetryError = vi.spyOn(telemetry, 'error');
    const doc = createMockTextDocument(p.modelPath(3), p.originals.get(p.modelPath(3))!, { persist: true });
    doc._setText(`${doc.getText()}# unsaved\n`);
    vscode.workspace.textDocuments.push(doc as never);

    await p.run();

    expect(messages(error)).toHaveLength(1);
    expect(messages(error)[0]).toContain('logical-models/model_03.yml');
    expect(messages(error)[0]).toContain('Save or revert these first, then run the move again');
    expect(telemetryError).toHaveBeenCalledWith('relMoveDirtyFiles');
    expect(messages(info).some((m) => SUCCESS.test(m))).toBe(false);
    for (const [filePath, text] of p.originals) expect(fs.readFileSync(filePath, 'utf-8')).toBe(text);
    expect(p.onWritten).not.toHaveBeenCalled();
    // Refused before the confirmation dialog — nobody settles conflicts only to be turned away.
    expect(info.mock.calls.some(([text]) => String(text).startsWith('Define each relationship once'))).toBe(false);
  });

  it('keeps CRLF in a model file written as one flow mapping', async () => {
    acceptModal();
    // model_04 (LF in the fixture) rewritten as `{ … }`, which the move re-emits whole.
    const flow = [
      '{',
      '  name: model_04,',
      '  columns: [{ name: id, dataType: string }, { name: parent_id, dataType: string }]',
      '}',
      '',
    ].join('\r\n');
    fs.writeFileSync(p.modelPath(4), flow);

    await p.run();

    const after = fs.readFileSync(p.modelPath(4), 'utf-8');
    expect(p.logicalModelService.getModel(modelName(4))?.relationships).toHaveLength(1);
    expect(after.endsWith('\r\n')).toBe(true);
    expect(after.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('finds a target open with unsaved edits when VS Code spells its path in another case', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      acceptModal();
      const error = vi.spyOn(vscode.window, 'showErrorMessage');
      // VS Code writes a Windows drive letter in lower case; path.resolve does not.
      const doc = createMockTextDocument(p.modelPath(3).toUpperCase(), p.originals.get(p.modelPath(3))!);
      doc._setText(`${doc.getText()}# unsaved\n`);
      vscode.workspace.textDocuments.push(doc as never);

      await p.run();

      expect(messages(error)).toHaveLength(1);
      expect(messages(error)[0]).toContain('logical-models/model_03.yml');
      for (const [filePath, text] of p.originals) expect(fs.readFileSync(filePath, 'utf-8')).toBe(text);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('puts every file back when a write fails mid-move', async () => {
    const info = acceptModal();
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const telemetryError = vi.spyOn(telemetry, 'error');
    const failing = p.domainPaths[4];
    let writes = 0;
    const writeFile = (filePath: string, text: string) => {
      if (filePath === failing && text !== p.originals.get(failing)) throw new Error('EACCES: permission denied');
      writes++;
      writeFileAtomic(filePath, text);
    };

    await p.run(writeFile);

    expect(writes).toBeGreaterThan(10); // the failure came after many files were written…
    for (const [filePath, text] of p.originals) expect(fs.readFileSync(filePath, 'utf-8')).toBe(text); // …and all were put back
    expect(messages(error)).toHaveLength(1);
    expect(messages(error)[0]).toContain('could not write silver/domain_4.json');
    expect(messages(error)[0]).toContain('Every file was put back as it was');
    expect(telemetryError).toHaveBeenCalledWith('relMoveWriteFailed');
    expect(messages(info).some((m) => SUCCESS.test(m))).toBe(false);
    expect(p.onWritten).not.toHaveBeenCalled();
  });

  it('shows and counts an error when the command throws — never swallowed', async () => {
    vi.spyOn(p.domainService, 'listDomains').mockImplementation(() => { throw new Error('disk on fire'); });
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    const telemetryError = vi.spyOn(telemetry, 'error');

    await expect(p.run()).resolves.toBeUndefined();

    expect(messages(error)).toEqual(['Move Relationships to Model Library failed: disk on fire']);
    expect(telemetryError).toHaveBeenCalledWith('relMoveFailed');
  });

  it('writes nothing when the modal is dismissed, and says the move bypasses undo', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const feature = vi.spyOn(telemetry, 'feature');

    await p.run();

    const modal = info.mock.calls.find((c) => (c[1] as { modal?: boolean } | undefined)?.modal);
    expect((modal?.[1] as { detail: string }).detail).toContain('saves the files directly — use git (or your source control) to undo it');
    expect(feature).toHaveBeenCalledWith('relMoveCancelled');
    for (const [filePath, text] of p.originals) expect(fs.readFileSync(filePath, 'utf-8')).toBe(text);
  });
});

describe('canvas edits save the documents they edited (#126 hardening)', () => {
  let root: string;
  let logicalModelService: LogicalModelService;

  async function openCanvas() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-canvas-save-'));
    const layerService = new LayerService(root, SEMANTIC_DIR);
    const domainService = new DomainService(layerService);
    logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
    domainService.setLogicalModelService(logicalModelService);
    const selectorsService = new SelectorsService(domainService, root, SEMANTIC_DIR);
    vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
    logicalModelService.saveModel({ name: 'fct_order', columns: [{ name: 'customer_key', dataType: 'string', description: '' }] });
    logicalModelService.saveModel({ name: 'dim_customer', columns: [{ name: 'customer_key', dataType: 'string', description: '', isPrimaryKey: true }] });
    const domainPath = path.join(root, SEMANTIC_DIR, 'silver', 'orders.json');
    fs.mkdirSync(path.dirname(domainPath), { recursive: true });
    fs.writeFileSync(domainPath, JSON.stringify({
      schemaVersion: 5, domain: 'orders', layer: 'silver', description: '',
      logical: { models: ['fct_order', 'dim_customer'], relationships: [] },
      viewConfig: { positions: { fct_order: { x: 0, y: 0 }, dim_customer: { x: 300, y: 0 } } },
    }, null, 2) + '\n');

    const context = {
      extensionUri: vscode.Uri.file(root),
      globalState: { get: () => undefined, update: async () => undefined },
      secrets: vscode.createMockSecretStorage(),
    } as unknown as vscode.ExtensionContext;
    const provider = new SemanticEditorProvider(
      context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
      layerService, root, selectorsService, logicalModelService, new OwnWriteTracker(),
    );
    const document = createMockTextDocument(domainPath, fs.readFileSync(domainPath, 'utf-8'), { persist: true });
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      panel as unknown as vscode.WebviewPanel,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
    );
    return {
      addRelationship: async () => {
        panel._postedMessages.length = 0;
        await panel._simulateMessage({
          type: 'addRelationship',
          payload: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
        });
      },
      errors: () => panel._postedMessages
        .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
        .map((m) => m.payload.message),
    };
  }

  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('saves a model file whose document VS Code disposed between opening it and the edit', async () => {
    const canvas = await openCanvas();
    const modelPath = logicalModelService.modelPath('fct_order');
    const applyEdit = vscode.workspace.applyEdit;
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      _closeMockDocument(modelPath); // the handle the provider holds is now dead
      return applyEdit(edit);
    });

    await canvas.addRelationship();

    expect(canvas.errors()).toEqual([]);
    expect(fs.readFileSync(modelPath, 'utf-8')).toMatch(/^relationships:/m);
    expect([..._mockDocuments.values()].filter((d) => d.isDirty)).toEqual([]);
  });

  it('reports a save that VS Code refused instead of leaving the file silently unsaved', async () => {
    const canvas = await openCanvas();
    const modelPath = logicalModelService.modelPath('fct_order');
    _failMockSave(modelPath);
    const telemetryError = vi.spyOn(telemetry, 'error');

    await canvas.addRelationship();

    expect(canvas.errors()).toHaveLength(1);
    expect(canvas.errors()[0]).toContain('Could not save .erd-studio/logical-models/fct_order.yml');
    expect(telemetryError).toHaveBeenCalledWith('saveFailed');
    expect(fs.readFileSync(modelPath, 'utf-8')).not.toMatch(/^relationships:/m);
  });
});

describe('readDomainRelationships', () => {
  it('reads an unrecognised cardinality the way the diagram draws it (many-to-one), so the move never stores the typo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-read-rels-'));
    try {
      const filePath = path.join(dir, 'orders.json');
      fs.writeFileSync(filePath, JSON.stringify({
        schemaVersion: 5, domain: 'orders', layer: 'gold', description: '',
        logical: { models: ['fct_order', 'dim_customer'], relationships: [
          { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-onee' },
        ] },
        viewConfig: {},
      }));
      const domains = readDomainRelationships(
        { listDomains: () => [{ domain: 'orders', layer: 'gold', filePath }] },
        dir,
        '.erd-studio',
      );
      expect(domains[0].relationships[0].cardinality).toBe('many-to-one');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('moveRelationshipsToLibrary — turns reversed library entries round (#133)', () => {
  const DIM = [
    '# hand-written dimension',
    'name: dim_customer',
    'columns:',
    '  - name: customer_key',
    '    dataType: string',
    '    isPrimaryKey: true',
    'relationships:',
    '  - fromColumn: customer_key',
    '    toModel: fct_order',
    '    toColumn: customer_key',
    '    cardinality: one-to-many',
    '    role: buyer',
    '',
  ].join('\n');
  const FCT = [
    'name: fct_order   # the fact',
    'columns:',
    '  - name: customer_key',
    '    dataType: string',
    '',
  ].join('\n');

  let root: string;
  let logicalModelService: LogicalModelService;
  let run: () => Promise<void>;

  beforeEach(() => {
    _resetMockWorkspace();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rehome-'));
    const layerService = new LayerService(root, SEMANTIC_DIR);
    const domainService = new DomainService(layerService);
    logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
    domainService.setLogicalModelService(logicalModelService);
    fs.mkdirSync(logicalModelService.getModelsDir(), { recursive: true });
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), DIM);
    fs.writeFileSync(logicalModelService.modelPath('fct_order'), FCT);
    run = () => moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService, logicalModelService, onWritten: vi.fn(async () => undefined),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('moves a one-to-many out of the dimension into the fact as many-to-one, keeping its role and both files\' other bytes', async () => {
    const info = acceptModal();
    await run();

    expect(messages(info).find((m) => m.startsWith('Store each relationship with the model that holds the foreign key?'))).toBeDefined();
    expect(messages(info)).toContain('1 relationship is now stored with the model holding the foreign key.');
    expect(fs.readFileSync(logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(DIM.slice(0, DIM.indexOf('relationships:')));
    const fct = fs.readFileSync(logicalModelService.modelPath('fct_order'), 'utf-8');
    expect(withoutRelationshipsBlock(fct)).toBe(FCT);
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    ]);
  });

  it('leaves a file whose relationships list holds a YAML anchor, which rewriting it would drop (#157)', async () => {
    const anchored = DIM.replace('role: buyer', 'role: &who buyer') + 'description: *who\n';
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), anchored);
    const info = acceptModal();
    await run();
    expect(fs.readFileSync(logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(anchored);
    expect(fs.readFileSync(logicalModelService.modelPath('fct_order'), 'utf-8')).toBe(FCT);
    expect(JSON.stringify(info.mock.calls)).toMatch(/dim_customer\.yml has comments, YAML anchors or entries/);
  });

  it('has nothing left to do on a second run', async () => {
    const info = acceptModal();
    await run();
    info.mockClear();
    await run();
    expect(messages(info)[0]).toMatch(/nothing to move/);
  });

  it('turns round a many-to-one 1.6.7 saved backwards on the dimension, then has nothing left to do', async () => {
    // The dim_product shape in core's library-relationships fixture: the stray FK flag stays.
    const backwards = DIM.replace('    isPrimaryKey: true\n', '    isPrimaryKey: true\n    isForeignKey: true\n').replace('one-to-many', 'many-to-one');
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), backwards);
    // The fact declares its own key, so customer_key there is certainly not it.
    fs.writeFileSync(logicalModelService.modelPath('fct_order'), FCT + '  - name: order_key\n    dataType: string\n    isPrimaryKey: true\n');
    const info = acceptModal();
    await run();
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    ]);
    expect(fs.readFileSync(logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(backwards.slice(0, backwards.indexOf('relationships:')));
    info.mockClear();
    await run();
    expect(messages(info)[0]).toMatch(/nothing to move/);
  });

  it('leaves a many-to-one from the dimension\'s key alone when the other model flags no key (M)', async () => {
    // A 1:1 extension table: customer_detail.customer_key is its whole key and points at a model with none flagged.
    const backwards = DIM.replace('one-to-many', 'many-to-one');
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), backwards);
    const info = acceptModal();
    await run();
    expect(fs.readFileSync(logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(backwards);
    expect(messages(info)[0]).toMatch(/nothing to move/);
  });

  it('Dim_Customer and dim_customer resolve to one model object: one read of the real file, one write (#133 L4)', async () => {
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), DIM.replace('toModel: fct_order', 'toModel: FCT_Order') + [
      '  - fromColumn: customer_key',
      '    toModel: fct_order',
      '    toColumn: alt_customer_key',
      '    cardinality: one-to-many',
      '',
    ].join('\n'));
    const reads = vi.spyOn(logicalModelService, 'getModel');
    const writes: string[] = [];
    acceptModal();
    await moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService: new DomainService(new LayerService(root, SEMANTIC_DIR)),
      logicalModelService, onWritten: vi.fn(async () => undefined),
      writeFile: (filePath, text) => { writes.push(path.basename(filePath)); writeFileAtomic(filePath, text); },
    });
    // Each file read by its real name, once, whichever spelling asked for it.
    expect(reads.mock.calls.map(([name]) => name).sort()).toEqual(['dim_customer', 'fct_order']);
    expect(writes.sort()).toEqual(['dim_customer.yml', 'fct_order.yml']);
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('fct_order')?.relationships?.map((r) => r.fromColumn)).toEqual(['customer_key', 'alt_customer_key']);
  });

  it('with no key flagged, dbt\'s tests turn a backwards copy round; without them it is left (#133 L1)', async () => {
    const backwards = DIM.replace('    isPrimaryKey: true\n', '').replace('one-to-many', 'many-to-one');
    fs.writeFileSync(logicalModelService.modelPath('dim_customer'), backwards);
    const info = acceptModal();
    await run();
    expect(messages(info)[0]).toMatch(/nothing to move/);
    expect(fs.readFileSync(logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(backwards);

    const loadDbtKeyIndex = vi.fn(async () => buildDbtKeyIndex([{
      uniqueColumns: new Map([['dim_customer', new Set(['customer_key'])]]),
      relationshipTests: [{ fromModel: 'fct_order', fromColumn: 'customer_key' }],
    }]));
    await moveRelationshipsToLibrary({
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService: new DomainService(new LayerService(root, SEMANTIC_DIR)),
      logicalModelService, onWritten: vi.fn(async () => undefined), loadDbtKeyIndex,
    });
    expect(loadDbtKeyIndex).toHaveBeenCalledTimes(1);
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    ]);
    expect(logicalModelService.getModel('dim_customer')?.relationships).toBeUndefined();
  });

  it('turns a backwards self-reference round inside its one file, written once (#133 L3)', async () => {
    const EMPLOYEE = [
      '# staff, with managers',
      'name: employee',
      'columns:',
      '  - name: employee_id',
      '    dataType: int',
      '    isPrimaryKey: true',
      '  - name: manager_id',
      '    dataType: int',
      'relationships:',
      '  - fromColumn: employee_id',
      '    toModel: employee',
      '    toColumn: manager_id',
      '    cardinality: one-to-many',
      '    role: manager',
      '',
    ].join('\n');
    fs.rmSync(logicalModelService.modelPath('dim_customer'));
    fs.writeFileSync(logicalModelService.modelPath('employee'), EMPLOYEE);
    const writes: string[] = [];
    const info = acceptModal();
    const deps = {
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService: new DomainService(new LayerService(root, SEMANTIC_DIR)),
      logicalModelService, onWritten: vi.fn(async () => undefined),
      writeFile: (filePath: string, text: string) => { writes.push(path.basename(filePath)); writeFileAtomic(filePath, text); },
    };
    await moveRelationshipsToLibrary(deps);
    expect(writes).toEqual(['employee.yml']);
    expect(fs.readFileSync(logicalModelService.modelPath('employee'), 'utf-8')).toBe(EMPLOYEE.replace(
      '  - fromColumn: employee_id\n    toModel: employee\n    toColumn: manager_id\n    cardinality: one-to-many\n    role: manager\n',
      '  - fromColumn: manager_id\n    toModel: employee\n    toColumn: employee_id\n    cardinality: many-to-one\n    role: manager\n',
    ));
    info.mockClear();
    await moveRelationshipsToLibrary(deps);
    expect(messages(info)[0]).toMatch(/nothing to move/);
  });

  it('drops the reversed copy when the fact already stores the link', async () => {
    fs.writeFileSync(logicalModelService.modelPath('fct_order'), FCT + [
      'relationships:',
      '  - fromColumn: customer_key',
      '    toModel: dim_customer',
      '    toColumn: customer_key',
      '    cardinality: many-to-one',
      '',
    ].join('\n'));
    acceptModal();
    await run();
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('dim_customer')?.relationships).toBeUndefined();
    expect(logicalModelService.getModel('fct_order')?.relationships).toHaveLength(1);
  });
});

describe('moveRelationshipsToLibrary — composite keys move as one (#133 L2)', () => {
  const PIT = { name: 'pit_customer', columns: [
    { name: 'pit_id', dataType: 'int', description: '', isPrimaryKey: true },
    { name: 'customer_hk', dataType: 'int', description: '' },
    { name: 'as_of_date', dataType: 'date', description: '' },
  ] };
  const SAT = { name: 'sat_customer', columns: [
    { name: 'customer_hk', dataType: 'int', description: '', isPrimaryKey: true },
    { name: 'load_date', dataType: 'date', description: '', isPrimaryKey: true },
  ] };
  const pair = (fromColumn: string, toColumn: string, extra: Partial<Relationship> = {}): Relationship =>
    ({ fromModel: 'pit_customer', fromColumn, toModel: 'sat_customer', toColumn, cardinality: 'many-to-one', ...extra });
  const GROUP = [pair('customer_hk', 'customer_hk', { compositeKey: 'fk_sat' }), pair('as_of_date', 'load_date', { compositeKey: 'fk_sat' })];

  let root: string;
  let logicalModelService: LogicalModelService;
  let deps: Parameters<typeof moveRelationshipsToLibrary>[0];
  const writeDomain = (name: string, relationships: unknown[]) => {
    const dir = path.join(root, SEMANTIC_DIR, 'silver');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
      schemaVersion: 5, domain: name, layer: 'silver', description: '', logical: { models: ['pit_customer', 'sat_customer'], relationships }, viewConfig: {},
    }, null, 2) + '\n');
  };
  const domainRels = (name: string) => JSON.parse(fs.readFileSync(path.join(root, SEMANTIC_DIR, 'silver', `${name}.json`), 'utf-8')).logical.relationships;
  const pitRels = () => { logicalModelService.invalidateCache(); return logicalModelService.getModel('pit_customer')?.relationships; };

  beforeEach(() => {
    _resetMockWorkspace();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-move-group-'));
    logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
    logicalModelService.saveModel(PIT);
    logicalModelService.saveModel(SAT);
    deps = {
      workspaceRoot: root, semanticDir: SEMANTIC_DIR, domainService: new DomainService(new LayerService(root, SEMANTIC_DIR)),
      logicalModelService, onWritten: vi.fn(async () => undefined),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const stored = (r: Relationship) => { const { fromModel: _f, ...e } = r; return e; };

  it('a group moves as one unit; grouped in one diagram and singles in another become the group; a second run is empty', async () => {
    writeDomain('d1', GROUP.map((r) => ({ ...r, role: 'as of' })));
    writeDomain('d2', GROUP.map(({ compositeKey: _k, ...r }) => r));
    const info = acceptModal();
    await moveRelationshipsToLibrary(deps);
    expect(pitRels()).toEqual(GROUP.map((r) => ({ ...stored(r), role: 'as of' })));
    expect([domainRels('d1'), domainRels('d2')]).toEqual([[], []]);
    const preview = messages(info).find((m) => m.startsWith('Define each relationship once')) ?? '';
    expect(info.mock.calls.map((c) => String((c[1] as { detail?: string } | undefined)?.detail ?? '')).join('\n')).toContain('silver/d2: pit_customer.customer_hk → sat_customer.customer_hk — part of fk_sat');
    expect(preview).not.toBe('');
    info.mockClear();
    await moveRelationshipsToLibrary(deps);
    expect(messages(info)[0]).toMatch(/nothing to move/);
  });

  it('two diagrams defining the group differently are one conflict; the pick moves every member', async () => {
    writeDomain('d1', GROUP);
    writeDomain('d2', GROUP.map((r) => ({ ...r, cardinality: 'one-to-one' })));
    acceptModal();
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string; definition?: { relationship: Relationship } }>) =>
      items.find((it) => it.definition?.relationship.cardinality === 'one-to-one')) as never);
    await moveRelationshipsToLibrary(deps);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringContaining('composite key pit_customer.(customer_hk, as_of_date) → sat_customer.(customer_hk, load_date)') })]));
    expect(pitRels()).toEqual(GROUP.map((r) => ({ ...stored(r), cardinality: 'one-to-one' })));
    expect([domainRels('d1'), domainRels('d2')]).toEqual([[], []]);
  });

  it('a group whose pair the library holds in another composite stays whole in the diagrams, and says why', async () => {
    logicalModelService.saveModel({ ...PIT, relationships: [stored({ ...GROUP[1], compositeKey: 'other' }), stored({ ...pair('pit_id', 'customer_hk'), compositeKey: 'other' })] });
    writeDomain('d1', GROUP);
    const info = acceptModal();
    await moveRelationshipsToLibrary(deps);
    expect(domainRels('d1')).toEqual(GROUP);
    expect(info.mock.calls.map((c) => String((c[1] as { detail?: string } | undefined)?.detail ?? '')).join('\n'))
      .toContain('Composite key pit_customer.(customer_hk, as_of_date) → sat_customer.(customer_hk, load_date) left in the diagrams (silver/d1): the model library holds one of its column pairs in another composite key.');
  });

  it('planRehome turns a backwards group round together, in one write per file', async () => {
    // Stored on the satellite's side, the one side by its whole composite key.
    logicalModelService.saveModel({ ...SAT, relationships: GROUP.map((r) => ({ fromColumn: r.toColumn, toModel: 'pit_customer', toColumn: r.fromColumn, cardinality: 'one-to-many' as const, compositeKey: 'fk_sat' })) });
    acceptModal();
    await moveRelationshipsToLibrary(deps);
    expect(pitRels()).toEqual(GROUP.map(stored));
    logicalModelService.invalidateCache();
    expect(logicalModelService.getModel('sat_customer')?.relationships).toBeUndefined();
  });
});
