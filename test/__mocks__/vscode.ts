// Manual mock of the vscode module for Vitest unit tests.
// Add stubs here as services are implemented and tests need them.

import * as fs from 'fs';
import * as path from 'path';

export const workspace = {
  getConfiguration: () => ({
    get: (key: string, defaultValue?: unknown) => defaultValue,
  }),
  workspaceFolders: [],
  textDocuments: [] as unknown[],
  // Replaced below with implementations backed by the mock document registry.
  applyEdit: async (_edit: unknown): Promise<boolean> => true,
  openTextDocument: async (_uriOrPath: unknown): Promise<unknown> => { throw new Error('not initialised'); },
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  findFiles: async () => [] as unknown[],
  fs: {
    readFile: async () => Buffer.from('{}'),
    writeFile: async () => {},
    stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async () => [],
    delete: async () => {},
    createDirectory: async () => {},
  },
};

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  setStatusBarMessage: (_message: string, _hideAfterTimeout?: number) => ({ dispose: () => {} }),
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  registerCustomEditorProvider: () => ({ dispose: () => {} }),
  createTreeView: () => ({ dispose: () => {} }),
  tabGroups: { all: [] as Array<{ tabs: Array<{ input: unknown }> }> },
};

/** Minimal mock of vscode.TabInputCustom for the recovery service. */
export class TabInputCustom {
  constructor(public readonly uri: unknown, public readonly viewType: string) {}
}

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

/** Creates a mock URI that stringifies to its path (matching VS Code webview behaviour). */
function createUri(uriPath: string) {
  return {
    fsPath: uriPath,
    scheme: 'file',
    path: uriPath,
    toString: () => uriPath,
  };
}

export const Uri = {
  file: (path: string) => createUri(path),
  parse: (uri: string) => createUri(uri),
  joinPath: (base: { path: string }, ...segments: string[]) =>
    createUri([base.path, ...segments].join('/')),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label: string;
  description?: string;
  tooltip?: string;
  collapsibleState?: TreeItemCollapsibleState;
  iconPath?: unknown;
  command?: unknown;
  contextValue?: string;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  constructor(value = '', supportThemeIcons?: boolean) {
    this.value = value;
  }
}

export class ThemeColor {
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon {
  id: string;
  color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

export class EventEmitter {
  private listeners: Array<(...args: unknown[]) => void> = [];
  event = (listener: (...args: unknown[]) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data?: unknown) {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

export class Disposable {
  static from(...disposables: { dispose: () => void }[]) {
    return {
      dispose: () => {
        for (const d of disposables) {
          d.dispose();
        }
      },
    };
  }
}

/**
 * Mock DataTransferItem for drag-and-drop testing.
 */
export class DataTransferItem {
  constructor(public readonly value: unknown) {}
  asString(): Thenable<string> {
    return Promise.resolve(String(this.value));
  }
  asFile(): undefined {
    return undefined;
  }
}

/**
 * Mock DataTransfer for drag-and-drop testing.
 */
export class DataTransfer {
  private items = new Map<string, DataTransferItem>();

  get(mimeType: string): DataTransferItem | undefined {
    return this.items.get(mimeType);
  }

  set(mimeType: string, value: DataTransferItem): void {
    this.items.set(mimeType, value);
  }

  forEach(
    callback: (value: DataTransferItem, mimeType: string) => void,
  ): void {
    this.items.forEach((value, key) => callback(value, key));
  }
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

// ---------------------------------------------------------------------------
// Helpers for testing CustomTextEditorProvider
// ---------------------------------------------------------------------------

/**
 * Create a mock WebviewPanel for use in unit tests.
 * Message handlers are captured so tests can simulate postMessage from webview.
 */
export function createMockWebviewPanel() {
  const messageHandlers: Array<(message: unknown) => void | Promise<void>> = [];
  const viewStateHandlers: Array<(e: { webviewPanel: { visible: boolean } }) => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const postedMessages: unknown[] = [];

  const panel = {
    webview: {
      html: '',
      options: {} as Record<string, unknown>,
      cspSource: 'https://mock-csp-source',
      asWebviewUri: (uri: any) => uri,
      postMessage: async (message: unknown) => {
        postedMessages.push(message);
        return true;
      },
      onDidReceiveMessage: (handler: (message: unknown) => void | Promise<void>) => {
        messageHandlers.push(handler);
        return { dispose: () => {} };
      },
    },
    onDidChangeViewState: (handler: (e: { webviewPanel: { visible: boolean } }) => void) => {
      viewStateHandlers.push(handler);
      return { dispose: () => {} };
    },
    onDidDispose: (handler: () => void) => {
      disposeHandlers.push(handler);
      return { dispose: () => {} };
    },
    visible: true,
    active: true,
    dispose: () => {},

    // Test helpers (not part of VS Code API)
    /** Dispatch a message to every handler; resolves once async handlers finish. */
    _simulateMessage: (message: unknown): Promise<void> =>
      Promise.all(messageHandlers.map((handler) => handler(message))).then(() => undefined),
    _simulateViewStateChange: (visible: boolean) => {
      for (const handler of viewStateHandlers) {
        handler({ webviewPanel: { visible } });
      }
    },
    _postedMessages: postedMessages,
  };

  return panel;
}

// ---------------------------------------------------------------------------
// Text documents + WorkspaceEdit (for testing mutation handlers end-to-end)
// ---------------------------------------------------------------------------

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export interface MockTextDocument {
  uri: ReturnType<typeof createUri>;
  fileName: string;
  isDirty: boolean;
  isUntitled: boolean;
  lineCount: number;
  getText: () => string;
  positionAt: (offset: number) => Position;
  offsetAt: (position: Position) => number;
  save: () => Promise<boolean>;
  /** Test helper: replace the whole in-memory text (marks dirty). */
  _setText: (text: string) => void;
  /** Whether save() writes the in-memory text to `uri.fsPath`. */
  _persist: boolean;
}

/** Documents "open" in the mock workspace, keyed by uri string. */
export const _mockDocuments = new Map<string, MockTextDocument>();

type MockUri = { toString(): string; fsPath: string };

export type MockEditOp =
  | { kind: 'replace'; uri: MockUri; range: Range; newText: string }
  | { kind: 'insert'; uri: MockUri; position: Position; newText: string }
  | { kind: 'createFile'; uri: MockUri; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }
  | { kind: 'deleteFile'; uri: MockUri; options?: { ignoreIfNotExists?: boolean } }
  | { kind: 'renameFile'; oldUri: MockUri; newUri: MockUri; options?: { overwrite?: boolean } };

/**
 * Mock WorkspaceEdit — records operations in order so tests can assert which
 * resources were touched by a single applyEdit call.
 */
export class WorkspaceEdit {
  readonly _ops: MockEditOp[] = [];
  replace(uri: MockUri, range: Range, newText: string) {
    this._ops.push({ kind: 'replace', uri, range, newText });
  }
  insert(uri: MockUri, position: Position, newText: string) {
    this._ops.push({ kind: 'insert', uri, position, newText });
  }
  createFile(uri: MockUri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }) {
    this._ops.push({ kind: 'createFile', uri, options });
  }
  deleteFile(uri: MockUri, options?: { ignoreIfNotExists?: boolean }) {
    this._ops.push({ kind: 'deleteFile', uri, options });
  }
  renameFile(oldUri: MockUri, newUri: MockUri, options?: { overwrite?: boolean }) {
    this._ops.push({ kind: 'renameFile', oldUri, newUri, options });
  }
  /** Convenience for assertions: the ops touching a given fsPath. */
  _opsFor(fsPath: string): MockEditOp[] {
    return this._ops.filter((op) =>
      op.kind === 'renameFile' ? op.oldUri.fsPath === fsPath || op.newUri.fsPath === fsPath : op.uri.fsPath === fsPath,
    );
  }
}

/** Every WorkspaceEdit passed to workspace.applyEdit, in order. */
export const _appliedEdits: WorkspaceEdit[] = [];

/** Set to false to make workspace.applyEdit reject (nothing is applied). */
export const _mockWorkspaceState = { applyEditResult: true };

/** Reset documents, applied edits and applyEdit behaviour (call in beforeEach). */
export function _resetMockWorkspace(): void {
  _mockDocuments.clear();
  _appliedEdits.length = 0;
  _mockWorkspaceState.applyEditResult = true;
  workspace.textDocuments = [];
}

/**
 * Create a mock TextDocument for use in unit tests.
 * With `persist: true`, save() writes the in-memory text to `fsPath`, which
 * lets handler tests observe the on-disk result the way the extension does.
 * The document is registered so workspace.applyEdit / openTextDocument find it.
 */
export function createMockTextDocument(fsPath: string, text = '{}', options: { persist?: boolean } = {}) {
  let current = text;
  const uri = Uri.file(fsPath);
  const doc: MockTextDocument = {
    uri,
    fileName: fsPath,
    isDirty: false,
    isUntitled: false,
    lineCount: text.split('\n').length,
    getText: () => current,
    positionAt: (offset: number) => {
      const clamped = Math.max(0, Math.min(offset, current.length));
      const before = current.slice(0, clamped);
      const line = (before.match(/\n/g) ?? []).length;
      const character = clamped - (before.lastIndexOf('\n') + 1);
      return new Position(line, character);
    },
    offsetAt: (position: Position) => {
      const lines = current.split('\n');
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      return Math.min(current.length, offset + position.character);
    },
    save: async () => {
      if (doc._persist) {
        fs.writeFileSync(fsPath, current, 'utf-8');
      }
      doc.isDirty = false;
      return true;
    },
    _setText: (next: string) => {
      current = next;
      doc.lineCount = next.split('\n').length;
      doc.isDirty = true;
    },
    _persist: options.persist ?? false,
  };
  _mockDocuments.set(uri.toString(), doc);
  return doc;
}

/**
 * Apply a mock WorkspaceEdit: text edits update registered documents in memory
 * (dirty until save()), file edits hit the real filesystem — mirroring VS Code,
 * where file operations are performed immediately but text edits need a save.
 */
async function applyMockEdit(edit: WorkspaceEdit): Promise<boolean> {
  _appliedEdits.push(edit);
  if (!_mockWorkspaceState.applyEditResult) {
    return false;
  }
  for (const op of edit._ops) {
    switch (op.kind) {
      case 'replace':
      case 'insert': {
        const doc = _mockDocuments.get(op.uri.toString()) ?? (await openMockDocument(op.uri.fsPath));
        const text = doc.getText();
        const start = op.kind === 'replace' ? doc.offsetAt(op.range.start) : doc.offsetAt(op.position);
        const end = op.kind === 'replace' ? doc.offsetAt(op.range.end) : start;
        doc._setText(text.slice(0, start) + op.newText + text.slice(end));
        break;
      }
      case 'createFile': {
        const exists = fs.existsSync(op.uri.fsPath);
        if (exists && !op.options?.overwrite) {
          if (op.options?.ignoreIfExists) break;
          return false;
        }
        fs.mkdirSync(path.dirname(op.uri.fsPath), { recursive: true });
        fs.writeFileSync(op.uri.fsPath, op.options?.contents ? Buffer.from(op.options.contents) : '');
        break;
      }
      case 'deleteFile': {
        if (!fs.existsSync(op.uri.fsPath)) {
          if (op.options?.ignoreIfNotExists) break;
          return false;
        }
        fs.rmSync(op.uri.fsPath, { recursive: true, force: true });
        _mockDocuments.delete(op.uri.toString());
        break;
      }
      case 'renameFile': {
        fs.mkdirSync(path.dirname(op.newUri.fsPath), { recursive: true });
        fs.renameSync(op.oldUri.fsPath, op.newUri.fsPath);
        break;
      }
    }
  }
  return true;
}

/** Open (or return the already-open) persisted document backed by a real file. */
async function openMockDocument(fsPath: string): Promise<MockTextDocument> {
  const key = Uri.file(fsPath).toString();
  const existing = _mockDocuments.get(key);
  if (existing) return existing;
  if (!fs.existsSync(fsPath)) {
    throw new Error(`cannot open ${fsPath}: file not found`);
  }
  const doc = createMockTextDocument(fsPath, fs.readFileSync(fsPath, 'utf-8'), { persist: true });
  workspace.textDocuments.push(doc);
  return doc;
}

workspace.applyEdit = applyMockEdit as unknown as typeof workspace.applyEdit;
workspace.openTextDocument = ((uriOrPath: string | { fsPath: string }) =>
  openMockDocument(typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath)) as unknown as typeof workspace.openTextDocument;

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}

// ---------------------------------------------------------------------------
// Helpers for testing FileSystemWatcher
// ---------------------------------------------------------------------------

export interface MockFileSystemWatcher {
  /** The glob pattern (RelativePattern) this watcher was created with. */
  _pattern?: unknown;
  onDidCreate: (handler: (uri: unknown) => void) => { dispose: () => void };
  onDidChange: (handler: (uri: unknown) => void) => { dispose: () => void };
  onDidDelete: (handler: (uri: unknown) => void) => { dispose: () => void };
  dispose: () => void;
  // Test helpers
  _simulateCreate: (uri: unknown) => void;
  _simulateChange: (uri: unknown) => void;
  _simulateDelete: (uri: unknown) => void;
}

/** Storage for all created file watchers (for test inspection) */
export const _mockFileWatchers: MockFileSystemWatcher[] = [];

/** Clear all mock file watchers (call in beforeEach) */
export function _clearMockFileWatchers(): void {
  _mockFileWatchers.length = 0;
}

/**
 * Create a mock FileSystemWatcher that captures event handlers.
 * The watcher is automatically added to _mockFileWatchers for test inspection.
 */
export function createMockFileSystemWatcher(): MockFileSystemWatcher {
  const handlers = {
    create: [] as Array<(uri: unknown) => void>,
    change: [] as Array<(uri: unknown) => void>,
    delete: [] as Array<(uri: unknown) => void>,
  };

  const watcher: MockFileSystemWatcher = {
    onDidCreate: (handler) => {
      handlers.create.push(handler);
      return { dispose: () => {} };
    },
    onDidChange: (handler) => {
      handlers.change.push(handler);
      return { dispose: () => {} };
    },
    onDidDelete: (handler) => {
      handlers.delete.push(handler);
      return { dispose: () => {} };
    },
    dispose: () => {},
    _simulateCreate: (uri) => handlers.create.forEach(h => h(uri)),
    _simulateChange: (uri) => handlers.change.forEach(h => h(uri)),
    _simulateDelete: (uri) => handlers.delete.forEach(h => h(uri)),
  };

  _mockFileWatchers.push(watcher);
  return watcher;
}

// Override workspace.createFileSystemWatcher to use the mock factory
workspace.createFileSystemWatcher = ((pattern?: unknown) => {
  const watcher = createMockFileSystemWatcher();
  watcher._pattern = pattern;
  return watcher;
}) as unknown as typeof workspace.createFileSystemWatcher;

/**
 * RelativePattern mock for file watchers
 */
export class RelativePattern {
  base: string;
  pattern: string;
  constructor(base: string | { uri: { fsPath: string } }, pattern: string) {
    this.base = typeof base === 'string' ? base : base.uri.fsPath;
    this.pattern = pattern;
  }
}
