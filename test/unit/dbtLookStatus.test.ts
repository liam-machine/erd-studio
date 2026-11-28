/**
 * #357: what the sidebar says while activation looks through the open
 * folders, and after a look that stopped early (`dbtLookStatus.ts`). The
 * wording is the product here, so it is pinned word for word, with the two
 * decisions it hangs on: when a look counts as stopped early, and when that
 * may have cost the user a project.
 */
import { describe, expect, it } from 'vitest';

import {
  LOOK_DISMISS_BUTTON,
  LOOK_LONGER_BUTTON,
  LOOK_SELECT_PROJECT_BUTTON,
  LOOK_STOP_BUTTON,
  folderCount,
  foundStatus,
  lookMayHaveMissed,
  lookOutcome,
  lookedThrough,
  lookingStatus,
  nothingMoreStatus,
  spokenDuration,
  stoppedStatus,
  userStoppedStatus,
} from '../../src/services/dbtLookStatus';
import type { DbtSearchStats } from '../../src/services/folderLook';
import * as fs from 'fs';
import * as path from 'path';

const stats = (over: Partial<DbtSearchStats> = {}): DbtSearchStats => ({ folders: 100, msLeft: 50_000, complete: true, stopped: undefined, maxMs: 60_000, maxFolders: 5000, ...over });

describe('#357 a look as one outcome', () => {
  it('every folder complete: not stopped early', () => {
    expect(lookOutcome([stats(), stats({ folders: 20 })])).toEqual({ folders: 120, stoppedEarly: false, stopped: undefined, maxMs: 60_000 });
  });

  it('one folder short: stopped early, by what stopped it; time wins over folders', () => {
    expect(lookOutcome([stats(), stats({ complete: false, stopped: 'folders', folders: 5000 })]).stopped).toBe('folders');
    expect(lookOutcome([stats({ complete: false, stopped: 'folders' }), stats({ complete: false, stopped: 'time' })]).stopped).toBe('time');
    expect(lookOutcome([stats({ complete: false, stopped: 'time', maxMs: 300_000, maxFolders: 100_000 })])).toEqual({ folders: 100, stoppedEarly: true, stopped: 'time', maxMs: 300_000 });
  });

  it('a project may have been missed only when the host search did not answer either', () => {
    const early = lookOutcome([stats({ complete: false, stopped: 'time' })]);
    expect(lookMayHaveMissed(early, false)).toBe(true);
    // workspace.findFiles answered: every dbt_project.yml is known at any depth.
    expect(lookMayHaveMissed(early, true)).toBe(false);
    expect(lookMayHaveMissed(lookOutcome([stats()]), false)).toBe(false);
  });
});

describe('#357 the words', () => {
  it('counts, durations and folder names', () => {
    expect([folderCount(0), folderCount(1), folderCount(1240), folderCount(100000)]).toEqual(['0 folders', '1 folder', '1,240 folders', '100,000 folders']);
    expect([spokenDuration(40), spokenDuration(45_000), spokenDuration(60_000), spokenDuration(90_000), spokenDuration(300_000), spokenDuration(1_500_000)])
      .toEqual(['1 second', '45 seconds', '1 minute', '90 seconds', '5 minutes', '25 minutes']);
    expect([lookedThrough(['shop']), lookedThrough(['shop', 'data']), lookedThrough(['a', 'b', 'c']), lookedThrough([])]).toEqual(['shop', 'shop and data', '3 folders', 'the folder']);
  });

  it('looking: what, how far, how long until it stops; no dbt word (nobody knows yet)', () => {
    // Without a bound, only how far.
    expect(lookingStatus({ folderNames: ['shop'], folders: 1240, msLeft: 48_200 }).detail).toBe('1,240 folders checked so far.');
    const s = lookingStatus({ folderNames: ['shop'], folders: 1240, maxFolders: 5000, msLeft: 48_200 });
    expect(s).toEqual({
      title: 'Looking through shop…',
      detail: '1,240 folders checked so far, of 5,000 at most.',
      working: true,
      countdown: { msLeft: 48_200, text: 'Stops in {time} if it has not finished.' },
    });
    expect(JSON.stringify(s)).not.toMatch(/dbt/i);
    // Nothing listed yet, no limit: only the title. A longer look can be stopped.
    expect(lookingStatus({ folderNames: ['shop'], folders: 0, msLeft: undefined })).toEqual({ title: 'Looking through shop…', working: true });
    expect(lookingStatus({ folderNames: ['shop'], folders: 3, msLeft: 10, canStop: true }).actions).toEqual([LOOK_STOP_BUTTON]);
  });

  it('stopped at its time: says how long, how far, what opened, and offers Look for Longer', () => {
    const outcome = lookOutcome([stats({ complete: false, stopped: 'time', folders: 3200 })]);
    expect(stoppedStatus({ folderNames: ['shop'], outcome, opened: 'shop', hasDbt: false })).toEqual({
      title: 'Stopped looking after 1 minute.',
      detail: 'ERD Studio checked 3,200 folders in shop, not all of them. It opened shop. A project deeper down may have been missed.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
  });

  it('stopped at its number of folders: the count is the title', () => {
    const outcome = lookOutcome([stats({ complete: false, stopped: 'folders', folders: 5000 })]);
    expect(stoppedStatus({ folderNames: ['shop'], outcome, opened: 'transform', hasDbt: true })).toEqual({
      title: 'Stopped looking after 5,000 folders.',
      detail: 'That is not every folder in shop. It opened transform. Another dbt project deeper down may have been missed.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
  });

  it('a folder with no dbt project is never told about dbt; a longer look that stopped again says still', () => {
    const outcome = lookOutcome([stats({ complete: false, stopped: 'time', folders: 90_000, maxMs: 300_000, maxFolders: 100_000 })]);
    const plain = stoppedStatus({ folderNames: ['shop'], outcome, opened: 'shop', hasDbt: false, again: true });
    expect(plain.title).toBe('Stopped looking after 5 minutes.');
    expect(plain.detail).toBe('ERD Studio checked 90,000 folders in shop, still not all of them. It opened shop. A project deeper down may have been missed.');
    expect(JSON.stringify(plain)).not.toMatch(/dbt/i);
  });

  it('the user stopped a longer look', () => {
    expect(userStoppedStatus({ folderNames: ['shop'], folders: 812 })).toEqual({
      title: 'Stopped looking.',
      detail: 'ERD Studio had checked 812 folders in shop.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
  });

  it('found: one by its path, several by count with the first three named; Select dbt Project… first', () => {
    expect(foundStatus(['analytics/dbt'])).toEqual({
      title: 'Found a dbt project: analytics/dbt.',
      detail: 'Select dbt Project opens it.',
      actions: [LOOK_SELECT_PROJECT_BUTTON, LOOK_DISMISS_BUTTON],
    });
    expect(foundStatus(['a', 'b', 'c', 'd', 'e'])).toEqual({
      title: 'Found 5 dbt projects.',
      detail: 'a, b, c and 2 more. Select dbt Project opens one.',
      actions: [LOOK_SELECT_PROJECT_BUTTON, LOOK_DISMISS_BUTTON],
    });
  });

  it('nothing more: says it went everywhere, with one way out', () => {
    expect(nothingMoreStatus({ folderNames: ['shop'], folders: 31_204 })).toEqual({
      title: 'Nothing more found.',
      detail: 'ERD Studio checked 31,204 folders in shop: every folder it looks in.',
      actions: [LOOK_DISMISS_BUTTON],
    });
  });

  it('the Select button is the command\'s own title', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    expect(pkg.contributes.commands.find((c) => c.command === 'erdStudio.selectDbtProject')?.title).toBe(LOOK_SELECT_PROJECT_BUTTON);
  });
});
