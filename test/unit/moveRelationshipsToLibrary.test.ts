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
