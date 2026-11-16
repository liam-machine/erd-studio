/**
 * The built-in Git extension's answer for one folder (#332): whether it has a
 * repository open there, and whether that repository lists a remote. Used
 * only for usage telemetry (`modelShareTelemetry.ts`), so it never changes
 * anything: it never activates the extension (that is VS Code's own
 * start-up), never calls `openRepository` (which would add a repository to
 * the user's Source Control view), and reads no URL, branch or author.
 *
 * The extension's API is typed here by the few members used (its `git.d.ts`
 * is not a dependency); it exists on VS Code 1.85. `undefined` is "no
 * answer": the extension is missing, not running yet, turned off
 * (`git.enabled`), has no Git binary, or did not finish its start-up within
 * the wait.
 */

import * as vscode from 'vscode';
import { GIT_EXTENSION_ID } from '../providers/GettingStartedPanel';
import type { GitApiAnswer } from './modelShareTelemetry';

interface GitRepositoryLike {
  readonly state: { readonly remotes: readonly unknown[] };
}

interface GitApiLike {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  getRepository(uri: vscode.Uri): GitRepositoryLike | null;
}

interface GitExtensionLike {
  readonly enabled?: boolean;
  getAPI(version: 1): GitApiLike;
}

/** Resolves once `api` has finished its start-up, or `false` after `waitMs`. */
function initialized(api: GitApiLike, waitMs: number): Promise<boolean> {
  if (api.state === 'initialized') return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let listener: vscode.Disposable | undefined;
    const timer = setTimeout(() => { listener?.dispose(); resolve(false); }, waitMs);
    (timer as { unref?: () => void }).unref?.();
    listener = api.onDidChangeState((state) => {
      if (state !== 'initialized') return;
      clearTimeout(timer);
      listener?.dispose();
      resolve(true);
    });
  });
}

/** The Git extension's answer for `dir` (see the module comment). Never throws. */
export async function askGitExtension(dir: string, waitMs: number): Promise<GitApiAnswer> {
  try {
    const ext = vscode.extensions.getExtension<GitExtensionLike>(GIT_EXTENSION_ID);
    if (!ext?.isActive) return undefined;
    const exports = ext.exports;
    if (!exports || exports.enabled === false || typeof exports.getAPI !== 'function') return undefined;
    const api = exports.getAPI(1);
    if (!(await initialized(api, waitMs))) return undefined;
    const repo = api.getRepository(vscode.Uri.file(dir));
    if (!repo) return { repo: false };
    return { repo: true, hasRemote: repo.state.remotes.length > 0 };
  } catch {
    return undefined;
  }
}
