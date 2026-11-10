/**
 * The Relationships view's Open in Diagram, host side
 * (`SemanticEditorProvider.revealRelationship`): a reveal reaches its canvas
 * only once the canvas has its diagram — held while it opens, posted right
 * after `domainLoaded`, posted at once to a canvas already loaded — and a
 * stale one is dropped. The webview side is `useRevealRelationship`
 * (`test/unit/useRevealRelationship.test.tsx`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { PENDING_REVEAL_MS, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
const TARGET = { fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_key', toColumn: 'customer_key' }] };

let root: string;

function buildProvider(projectRoot: string): SemanticEditorProvider {
  const layerService = new LayerService(projectRoot, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(projectRoot, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(projectRoot, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(projectRoot, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty } as unknown as ManifestService,
    { loadYmlData: async () => empty } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const diagram = (): string => path.join(root, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');

async function open(provider: SemanticEditorProvider) {
  const panel = createMockWebviewPanel();
  const doc = createMockTextDocument(diagram(), fs.readFileSync(diagram(), 'utf-8'));
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return panel;
}

const types = (panel: ReturnType<typeof createMockWebviewPanel>): string[] =>
  panel._postedMessages.map((m) => (m as { type: string }).type);

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-reveal-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('revealRelationship (Open in Diagram)', () => {
  it('holds a reveal asked for while the canvas opens, and posts it right after the diagram', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider);
    await provider.revealRelationship(vscode.Uri.file(diagram()), TARGET);
    expect(types(panel)).not.toContain('revealRelationship');

    await panel._simulateMessage({ type: 'ready' });
    const posted = types(panel);
    expect(posted.indexOf('revealRelationship')).toBeGreaterThan(posted.indexOf('domainLoaded'));
    expect(panel._postedMessages.find((m) => (m as { type: string }).type === 'revealRelationship')).toEqual({ type: 'revealRelationship', payload: TARGET });
  });

  it('holds it even when asked before the editor exists', async () => {
    const provider = buildProvider(root);
    await provider.revealRelationship(vscode.Uri.file(diagram()), TARGET);
    const panel = await open(provider);
    await panel._simulateMessage({ type: 'ready' });
    expect(types(panel).filter((t) => t === 'revealRelationship')).toHaveLength(1);
  });

  it('posts at once to a canvas that has its diagram, and only once', async () => {
    const provider = buildProvider(root);
    const panel = await open(provider);
    await panel._simulateMessage({ type: 'ready' });
    await provider.revealRelationship(vscode.Uri.file(diagram()), TARGET);
    expect(types(panel).at(-1)).toBe('revealRelationship');
    // A Retry's second `ready` does not repeat a reveal already shown.
    await panel._simulateMessage({ type: 'ready' });
    expect(types(panel).filter((t) => t === 'revealRelationship')).toHaveLength(1);
  });

  it('drops a reveal its canvas never loaded in time, so a later open by hand does not jump', async () => {
    const provider = buildProvider(root);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await provider.revealRelationship(vscode.Uri.file(diagram()), TARGET);
    clock.mockReturnValue(now + PENDING_REVEAL_MS + 1);
    const panel = await open(provider);
    await panel._simulateMessage({ type: 'ready' });
    expect(types(panel)).toContain('domainLoaded');
    expect(types(panel)).not.toContain('revealRelationship');
  });
});
