/**
 * Real files for relationshipStateSpace: write a model World to a temp
 * project, send one canvas message to the real SemanticEditorProvider or run
 * the real Move command, and read the World back.
 */

import { vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { moveRelationshipsToLibrary } from '../../src/commands/moveRelationshipsToLibrary';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { SelectorsService } from '../../src/services/selectorsService';
import { TemplateService } from '../../src/services/templateService';
import { YmlParserService } from '../../src/services/ymlParserService';
import type { ConflictDefinition } from '../../src/services/libraryRelationships';
import type { Relationship } from '../../src/types/semantic';
import { columnsOf } from './relationshipStateSpace.model';
import type { DomainName, ModelName, MovePick, World } from './relationshipStateSpace.model';

export const SEMANTIC_DIR = '.erd-studio';

export interface Project { root: string; logicalModelService: LogicalModelService; domainService: DomainService; domainPath: (d: DomainName) => string }

export function materialise(w: World): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-statespace-'));
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, SEMANTIC_DIR);
  domainService.setLogicalModelService(logicalModelService);
  for (const name of ['dim', 'fct'] as const) {
    logicalModelService.saveModel({
      name, columns: columnsOf(w.profile, name), ...(w.lib[name].length > 0 ? { relationships: w.lib[name] } : {}),
    });
  }
  const domainDir = path.join(root, SEMANTIC_DIR, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPath = (d: DomainName) => path.join(domainDir, `${d}.json`);
  for (const d of ['D1', 'D2', 'D3'] as const) {
    fs.writeFileSync(domainPath(d), JSON.stringify({
      schemaVersion: 5, domain: d, layer: 'silver', description: '',
      logical: { models: w.domModels[d], relationships: w.dom[d] },
      viewConfig: { positions: Object.fromEntries(w.domModels[d].map((m, i) => [m, { x: i * 300, y: 0 }])) },
    }, null, 2) + '\n');
  }
  return { root, logicalModelService, domainService, domainPath };
}

export function readBack(p: Project, profile: World['profile']): World {
  p.logicalModelService.invalidateCache();
  const lib = {} as World['lib'];
  for (const name of ['dim', 'fct'] as const) lib[name] = (p.logicalModelService.getModel(name)?.relationships ?? []).map((r) => ({ ...r }));
  const dom = {} as World['dom'];
  const domModels = {} as World['domModels'];
  for (const d of ['D1', 'D2', 'D3'] as const) {
    const raw = JSON.parse(fs.readFileSync(p.domainPath(d), 'utf-8')) as { logical: { models: ModelName[]; relationships?: Relationship[] } };
    dom[d] = raw.logical.relationships ?? [];
    domModels[d] = raw.logical.models;
  }
  return { profile, lib, dom, domModels };
}

/** Field order does not matter on disk; entry order does. */
export const norm = (w: World): string => JSON.stringify({
  lib: Object.fromEntries((['dim', 'fct'] as const).map((m) => [m, w.lib[m].map((e) => Object.fromEntries(Object.entries(e).sort()))])),
  dom: Object.fromEntries((['D1', 'D2'] as const).map((d) => [d, w.dom[d].map((e) => Object.fromEntries(Object.entries(e).sort()))])),
});

/** Send one canvas message from `domain`; returns the error toasts and the information messages shown. */
export async function sendToProvider(p: Project, message: unknown, domain: DomainName = 'D1'): Promise<{ errors: string[]; infos: string[] }> {
  const selectorsService = new SelectorsService(p.domainService, p.root, SEMANTIC_DIR);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const infos: string[] = [];
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (text: string) => { infos.push(text); return undefined; }) as never);
  const context = {
    extensionUri: vscode.Uri.file(p.root),
    globalState: { get: () => undefined, update: async () => undefined },
    workspaceState: { get: () => true, update: async () => undefined },
    secrets: (vscode as unknown as { createMockSecretStorage: () => unknown }).createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, p.domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    new LayerService(p.root, SEMANTIC_DIR), p.root, selectorsService, p.logicalModelService, new OwnWriteTracker(),
  );
  const document = createMockTextDocument(p.domainPath(domain), fs.readFileSync(p.domainPath(domain), 'utf-8'), { persist: true });
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
  );
  panel._postedMessages.length = 0;
  infos.length = 0;
  await panel._simulateMessage(message);
  const errors = panel._postedMessages
    .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
    .map((m) => m.payload.message);
  return { errors, infos };
}

const sameDefinition = (a: Relationship, b: Relationship): boolean =>
  JSON.stringify([a.fromModel, a.fromColumn, a.toModel, a.toColumn, a.cardinality, a.role ?? null])
  === JSON.stringify([b.fromModel, b.fromColumn, b.toModel, b.toColumn, b.cardinality, b.role ?? null]);

/** Run the real Move command, picking `picks[i]` (by content) for conflict i; undefined leaves it. */
export async function runRealMove(p: Project, picks: MovePick[]): Promise<void> {
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) => {
    const options = args[1] as { modal?: boolean } | undefined;
    return options && typeof options === 'object' && options.modal ? args[args.length - 1] : undefined;
  }) as never);
  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
  let i = 0;
  vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ definition?: ConflictDefinition }>) => {
    const pick = picks[i++];
    return items.find((it) => (pick ? !!it.definition && sameDefinition(it.definition.relationship, pick.relationship) : !it.definition));
  }) as never);
  await moveRelationshipsToLibrary({
    workspaceRoot: p.root, semanticDir: SEMANTIC_DIR, domainService: p.domainService,
    logicalModelService: p.logicalModelService, onWritten: async () => undefined,
  });
}
