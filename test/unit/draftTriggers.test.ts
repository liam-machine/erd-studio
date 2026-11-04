/**
 * Draft-first triggers (docs/dev/draft-first.md §3.2, §3.4): when the
 * automatic draft is due, which source an intent draws, and when the
 * walkthrough still opens by itself.
 */
import { describe, expect, it } from 'vitest';

import {
  EXAMPLE_DRAFT_SHOWN_KEY,
  autoDraftDue,
  draftSourceForIntent,
  walkthroughAutoOpens,
  type AutoDraftInput,
} from '../../src/services/draftTriggers';
import { START_INTENTS, type StartIntent } from '../../src/types/startActions';

const base = (over: Partial<AutoDraftInput> = {}): AutoDraftInput => ({
  settingOn: true,
  state: {},
  hasDiagrams: false,
  hasTables: false,
  canvasOpen: false,
  intent: 'importSqlDdl',
  exampleShownOnMachine: false,
  ...over,
});

const FINDS: StartIntent[] = ['drawFromDbt', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile'];

describe('autoDraftDue', () => {
  it.each(FINDS)('drafts the find for %s in a fresh folder', (intent) => {
    expect(autoDraftDue(base({ intent }))).toBe('find');
  });

  it.each(FINDS)('drafts %s once per folder: not after draftShown or an answer', (intent) => {
    expect(autoDraftDue(base({ intent, state: { draftShown: true } }))).toBeUndefined();
    expect(autoDraftDue(base({ intent, state: { answered: true } }))).toBeUndefined();
  });

  it('a find ignores the machine-wide example flag', () => {
    expect(autoDraftDue(base({ intent: 'importSqlDdl', exampleShownOnMachine: true }))).toBe('find');
  });

  it('a blank folder gets the example once per machine', () => {
    expect(autoDraftDue(base({ intent: 'blank' }))).toBe('example');
    expect(autoDraftDue(base({ intent: 'blank', exampleShownOnMachine: true }))).toBeUndefined();
  });

  it('never drafts Convert or with no intent', () => {
    expect(autoDraftDue(base({ intent: 'convert' }))).toBeUndefined();
    expect(autoDraftDue(base({ intent: undefined }))).toBeUndefined();
  });

  it.each([...START_INTENTS])('nothing is due for %s when any blocking condition holds', (intent) => {
    const blockers: Array<Partial<AutoDraftInput>> = [
      { settingOn: false },
      { state: { off: true } },
      { hasDiagrams: true },
      { hasTables: true },
      { canvasOpen: true },
    ];
    for (const blocker of blockers) expect(autoDraftDue(base({ intent, ...blocker }))).toBeUndefined();
  });

  it('the full truth table over the flags', () => {
    const bools = [false, true];
    for (const intent of [...START_INTENTS, undefined]) {
      for (const settingOn of bools) for (const off of bools) for (const answered of bools) for (const draftShown of bools)
        for (const hasDiagrams of bools) for (const hasTables of bools) for (const canvasOpen of bools) for (const exampleShownOnMachine of bools) {
          const got = autoDraftDue({ settingOn, state: { off, answered, draftShown }, hasDiagrams, hasTables, canvasOpen, intent, exampleShownOnMachine });
          const open = settingOn && !off && !hasDiagrams && !hasTables && !canvasOpen;
          let want: 'find' | 'example' | undefined;
          if (open && intent !== undefined && FINDS.includes(intent) && !draftShown && !answered) want = 'find';
          if (open && intent === 'blank' && !exampleShownOnMachine) want = 'example';
          expect(got).toBe(want);
        }
    }
  });
});

describe('draftSourceForIntent', () => {
  it('maps each find to its draft source', () => {
    expect(draftSourceForIntent('importSqlDdl')).toBe('sqlDdl');
    expect(draftSourceForIntent('importSemanticModel')).toBe('semanticModel');
    expect(draftSourceForIntent('importDbmlFile')).toBe('dbml');
    expect(draftSourceForIntent('drawFromDbt')).toBe('dbt');
    expect(draftSourceForIntent('blank')).toBeUndefined();
    expect(draftSourceForIntent('convert')).toBeUndefined();
  });
});

describe('walkthroughAutoOpens', () => {
  it('opens only in an empty window, and only when owed', () => {
    expect(walkthroughAutoOpens({ hasFolder: false, owed: true })).toBe(true);
    expect(walkthroughAutoOpens({ hasFolder: true, owed: true })).toBe(false);
    expect(walkthroughAutoOpens({ hasFolder: false, owed: false })).toBe(false);
    expect(walkthroughAutoOpens({ hasFolder: true, owed: false })).toBe(false);
  });
});

it('the machine flag key', () => {
  expect(EXAMPLE_DRAFT_SHOWN_KEY).toBe('erdStudio.exampleDraftShown');
});
