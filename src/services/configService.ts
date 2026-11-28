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
 * `telemetry.enabled` is here for the same reason in the other direction: a
 * checked-in file must not be able to switch the user's telemetry choice, and
 * `checkKnownFixes` (the "a newer version fixes this" check) likewise.
 * `claudeSync.skipPermissions` adds `--dangerously-skip-permissions` to the
 * Claude Code launch for a sync plan: a cloned repository must not be able to
 * turn off Claude Code's permission prompts for the user.
 *
 * Keys are written without the `erdStudio.` / `dbtSemantic.` prefix, exactly as
 * they are passed to {@link getErdStudioSetting}.
 */
export const USER_SCOPED_SETTINGS: ReadonlySet<string> = new Set([
  'feedback.aiAssist',
  'feedback.endpoint',
  'feedback.model',
  'feedback.hostedFallback',
  'feedback.provider',
  'telemetry.enabled',
  'checkKnownFixes',
  'claudeSync.skipPermissions',
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

/** Where a setting's value was found: User settings, the workspace, or one folder's settings. */
export type ErdStudioSettingScope = 'user' | 'workspace' | 'folder';

/** The value {@link getErdStudioSetting} returns, with the key and the scope that held it. */
export interface ErdStudioSettingSource<T> {
  value: T;
  settingKey: `erdStudio.${string}` | `dbtSemantic.${string}`;
  scope: ErdStudioSettingScope;
}

/**
 * Where {@link getErdStudioSetting}'s value comes from (#370): the same value,
 * found by the same steps in the same order, plus which key held it (the
 * current `erdStudio.*` or the deprecated `dbtSemantic.*`) and in which
 * scope, so a message about the setting can name the one the user has to
 * open. Undefined when nothing is set, where getErdStudioSetting returns its
 * default. An explicit `""` counts as set, exactly as `??` counts it there.
 */
export function erdStudioSettingSource<T>(key: string): ErdStudioSettingSource<T> | undefined {
  const steps: ReadonlyArray<readonly [ErdStudioSettingScope, 'workspaceFolderValue' | 'workspaceValue' | 'globalValue']> =
    USER_SCOPED_SETTINGS.has(key)
      ? [['user', 'globalValue']]
      : [['folder', 'workspaceFolderValue'], ['workspace', 'workspaceValue'], ['user', 'globalValue']];
  for (const section of ['erdStudio', 'dbtSemantic'] as const) {
    const inspected = vscode.workspace.getConfiguration(section).inspect<T>(key);
    for (const [scope, field] of steps) {
      const value = inspected?.[field];
      if (value !== undefined && value !== null) return { value, settingKey: `${section}.${key}`, scope };
    }
  }
  return undefined;
}
