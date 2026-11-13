/**
 * #296: the words for a dbt run that never started and for a placeholder
 * profile that could not be saved. Each case says whose problem it is and
 * what to do next, and never shows a system error code or "cmd.exe".
 */
import { describe, expect, it } from 'vitest';

import { cmdUnquotableChars, dbtSpawnCommand } from '../../src/services/dbtEnv';
import { couldNotStartNotice, profileWriteNotice } from '../../src/services/dbtRunMessages';

const RAW = /cmd\.exe|\bE[A-Z]{3,}\b|unknown|\(/;
const base = { shown: '.venv/bin/dbt', executable: '/proj/.venv/bin/dbt', executableExists: false };

describe('cmdUnquotableChars follows the shim refusal rule', () => {
  it('names exactly the characters dbtSpawnCommand refuses, once each', () => {
    expect(cmdUnquotableChars('C:\\a "b" 100% !x')).toEqual(['"', '%', '!']);
    expect(cmdUnquotableChars('C:\\a\r\nb\nc')).toEqual(['a line break']);
    // `^` and `&` are quoted safely, never refused.
    expect(cmdUnquotableChars('C:\\R&D ^ (x)')).toEqual([]);
    expect(dbtSpawnCommand('C:\\R&D ^ (x)\\dbt.cmd', ['parse'])).not.toBeNull();
    for (const ch of ['"', '%', '!', '\n']) {
      expect(dbtSpawnCommand(`C:\\a${ch}b\\dbt.cmd`, ['parse']), JSON.stringify(ch)).toBeNull();
      expect(cmdUnquotableChars(`a${ch}b`)).toHaveLength(1);
    }
  });
});

describe('couldNotStartNotice', () => {
  it.each([
    ['ENOENT, file gone', 'ENOENT', false,
      'ERD Studio couldn\'t start .venv/bin/dbt: the file is no longer there. If you moved or rebuilt dbt\'s virtual environment, try again: ERD Studio looks for dbt again each time.',
      ['tryAgain', 'installDocs']],
    ['ENOENT, file still there (a broken venv)', 'ENOENT', true,
      'ERD Studio couldn\'t start .venv/bin/dbt: the file is there, but the Python it runs with is missing. If Python was upgraded or removed, rebuild dbt\'s virtual environment or reinstall dbt, then try again.',
      ['tryAgain', 'installDocs']],
    ['EACCES', 'EACCES', false,
      'ERD Studio couldn\'t start .venv/bin/dbt: this account isn\'t allowed to run it. Check the file\'s permissions, then try again.',
      ['tryAgain']],
    ['EPERM', 'EPERM', false,
      'ERD Studio couldn\'t start .venv/bin/dbt: this account isn\'t allowed to run it. Check the file\'s permissions, then try again.',
      ['tryAgain']],
    ['EMFILE', 'EMFILE', false,
      'ERD Studio couldn\'t start .venv/bin/dbt. This is usually a passing problem on this machine: try again, and if it keeps happening, send us a report.',
      ['tryAgain', 'sendFeedback']],
    ['unknown', 'unknown', false,
      'ERD Studio couldn\'t start .venv/bin/dbt. This is usually a passing problem on this machine: try again, and if it keeps happening, send us a report.',
      ['tryAgain', 'sendFeedback']],
  ])('%s', (_name, cause, exists, message, actions) => {
    const n = couldNotStartNotice(cause, { ...base, executableExists: exists });
    expect(n.message).toBe(message);
    expect(n.actions).toEqual(actions);
    expect(n.message).not.toMatch(RAW);
  });

  it('only ENOENT reads whether the file is there', () => {
    expect(couldNotStartNotice('EACCES', { ...base, executableExists: true }).message)
      .toBe(couldNotStartNotice('EACCES', { ...base, executableExists: false }).message);
  });

  it('refused by dbt\'s own path: names only the characters that path holds, never cmd.exe', () => {
    const executable = 'C:\\R&D ^ 100%\\pyenv\\shims\\dbt.bat';
    const n = couldNotStartNotice('refused', { shown: '~/R&D ^ 100%/pyenv/shims/dbt.bat', executable, executableExists: true });
    expect(n.message).toBe(
      'ERD Studio couldn\'t start ~/R&D ^ 100%/pyenv/shims/dbt.bat: its path contains %, which Windows can\'t pass safely to a .cmd or .bat file. ' +
        'Install dbt in a folder whose path doesn\'t contain %, then try again.',
    );
    expect(n.actions).toEqual(['installDocs']);
    expect(n.message).not.toMatch(/cmd\.exe|project/);
  });

  it('refused by the placeholder profile folder: names VS Code\'s storage, never the project or dbt\'s folder', () => {
    const n = couldNotStartNotice('refused', {
      shown: '~/pyenv/shims/dbt.bat',
      executable: 'C:\\Users\\Bob\\pyenv\\shims\\dbt.bat',
      profilesDir: 'C:\\Users\\Bob!\\AppData\\Roaming\\Code\\User\\globalStorage\\x\\dbt-parse-profile\\duckdb',
      profilesDirShown: '~/AppData/Roaming/Code/User/globalStorage/x/dbt-parse-profile/duckdb',
      executableExists: true,
    });
    expect(n.message).toBe(
      'Parse without your credentials can\'t run on this machine: the folder where VS Code keeps ERD Studio\'s files ' +
        '(~/AppData/Roaming/Code/User/globalStorage/x/dbt-parse-profile/duckdb) contains !, which Windows can\'t pass safely to ~/pyenv/shims/dbt.bat. ' +
        'Nothing in your project is wrong. Set up a dbt profile, then run dbt parse with it instead.',
    );
    expect(n.actions).toEqual(['profileDocs']);
    expect(n.message).not.toMatch(/cmd\.exe|Move the project|Install dbt in a folder/);
  });

  it('refused with a bad character in both: dbt\'s path is named first (moving dbt is the fix the user can make)', () => {
    const n = couldNotStartNotice('refused', {
      shown: 'C:/a%/dbt.cmd', executable: 'C:\\a%\\dbt.cmd', profilesDir: 'C:\\b!', profilesDirShown: 'C:/b!', executableExists: true,
    });
    expect(n.message).toMatch(/^ERD Studio couldn't start C:\/a%\/dbt\.cmd: its path contains %,/);
  });

  it('no notice ever offers Show output (a refused run has no terminal; a start error\'s shows only the code)', () => {
    for (const cause of ['refused', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'unknown']) {
      expect(couldNotStartNotice(cause, base).actions.join()).not.toMatch(/output/i);
    }
  });
});

describe('profileWriteNotice', () => {
  const folderShown = '~/Library/Application Support/Code/User/globalStorage/x/dbt-parse-profile/duckdb';
  const errno = (code: string, message = `${code}: /secret/path/profiles.yml`) => Object.assign(new Error(message), { code });
  const lead = 'ERD Studio couldn\'t save the placeholder profile it uses to parse without your credentials.';

  it('ENOSPC (or EDQUOT): the disk is full; Try Again', () => {
    for (const err of [errno('ENOSPC'), errno('EDQUOT'), new Error('ENOSPC: no space left on device, write')]) {
      const n = profileWriteNotice(err, { folderShown, platform: 'darwin' });
      expect(n.message).toBe(`${lead} The disk is full: free up some space, then try again. The file lives in VS Code's own storage, not in your project.`);
      expect(n.actions).toEqual(['tryAgain']);
    }
  });

  it('EACCES: names the storage folder and says it is not the project; Try Again', () => {
    const n = profileWriteNotice(errno('EACCES'), { folderShown, platform: 'darwin' });
    expect(n.message).toBe(
      `${lead} ERD Studio isn't allowed to write to ${folderShown}, where VS Code keeps ERD Studio's files (not your project). ` +
        'Check that folder\'s permissions, then try again.',
    );
    expect(n.actions).toEqual(['tryAgain']);
  });

  it('EPERM on Windows also says another program may have the file open (a rename over an open file)', () => {
    const n = profileWriteNotice(errno('EPERM'), { folderShown, platform: 'win32' });
    expect(n.message).toContain('or that no other program (such as dbt in another VS Code window) has the file open');
    expect(n.actions).toEqual(['tryAgain']);
  });

  it('any other code: the general sentence, Try Again and Send Feedback', () => {
    for (const code of ['EIO', 'EBUSY']) {
      const n = profileWriteNotice(errno(code), { folderShown, platform: 'darwin' });
      expect(n.message).toBe(
        `${lead} That file lives in VS Code's own storage, not in your project, so nothing in your project is wrong. Check that the disk isn't full, then try again.`,
      );
      expect(n.actions).toEqual(['tryAgain', 'sendFeedback']);
    }
  });

  it('never shows the raw error or its path', () => {
    for (const code of ['ENOSPC', 'EACCES', 'EPERM', 'EIO']) {
      const n = profileWriteNotice(errno(code), { folderShown, platform: 'win32' });
      expect(n.message).not.toContain('/secret/path');
      expect(n.message).not.toMatch(/\bE[A-Z]{3,}\b/);
    }
  });
});
