/**
 * #335, after review: a failure whose cause is known and the user's to fix
 * (a file or folder this account may not open or write, a full disk) says
 * that in the toast and offers no Send Feedback. Send Feedback is only for a
 * failure with no known cause.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { firstUnwritable } from '../../src/commands/commandFailure';
import { SEND_FEEDBACK_BUTTON, SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON, classifyWriteFailure } from '../../src/services/commandErrors';
import { SHOW_FOLDER_BUTTON, editNotAccepted, knownCauseOrOurs } from '../../src/services/diagramCommandErrors';

const ctx = { doing: 'while working out which files to change', outcome: 'nothing was moved', retry: true, workspaceRoot: '/proj' };

describe('knownCauseOrOurs', () => {
  it('a permission error names the file, says to check its permissions, and offers no Send Feedback', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/proj/.erd-studio/gold/tables/a.dbml'"), { code: 'EACCES', path: '/proj/.erd-studio/gold/tables/a.dbml' });
    const failure = knownCauseOrOurs('Move Table', err, ctx);
    expect(failure.message).toBe("Move Table: ERD Studio isn't allowed to open .erd-studio/gold/tables/a.dbml, so nothing was moved. Check its permissions, then try again.");
    expect(failure.buttons).toEqual([SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON]);
    expect(failure.buttons).not.toContain(SEND_FEEDBACK_BUTTON);
    expect(failure.target).toBe('/proj/.erd-studio/gold/tables/a.dbml');
    // Not ours: nothing is counted as commandFailedOurs.
    expect(failure.doing).toBeUndefined();
    expect(failure.message).not.toContain('EACCES');
  });

  it("VS Code's NoPermissions, carried only in a plain error's message, is a permission problem", () => {
    const err = new Error("cannot open file:///x/fields.yml. Detail: Unable to read file (NoPermissions (FileSystemError): An unknown error occurred.)");
    expect(classifyWriteFailure(err)).toBe('permission');
    const failure = knownCauseOrOurs('Go to Table', err, { doing: 'while opening that table', outcome: 'nothing was opened', retry: false });
    expect(failure.message).toBe("Go to Table: ERD Studio isn't allowed to open a file or folder it needs, so nothing was opened. Check its permissions, then try again.");
    expect(failure.buttons).toEqual([]);
  });

  it('a full disk says so, with Try Again and no Send Feedback', () => {
    const failure = knownCauseOrOurs('New Table', Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), { ...ctx, outcome: 'nothing was created' });
    expect(failure.message).toBe('New Table: the disk is full, so nothing was created. Free up some space, then try again.');
    expect(failure.buttons).toEqual([TRY_AGAIN_BUTTON]);
    expect(failure.doing).toBeUndefined();
  });

  it('with no prefix (the Explorer), the sentence starts with a capital and keeps the back button', () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM', path: '/proj/.erd-studio/gold/diagrams/sales.dbml' });
    const failure = knownCauseOrOurs('Update References', err, { ...ctx, retry: false, prefix: '', extra: ['Move It Back'] });
    expect(failure.message.startsWith("ERD Studio isn't allowed to open .erd-studio/gold/diagrams/sales.dbml, so")).toBe(true);
    expect(failure.buttons).toEqual([SHOW_FILE_BUTTON, 'Move It Back']);
  });

  it('a failure with no known cause is still ours: Send Feedback, counted, never the exception text', () => {
    const failure = knownCauseOrOurs('Move Table', new Error('boom'), ctx);
    expect(failure.buttons).toEqual([SEND_FEEDBACK_BUTTON, TRY_AGAIN_BUTTON]);
    expect(failure.doing).toBe(ctx.doing);
    expect(failure.message).not.toContain('boom');
    expect(failure.message).toContain("This isn't something you did");
  });
});

describe("editNotAccepted with a path that can't be written", () => {
  it('names it, with Show Folder and Try Again, and no Send Feedback', () => {
    const failure = editNotAccepted('New Table', 'the new file', 'nothing was created', { unwritable: { path: '/proj/.erd-studio/gold/tables/gold', workspaceRoot: '/proj' } });
    expect(failure.message).toBe("New Table: ERD Studio isn't allowed to write to .erd-studio/gold/tables/gold, so nothing was created. Check its permissions, then try again.");
    expect(failure.buttons).toEqual([SHOW_FOLDER_BUTTON, TRY_AGAIN_BUTTON]);
    expect(failure.target).toBe('/proj/.erd-studio/gold/tables/gold');
    expect(failure.reportDoing).toBeUndefined();
  });

  it('keeps the extra button (Move It Back) and the given prefix', () => {
    const failure = editNotAccepted('Update References', 'the update', 'nothing else was changed', { prefix: 'ERD Studio', extra: ['Move It Back'], unwritable: { path: '/proj', workspaceRoot: '/proj' } });
    expect(failure.message).toBe("ERD Studio isn't allowed to write to the project folder, so nothing else was changed. Check its permissions, then try again.");
    expect(failure.buttons).toEqual([SHOW_FOLDER_BUTTON, TRY_AGAIN_BUTTON, 'Move It Back']);
  });

  it('with nothing unwritable, the cause is unknown: the usual words, with Send Feedback', () => {
    const failure = editNotAccepted('New Table', 'the new file', 'nothing was created');
    expect(failure.buttons).toEqual([TRY_AGAIN_BUTTON, SEND_FEEDBACK_BUTTON]);
    expect(failure.message).toContain('This is usually a file another program has open');
  });
});

// Permission bits mean nothing to root or on Windows.
const canDeny = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.runIf(canDeny)('firstUnwritable', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      for (const p of [dir, path.join(dir, 'ro'), path.join(dir, 'rw', 'locked.dbml')]) {
        try { fs.chmodSync(p, 0o755); } catch { /* not made */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const temp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-unwritable-'));
    made.push(dir);
    fs.mkdirSync(path.join(dir, 'ro'));
    fs.mkdirSync(path.join(dir, 'rw'));
    return dir;
  };

  it('undefined when every path can be written', () => {
    const dir = temp();
    expect(firstUnwritable([path.join(dir, 'rw', 'new.dbml'), path.join(dir, 'rw', 'deeper', 'new.dbml')], dir)).toBeUndefined();
  });

  it('a new file in a read-only folder: the folder', () => {
    const dir = temp();
    fs.chmodSync(path.join(dir, 'ro'), 0o555);
    expect(firstUnwritable([path.join(dir, 'rw', 'ok.dbml'), path.join(dir, 'ro', 'new.dbml')], dir)).toBe(path.join(dir, 'ro'));
  });

  it('a new file under a folder not made yet: the nearest folder that exists', () => {
    const dir = temp();
    fs.chmodSync(path.join(dir, 'ro'), 0o555);
    expect(firstUnwritable([path.join(dir, 'ro', 'schema', 'new.dbml')], dir)).toBe(path.join(dir, 'ro'));
  });

  it('a path outside the project, or whose nearest folder is above it, is never blamed', () => {
    const dir = temp();
    fs.chmodSync(path.join(dir, 'ro'), 0o555);
    expect(firstUnwritable([path.join(dir, 'ro', 'new.dbml')], path.join(dir, 'rw'))).toBeUndefined();
    expect(firstUnwritable(['/no-such-root/.erd-studio/gold/diagrams/sales.dbml'], '/no-such-root')).toBeUndefined();
  });

  it('an existing read-only file: the file', () => {
    const dir = temp();
    const file = path.join(dir, 'rw', 'locked.dbml');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    expect(firstUnwritable([file], dir)).toBe(file);
  });
});
