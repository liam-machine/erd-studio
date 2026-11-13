/**
 * Where a project from before 2.0 (YAML/JSON storage) is offered Convert
 * Project to DBML, and when. vscode-free, so the rules are unit tested.
 *
 * A pre-2.0 project that already has diagrams used to meet only "This project
 * has 1 ERD Studio diagram. Open sales" on opening, and its sidebar never
 * named Convert: the empty Diagrams view's Convert entry is a welcome view,
 * drawn only while the tree has no rows (onboarding story 08). Now:
 *
 * - **the opening notice** (the window's one activation prompt) leads with
 *   **Convert to DBML…** and keeps **Open <diagram>** as the second button,
 *   when the canvas's own Convert offer would be made
 *   ({@link convertOfferApplies}, the same checks);
 * - **the Diagrams view** shows a **Convert to DBML…** row above the layers
 *   ({@link convertRowShows}) until the project is DBML, the offer was turned
 *   down for good in this workspace (Don't Ask Again) or everywhere
 *   (`erdStudio.dbml.offerConvert`);
 * - **the canvas** keeps an information button ("i", at the end of the
 *   toolbar's identity island; #305) with a card and **Convert to DBML…**,
 *   on the logical stage, for as long as {@link convertOfferApplies} holds
 *   (`SemanticEditorProvider.convertInfoShows`, the `convertOffer` message):
 *   the canvas offer's checks without its once-a-session flag, the window's
 *   one prompt or the start suggestion's cap, since it is not a prompt. A run
 *   that was refused or left only files to fix with nothing changed since
 *   (`goesNowhere`) hides it, as its button would lead to the same refusal;
 *   the Diagrams view's row stays, and the button returns once a file changes.
 *
 * Besides these, the canvas's once-a-session modal
 * (`SemanticEditorProvider.maybeOfferDbmlConversion`) and the palette command
 * `erdStudio.convertProjectToDbml`.
 */

import type { DbmlConversionCandidates } from './dbmlConversionFiles';

export interface ConvertOfferState {
  /** `projectStorageOf()`: what the project writes. */
  storage: 'dbml' | 'yaml' | 'mixed';
  /** "Don't Ask Again" on the Convert offer, in this workspace. */
  declined: boolean;
  /** `erdStudio.dbml.offerConvert` (default on). */
  offerSetting: boolean;
}

/** Whether the Diagrams view shows its Convert to DBML… row (a quiet row, so no file listing). */
export function convertRowShows(state: ConvertOfferState): boolean {
  return state.storage !== 'dbml' && !state.declined && state.offerSetting;
}

/**
 * Whether opening the project offers Convert, by the canvas offer's checks
 * (`SemanticEditorProvider.maybeOfferDbmlConversion`): YAML or mixed, not
 * declined or turned off, something to convert, no layer called `tables`
 * (Convert would refuse), and not a run that was refused or left only files
 * to fix with nothing changed since.
 */
export function convertOfferApplies(state: ConvertOfferState & {
  candidates: () => DbmlConversionCandidates;
  goesNowhere: () => boolean;
}): boolean {
  if (!convertRowShows(state)) return false;
  const candidates = state.candidates();
  if (candidates.tablesDirIsLayer || candidates.files === 0) return false;
  return !state.goesNowhere();
}

/** The opening notice's Convert button (the panel it opens lists every change first). */
export const CONVERT_NOTICE_BUTTON = 'Convert to DBML…';

/** The opening notice in a project to convert: what it has, where it is from, and that converting keeps the diagrams. */
export function convertNoticeMessage(diagrams: number): string {
  return `This project has ${diagrams} ERD Studio diagram${diagrams === 1 ? '' : 's'}, from an older ERD Studio. ` +
    'Convert it once to DBML, an open format: your diagrams stay as they are.';
}

/** The Diagrams view's row. */
export const CONVERT_ROW_LABEL = 'Convert to DBML…';
export const CONVERT_ROW_DESCRIPTION = 'from an older ERD Studio';
export const CONVERT_ROW_TOOLTIP =
  'This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables and diagrams stay as they are. ' +
  'You see every change before anything is written.';
