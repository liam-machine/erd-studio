// Manual mock of the vscode module for Vitest unit tests.
// Add stubs here as services are implemented and tests need them.

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration (workspace.getConfiguration)
// ---------------------------------------------------------------------------

/** Per-scope values of one setting, mirroring `WorkspaceConfiguration.inspect()`. */
export interface MockConfigValues<T = unknown> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/** Configured settings keyed by `<section>.<key>` (e.g. `erdStudio.semanticDir`). */
const _mockConfigValues = new Map<string, MockConfigValues>();

/** Configure the scoped values of one setting; scopes left out stay unset. */
export function _setMockConfiguration(section: string, key: string, values: MockConfigValues): void {
  _mockConfigValues.set(`${section}.${key}`, { ...values });
}

/** Forget every configured setting (call in beforeEach). */
export function _resetMockConfiguration(): void {
  _mockConfigValues.clear();
}

/** Effective value the way VS Code resolves it: folder > workspace > global > default. */
function effectiveConfigValue(values: MockConfigValues | undefined): unknown {
  return (
    values?.workspaceFolderValue ??
    values?.workspaceValue ??
    values?.globalValue ??
    values?.defaultValue
  );
}

/** `vscode.ConfigurationTarget`, which `update()` takes as its scope. */
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

/** Which `MockConfigValues` field a ConfigurationTarget writes. */
const CONFIG_TARGET_FIELD: Record<number, keyof MockConfigValues> = {
  [ConfigurationTarget.Global]: 'globalValue',
  [ConfigurationTarget.Workspace]: 'workspaceValue',
  [ConfigurationTarget.WorkspaceFolder]: 'workspaceFolderValue',
};

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: (key: string, defaultValue?: unknown) => {
      const values = _mockConfigValues.get(section ? `${section}.${key}` : key);
      return effectiveConfigValue(values) ?? defaultValue;
    },
    /** Scoped values as VS Code reports them; every scope is undefined when nothing is configured. */
    inspect: (key: string) => {
      const fullKey = section ? `${section}.${key}` : key;
      return { key: fullKey, ...(_mockConfigValues.get(fullKey) ?? {}) } as { key: string } & MockConfigValues;
    },
    /**
     * Write one scope of a setting, so a test can read back what production
     * code actually persisted. Defaults to Global, as VS Code does when no
     * target is given and the setting has no workspace value.
     */
    update: async (key: string, value: unknown, target: number = ConfigurationTarget.Global) => {
      const fullKey = section ? `${section}.${key}` : key;
      const field = CONFIG_TARGET_FIELD[target] ?? 'globalValue';
      const current = _mockConfigValues.get(fullKey) ?? {};
      if (value === undefined) {
        delete current[field];
      } else {
        current[field] = value;
      }
      _mockConfigValues.set(fullKey, current);
    },
  }),
  workspaceFolders: [] as Array<{ uri: { fsPath: string }; name?: string; index?: number }>,
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
  showOpenDialog: async () => _mockOpenDialogResult,
  setStatusBarMessage: (_message: string, _hideAfterTimeout?: number) => ({ dispose: () => {} }),
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showTextDocument: async () => undefined,
  /** Runs the task immediately with a no-op progress reporter. */
  withProgress: async <R>(
    _options: unknown,
    task: (progress: { report: (value: unknown) => void }, token: unknown) => Thenable<R>,
  ): Promise<R> =>
    task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  registerCustomEditorProvider: () => ({ dispose: () => {} }),
  registerFileDecorationProvider: () => ({ dispose: () => {} }),
  createTreeView: (_viewId?: string, _options?: unknown) => ({ dispose: () => {} }),
  createStatusBarItem: (_alignment?: unknown, _priority?: number): MockStatusBarItem => ({
    text: '',
    tooltip: undefined,
    command: undefined,
    backgroundColor: undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  tabGroups: {
    all: [] as Array<{ tabs: Array<{ input: unknown }> }>,
    /** Set `activeTab` to `{ input: new TabInputCustom(uri, viewType) }` to simulate a focused canvas. */
    activeTabGroup: { activeTab: undefined as { input: unknown } | undefined },
  },
  /** Open terminals — createTerminal adds to this list; tests may splice to simulate close. */
  terminals: [] as MockTerminal[],
  createTerminal: (options?: { name?: string; cwd?: string }): MockTerminal => {
    const terminal = createMockTerminal(options?.name ?? 'terminal');
    window.terminals.push(terminal);
    return terminal;
  },
};

/** Minimal mock of vscode.StatusBarItem. */
export interface MockStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

/** Mirrors `vscode.version`. */
export const version = '1.85.0-mock';

export const env = {
  /** Resolves true (browser opened); spy on it to assert the URL a bug report opens. */
  openExternal: async (_target: unknown): Promise<boolean> => true,
  clipboard: {
    writeText: async (_text: string): Promise<void> => {},
    readText: async (): Promise<string> => '',
  },
};

/** Minimal mock of vscode.Terminal for launch-in-terminal handlers. */
export interface MockTerminal {
  name: string;
  exitStatus: { code: number | undefined } | undefined;
  show: () => void;
  sendText: (text: string, addNewLine?: boolean) => void;
  dispose: () => void;
  /** Test helper: every string passed to sendText, in order. */
  _sentText: string[];
}

export function createMockTerminal(name: string): MockTerminal {
  const terminal: MockTerminal = {
    name,
    exitStatus: undefined,
    show: () => {},
    sendText: (text: string) => {
      if (terminal.exitStatus !== undefined || !window.terminals.includes(terminal)) {
        throw new Error('Terminal has already been disposed');
      }
      terminal._sentText.push(text);
    },
    dispose: () => {
      terminal.exitStatus = { code: undefined };
      const idx = window.terminals.indexOf(terminal);
      if (idx !== -1) window.terminals.splice(idx, 1);
    },
    _sentText: [],
  };
  return terminal;
}

/** Minimal mock of vscode.TabInputCustom for the recovery service. */
export class TabInputCustom {
  constructor(public readonly uri: unknown, public readonly viewType: string) {}
}

/** Every command registered via commands.registerCommand, in registration order. */
export const _registeredCommands: Array<{ command: string; callback: (...args: any[]) => unknown }> = [];

/** Forget every registered command (call in beforeEach when a test runs activate()). */
export function _resetRegisteredCommands(): void {
  _registeredCommands.length = 0;
}

export const commands = {
  /** Records the registration; like VS Code, registering an id twice throws. */
  registerCommand: (command: string, callback: (...args: any[]) => unknown) => {
    if (_registeredCommands.some((entry) => entry.command === command)) {
      throw new Error(`command '${command}' already exists`);
    }
    const entry = { command, callback };
    _registeredCommands.push(entry);
    return {
      dispose: () => {
        const idx = _registeredCommands.indexOf(entry);
        if (idx !== -1) _registeredCommands.splice(idx, 1);
      },
    };
  },
  /** Runs the registered handler when one exists (mirrors VS Code); resolves undefined otherwise. */
  executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
    const entry = _registeredCommands.find((e) => e.command === command);
    return entry ? await entry.callback(...args) : undefined;
  },
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

export class FileDecoration {
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor,
  ) {}
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
    _simulateDispose: () => {
      for (const handler of disposeHandlers) {
        handler();
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

// ---------------------------------------------------------------------------
// Open dialog (unused by the current design; present so a host-side picker
// does not require another mock change)
// ---------------------------------------------------------------------------

let _mockOpenDialogResult: Array<{ fsPath: string }> | undefined;

/** Set what `window.showOpenDialog` resolves to; `undefined` means "cancelled". */
export function _setMockOpenDialogResult(result: Array<{ fsPath: string }> | undefined): void {
  _mockOpenDialogResult = result;
}

export function _resetMockOpenDialogResult(): void {
  _mockOpenDialogResult = undefined;
}

// ---------------------------------------------------------------------------
// Language Model API (feature-detected in production — absent by default here)
// ---------------------------------------------------------------------------

export interface MockLanguageModel {
  id: string;
  name: string;
  /** Text the model returns for any request. */
  reply: string;
  /**
   * When set, `sendRequest` rejects with this instead of replying — what VS
   * Code does when the user dismisses its language model access dialog.
   */
  error?: unknown;
}

/** The subset of `vscode.lm` the feature-detection shim reaches for. */
export interface MockLanguageModelNamespace {
  selectChatModels(selector?: { vendor?: string; family?: string }): Promise<
    Array<{
      id: string;
      name: string;
      sendRequest(
        messages: unknown[],
        options?: unknown,
        token?: unknown,
      ): Promise<{ text: AsyncIterable<string> }>;
    }>
  >;
}

/**
 * `vscode.lm` — undefined unless a test installs one, so the production
 * feature-detection path (`typeof api.lm?.selectChatModels === 'function'`)
 * behaves exactly as it does on a VS Code 1.85 host, where the namespace does
 * not exist at all.
 *
 * These are `let` exports rather than properties on a frozen namespace object
 * because a module namespace cannot gain new keys at runtime; the ESM live
 * binding gives production code the current value on every read.
 */
export let lm: MockLanguageModelNamespace | undefined;

export let LanguageModelChatMessage: { User(content: string): unknown } | undefined;

let _mockLanguageModels: MockLanguageModel[] | null = null;

/**
 * Install a fake `vscode.lm`. Pass `null`/`undefined` (the default) to remove
 * the namespace, which is what a VS Code 1.85 host looks like.
 */
export function _setMockLanguageModels(models: MockLanguageModel[] | null | undefined): void {
  _mockLanguageModels = models ?? null;
  if (_mockLanguageModels === null) {
    lm = undefined;
    LanguageModelChatMessage = undefined;
    return;
  }
  lm = {
    selectChatModels: async (_selector?: { vendor?: string; family?: string }) =>
      (_mockLanguageModels ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        sendRequest: async () => {
          if (model.error !== undefined) throw model.error;
          return {
            text: (async function* () {
              yield model.reply;
            })(),
          };
        },
      })),
  };
  LanguageModelChatMessage = {
    User: (content: string) => ({ role: 'user', content }),
  };
}

/** Remove the fake `vscode.lm` (call in beforeEach). */
export function _resetMockLanguageModels(): void {
  _setMockLanguageModels(null);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface MockAuthSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: string[];
}

let _mockGithubSession: MockAuthSession | null = null;
let _mockAuthError: unknown = null;

/** Install (or clear) the session returned by `authentication.getSession`. */
export function _setMockGithubSession(session: MockAuthSession | null): void {
  _mockGithubSession = session;
}

/**
 * Make `authentication.getSession` reject, as it does on a host with no GitHub
 * authentication provider registered (the built-in extension disabled, some
 * remote hosts). Pass `null` to go back to resolving normally.
 */
export function _setMockAuthError(error: unknown): void {
  _mockAuthError = error;
}

export function _resetMockGithubSession(): void {
  _mockGithubSession = null;
  _mockAuthError = null;
}

export const authentication = {
  /**
   * Resolves `undefined` by default, so the silent "no session" path is what a
   * test gets unless it opts in. `createIfNone` mints one, mirroring the
   * interactive sign-in.
   */
  getSession: async (
    _providerId: string,
    _scopes: readonly string[],
    options?: { silent?: boolean; createIfNone?: boolean },
  ): Promise<MockAuthSession | undefined> => {
    if (_mockAuthError) throw _mockAuthError;
    if (_mockGithubSession) return _mockGithubSession;
    if (options?.createIfNone) {
      _mockGithubSession = {
        id: 'mock-session',
        accessToken: 'mock-token',
        account: { id: '1', label: 'mockuser' },
        scopes: ['read:user'],
      };
      return _mockGithubSession;
    }
    return undefined;
  },
  onDidChangeSessions: (_listener: (e: unknown) => void) => ({ dispose: () => {} }),
};

// ---------------------------------------------------------------------------
// ExtensionContext building blocks (SecretStorage / Memento)
// ---------------------------------------------------------------------------

/** Minimal mock of vscode.SecretStorage. */
export interface MockSecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange: (listener: (e: { key: string }) => void) => { dispose: () => void };
  /** Test helper: seed a value without going through store(). */
  _seed(key: string, value: string): void;
}

/** Build a Map-backed SecretStorage for an ExtensionContext fake. */
export function createMockSecretStorage(): MockSecretStorage {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key),
    store: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    onDidChange: () => ({ dispose: () => {} }),
    _seed: (key, value) => {
      store.set(key, value);
    },
  };
}

/** Minimal mock of vscode.Memento — `get` / `update` only, as production uses. */
export interface MockMemento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  /** Test helper: seed a value without going through update(). */
  _seed(key: string, value: unknown): void;
}

/** Build a Map-backed Memento for an ExtensionContext fake. */
export function createMockMemento(seed?: Iterable<readonly [string, unknown]>): MockMemento {
  const store = new Map<string, unknown>(seed ?? []);
  return {
    get: <T>(key: string, defaultValue?: T) =>
      (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    _seed: (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

/** The pieces of an ExtensionContext fake every suite needs. */
export interface MockExtensionContextOptions {
  /** Root the globalStorageUri is placed under. */
  storageRoot: string;
  extensionRoot: string;
  packageJSON?: unknown;
  globalStateSeed?: Iterable<readonly [string, unknown]>;
  workspaceStateSeed?: Iterable<readonly [string, unknown]>;
}

/**
 * Shared ExtensionContext factory. Every fake needs `secrets` and a real
 * `globalState` now that the feedback services read both, so build them here
 * rather than repeating an object literal in each suite.
 */
export function createMockExtensionContext(options: MockExtensionContextOptions) {
  return {
    subscriptions: [] as Array<{ dispose: () => void }>,
    extension: { packageJSON: options.packageJSON ?? { version: '0.0.0-test' } },
    extensionUri: Uri.file(options.extensionRoot),
    globalStorageUri: Uri.file(`${options.storageRoot}/.global-storage`),
    globalState: createMockMemento(options.globalStateSeed),
    workspaceState: createMockMemento(options.workspaceStateSeed),
    secrets: createMockSecretStorage(),
  };
}
