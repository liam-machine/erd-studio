/**
 * Domain-file read failures on the canvas (issue #64).
 *
 * Covers the three things that report exposed:
 *   - a domain file caught mid-write is re-read, not declared broken;
 *   - a JSON file under the semantic dir that is NOT a domain (a template) is
 *     refused with an explanation instead of a parse error;
 *   - a burst of refreshes over one broken file posts one error, not fifteen.
 *
 * Drives the real provider with the real services over a temp copy of the
 * fixture dbt project, the same way semanticEditorProvider.test.ts does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const errors = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'error');
const types = (panel: MockPanel) => posted(panel).map((m) => m.type);

function makeDoc(fsPath: string) {
  let text = fs.existsSync(fsPath) ? fs.readFileSync(fsPath, 'utf-8') : '';
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
    _setText: (t: string) => { text = t; },
  };
}

function buildProvider(rootDir: string) {
  const layerService = new LayerService(rootDir, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(rootDir, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  const selectorsService = new SelectorsService(domainService, rootDir, '.erd-studio');
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(rootDir, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  return new SemanticEditorProvider(
    context,
    domainService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    rootDir,
    selectorsService,
    logicalModelService,
  );
}

async function open(rootDir: string, filePath: string) {
  const provider = buildProvider(rootDir);
  const doc = makeDoc(filePath);
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return { provider, doc, panel };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-domainfile-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  vscode._resetMockWorkspace();
  vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a domain file caught mid-write', () => {
  it('re-reads a zero-byte file and loads it once the content lands', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const realContent = fs.readFileSync(file, 'utf-8');
    // The state an external writer leaves behind for a few milliseconds
    // between creating the file and writing it.
    fs.writeFileSync(file, '');

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    // The writer finishes while the provider is between re-reads.
    setTimeout(() => fs.writeFileSync(file, realContent), 200);

    await vi.waitFor(
      () => expect(types(panel)).toContain('domainLoaded'),
      { timeout: 4000, interval: 20 },
    );
    expect(errors(panel)).toHaveLength(0);
  });

  it('re-reads a truncated file and loads it once the content lands', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const realContent = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, realContent.slice(0, 40));

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    setTimeout(() => fs.writeFileSync(file, realContent), 200);

    await vi.waitFor(
      () => expect(types(panel)).toContain('domainLoaded'),
      { timeout: 4000, interval: 20 },
    );
    expect(errors(panel)).toHaveLength(0);
  });

  it('gives up on a file that stays empty, and says it is empty', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    fs.writeFileSync(file, '');

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });
    const payload = errors(panel)[0].payload;
    expect(payload.message).toContain('Domain file is empty');
    // Not the parser's "Unexpected end of JSON input", which reads as
    // corruption when the file is simply blank.
    expect(payload.message).not.toContain('Unexpected end of JSON input');
    expect(payload.kind).toBe('domain-file');
    expect(types(panel)).not.toContain('domainLoaded');
  });

  it('does not stall on a structurally invalid file — no retry, one error', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    // Parses fine; it is simply not a domain. Re-reading cannot change that,
    // so the answer must come back without serving out the backoff.
    fs.writeFileSync(file, JSON.stringify({ nope: true }));

    const { panel } = await open(root, file);
    const startedAt = Date.now();
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('a JSON file under the semantic dir that is not a domain', () => {
  it('refuses a template with an explanation, not a parse error', async () => {
    const file = path.join(root, '.erd-studio', 'templates', 'fact.json');
    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    const payload = errors(panel)[0].payload;
    expect(payload.kind).toBe('not-a-domain');
    expect(payload.message).toContain('fact.json');
    expect(payload.message).toContain('not an ERD domain file');
    expect(types(panel)).not.toContain('domainLoaded');
  });

  it('answers `viewFile` so the canvas can offer "Open as Text"', async () => {
    const file = path.join(root, '.erd-studio', 'templates', 'fact.json');
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const { panel } = await open(root, file);

    panel._simulateMessage({ type: 'viewFile' });

    await vi.waitFor(
      () => expect(executeCommand).toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'default'),
      { timeout: 4000, interval: 10 },
    );
  });
});

describe('an error the user is already looking at', () => {
  it('is posted once across a burst of refreshes, not once per refresh', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    fs.writeFileSync(file, '');

    const { provider, panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });

    // What issue #64 recorded: an external writer touching several model files
    // in a burst, each one refreshing every domain that references it.
    for (let i = 0; i < 3; i++) {
      await provider.refreshAllOpenDomains();
    }

    expect(errors(panel)).toHaveLength(1);
    // Each refresh serves out the full backoff before giving up again — the
    // test's own timeout has to allow for that.
  }, 20_000);

  it('is posted again when the user presses Retry', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    fs.writeFileSync(file, '');

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });

    // Retry clears the webview's error before asking again, so a suppressed
    // reply would leave the canvas showing "Loading domain…" for ever.
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(errors(panel)).toHaveLength(2), { timeout: 4000, interval: 20 });
  });
});
