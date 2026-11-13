/**
 * A sidebar row's click and double-click (the Table Library's tables and the
 * Relationships view's relationships, in the native views and the glass
 * sidebar alike).
 *
 * **Where a click goes** ({@link chooseDiagram}): a row's click takes the user
 * to its table (or relationship line) on a diagram, by one rule:
 *
 * a. the diagram the user is looking at shows it: highlighted there, nothing
 *    asked and nothing opened (even when other diagrams show it too);
 * b. else exactly one diagram shows it: that diagram opens;
 * c. else several do: a quick pick asks which (never a guess);
 * d. none does: the caller opens the file instead (with a status-bar line).
 *
 * "The diagram the user is looking at" is the active editor when it is a
 * diagram, else the diagram editor last active while it is still open and on
 * screen (`RelationshipsViewDeps.lookingAtDiagram`).
 *
 * **Double-click** ({@link RowActivations}): VS Code's tree views have no
 * double-click event, so a second activation of the same row within
 * {@link DOUBLE_CLICK_MS} is one (the usual approach). The first click has
 * already run the rule above; the second cancels whatever that click still
 * waits on (its quick pick: the token given to it), waits for it to finish
 * (so a diagram it was opening never lands over the file), then opens the
 * row's file. The glass page has a real `dblclick`: it reaches the same
 * {@link RowActivations.settle} through the row's secondary command.
 *
 * No `vscode` value at import time beyond the CancellationTokenSource the
 * tracker makes, so the decision is a pure function the tests drive.
 */
import * as path from 'path';
import * as vscode from 'vscode';

import { log } from '../services/logger';

/** Two activations of one row closer than this are a double-click (a typical OS double-click time). */
export const DOUBLE_CLICK_MS = 500;

/** How long a double-click waits for its first click to finish before opening the file anyway. */
const SETTLE_WAIT_MS = 2000;

/** Where a row's click takes the user (see the rule in the module comment). */
export type DiagramChoice =
  /** (a) The diagram the user is looking at shows it: highlight it there. */
  | { kind: 'here'; filePath: string }
  /** (b) The only diagram that shows it: open it. */
  | { kind: 'open'; filePath: string }
  /** (c) Several show it and the user is looking at none of them: ask. */
  | { kind: 'pick' }
  /** (d) No diagram shows it. */
  | { kind: 'none' };

const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * The rule a row's click follows, given the diagrams that show the row's
 * table (or both ends of its relationship) and the diagram the user is
 * looking at (undefined when none is). Pure.
 */
export function chooseDiagram(shownOn: readonly string[], lookingAt: string | undefined): DiagramChoice {
  if (lookingAt !== undefined) {
    const here = shownOn.find((p) => samePath(p, lookingAt));
    if (here !== undefined) return { kind: 'here', filePath: here };
  }
  if (shownOn.length === 1) return { kind: 'open', filePath: shownOn[0] };
  if (shownOn.length > 1) return { kind: 'pick' };
  return { kind: 'none' };
}

/**
 * The diagram a table row's click would NOT choose among the ones that show
 * it, for Show on Another Diagram…: the one it highlights (a) or opens (b) is
 * left out; with several and none in front (c) the click asks, so none is.
 */
export function diagramTheClickChooses(shownOn: readonly string[], lookingAt: string | undefined): string | undefined {
  const choice = chooseDiagram(shownOn, lookingAt);
  return choice.kind === 'here' || choice.kind === 'open' ? choice.filePath : undefined;
}

/** A row's identity for the double-click check: its kind and what it names (never an object identity, which a refresh replaces). */
export function rowActivationKey(node: unknown): string | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const n = node as { type?: unknown; filePath?: unknown; name?: unknown; parentId?: unknown; side?: unknown; entry?: unknown };
  if (n.type === 'model' && typeof n.filePath === 'string') return `table:${path.resolve(n.filePath).toLowerCase()}`;
  if (n.type === 'relationship' && typeof n.entry === 'object' && n.entry !== null) {
    const e = n.entry as { fromModel?: unknown; toModel?: unknown; fromColumns?: unknown; toColumns?: unknown };
    const cols = (c: unknown): string => (Array.isArray(c) ? c.join(',') : '');
    return `rel:${String(n.parentId)}|${String(n.side)}|${String(e.fromModel)}.${cols(e.fromColumns)}|${String(e.toModel)}.${cols(e.toColumns)}`.toLowerCase();
  }
  return undefined;
}

interface Activation {
  readonly key: string;
  readonly at: number;
  readonly source: vscode.CancellationTokenSource;
  done: Promise<void>;
  /** Its double-click has been taken (a third click starts afresh). */
  doubled: boolean;
}

/**
 * Tells a double-click from a click for rows whose view gives no double-click
 * event, and lets a double-click that arrives by its own route (the glass
 * page's `dblclick`) close what the first click opened. One per window.
 */
export class RowActivations {
  private last: Activation | undefined;

  constructor(private readonly now: () => number = () => Date.now(), private readonly windowMs = DOUBLE_CLICK_MS) {}

  /**
   * A row was activated (clicked, or Enter): run `primary` with a token that
   * a double-click cancels, or, when this is the second activation of the
   * same row within the window, `secondary` once the first has settled.
   */
  async click(key: string | undefined, primary: (token: vscode.CancellationToken) => Promise<void>, secondary: () => Promise<void>): Promise<void> {
    const t = this.now();
    const last = this.last;
    if (key !== undefined && last && last.key === key && !last.doubled && t - last.at <= this.windowMs) {
      last.doubled = true;
      await this.finish(last);
      await secondary();
      return;
    }
    // A click on another row: whatever the last one still asks is moot.
    if (last && !last.doubled) last.source.cancel();
    const source = new vscode.CancellationTokenSource();
    const activation: Activation = { key: key ?? '', at: t, source, done: Promise.resolve(), doubled: key === undefined };
    this.last = activation;
    activation.done = primary(source.token).catch((err: unknown) => {
      log.warn(`[ERD Studio] A sidebar row's click failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await activation.done;
  }

  /**
   * A double-click is opening the row's file by its own route: cancel what
   * the last click still waits on (its quick pick) and wait for that click
   * to finish, so nothing it opens lands over the file. At once when none.
   */
  async settle(): Promise<void> {
    const last = this.last;
    if (!last) return;
    last.doubled = true;
    await this.finish(last);
  }

  private async finish(activation: Activation): Promise<void> {
    activation.source.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([activation.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, SETTLE_WAIT_MS); })]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
