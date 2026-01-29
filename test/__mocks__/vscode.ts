// Manual mock of the vscode module for Vitest unit tests.
// Add stubs here as services are implemented and tests need them.

export const workspace = {
  getConfiguration: () => ({
    get: (key: string, defaultValue?: unknown) => defaultValue,
  }),
  workspaceFolders: [],
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
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  registerCustomEditorProvider: () => ({ dispose: () => {} }),
};

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

export class ThemeIcon {
  id: string;
  constructor(id: string) {
    this.id = id;
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
