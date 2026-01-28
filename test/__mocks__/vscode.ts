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
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: 'file', path: uri }),
  joinPath: (base: { path: string }, ...segments: string[]) => ({
    fsPath: [base.path, ...segments].join('/'),
    scheme: 'file',
    path: [base.path, ...segments].join('/'),
  }),
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
