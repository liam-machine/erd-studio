/**
 * Shared harness for the relationship journey tests (issue #133): a real
 * project on disk (dbt_project.yml, layers.json, model files, diagram files),
 * the real services and `SemanticEditorProvider` over the vscode mock, the
 * `erd-studio` CLI run in-process through `main()`, and the Repair
 * Relationships… runner with its preview accepted. Every journey asserts what
 * lands on disk, what each diagram draws, what `check` reports and what Repair
 * does — the four things a user (or their AI assistant) actually sees.
 *
 * Not a test file itself (no `.test.ts`), so vitest only loads it through the
 * journeys that import it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';
import { vi } from 'vitest';
import * as vscode from 'vscode';
import { stripRelationshipProvenance, type RelationshipFinding } from '@erd-studio/core';

import {
  createMockWebviewPanel,
  createMockTextDocument,
  _appliedEdits,
  type MockTextDocument,
  type WorkspaceEdit as MockWorkspaceEdit,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { repairRelationships } from '../../src/commands/repairRelationships';
import { main } from '../../src/cli/index';
import type { CheckResult } from '../../src/cli/check';
import type { DisplayDomain, DisplayRelationship } from '../../src/types/display';
import type { Relationship } from '../../src/types/semantic';

export const SEMANTIC_DIR = '.erd-studio';

const schema = (file: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas', file), 'utf-8'));
const ajv = new Ajv({ allErrors: true, strictTypes: false });
ajv.addKeyword('enumDescriptions');
const validators = {
  model: ajv.compile(schema('logical-model.schema.json')),
  domain: ajv.compile(schema('domain.schema.json')),
};

const LAYERS = JSON.stringify({
  schemaVersion: 1,
  layers: [
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 0 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 },
  ],
}, null, 2);

/** A model file's text: its columns (`name` + flags) and, optionally, raw `relationships:` YAML. */
export function modelYaml(
  name: string,
  columns: Array<string | { name: string; pk?: boolean; nk?: boolean; fk?: boolean; type?: string }>,
  relationships?: string,
): string {
  const lines = [`name: ${name}`, 'columns:'];
  for (const c of columns) {
    const col = typeof c === 'string' ? { name: c } : c;
    lines.push(`  - name: ${col.name}`, `    dataType: ${col.type ?? 'string'}`);
    if (col.pk) lines.push('    isPrimaryKey: true');
    if (col.nk) lines.push('    isNaturalKey: true');
    if (col.fk) lines.push('    isForeignKey: true');
  }
  return `${lines.join('\n')}\n${relationships ? `relationships:\n${relationships}` : ''}`;
}

/** One `relationships:` entry of a model file, as YAML. */
export function entryYaml(fromColumn: string, toModel: string, toColumn: string, cardinality: string, role?: string): string {
  return `  - fromColumn: ${fromColumn}\n    toModel: ${toModel}\n    toColumn: ${toColumn}\n    cardinality: ${cardinality}\n${role ? `    role: ${role}\n` : ''}`;
}

export interface DomainSpec {
  models: string[];
  relationships?: unknown[];
}

export interface ProjectSpec {
  /** Model files by path under `logical-models/` without `.yml` (e.g. `dim_customer`, `gold/fct_order`) → text. */
  models: Record<string, string>;
  /** Diagram files by `{layer}/{name}` → content. */
  domains?: Record<string, DomainSpec>;
  /** Extra files by project-relative path (a dbt project's schema yml, …). */
  files?: Record<string, string>;
}

/** A relationship as drawn, without provenance (what the user sees on the canvas). */
export type Drawn = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn' | 'cardinality' | 'role'>;

export function plainDrawn(rel: Relationship | DisplayRelationship): Drawn {
  const { fromModel, fromColumn, toModel, toColumn, cardinality, role } = stripRelationshipProvenance(rel as Relationship) as Relationship;
  return { fromModel, fromColumn, toModel, toColumn, cardinality, ...(role ? { role } : {}) };
}

/** Order-independent comparison helper: drawn relationships sorted by their ends. */
export function sortDrawn(list: Drawn[]): Drawn[] {
  const key = (r: Drawn) => [r.fromModel, r.fromColumn, r.toModel, r.toColumn].join('\u0000').toLowerCase();
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export interface Panel {
  /** Send a message from the webview, as the canvas would; waits for the host to finish. */
  send: (message: unknown) => Promise<void>;
  /** Error toasts posted since the last `send`. */
  errors: () => string[];
  /** Every message posted to this panel. */
  posted: () => Array<{ type: string; payload?: unknown }>;
  /** The latest `domainLoaded` payload (what the canvas currently shows). */
  loaded: () => DisplayDomain;
  /** The relationships the canvas currently draws. */
  drawn: () => Drawn[];
  /** WorkspaceEdits applied by the last `send`. */
  edits: () => number;
  document: MockTextDocument;
}

export interface CheckRun {
  code: number;
  result: CheckResult;
  findings: Array<Pick<RelationshipFinding, 'code' | 'severity' | 'files'>>;
  codes: string[];
}

export interface RepairRun {
  /** The modal preview's title, or undefined when no preview was shown. */
  title?: string;
  /** The preview's detail text. */
  detail?: string;
  /** Every non-modal information / warning message shown. */
  messages: string[];
  errors: string[];
}

export interface Journey {
  root: string;
  semantic: (rel: string) => string;
  provider: SemanticEditorProvider;
  domainService: DomainService;
  models: LogicalModelService;
  modelPath: (name: string) => string;
  modelText: (name: string) => string;
  writeModel: (name: string, text: string) => void;
  domainJson: (rel: string) => { logical: { models: string[]; relationships: unknown[] } };
  writeDomain: (rel: string, spec: DomainSpec) => void;
  /** What a diagram draws, read fresh from disk through the same reader the canvas uses. */
  drawnOnDisk: (rel: string) => Drawn[];
  open: (rel: string) => Promise<Panel>;
  check: (strict?: boolean) => Promise<CheckRun>;
  repair: () => Promise<RepairRun>;
  /** Every file under the ERD folder, by project-relative path. */
  files: () => Record<string, string>;
  /**
   * What VS Code's YAML / JSON validation would flag in the model and diagram
   * files, against the schemas the extension contributes — one line per
   * problem, empty when every file validates.
   */
  schemaProblems: () => string[];
  dispose: () => void;
}

/** Build a project on disk and the host around it. */
export function createJourney(spec: ProjectSpec): Journey {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-journey-'));
  const semantic = (rel: string) => path.join(root, SEMANTIC_DIR, rel);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(root, 'dbt_project.yml'), "name: 'journey'\nversion: '1.0.0'\nconfig-version: 2\nprofile: 'journey'\n");
  write(semantic('layers.json'), LAYERS);
  fs.mkdirSync(semantic('logical-models'), { recursive: true });
  for (const [name, text] of Object.entries(spec.models)) write(semantic(`logical-models/${name}.yml`), text);
  const writeDomain = (rel: string, d: DomainSpec) => {
    const [layer, domain] = rel.split('/');
    write(semantic(`${rel}.json`), JSON.stringify({
      schemaVersion: 5, domain, layer, description: '',
      logical: { models: d.models, relationships: d.relationships ?? [] },
      viewConfig: { positions: Object.fromEntries(d.models.map((m, i) => [m, { x: i * 300, y: 0 }])) },
    }, null, 2) + '\n');
  };
  for (const [rel, d] of Object.entries(spec.domains ?? {})) writeDomain(rel, d);
  for (const [rel, text] of Object.entries(spec.files ?? {})) write(path.join(root, rel), text);

  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const models = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(models);
  const selectorsService = new SelectorsService(domainService, root, SEMANTIC_DIR);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const workspaceState = new Map<string, unknown>();
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, models, new OwnWriteTracker(),
  );

  const modelPath = (name: string): string => {
    models.invalidateCache();
    return models.findModelFile(name) ?? models.modelPath(name);
  };

  const journey: Journey = {
    root,
    semantic,
    provider,
    domainService,
    models,
    modelPath,
    modelText: (name) => fs.readFileSync(modelPath(name), 'utf-8'),
    writeModel: (name, text) => { write(semantic(`logical-models/${name}.yml`), text); models.invalidateCache(); },
    domainJson: (rel) => JSON.parse(fs.readFileSync(semantic(`${rel}.json`), 'utf-8')),
    writeDomain,
    drawnOnDisk: (rel) => {
      models.invalidateCache();
      return domainService.getDomain(semantic(`${rel}.json`)).logical.relationships.map(plainDrawn);
    },
    open: async (rel) => {
      const file = semantic(`${rel}.json`);
      const document = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
      const panel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
      );
      let since = 0;
      let editsBefore = 0;
      let editsAfter = 0;
      const posted = () => panel._postedMessages as Array<{ type: string; payload?: unknown }>;
      const loaded = (): DisplayDomain => {
        const all = posted().filter((m) => m.type === 'domainLoaded');
        if (all.length === 0) throw new Error(`${rel}: no domainLoaded posted yet`);
        return all[all.length - 1].payload as DisplayDomain;
      };
      return {
        document,
        send: async (message) => {
          since = posted().length;
          editsBefore = _appliedEdits.length;
          await panel._simulateMessage(message);
          // Let notifications the handler started without awaiting settle.
          await new Promise((r) => setTimeout(r, 5));
          editsAfter = _appliedEdits.length;
        },
        errors: () => posted().slice(since)
          .filter((m) => m.type === 'error')
          .map((m) => (m.payload as { message: string }).message),
        posted,
        loaded,
        drawn: () => loaded().relationships.map(plainDrawn),
        edits: () => editsAfter - editsBefore,
      };
    },
    check: async (strict = false) => {
      let out = '';
      const code = await main(['check', '--json', ...(strict ? ['--strict'] : []), '--project', root], {
        stdout: { write: (s: string) => { out += s; } },
        stderr: { write: () => undefined },
        cwd: root,
        env: {},
      });
      const result = JSON.parse(out) as CheckResult;
      const findings = result.findings.map((f) => ({ code: f.code, severity: f.severity, files: f.files }));
      return { code, result, findings, codes: findings.map((f) => f.code) };
    },
    repair: async () => {
      const run: RepairRun = { messages: [], errors: [] };
      const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
        const options = args[1] as { modal?: boolean; detail?: string } | undefined;
        if (options && typeof options === 'object' && options.modal) {
          run.title = String(args[0]);
          run.detail = options.detail;
          return args[args.length - 1];
        }
        run.messages.push(String(args[0]));
        return undefined;
      }) as never);
      const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((async (...args: unknown[]) => {
        const options = args[1] as { modal?: boolean; detail?: string } | undefined;
        if (options && typeof options === 'object' && options.modal) {
          run.title = String(args[0]);
          run.detail = options.detail;
          return args[args.length - 1];
        }
        run.messages.push(String(args[0]));
        return undefined;
      }) as never);
      const error = vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async (message: string) => {
        run.errors.push(String(message));
        return undefined;
      }) as never);
      try {
        await repairRelationships({
          workspaceRoot: root,
          semanticDir: SEMANTIC_DIR,
          domainService,
          logicalModelService: models,
          layerService,
          // As activate() wires it: an undo may not cross the write, and every
          // open diagram is refreshed from disk.
          onWritten: async () => {
            provider.markFilesRewrittenOnDisk();
            await provider.refreshAllOpenDomains();
          },
        });
      } finally {
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
      return run;
    },
    files: () => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
        }
      };
      walk(path.join(root, SEMANTIC_DIR));
      return out;
    },
    schemaProblems: () => {
      const problems: string[] = [];
      for (const [rel, text] of Object.entries(journey.files())) {
        const validate = rel.includes('/logical-models/') && rel.endsWith('.yml') ? validators.model
          : /^\.erd-studio\/[^/]+\/[^/]+\.json$/.test(rel) ? validators.domain
            : undefined;
        if (!validate) continue;
        const data = rel.endsWith('.yml') ? parseYaml(text) : JSON.parse(text);
        if (!validate(data)) problems.push(...(validate.errors ?? []).map((e) => `${rel}${e.instancePath} ${e.message}`));
      }
      return problems;
    },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return journey;
}

/**
 * Simulate VS Code's custom-editor undo stack: every applied edit that
 * includes the domain document is one element, holding the texts before and
 * after for every file it replaced; `undo` / `redo` put one side back into
 * the open documents (the provider then saves what it wrote and refreshes).
 */
export function simulateUndoStack(domainFile: string): { dispose: () => void; depth: () => number } {
  const done: Array<{ before: Map<string, string>; after: Map<string, string> }> = [];
  const undone: typeof done = [];
  const apply = vscode.workspace.applyEdit.bind(vscode.workspace);
  const spy = vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
    const files = new Set<string>();
    for (const op of (edit as unknown as MockWorkspaceEdit)._ops) {
      if (op.kind === 'replace') files.add(op.uri.fsPath);
    }
    const before = new Map<string, string>();
    for (const file of files) before.set(file, (await vscode.workspace.openTextDocument(file)).getText());
    const ok = await apply(edit);
    if (ok && files.has(domainFile)) {
      const after = new Map<string, string>();
      for (const file of files) after.set(file, (await vscode.workspace.openTextDocument(file)).getText());
      done.push({ before, after });
      undone.length = 0;
    }
    return ok;
  });
  const restore = async (texts: Map<string, string>) => {
    for (const [file, text] of texts) {
      (await vscode.workspace.openTextDocument(file) as unknown as MockTextDocument)._setText(text);
    }
  };
  const undo = vscode.commands.registerCommand('undo', async () => {
    const step = done.pop();
    if (!step) return;
    await restore(step.before);
    undone.push(step);
  });
  const redo = vscode.commands.registerCommand('redo', async () => {
    const step = undone.pop();
    if (!step) return;
    await restore(step.after);
    done.push(step);
  });
  return {
    dispose: () => { undo.dispose(); redo.dispose(); spy.mockRestore(); },
    depth: () => done.length,
  };
}
