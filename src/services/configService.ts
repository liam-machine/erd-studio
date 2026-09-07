import * as vscode from 'vscode';

/**
 * Settings that may only ever be read from the user's own (global) settings.
 *
 * A repository can ship a `.vscode/settings.json`, and a workspace value
 * normally wins over the user's. For the feedback analysis that would mean a
 * checked-in file could point the request — and the API key stored in secret
 * storage that travels with it — at a host of the repo author's choosing, or
 * silently switch a destination the user has decided about on or off. These
 * keys are contributed with `"scope": "machine"`, which already keeps workspace
 * values out of `inspect()`; this list is the belt to that pair of braces,
 * because {@link getErdStudioSetting} reads `inspect()` directly rather than
 * going through `get()` and so does not inherit VS Code's own scope filtering.
 *
 * Keys are written without the `erdStudio.` / `dbtSemantic.` prefix, exactly as
 * they are passed to {@link getErdStudioSetting}.
 */
export const USER_SCOPED_SETTINGS: ReadonlySet<string> = new Set([
  'feedback.aiAssist',
  'feedback.endpoint',
  'feedback.model',
  'feedback.hostedFallback',
]);

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
 *
 * A key in {@link USER_SCOPED_SETTINGS} skips the folder and workspace steps
 * entirely — only the global value is honoured.
 */
export function getErdStudioSetting<T>(key: string, defaultValue: T): T {
  const current = vscode.workspace.getConfiguration('erdStudio').inspect<T>(key);
  const legacy = vscode.workspace.getConfiguration('dbtSemantic').inspect<T>(key);

  if (USER_SCOPED_SETTINGS.has(key)) {
    return current?.globalValue ?? legacy?.globalValue ?? defaultValue;
  }

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
