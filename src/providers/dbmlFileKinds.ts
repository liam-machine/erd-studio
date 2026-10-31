/**
 * The three kinds of `.dbml` file a DBML project keeps, as VS Code sees them:
 * a language mode each (chosen by path in `package.json`'s `languages`, all
 * sharing the one grammar, language configuration and formatter) and a light
 * and dark icon each, which the Explorer and tabs show through the language
 * and ERD Studio's own trees show through `iconPath`.
 *
 * - `<layer>/diagrams/<name>.dbml` → `dbml-diagram` (the canvas opens it);
 * - `<layer>/tables/<schema>/<name>.dbml` → `dbml-table`;
 * - `<layer>/relationships/<name>.dbml` → `dbml-relationships`;
 * - any other `.dbml` (an export, a file outside `.erd-studio`) stays `dbml`.
 *
 * The paths in {@link dbmlFileIconPath} are the ones `package.json` names, so
 * the trees and the Explorer draw the same files. Host only (imports `vscode`).
 */

import * as vscode from 'vscode';

/** The language id `package.json` contributes for each kind of DBML project file. */
export const DBML_KIND_LANGUAGE_IDS = {
  table: 'dbml-table',
  relationships: 'dbml-relationships',
  diagram: 'dbml-diagram',
} as const;

/** Every language id a `.dbml` file can have: plain `dbml` and the three kinds. The formatter registers for all four. */
export const DBML_LANGUAGE_IDS = ['dbml', 'dbml-table', 'dbml-relationships', 'dbml-diagram'] as const;

/** A kind of DBML project file with its own language mode and icon. */
export type DbmlFileKind = keyof typeof DBML_KIND_LANGUAGE_IDS;

/** A kind's light and dark icon, relative to the extension root, as `package.json` writes them. */
export function dbmlFileIconPath(kind: DbmlFileKind): { light: string; dark: string } {
  return {
    light: `./media/file-icons/dbml-${kind}-light.svg`,
    dark: `./media/file-icons/dbml-${kind}-dark.svg`,
  };
}

/** A resolver tree providers take for their DBML rows' icons (`dbmlFileIcon` bound to the extension). */
export type DbmlFileIconResolver = (kind: DbmlFileKind) => { light: vscode.Uri; dark: vscode.Uri };

const iconCache = new Map<string, { light: vscode.Uri; dark: vscode.Uri }>();

/** A kind's icon as a tree item's `iconPath`: the two SVGs under `extensionUri`, built once per kind. */
export function dbmlFileIcon(extensionUri: vscode.Uri, kind: DbmlFileKind): { light: vscode.Uri; dark: vscode.Uri } {
  const key = `${extensionUri.toString()}\n${kind}`;
  let icon = iconCache.get(key);
  if (!icon) {
    const rel = dbmlFileIconPath(kind);
    const segments = (p: string) => p.replace(/^\.\//, '').split('/');
    icon = {
      light: vscode.Uri.joinPath(extensionUri, ...segments(rel.light)),
      dark: vscode.Uri.joinPath(extensionUri, ...segments(rel.dark)),
    };
    iconCache.set(key, icon);
  }
  return icon;
}
