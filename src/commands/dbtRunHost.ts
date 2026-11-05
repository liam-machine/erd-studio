/**
 * What Run dbt parse needs from the running extension, set once by
 * `activate()` when the window has a dbt project: where its placeholder
 * profile may live (the extension's own global storage, never the
 * workspace), the dbt project config (target-path), and the canvas hooks for
 * **Open Physical view**. Without a host (tests, a logical-only window) Parse
 * without your credentials is unavailable, success offers no Open Physical
 * view, and the manifest is looked for at dbt's default `target/`.
 */

import type * as vscode from 'vscode';

import type { DbtProjectConfig } from '../services/dbtProjectConfig';

export interface DbtRunHost {
  /** `context.globalStorageUri.fsPath`. */
  storageDir: string;
  dbtConfig(): DbtProjectConfig;
  /** The logical canvas Open Physical view would switch: `origin` first, else the last active one. */
  physicalTarget(origin?: vscode.Uri): vscode.Uri | undefined;
  /** The canvas that asked is already on the Physical stage. */
  originIsPhysical(origin?: vscode.Uri): boolean;
  /** Re-read the manifest and switch `uri`'s canvas to Physical. */
  openPhysical(uri: vscode.Uri): void;
}

let host: DbtRunHost | undefined;

export function setDbtRunHost(h: DbtRunHost | undefined): void {
  host = h;
}

export function getDbtRunHost(): DbtRunHost | undefined {
  return host;
}
