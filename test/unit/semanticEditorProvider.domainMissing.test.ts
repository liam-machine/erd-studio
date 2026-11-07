/**
 * A canvas whose domain file was deleted or renamed outside ERD Studio
 * (issue #161) — by an AI assistant, a git checkout, the file explorer.
 *
 * The open document outlives its file, so the canvas used to keep drawing the
 * stale diagram, editable, until an unrelated refresh failed with "Domain file
 * not found: <absolute path>" and Retry / Open as Text, neither of which can
 * work. The rule now:
 *   - a missing file is its own error kind, `domain-missing`, named
 *     project-relative, on load (a tab VS Code restored) and as soon as the
 *     watcher sees the delete;
 *   - nothing is written back: an edit or an undo on that canvas refuses, and
 *     the deleted file stays deleted;
 *   - a delete git fires for a file that is still there changes nothing, and a
 *     file that comes back redraws by itself.
 *
 * Drives the real provider with the real services over a temp copy of the
 * fixture dbt project, as semanticEditorProvider.domainFile.test.ts does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { telemetry } from '../../src/services/telemetryService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { hostErrorLog } from '../../src/services/feedbackService';
import { setLogSink, type LogSink } from '../../src/services/logger';

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
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(rootDir, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, rootDir, '.erd-studio');
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
    subjectAreaService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    rootDir,
    selectorsService,
    tableLibraryService,
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-domainmissing-'));
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

const MISSING = {
  message: '.erd-studio/silver/showcase.json was deleted or renamed outside ERD Studio.',
  kind: 'domain-missing',
};

/** The showcase diagram, open and loaded. */
async function openLoaded() {
  const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
  const opened = await open(root, file);
  await opened.panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(() => expect(types(opened.panel)).toContain('domainLoaded'), { timeout: 4000, interval: 20 });
  expect(errors(opened.panel)).toEqual([]);
  return { file, content: fs.readFileSync(file, 'utf-8'), ...opened };
}

describe('a diagram whose file is gone when the canvas loads', () => {
  it('says deleted or renamed, project-relative, and records domainLoadMissing', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const { panel } = await open(root, file);
    fs.rmSync(file);

    await panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(errors(panel)[0].payload).toEqual(MISSING);
    expect(errors(panel)[0].payload.message).not.toContain(root);
    expect(types(panel)).not.toContain('domainLoaded');
    expect(error.mock.calls.map((c) => c[0])).toEqual(['domainLoad', 'domainLoadMissing']);
  });
});

describe('a diagram whose file is deleted while its canvas is open', () => {
  it('switches to the deleted-or-renamed screen when the delete is seen, once', async () => {
    const { provider, file, panel } = await openLoaded();
    const error = vi.spyOn(telemetry, 'error');
    fs.rmSync(file);

    provider.syncSubjectAreaFilePresence();
    expect(errors(panel).map((m) => m.payload)).toEqual([MISSING]);

    // The refreshes that used to be the first sign of it say nothing new.
    await provider.refreshAllOpenSubjectAreas();
    provider.syncSubjectAreaFilePresence();
    expect(errors(panel)).toHaveLength(1);
    expect(error.mock.calls.map((c) => c[0])).toEqual(['domainLoad', 'domainLoadMissing']);
  });

  it('logs the delete at info, not as an error, and adds nothing to the bug-report error log', async () => {
    // An Undo of Convert removes the diagram it made: an expected event,
    // which used to write two [error] lines ("[sendDomainData] … was deleted
    // or renamed outside ERD Studio." and "Failed to load domain").
    const { provider, file, panel } = await openLoaded();
    const lines: Array<{ level: string; message: string }> = [];
    const at = (level: string) => (message: string | Error) => { lines.push({ level, message: String(message) }); };
    const sink: LogSink = { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
    const previous = setLogSink(sink);
    hostErrorLog.clear();
    try {
      fs.rmSync(file);
      provider.syncSubjectAreaFilePresence();
      await provider.refreshAllOpenSubjectAreas();
    } finally {
      setLogSink(previous);
    }
    expect(errors(panel).map((m) => m.payload)).toEqual([MISSING]);
    expect(lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(lines.filter((l) => l.level === 'info' && l.message.includes(MISSING.message))).toHaveLength(1);
    expect(hostErrorLog.recent()).toEqual([]);
  });

  it('still logs a load failure that is not a delete as an error', async () => {
    const { provider, file, panel } = await openLoaded();
    const lines: string[] = [];
    const previous = setLogSink({ trace() {}, debug() {}, info() {}, warn() {}, error: (m: string | Error) => { lines.push(String(m)); } });
    hostErrorLog.clear();
    try {
      fs.writeFileSync(file, '{ not json');
      await provider.refreshAllOpenSubjectAreas();
    } finally {
      setLogSink(previous);
    }
    await vi.waitFor(() => expect(errors(panel).length).toBeGreaterThan(0), { timeout: 4000, interval: 10 });
    expect(lines.some((l) => l.includes('Failed to load domain'))).toBe(true);
    expect(hostErrorLog.recent().length).toBeGreaterThan(0);
  });

  it('leaves a canvas alone when the "deleted" file is still there (git delete-then-rename)', async () => {
    const { provider, panel } = await openLoaded();
    const before = posted(panel).length;

    provider.syncSubjectAreaFilePresence();

    expect(posted(panel)).toHaveLength(before);
  });

  it('redraws by itself when the file comes back', async () => {
    const { provider, file, content, panel } = await openLoaded();
    fs.rmSync(file);
    provider.syncSubjectAreaFilePresence();
    panel._postedMessages.length = 0;

    // `git checkout` back: same bytes, so the document fires no change.
    fs.writeFileSync(file, content);
    provider.syncSubjectAreaFilePresence();

    await vi.waitFor(() => expect(types(panel)).toContain('domainLoaded'), { timeout: 4000, interval: 10 });
    expect(errors(panel)).toEqual([]);
  });

  it('writes nothing for an edit on the stale canvas, and the file stays deleted', async () => {
    const { provider, file, doc, panel } = await openLoaded();
    fs.rmSync(file);
    provider.syncSubjectAreaFilePresence();
    vi.mocked(vscode.workspace.applyEdit).mockClear();
    doc.save.mockClear();
    panel._postedMessages.length = 0;

    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_task: { x: 1, y: 2 } } } });
    await panel._simulateMessage({ type: 'addModel', payload: { name: 'dim_new', columns: [] } });

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(errors(panel).length).toBeGreaterThan(0);
    for (const e of errors(panel)) {
      expect(e.payload.message).toContain('.erd-studio/silver/showcase.json was deleted or renamed outside ERD Studio. Nothing was saved.');
    }
  });

  it('does not save an undo back into existence, from the toolbar or Cmd+Z', async () => {
    const { provider, file, doc, panel } = await openLoaded();
    fs.rmSync(file);
    provider.syncSubjectAreaFilePresence();
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    doc.save.mockClear();

    await panel._simulateMessage({ type: 'undo' });
    expect(executeCommand).not.toHaveBeenCalledWith('undo');

    // VS Code's own undo rewinds the document in memory, then the provider flushes.
    doc._setText(doc.getText() + ' ');
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    await new Promise((resolve) => setTimeout(resolve, 600));

    // An external change to the dirty document is not saved either.
    (doc as { isDirty: boolean }).isDirty = true;
    await vscode._fireDidChangeTextDocument(doc);

    expect(doc.save).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('the deleted-or-renamed screen\'s buttons', () => {
  it('Close disposes the tab', async () => {
    const { panel } = await openLoaded();
    await panel._simulateMessage({ type: 'closeEditor' });
    expect(panel._disposed).toBe(true);
  });

  it('Open Another Diagram asks which, through erdStudio.openDomain', async () => {
    const { panel } = await openLoaded();
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await panel._simulateMessage({ type: 'openAnotherDomain' });
    expect(executeCommand).toHaveBeenCalledWith('erdStudio.openDomain');
  });

  it('both work on the physical stage, which writes nothing', async () => {
    const { panel } = await openLoaded();
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(types(panel)).toContain('stageData'), { timeout: 4000, interval: 10 });
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    panel._postedMessages.length = 0;

    await panel._simulateMessage({ type: 'openAnotherDomain' });
    await panel._simulateMessage({ type: 'closeEditor' });

    expect(errors(panel)).toEqual([]);
    expect(executeCommand).toHaveBeenCalledWith('erdStudio.openDomain');
    expect(panel._disposed).toBe(true);
  });
});
