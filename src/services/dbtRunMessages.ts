/**
 * The words for a dbt run that never started, and for Parse without your
 * credentials' placeholder profile that could not be saved (#296). Each says
 * whose problem it is and offers the step that moves it on; the commands
 * (`runDbtParse.ts`, `runDbtCompile.ts`) give each action its button and
 * what it does. A system error code is never shown: it goes to Send
 * Feedback's report only, where the failure may be ours.
 *
 * vscode-free, so every message and its actions are unit-tested without a
 * host, and the write failure is sorted by `commandErrors.ts`'s
 * `classifyWriteFailure` rather than a second check on the code.
 */

import { classifyWriteFailure } from './commandErrors';
import { cmdUnquotableChars } from './dbtEnv';

/**
 * What a notice's buttons do, in order. `tryAgain` runs the command again;
 * `installDocs` / `profileDocs` open dbt's install or profile docs.
 */
export type DbtNoticeAction = 'tryAgain' | 'sendFeedback' | 'installDocs' | 'profileDocs';

export interface DbtNotice {
  message: string;
  actions: DbtNoticeAction[];
}

/** "%", "% and !", or "\", % and !". */
function listChars(chars: readonly string[]): string {
  return chars.length <= 1 ? chars.join('') : `${chars.slice(0, -1).join(', ')} and ${chars[chars.length - 1]}`;
}

/**
 * dbt could not be started. `cause` is `'refused'` (a `.cmd` / `.bat` shim
 * whose path or arguments cmd.exe cannot quote; `planDbtSpawn`) or the start
 * error's code (`dbtProcess.ts` reduces it to a code or `'unknown'`).
 *
 * - `refused`: names the characters the refused path really holds, and which
 *   path it is. The project folder is only the working directory and is never
 *   refused; the placeholder profile folder (VS Code's storage, `profilesDir`)
 *   is, and moving the project cannot fix that.
 * - `ENOENT`: the file is gone (dbt is looked for again on every run, so Try
 *   Again is enough), or it is there and the Python it runs with is missing
 *   (a broken venv), where saying "no longer there" would be false.
 * - `EACCES` / `EPERM`: this account may not run it.
 * - anything else: Try Again, then a report.
 */
export function couldNotStartNotice(
  cause: string | 'refused',
  ctx: {
    /** dbt's path as shown (`displayPath`). */
    shown: string;
    executable: string;
    /** The placeholder profile folder, for a Parse without your credentials run. */
    profilesDir?: string;
    /** The same folder as shown. */
    profilesDirShown?: string;
    /** Whether dbt's file is still there (read for `ENOENT` only). */
    executableExists: boolean;
  },
): DbtNotice {
  const { shown } = ctx;
  if (cause === 'refused') {
    const inExecutable = cmdUnquotableChars(ctx.executable);
    const inProfilesDir = ctx.profilesDir ? cmdUnquotableChars(ctx.profilesDir) : [];
    if (inExecutable.length === 0 && inProfilesDir.length > 0) {
      const chars = listChars(inProfilesDir);
      return {
        message: `Parse without your credentials can't run on this machine: the folder where VS Code keeps ERD Studio's files (${ctx.profilesDirShown ?? ctx.profilesDir}) contains ${chars}, ` +
          `which Windows can't pass safely to ${shown}. Nothing in your project is wrong. Set up a dbt profile, then run dbt parse with it instead.`,
        actions: ['profileDocs'],
      };
    }
    const chars = listChars(inExecutable.length > 0 ? inExecutable : ['"', '%', '!']);
    return {
      message: `ERD Studio couldn't start ${shown}: its path contains ${chars}, which Windows can't pass safely to a .cmd or .bat file. ` +
        `Install dbt in a folder whose path doesn't contain ${chars}, then try again.`,
      actions: ['installDocs'],
    };
  }
  if (cause === 'ENOENT') {
    if (ctx.executableExists) {
      return {
        message: `ERD Studio couldn't start ${shown}: the file is there, but the Python it runs with is missing. ` +
          'If Python was upgraded or removed, rebuild dbt\'s virtual environment or reinstall dbt, then try again.',
        actions: ['tryAgain', 'installDocs'],
      };
    }
    return {
      message: `ERD Studio couldn't start ${shown}: the file is no longer there. ` +
        'If you moved or rebuilt dbt\'s virtual environment, try again: ERD Studio looks for dbt again each time.',
      actions: ['tryAgain', 'installDocs'],
    };
  }
  if (cause === 'EACCES' || cause === 'EPERM') {
    return {
      message: `ERD Studio couldn't start ${shown}: this account isn't allowed to run it. Check the file's permissions, then try again.`,
      actions: ['tryAgain'],
    };
  }
  return {
    message: `ERD Studio couldn't start ${shown}. This is usually a passing problem on this machine: try again, and if it keeps happening, send us a report.`,
    actions: ['tryAgain', 'sendFeedback'],
  };
}

const PROFILE_NOT_SAVED = 'ERD Studio couldn\'t save the placeholder profile it uses to parse without your credentials.';

/**
 * The placeholder profile could not be written into VS Code's storage
 * (`classifyWriteFailure`): a full disk, a folder this account may not
 * write (on Windows, also another program holding the file, such as dbt in
 * another window), or anything else, which may be ours, so Send Feedback.
 * Every case says the file is not in the project, and offers Try Again.
 */
export function profileWriteNotice(err: unknown, ctx: { folderShown: string; platform: NodeJS.Platform }): DbtNotice {
  const failure = classifyWriteFailure(err);
  if (failure === 'disk-full') {
    return {
      message: `${PROFILE_NOT_SAVED} The disk is full: free up some space, then try again. The file lives in VS Code's own storage, not in your project.`,
      actions: ['tryAgain'],
    };
  }
  if (failure === 'permission') {
    const inUse = ctx.platform === 'win32' ? ', or that no other program (such as dbt in another VS Code window) has the file open' : '';
    return {
      message: `${PROFILE_NOT_SAVED} ERD Studio isn't allowed to write to ${ctx.folderShown}, where VS Code keeps ERD Studio's files (not your project). ` +
        `Check that folder's permissions${inUse}, then try again.`,
      actions: ['tryAgain'],
    };
  }
  return {
    message: `${PROFILE_NOT_SAVED} That file lives in VS Code's own storage, not in your project, so nothing in your project is wrong. ` +
      'Check that the disk isn\'t full, then try again.',
    actions: ['tryAgain', 'sendFeedback'],
  };
}
