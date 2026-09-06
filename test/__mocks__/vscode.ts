// Manual mock of the vscode module for Vitest unit tests.
// Add stubs here as services are implemented and tests need them.

export const workspace = {
  getConfiguration: () => ({
    get: (key: string, defaultValue?: unknown) => defaultValue,
    /** `inspect` returns undefined so getErdStudioSetting falls back to defaults. */
    inspect: (_key: string) => undefined as unknown,
  }),
  /** Default applyEdit succeeds without changing anything; tests override per case. */
  applyEdit: async (_edit: unknown) => true,
  workspaceFolders: [],
  textDocuments: [] as unknown[],
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeTextDocument: () => ({ dispose: () => {} }),
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
  /** Open terminals — createTerminal adds to this list; tests may splice to simulate close. */
  terminals: [] as MockTerminal[],
  createTerminal: (options?: { name?: string; cwd?: string }): MockTerminal => {
    const terminal = createMockTerminal(options?.name ?? 'terminal');
    window.terminals.push(terminal);
    return terminal;
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

/** Minimal Position/Range/WorkspaceEdit so providers can build edits under test. */
export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class WorkspaceEdit {
  readonly edits: Array<{ uri: { fsPath: string }; range: Range; text: string }> = [];
  replace(uri: { fsPath: string }, range: Range, text: string): void {
    this.edits.push({ uri, range, text });
  }
}

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
  const messageHandlers: Array<(message: unknown) => void> = [];
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
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
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
    _simulateMessage: (message: unknown) => {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
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

/**
 * Create a mock TextDocument for use in unit tests.
 */
export function createMockTextDocument(fsPath: string, text = '{}') {
  return {
    uri: Uri.file(fsPath),
    getText: () => text,
    lineCount: text.split('\n').length,
  };
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}

// ---------------------------------------------------------------------------
// Helpers for testing FileSystemWatcher
// ---------------------------------------------------------------------------

export interface MockFileSystemWatcher {
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
workspace.createFileSystemWatcher = () => createMockFileSystemWatcher() as unknown as ReturnType<typeof workspace.createFileSystemWatcher>;

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
