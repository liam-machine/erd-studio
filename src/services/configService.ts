import * as vscode from 'vscode';

/**
 * Read an ERD Studio setting.
 *
 * The extension was originally published with `dbtSemantic.*` setting keys.
 * Users who configured those keys before the `erdStudio.*` rename must keep
 * their values, so resolution order is:
 *
 *   1. explicit `erdStudio.<key>` (folder > workspace > global)
 *   2. explicit `dbtSemantic.<key>` (folder > workspace > global)
 *   3. the provided default
 */
export function getErdStudioSetting<T>(key: string, defaultValue: T): T {
  const current = vscode.workspace.getConfiguration('erdStudio').inspect<T>(key);
  const legacy = vscode.workspace.getConfiguration('dbtSemantic').inspect<T>(key);
  return (
    current?.workspaceFolderValue ??
    current?.workspaceValue ??
    current?.globalValue ??
    legacy?.workspaceFolderValue ??
    legacy?.workspaceValue ??
    legacy?.globalValue ??
    defaultValue
  );
}
