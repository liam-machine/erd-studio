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

import { SubjectAreaValidationError } from '@erd-studio/core';
import { classifySubjectAreaLoadFailure, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaFileError, SubjectAreaService } from '../../src/services/domainService';
import { telemetry } from '../../src/services/telemetryService';
import { subjectAreaLoadErrorCode } from '../../src/services/telemetryPayload';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
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
    get lineCount() { return text.split('\n').length; },
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
    // Plain words and a project-relative path (#186), not the parser's
    // "Unexpected end of JSON input", which reads as corruption when the
    // file is simply blank.
    expect(payload.message).toBe('.erd-studio/silver/showcase.json has no content.');
    expect(payload.kind).toBe('domain-file');
    expect(payload.fileProblem).toBe('empty');
    expect(types(panel)).not.toContain('domainLoaded');
  });

  it('re-reads a file another process has locked (Windows EBUSY) and loads it once the lock clears', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    // What a Windows sharing violation looks like by the time it reaches the
    // provider: the file exists, but this read of it failed.
    const real = SubjectAreaService.prototype.getSubjectArea;
    let locked = 2;
    vi.spyOn(SubjectAreaService.prototype, 'getSubjectArea').mockImplementation(function (this: SubjectAreaService, p: string) {
      if (p === file && locked-- > 0) {
        throw new SubjectAreaFileError('unreadable', p, `Failed to read domain file: EBUSY: resource busy or locked, open '${p}'`);
      }
      return real.call(this, p);
    });

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(
      () => expect(types(panel)).toContain('domainLoaded'),
      { timeout: 4000, interval: 20 },
    );
    expect(errors(panel)).toHaveLength(0);
    expect(locked).toBeLessThan(0);
  });

  it('reports a file that stays unreadable once the retries run out', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    vi.spyOn(SubjectAreaService.prototype, 'getSubjectArea').mockImplementation((p: string) => {
      throw new SubjectAreaFileError('unreadable', p, 'Failed to read domain file: EACCES: permission denied');
    });

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });
    expect(errors(panel)[0].payload.message).toContain('EACCES');
    expect(SubjectAreaService.prototype.getSubjectArea).toHaveBeenCalledTimes(4);
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

describe('a domain file with unresolved git merge conflicts (#145)', () => {
  /** showcase.json as two branches that moved the same model leave it. */
  function conflicted(realContent: string): string {
    const parsed = JSON.parse(realContent) as { viewConfig: { positions: Record<string, { x: number; y: number }> } };
    const [name, pos] = Object.entries(parsed.viewConfig.positions)[0];
    const ours = JSON.stringify(pos);
    const theirs = JSON.stringify({ x: pos.x + 200, y: pos.y + 100 });
    const lines = JSON.stringify(parsed, null, 2).split('\n');
    const at = lines.findIndex((l) => l.trimStart().startsWith(`"${name}": {`));
    // Collapse the entry onto one line so each side is a single line.
    let end = at;
    while (!/^\s*}/.test(lines[end]) || end === at) end++;
    const comma = lines[end].trimEnd().endsWith(',') ? ',' : '';
    lines.splice(at, end - at + 1,
      '<<<<<<< HEAD', `      "${name}": ${ours}${comma}`, '=======', `      "${name}": ${theirs}${comma}`, '>>>>>>> feature/move');
    return lines.join('\n');
  }

  it('says merge conflict at once — no re-reads — and flags the payload', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const text = conflicted(fs.readFileSync(file, 'utf-8'));
    const line = text.split('\n').indexOf('<<<<<<< HEAD') + 1;
    fs.writeFileSync(file, text);
    const getSubjectArea = vi.spyOn(SubjectAreaService.prototype, 'getSubjectArea');

    const { panel } = await open(root, file);
    const startedAt = Date.now();
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    // The ~1.2s backoff is for a file caught mid-write; a conflict reads the same every time.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(getSubjectArea).toHaveBeenCalledTimes(1);
    const payload = errors(panel)[0].payload;
    expect(payload).toEqual({
      message: expect.stringContaining(`has unresolved git merge conflicts (first at line ${line})`),
      kind: 'domain-file',
      mergeConflict: true,
    });
    expect(payload.message).not.toContain('Invalid JSON');
  });

  it('loads by itself once the conflict is resolved and the document changes', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const realContent = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, conflicted(realContent));

    const { doc, panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(types(panel)).not.toContain('domainLoaded');

    // What keeping one side in the text editor (or `git checkout --ours`) does:
    // the document changes and the file on disk is the resolved one.
    fs.writeFileSync(file, realContent);
    doc._setText(realContent);
    await vscode._fireDidChangeTextDocument(doc);

    await vi.waitFor(() => expect(types(panel)).toContain('domainLoaded'), { timeout: 4000, interval: 10 });
    expect(errors(panel)).toHaveLength(1);
  });

  it('is a conflict failure to telemetry, not a json one', () => {
    const err = new SubjectAreaFileError('invalid-json', '/x.json', 'conflict', { mergeConflict: true, line: 3 });
    expect(err.transient).toBe(false);
    expect(classifySubjectAreaLoadFailure(err)).toBe('conflict');
    expect(subjectAreaLoadErrorCode('conflict')).toBe('domainLoadConflict');
  });
});

describe('a domain file with a JSON mistake (#186)', () => {
  /** showcase.json with a trailing comma after its last top-level property. */
  function withTrailingComma(file: string): { line: number; column: number } {
    const lines = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf-8')), null, 2).split('\n');
    const last = lines.length - 2;
    lines[last] += ',';
    fs.writeFileSync(file, lines.join('\n'));
    return { line: last + 1, column: lines[last].length };
  }

  it('says where the mistake is, project-relative, and never the absolute path or the parser', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const at = withTrailingComma(file);

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });
    const payload = errors(panel)[0].payload;
    expect(payload).toEqual({
      message: `.erd-studio/silver/showcase.json has a mistake at line ${at.line}, column ${at.column}: `
        + 'there is a comma after the last item, before a closing } or ].',
      kind: 'domain-file',
      fileProblem: 'syntax',
      line: at.line,
      column: at.column,
    });
    expect(JSON.stringify(payload)).not.toContain(root);
    expect(payload.message).not.toMatch(/position|JSON at|Expected/);
  });

  it('posts a second mistake elsewhere in the file, so Open at Line follows it', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const real = fs.readFileSync(file, 'utf-8');
    withTrailingComma(file);

    const { doc, panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 20 });

    // The user fixes that one and leaves another: a missing comma on line 3.
    const lines = JSON.stringify(JSON.parse(real), null, 2).split('\n');
    lines[2] = lines[2].replace(/,$/, '');
    fs.writeFileSync(file, lines.join('\n'));
    doc._setText(lines.join('\n'));
    await vscode._fireDidChangeTextDocument(doc);

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(2), { timeout: 4000, interval: 20 });
    expect(errors(panel)[1].payload).toMatchObject({ fileProblem: 'syntax', line: 3, column: lines[2].length + 1 });
  });

  it('refuses a canvas edit to the broken file with the same plain sentence', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const real = fs.readFileSync(file, 'utf-8');
    const { doc, panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(types(panel)).toContain('domainLoaded'), { timeout: 4000, interval: 20 });

    const at = withTrailingComma(file);
    doc._setText(fs.readFileSync(file, 'utf-8'));
    panel._simulateMessage({ type: 'updatePositions', payload: { positions: { fct_task_event: { x: 1, y: 2 } } } });

    await vi.waitFor(() => expect(errors(panel).length).toBeGreaterThan(0), { timeout: 4000, interval: 20 });
    const text = errors(panel).map((e) => e.payload.message).join('\n');
    expect(text).toContain(`.erd-studio/silver/showcase.json has a mistake at line ${at.line}, column ${at.column}`);
    expect(text).not.toContain(root);
    expect(real).not.toBe(fs.readFileSync(file, 'utf-8'));
  });

  it('opens the file at the mistake for `viewFile` with a position, and as before without one', async () => {
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const { panel } = await open(root, file);

    panel._simulateMessage({ type: 'viewFile', payload: { line: 4, column: 7 } });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith', expect.anything(), 'default', { selection: new vscode.Range(new vscode.Position(3, 6), new vscode.Position(3, 6)) },
    ), { timeout: 4000, interval: 10 });

    // The toolbar's View JSON, and a payload that does not validate, open it as they always did.
    executeCommand.mockClear();
    panel._simulateMessage({ type: 'viewFile' });
    panel._simulateMessage({ type: 'viewFile', payload: { line: 0 } });
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(2), { timeout: 4000, interval: 10 });
    for (const call of executeCommand.mock.calls) expect(call).toEqual(['vscode.openWith', expect.anything(), 'default']);
  });

  it('names a file outside the project by its name only, but keeps a folder that merely starts with two dots', () => {
    const shown = (fsPath: string) => (buildProvider(root) as any).shownSubjectAreaPath(fsPath) as string;
    expect(shown(path.join(root, '..', 'elsewhere', 'showcase.json'))).toBe('showcase.json');
    expect(shown(path.join(root, '..erd', 'silver', 'showcase.json'))).toBe('..erd/silver/showcase.json');
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
    expect(payload.message).toContain('not an ERD Studio diagram file');
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
      await provider.refreshAllOpenSubjectAreas();
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

// ---------------------------------------------------------------------------

describe('domainLoad telemetry carries a fixed reason', () => {
  it('classifies each kind of failure without reading its message', () => {
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('missing', '/x.json', 'gone'))).toBe('missing');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('unreadable', '/x.json', 'EBUSY'))).toBe('unreadable');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('empty', '/x.json', 'empty'))).toBe('empty');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaFileError('invalid-json', '/x.json', 'bad'))).toBe('json');
    expect(classifySubjectAreaLoadFailure(new SubjectAreaValidationError('no schemaVersion'))).toBe('invalid');
    expect(classifySubjectAreaLoadFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('internal');
    expect(classifySubjectAreaLoadFailure('a string')).toBe('internal');
  });

  it('records domainLoad and its reason once per distinct error', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    fs.writeFileSync(file, JSON.stringify({ nope: true }));

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(error.mock.calls.map((c) => c[0])).toEqual(['domainLoad', 'domainLoadInvalid']);
  });

  it('maps each reason to its own error code', () => {
    expect(subjectAreaLoadErrorCode('json')).toBe('domainLoadJson');
    expect(subjectAreaLoadErrorCode('empty')).toBe('domainLoadEmpty');
    expect(subjectAreaLoadErrorCode('conflict')).toBe('domainLoadConflict');
  });

  it('records a file that stays empty as domainLoadEmpty, not domainLoadJson', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    fs.writeFileSync(file, '');

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(error.mock.calls.map((c) => c[0])).toEqual(['domainLoad', 'domainLoadEmpty']);
  });

  it('records a template opened as a canvas as notDomain', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const templates = fs.readdirSync(path.join(root, '.erd-studio', 'templates')).filter((f) => f.endsWith('.json'));
    const file = path.join(root, '.erd-studio', 'templates', templates[0]);

    const { panel } = await open(root, file);
    panel._simulateMessage({ type: 'ready' });

    await vi.waitFor(() => expect(errors(panel)).toHaveLength(1), { timeout: 4000, interval: 10 });
    expect(error.mock.calls.map((c) => c[0])).toEqual(['domainLoad', 'domainLoadNotDomain']);
  });
});
