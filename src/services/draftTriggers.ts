/**
 * Draft-first: when a draft opens by itself (spec `docs/dev/draft-first.md`
 * §3). Pure: no `vscode`, no Node built-ins, no file access. The wiring reads
 * the settings, the folder's start-suggestion state and globalState, and asks
 * these functions what to do.
 */

import type { DraftSource } from '../types/draft';
import type { StartIntent } from '../types/startActions';

/** globalState key: this machine has had the automatic example draft (once per machine, §3.2). */
export const EXAMPLE_DRAFT_SHOWN_KEY = 'erdStudio.exampleDraftShown';

/** What the automatic (`sidebar`) draft shows: the folder's find, or the example. */
export type AutoDraft = 'find' | 'example';

export interface AutoDraftInput {
  /** `erdStudio.startSuggestions` is on. */
  settingOn: boolean;
  /** The folder's start-suggestion state. */
  state: {
    /** Don't Ask Again / Turn Off for this folder. */
    off?: boolean;
    /** The start suggestion was answered (Show Me, Create, …). */
    answered?: boolean;
    /** This folder has had its automatic draft. */
    draftShown?: boolean;
  };
  /** The folder holds a diagram. */
  hasDiagrams: boolean;
  /** The folder's Table Library holds a table. */
  hasTables: boolean;
  /** An ERD Studio canvas is open in this window. */
  canvasOpen: boolean;
  /** What the folder suggests (`startIntentFor`); undefined: not decided, or no folder. */
  intent: StartIntent | undefined;
  /** {@link EXAMPLE_DRAFT_SHOWN_KEY} is set. */
  exampleShownOnMachine: boolean;
}

/** The intents a draft can be built from (`convert` never is: Convert has its own review). */
const FIND_INTENTS: ReadonlySet<StartIntent> = new Set<StartIntent>(['drawFromDbt', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile']);

/**
 * Whether an automatic draft is due when the empty Diagrams view is drawn
 * (§3.2): the setting is on, the folder's suggestions are not off, the folder
 * has no diagram and no table, no canvas is open, and either the folder's
 * find has not been drafted nor its suggestion answered (`find`), or the
 * folder suggests a blank start and this machine has not had the example
 * draft (`example`). Undefined otherwise.
 */
export function autoDraftDue(input: AutoDraftInput): AutoDraft | undefined {
  if (!input.settingOn) return undefined;
  if (input.state.off === true) return undefined;
  if (input.hasDiagrams || input.hasTables || input.canvasOpen) return undefined;
  const intent = input.intent;
  if (intent === undefined) return undefined;
  if (FIND_INTENTS.has(intent)) {
    return input.state.draftShown === true || input.state.answered === true ? undefined : 'find';
  }
  if (intent === 'blank') {
    return input.exampleShownOnMachine ? undefined : 'example';
  }
  return undefined;
}

/** The draft source a start intent draws (`convert` and `blank` draw none of the user's files). */
export function draftSourceForIntent(intent: StartIntent): DraftSource | undefined {
  switch (intent) {
    case 'importSqlDdl': return 'sqlDdl';
    case 'importSemanticModel': return 'semanticModel';
    case 'importDbmlFile': return 'dbml';
    case 'drawFromDbt': return 'dbt';
    default: return undefined;
  }
}

/**
 * Whether the walkthrough opens by itself (§3.4): only in an empty window (no
 * folder) and only when it is owed. In a folder the draft takes its place.
 */
export function walkthroughAutoOpens(input: { hasFolder: boolean; owed: boolean }): boolean {
  return input.owed && !input.hasFolder;
}
