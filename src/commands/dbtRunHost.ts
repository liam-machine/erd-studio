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
  /**
   * Re-read the manifest, bring `uri`'s canvas to the front and switch it to
   * Physical (`openPhysicalCanvas`). Resolves true when a canvas switched.
   */
  openPhysical(uri: vscode.Uri): Promise<boolean>;
}

/** The canvas operations Open Physical view uses (`SemanticEditorProvider`). */
export interface PhysicalCanvases {
  /** False when no live canvas is open for `uri`. */
  revealCanvas(uri: vscode.Uri): boolean;
  physicalSwitchTarget(origin?: vscode.Uri): vscode.Uri | undefined;
  switchStageForUri(uri: vscode.Uri, stage: 'physical'): void;
}

/**
 * **Open Physical view**. The success notice is non-modal and can wait in the
 * notification centre, so the canvas it named may have closed since: then
 * another open logical canvas switches, else `reopen` opens the diagram
 * again (resolving false when it can't) and that one switches.
 */
export async function openPhysicalCanvas(
  canvases: PhysicalCanvases,
  uri: vscode.Uri,
  reopen: (uri: vscode.Uri) => Promise<boolean>,
): Promise<boolean> {
  if (canvases.revealCanvas(uri)) {
    canvases.switchStageForUri(uri, 'physical');
    return true;
  }
  const other = canvases.physicalSwitchTarget(undefined);
  if (other && canvases.revealCanvas(other)) {
    canvases.switchStageForUri(other, 'physical');
    return true;
  }
  if (!(await reopen(uri))) return false;
  // switchStageForUri waits for the reopened canvas to register.
  canvases.switchStageForUri(uri, 'physical');
  return true;
}

let host: DbtRunHost | undefined;

export function setDbtRunHost(h: DbtRunHost | undefined): void {
  host = h;
}

export function getDbtRunHost(): DbtRunHost | undefined {
  return host;
}
