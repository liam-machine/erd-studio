/**
 * ERD Studio: Suggest Relationships… — the flow on the active diagram, and
 * its QuickPick. The provider supplies the reads and the one write
 * (`SemanticEditorProvider.suggestRelationshipsOn`: `commitRelationshipWrite`
 * inside its edit queue, so every accepted relationship is one WorkspaceEdit,
 * one save and one undo step); the suggestions come from the engine through
 * `computeSuggestions`, and the words from `relationshipSuggestionReview.ts`.
 *
 * Nothing about a suggestion that is not accepted is kept anywhere.
 */

import * as vscode from 'vscode';
import type { Stage } from '../types/semantic';
import type { RelationshipWriteOp } from '../services/libraryRelationships';
import type { RelationshipSuggestion } from '../services/relationshipSuggestions';
import {
  NOTHING_STILL_APPLIES_MESSAGE,
  PHYSICAL_STAGE_MESSAGE,
  REVIEW_PAGE,
  addedMessage,
  anyDeclaredKeys,
  buildSuggestionReview,
  computeSuggestions,
  directionQuestion,
  noSuggestionsMessage,
  noTablesMessage,
  stillValid,
  suggestionWriteOps,
  type AcceptedSuggestion,
  type DirectionAnswer,
  type DirectionQuestion,
  type ReviewRow,
  type SuggestionReview,
  type SuggestionSource,
} from '../services/relationshipSuggestionReview';

export const SUGGEST_RELATIONSHIPS_COMMAND = 'erdStudio.suggestRelationships';

/** The diagram as read now: its name and what the engine reads, or why it could not be read. */
export type SuggestionRead =
  | ({ ok: true; diagramName: string } & SuggestionSource)
  | { ok: false; message: string };

export interface SuggestRelationshipsUi {
  /** The review list: the ids ticked on OK, or undefined when it was closed. `review(limit)` rebuilds it with more rows listed. */
  pick(review: (limit: number) => SuggestionReview): Promise<string[] | undefined>;
  /** One direction question; undefined when it was closed (which cancels the whole run). */
  askDirection(question: DirectionQuestion): Promise<DirectionAnswer | undefined>;
  info(message: string): void;
  error(message: string): void;
}

export interface SuggestRelationshipsDeps {
  /** The tab the canvas shows: the physical stage writes nothing. */
  stage: Stage;
  /** A dbt project (the review may name dbt's tests). */
  dbt: boolean;
  read(): Promise<SuggestionRead>;
  /** Run `fn` in the diagram's edit queue, after any edit already in flight. */
  inQueue(fn: () => Promise<void>): Promise<void>;
  /** The one write; true when it landed. It reports its own failures. */
  write(ops: RelationshipWriteOp[]): Promise<boolean>;
  ui: SuggestRelationshipsUi;
}

export type SuggestOutcome =
  | 'physical' | 'unreadable' | 'noTables' | 'none' | 'cancelled' | 'stale' | 'notWritten'
  | { written: number; dropped: number };

/** The whole command, on one diagram. */
export async function runSuggestRelationships(deps: SuggestRelationshipsDeps): Promise<SuggestOutcome> {
  const { ui } = deps;
  if (deps.stage === 'physical') {
    ui.info(PHYSICAL_STAGE_MESSAGE);
    return 'physical';
  }
  const read = await deps.read();
  if (!read.ok) {
    ui.error(read.message);
    return 'unreadable';
  }
  if (read.tables.length === 0) {
    ui.info(noTablesMessage(read.diagramName));
    return 'noTables';
  }
  const suggestions = computeSuggestions(read);
  if (suggestions.length === 0) {
    ui.info(noSuggestionsMessage(read.diagramName));
    return 'none';
  }

  const options = { diagramName: read.diagramName, dbt: deps.dbt, anyKeys: anyDeclaredKeys(read.tables) };
  const ids = await ui.pick((limit) => buildSuggestionReview(suggestions, { ...options, limit }));
  if (!ids || ids.length === 0) return 'cancelled';
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const ticked = ids.map((id) => byId.get(id)).filter((s): s is RelationshipSuggestion => s !== undefined);

  // Nothing orients these: the user says which way, one at a time, or skips; never a default.
  const accepted: AcceptedSuggestion[] = [];
  const undecided = ticked.filter((s) => s.direction === 'undecided');
  let asked = 0;
  for (const suggestion of ticked) {
    if (suggestion.direction === 'decided') {
      accepted.push({ suggestion });
      continue;
    }
    const answer = await ui.askDirection(directionQuestion(suggestion, ++asked, undecided.length));
    if (answer === undefined) return 'cancelled';
    if (answer === 'skip') continue;
    accepted.push({ suggestion, ...(answer === 'reversed' ? { reversed: true } : {}) });
  }
  if (accepted.length === 0) return 'cancelled';

  // The list may have waited a while: write only what the engine still suggests, on the diagram as it is now.
  let outcome: SuggestOutcome = 'notWritten';
  await deps.inQueue(async () => {
    const now = await deps.read();
    if (!now.ok) {
      ui.error(now.message);
      outcome = 'unreadable';
      return;
    }
    const { keep, dropped } = stillValid(accepted, computeSuggestions(now));
    if (keep.length === 0) {
      ui.info(NOTHING_STILL_APPLIES_MESSAGE);
      outcome = 'stale';
      return;
    }
    if (!(await deps.write(suggestionWriteOps(keep)))) return;
    ui.info(addedMessage(keep.length, now.diagramName, dropped));
    outcome = { written: keep.length, dropped };
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// The real UI
// ---------------------------------------------------------------------------

type RowItem = vscode.QuickPickItem & { id?: string };

function itemsOf(review: SuggestionReview): RowItem[] {
  const items: RowItem[] = [];
  for (const section of review.sections) {
    items.push({ label: section.label, kind: vscode.QuickPickItemKind.Separator });
    for (const row of section.rows) items.push(rowItem(row));
  }
  return items;
}

const rowItem = (row: ReviewRow): RowItem => ({ id: row.id, label: row.label, description: row.description, detail: row.detail, picked: row.picked });

/** The review as a multi-select QuickPick: strong rows ticked; More (a title button) lists the next page, keeping every tick. */
async function pickSuggestions(review: (limit: number) => SuggestionReview): Promise<string[] | undefined> {
  let limit = REVIEW_PAGE;
  let current = review(limit);
  const qp = vscode.window.createQuickPick<RowItem>();
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  const more: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: '' };
  const show = (keep?: Set<string>): void => {
    qp.title = current.title;
    qp.placeholder = current.placeholder;
    const items = itemsOf(current);
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.id !== undefined && (keep ? keep.has(i.id) : i.picked === true));
    qp.buttons = current.moreLabel ? [{ ...more, tooltip: current.moreLabel }] : [];
  };
  show();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string[] | undefined): void => {
      if (done) return;
      done = true;
      resolve(value);
      qp.dispose();
    };
    qp.onDidTriggerButton(() => {
      const ticked = new Set(qp.selectedItems.map((i) => i.id!).filter(Boolean));
      limit += REVIEW_PAGE;
      current = review(limit);
      show(ticked);
    });
    qp.onDidAccept(() => finish(qp.selectedItems.map((i) => i.id).filter((id): id is string => id !== undefined)));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

export function vscodeSuggestRelationshipsUi(): SuggestRelationshipsUi {
  return {
    pick: pickSuggestions,
    askDirection: async (question) => {
      const picked = await vscode.window.showQuickPick(
        question.items.map((i) => ({ label: i.label, ...(i.detail ? { detail: i.detail } : {}), answer: i.answer })),
        { title: question.title, placeHolder: question.placeholder, ignoreFocusOut: true },
      );
      return picked?.answer;
    },
    info: (message) => { void vscode.window.showInformationMessage(message); },
    error: (message) => { void vscode.window.showErrorMessage(message); },
  };
}
