/**
 * The canvas toolbar's **dbt command** menu (GitHub #378): a ready-to-paste
 * `dbt build | run | test --select …` for the tables on the diagram, or the
 * ones selected. It runs nothing and writes no file: the host only puts the
 * text on the clipboard, so the developer decides when a warehouse job starts.
 *
 * Pure: the host (`SemanticEditorProvider.handleCopyDbtCommand`) supplies
 * each table's dbt model, the node the physical stage finds it as
 * (`SubjectAreaService.dbtNodeNamesOf`, in dbt's spelling), or null when it
 * is not in dbt; this module only chooses the tables and words the command
 * and its confirmation. No `vscode` import.
 */

import { normaliseName } from './nameUtils';
import type { DbtCommandVerb } from '../types/dbtCommand';

export { DBT_COMMAND_VERBS, isDbtCommandVerb, type DbtCommandVerb } from '../types/dbtCommand';

/**
 * The longest command copied without a second thought. The Windows command
 * prompt takes at most 8,191 characters on a line; past this, the diagram's
 * selector is copied instead when there is a current one.
 */
export const DBT_COMMAND_MAX_LENGTH = 8000;

/**
 * A dbt model name pasted unquoted: letters, digits, `_`, and `.` or `-`
 * after the first character. Nothing a shell (sh, zsh, PowerShell, cmd)
 * would expand, split or redirect, and none of dbt's own selector syntax
 * (`+`, `@`, `*`, `:`, `,`). A name outside it is left out, never quoted:
 * no one quoting works in every shell.
 */
const SHELL_SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Whether `name` can be pasted into a terminal as it is. */
export function isShellSafeDbtName(name: string): boolean {
  return SHELL_SAFE_NAME.test(name);
}

/** One table on the diagram, as the host found it. */
export interface DbtCommandTable {
  /** Its name on the canvas (what a selection names). */
  name: string;
  /** The dbt model it is, when the physical stage finds it in dbt; null when it is not in dbt yet. */
  dbtModel: string | null;
}

export interface DbtCommandRequest {
  verb: DbtCommandVerb;
  /** Every table on the diagram, in its order. */
  tables: readonly DbtCommandTable[];
  /** The tables selected on the canvas; none or empty means the whole diagram. */
  selected?: readonly string[];
  /**
   * The diagram's selector in selectors.yml while that file is current and
   * selects every model the list names (no `selectorNameGaps`). Asked only
   * when the command would be too long and nothing is selected.
   */
  currentSelector?: () => string | undefined;
}

/** A table on a diagram that dbt has a model for, under a name its diagram's selector does not list. */
export interface SelectorNameGap {
  /** The table's name on the diagram, which is what selectors.yml lists it by. */
  table: string;
  /** What dbt names its model. */
  dbtModel: string;
}

/**
 * The tables of one diagram its selector in selectors.yml does not select:
 * each table dbt has a model for (`dbtModel`, as `dbtNodeNamesOf` finds it)
 * whose model is not among the selector's `members`, compared exactly, as
 * dbt compares a name. selectors.yml lists a table by its name on the
 * diagram, so this is a table dbt names otherwise (`orders_fact` for
 * `fct_order`, `DIM_Customer` for `dim_customer`). A table not in dbt yet is
 * never one, and neither is a table whose model another table already put in
 * the selector.
 *
 * The one rule, for **Regenerate dbt selectors.yml**'s note and for whether
 * the dbt command may copy `--selector` in place of a long list (it may only
 * when there is none).
 */
export function selectorNameGaps(tables: readonly DbtCommandTable[], members: readonly string[]): SelectorNameGap[] {
  const selected = new Set(members);
  const gaps: SelectorNameGap[] = [];
  for (const table of tables) {
    if (table.dbtModel === null || selected.has(table.dbtModel)) continue;
    gaps.push({ table: table.name, dbtModel: table.dbtModel });
  }
  return gaps;
}

/** How many tables `selectorNameGapsNote` names before "and N more". */
export const SELECTOR_NAME_GAPS_SHOWN = 3;

/**
 * What **Regenerate dbt selectors.yml** adds to its message when dbt names
 * some tables otherwise: how many, what that means for their selectors,
 * where to get a command with dbt's names, then up to
 * `SELECTOR_NAME_GAPS_SHOWN` of them (the pointer comes before the names, so
 * a notification cut short still has it). '' when there are none. A table on
 * several diagrams is counted and named once. "dbt's files" because the
 * names come from what dbt last wrote and what the project holds, not from a
 * dbt run made now.
 */
export function selectorNameGapsNote(gaps: readonly SelectorNameGap[]): string {
  const unique = new Map<string, SelectorNameGap>();
  for (const gap of gaps) unique.set(`${gap.table}\u0000${gap.dbtModel}`, gap);
  const all = [...unique.values()];
  if (all.length === 0) return '';
  const one = all.length === 1;
  const named = all.slice(0, SELECTOR_NAME_GAPS_SHOWN).map((gap) => `${gap.table} is ${gap.dbtModel} in dbt`);
  const more = all.length - named.length;
  return `In dbt's files, ${one ? '1 table has' : `${all.length} tables have`} another name, `
    + `so ${one ? 'its selector' : 'their selectors'} may leave ${one ? 'it' : 'them'} out of a build. `
    + 'The dbt command button on a diagram\'s toolbar copies a command with dbt\'s names. '
    + `${named.join('; ')}${more > 0 ? `; and ${more} more (Show Logs lists them all)` : ''}.`;
}

export type DbtCommandResult =
  /** Copy `text`, then say `message`. */
  | { kind: 'copy'; text: string; message: string; form: 'select' | 'selector'; tooLong: boolean }
  /** Copy nothing; say `message`. */
  | { kind: 'nothing'; message: string };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 selected tables" / "the 12 tables on this diagram" (or "the table on this diagram"). */
function scopeWords(count: number, selected: boolean): string {
  if (selected) return `${plural(count, 'selected table')}`;
  return count === 1 ? 'the table on this diagram' : `the ${count} tables on this diagram`;
}

/**
 * The command for `request`, or why there is none.
 *
 *   - A selected name the diagram does not have: nothing (the selection is stale).
 *   - Tables not in dbt yet, and ones whose dbt name a shell would misread,
 *     are left out and counted in the message; with none left, nothing.
 *   - Two tables of one dbt model name it once.
 *   - Longer than `DBT_COMMAND_MAX_LENGTH`: with nothing selected and a
 *     current selector, `dbt <verb> --selector <name>`; otherwise the long
 *     command, with a warning about the Windows command prompt.
 */
export function buildDbtCommand(request: DbtCommandRequest): DbtCommandResult {
  const { verb } = request;
  const selection = request.selected && request.selected.length > 0 ? request.selected : undefined;

  let scope: DbtCommandTable[];
  if (selection) {
    const byName = new Map(request.tables.map((t) => [normaliseName(t.name), t]));
    const unknown = selection.filter((name) => !byName.has(normaliseName(name)));
    if (unknown.length > 0) {
      const named = unknown.length === 1 ? `"${unknown[0]}" is` : `${unknown.length} of the selected tables are`;
      return { kind: 'nothing', message: `Nothing copied: ${named} not on this diagram.` };
    }
    const picked = new Set<string>();
    scope = [];
    for (const name of selection) {
      const key = normaliseName(name);
      if (picked.has(key)) continue;
      picked.add(key);
      scope.push(byName.get(key)!);
    }
  } else {
    scope = [...request.tables];
  }

  if (scope.length === 0) {
    return { kind: 'nothing', message: 'Nothing copied: this diagram has no tables yet.' };
  }

  const names: string[] = [];
  const seen = new Set<string>();
  let notInDbt = 0;
  let unsafe = 0;
  for (const table of scope) {
    if (table.dbtModel === null) { notInDbt++; continue; }
    if (!isShellSafeDbtName(table.dbtModel)) { unsafe++; continue; }
    const key = table.dbtModel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(table.dbtModel);
  }

  const leftOut: string[] = [];
  if (notInDbt > 0) leftOut.push(`${notInDbt} left out: not in dbt yet.`);
  if (unsafe > 0) leftOut.push(`${unsafe} left out: ${unsafe === 1 ? 'its dbt name has' : 'their dbt names have'} characters a terminal would misread.`);

  if (names.length === 0) {
    const them = selection
      ? (scope.length === 1 ? 'the selected table' : `the ${scope.length} selected tables`)
      : (scope.length === 1 ? 'the table on this diagram' : `the ${scope.length} tables on this diagram`);
    if (unsafe === 0) {
      const none = scope.length === 1 ? `${them} is not` : `none of ${them} is`;
      return { kind: 'nothing', message: `Nothing copied: ${none} in dbt yet.` };
    }
    if (notInDbt === 0) {
      const names = scope.length === 1 ? `the dbt name of ${them} has` : `the dbt names of ${them} have`;
      return { kind: 'nothing', message: `Nothing copied: ${names} characters a terminal would misread.` };
    }
    return { kind: 'nothing', message: `Nothing copied: of ${them}, ${notInDbt} not in dbt yet and ${unsafe} with a dbt name a terminal would misread.` };
  }

  const included = scope.length - notInDbt - unsafe;
  const text = `dbt ${verb} --select ${names.join(' ')}`;
  const forWhat = included === scope.length
    ? scopeWords(scope.length, !!selection)
    : `${included} of ${scopeWords(scope.length, !!selection)}`;
  const tail = leftOut.length > 0 ? ` ${leftOut.join(' ')}` : '';

  if (text.length > DBT_COMMAND_MAX_LENGTH) {
    const selector = selection ? undefined : request.currentSelector?.();
    if (selector && isShellSafeDbtName(selector)) {
      return {
        kind: 'copy',
        text: `dbt ${verb} --selector ${selector}`,
        form: 'selector',
        tooLong: false,
        message: `Copied: dbt ${verb} --selector ${selector}, this diagram's selector in selectors.yml. `
          + `Listing ${scopeWords(scope.length, false)} would be too long for the Windows command prompt.`,
      };
    }
    return {
      kind: 'copy',
      text,
      form: 'select',
      tooLong: true,
      message: `Copied: dbt ${verb} for ${forWhat}.${tail} `
        + `It is ${text.length.toLocaleString('en-US')} characters, which may be too long for the Windows command prompt.`,
    };
  }

  return { kind: 'copy', text, form: 'select', tooLong: false, message: `Copied: dbt ${verb} for ${forWhat}.${tail}` };
}
