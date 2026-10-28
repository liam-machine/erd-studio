/**
 * One file write an edit plans (native DBML storage, §4.1): replace a file's
 * text, create a new file, or delete one. Pure: no `vscode`, no file access,
 * so the CLI and the planners can name it. The editor applies these through
 * one WorkspaceEdit; non-editor paths through the fs twin.
 */
export type FileWrite =
  | { kind: 'replace'; path: string; text: string }
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string };
