/**
 * The QuickPick flow that chooses what Draw from dbt draws: a scope (a dbt
 * folder or a connected cluster) or a hand-picked list, capped at
 * `DRAFT_MODEL_LIMIT`. Shared by the Draw from dbt command and the canvas's
 * "add models from dbt" batch add. Only the UI lives here; the scopes and the
 * draft itself come from `src/services/dbtDraft.ts`.
 */

import * as vscode from 'vscode';

import {
  DRAFT_MODEL_LIMIT,
  customDraftScope,
  narrowDraftScope,
  type DraftModelEntry,
  type DraftScope,
} from '../services/dbtDraft';
import { normaliseName } from '../services/nameUtils';

export interface PickDraftScopeOptions {
  /** Every draftable model, for "Choose models…" (from `listDraftModels`). */
  models: readonly DraftModelEntry[];
  /** Names to leave out everywhere — e.g. the models already in the open domain. */
  excludeNames?: Iterable<string>;
  /** Defaults to `DRAFT_MODEL_LIMIT`. */
  limit?: number;
  /** QuickPick title (e.g. "Draw from dbt"). */
  title?: string;
}

export interface DraftScopePick {
  scope: DraftScope;
  /** What to draw, in order, at most `limit`. */
  modelNames: string[];
}

type ScopeItem = vscode.QuickPickItem & { scope?: DraftScope; choose?: true };
type ModelItem = vscode.QuickPickItem & { modelName: string };

/** Label of the last item in the first list. */
export const CHOOSE_MODELS_LABEL = '$(checklist) Choose models…';

/**
 * Ask what to draw. Undefined when the user cancels at any step, or when
 * nothing is left to offer once `excludeNames` is applied — callers that need
 * to tell those apart check `scopes` / `models` first.
 */
export async function pickDraftScope(
  scopes: readonly DraftScope[],
  opts: PickDraftScopeOptions,
): Promise<DraftScopePick | undefined> {
  const limit = opts.limit ?? DRAFT_MODEL_LIMIT;
  const excluded = new Set([...(opts.excludeNames ?? [])].map(normaliseName));
  const keep = (name: string): boolean => !excluded.has(normaliseName(name));

  const models = opts.models.filter((m) => keep(m.name));
  const available = scopes
    .map((s) => narrowDraftScope(s, s.modelNames.filter(keep)))
    .filter((s) => s.count > 0);
  if (available.length === 0 && models.length === 0) { return undefined; }

  const items: ScopeItem[] = available.map((scope) => ({
    label: `${scope.kind === 'cluster' ? '$(type-hierarchy)' : '$(folder)'} ${scope.label}`,
    description: scope.count > limit ? `${scope.description}, pick up to ${limit}` : scope.description,
    detail: scope.detail,
    scope,
  }));
  if (models.length > 0) {
    items.push({
      label: CHOOSE_MODELS_LABEL,
      description: `pick up to ${limit} of ${models.length}`,
      choose: true,
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: 'Which dbt models should the diagram start from?',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!choice) { return undefined; }

  if (choice.choose) {
    const names = await pickModels(
      models.map((m) => ({
        label: m.name,
        description: m.folder === null ? undefined : (m.folder || '(top level)'),
        detail: m.description ? truncate(m.description, 120) : undefined,
        modelName: m.name,
      })),
      limit,
      opts.title,
    );
    return names ? { scope: customDraftScope(names, models), modelNames: names } : undefined;
  }

  const scope = choice.scope!;
  if (scope.count <= limit) {
    return { scope, modelNames: [...scope.modelNames] };
  }
  // More than one draft's worth: offer the folder with the first `limit` ticked.
  const names = await pickModels(
    scope.modelNames.map((name, i) => ({ label: name, picked: i < limit, modelName: name })),
    limit,
    opts.title,
    `${scope.label} has ${scope.count} models. Keep up to ${limit}.`,
  );
  return names ? { scope: narrowDraftScope(scope, names), modelNames: names } : undefined;
}

/**
 * Multi-select until the choice fits `limit`. Choosing more shows a warning
 * and opens the list again with the same ticks; choosing none or closing it
 * cancels.
 */
async function pickModels(
  items: ModelItem[],
  limit: number,
  title: string | undefined,
  placeHolder = `Pick up to ${limit} models`,
): Promise<string[] | undefined> {
  let current = items;
  for (;;) {
    const picked = await vscode.window.showQuickPick(current, {
      title,
      placeHolder,
      canPickMany: true,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    if (!picked || picked.length === 0) { return undefined; }
    if (picked.length <= limit) {
      // Keep the list's order, not the order of ticking.
      const chosen = new Set(picked.map((p) => p.modelName));
      return current.filter((i) => chosen.has(i.modelName)).map((i) => i.modelName);
    }
    const again = await vscode.window.showWarningMessage(
      `You picked ${picked.length} models. A draft holds up to ${limit}, so untick ${picked.length - limit}.`,
      'Choose Again',
    );
    if (again !== 'Choose Again') { return undefined; }
    const chosen = new Set(picked.map((p) => p.modelName));
    current = current.map((i) => ({ ...i, picked: chosen.has(i.modelName) }));
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
