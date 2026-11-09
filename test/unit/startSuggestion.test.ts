/**
 * The start suggestion (A), its pure half: the wording per start (counts and
 * kinds only, never a file name), when it is due (once per
 * folder, never once answered or turned off), what each button does, and the
 * pieces it rests on — the look's exact CREATE TABLE count, the tracker that
 * keeps it, and the session gate it hands on when there is nothing concrete.
 * Draft-first (`docs/dev/draft-first.md` §3.3): Show Me opens the start's
 * draft (nothing written until Keep); More Options… and the nothing-found
 * notification are gone.
 */

import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { StartIntentTracker } from '../../src/commands/startIntent';
import { detectImportFindings, DETECT_SQL_CHARS, DETECT_SQL_FILES, type DetectImportIo } from '../../src/commands/importModel';
import { ACTIVATION_PROMPT_PRIORITY, SessionPromptGate, pickActivationPrompt } from '../../src/services/activationPrompts';
import { countSqlCreateTables, looksLikeSqlKeys } from '../../src/services/importSources';
import * as startSuggestion from '../../src/services/startSuggestion';
import {
  CONVERT_BUTTON,
  DONT_ASK_AGAIN_FOLDER_BUTTON,
  MAX_START_SUGGESTION_SHOWS,
  SHOW_ME_BUTTON,
  START_SUGGESTIONS_OFF_MESSAGE,
  TURN_ON_START_SUGGESTIONS_TITLE,
  readStartSuggestionState,
  runStartSuggestion,
  startSuggestionDue,
  dbtProjectAboveOpenFolders,
  startSuggestionMessage,
  startSuggestionsOff,
  type StartSuggestionDeps,
  type StartSuggestionState,
} from '../../src/services/startSuggestion';
import { autoDraftDue } from '../../src/services/draftTriggers';
import type { StartIntent } from '../../src/types/startActions';
import packageJson from '../../package.json';

describe('the notification text', () => {
  it('names the kind of file and, for SQL, an exact table count only — never a file name', () => {
    expect(startSuggestionMessage('importSqlDdl', { sqlTables: 24 }))
      .toBe('ERD Studio found CREATE TABLE scripts in this folder (24 tables). Show them as a diagram? Nothing is saved until you keep it.');
    expect(startSuggestionMessage('importSqlDdl', { sqlTables: 1 })).toContain('(1 table)');
    expect(startSuggestionMessage('importSqlDdl')).toBe('ERD Studio found CREATE TABLE scripts in this folder. Show them as a diagram? Nothing is saved until you keep it.');
    expect(startSuggestionMessage('importSemanticModel')).toBe('ERD Studio found a Power BI or Fabric semantic model in this folder. Show it as a diagram? Nothing is saved until you keep it.');
    expect(startSuggestionMessage('importDbmlFile')).toBe('ERD Studio found a DBML file in this folder. Show it as a diagram? Nothing is saved until you keep it.');
    expect(startSuggestionMessage('drawFromDbt')).toBe('ERD Studio found a dbt project in this folder. Show its models as a diagram? Nothing is saved until you keep it.');
    // Opened from one of its subfolders (models/): the project is not in this folder.
    expect(startSuggestionMessage('drawFromDbt', { dbtAbove: true })).toBe('ERD Studio found a dbt project in a folder above this one. Show its models as a diagram? Nothing is saved until you keep it.');
    expect(startSuggestionMessage('drawFromDbt', { dbtAbove: false })).toBe(startSuggestionMessage('drawFromDbt'));
    expect(startSuggestionMessage('convert')).toBe('This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables stay as they are.');
    // dbt is named only for a dbt project.
    for (const intent of ['importSqlDdl', 'importSemanticModel', 'importDbmlFile', 'convert'] as const) {
      expect(startSuggestionMessage(intent)).not.toMatch(/\bdbt\b/i);
    }
    // Turning it off is answered in one short line, with Undo (Turn On is in the palette too).
    expect(START_SUGGESTIONS_OFF_MESSAGE).toBe('Start suggestions are off for this folder.');
    expect(START_SUGGESTIONS_OFF_MESSAGE.split(/\s+/).length).toBeLessThanOrEqual(8);
  });

  it('every command a message names exists as written', () => {
    const titles = packageJson.contributes.commands.map((c: { title: string; category?: string }) => `${c.category ? `${c.category}: ` : ''}${c.title}`);
    expect(titles).toContain(TURN_ON_START_SUGGESTIONS_TITLE);
    expect(titles).toContain('ERD Studio: Turn Off Start Suggestions for This Folder');
  });
});

describe('when it is due', () => {
  const state = (s: Partial<StartSuggestionState> = {}): StartSuggestionState => ({ shown: 0, ...s });
  it('once per folder (no drip across windows), never with a diagram, once answered, turned off or with the setting off', () => {
    expect(MAX_START_SUGGESTION_SHOWS).toBe(1);
    expect(startSuggestionDue({ settingOn: true, state: state(), hasDiagrams: false })).toBe(true);
    expect(startSuggestionDue({ settingOn: true, state: state({ shown: 1 }), hasDiagrams: false })).toBe(false);
    expect(startSuggestionDue({ settingOn: true, state: state({ shown: 3 }), hasDiagrams: false })).toBe(false);
    expect(startSuggestionDue({ settingOn: true, state: state(), hasDiagrams: true })).toBe(false);
    expect(startSuggestionDue({ settingOn: true, state: state({ answered: true }), hasDiagrams: false })).toBe(false);
    expect(startSuggestionDue({ settingOn: true, state: state({ off: true }), hasDiagrams: false })).toBe(false);
    expect(startSuggestionDue({ settingOn: false, state: state(), hasDiagrams: false })).toBe(false);
    expect(startSuggestionsOff(state({ off: true }), true)).toBe(true);
    expect(startSuggestionsOff(state(), false)).toBe(true);
    expect(startSuggestionsOff(state({ shown: 3 }), true)).toBe(false);
  });

  it('reads a stored state defensively', () => {
    expect(readStartSuggestionState(undefined)).toEqual({ shown: 0 });
    expect(readStartSuggestionState('x')).toEqual({ shown: 0 });
    expect(readStartSuggestionState({ shown: -1, off: 'yes' })).toEqual({ shown: 0 });
    expect(readStartSuggestionState({ shown: 2.7, off: true, answered: true })).toEqual({ shown: 2, off: true, answered: true });
    // The automatic draft's flag; the nothing-found counts of an older release are dropped.
    expect(readStartSuggestionState({ shown: 1, draftShown: true })).toEqual({ shown: 1, draftShown: true });
    expect(readStartSuggestionState({ shown: 1, draftShown: 'yes', nothingShown: 2, nothingAnswered: true })).toEqual({ shown: 1 });
  });
});

function harness(options: { intent?: StartIntent; choice?: string; state?: StartSuggestionState; convertApplies?: boolean; sqlTables?: number; undo?: boolean } = {}) {
  let stored: StartSuggestionState = options.state ?? { shown: 0 };
  const calls = {
    shows: [] as Array<{ message: string; buttons: string[] }>,
    commands: [] as unknown[][],
    features: [] as string[],
    suggested: [] as StartIntent[],
    infos: [] as string[],
    infoButtons: [] as string[][],
    offContext: [] as boolean[],
    savedBeforeShow: undefined as StartSuggestionState | undefined,
  };
  const deps: StartSuggestionDeps = {
    intent: async () => options.intent,
    sqlTables: () => options.sqlTables,
    hasDiagrams: () => false,
    settingOn: () => true,
    convertApplies: () => options.convertApplies ?? true,
    state: () => stored,
    saveState: async (s) => { stored = s; },
    show: async (message, ...buttons) => { calls.savedBeforeShow = stored; calls.shows.push({ message, buttons }); return options.choice; },
    info: async (m, ...buttons) => { calls.infos.push(m); calls.infoButtons.push(buttons); return options.undo ? buttons[0] : undefined; },
    executeCommand: async (...args) => { calls.commands.push(args); },
    recordSuggested: (i) => { calls.suggested.push(i); },
    feature: (k) => { calls.features.push(k); },
    setOffContext: (off) => { calls.offContext.push(off); },
  };
  return { deps, calls, stored: () => stored };
}

describe('runStartSuggestion', () => {
  it('nothing concrete (a blank folder, no folder): shows nothing, so the window goes to the next prompt', async () => {
    for (const intent of [undefined, 'blank'] as const) {
      const h = harness({ intent });
      expect((await runStartSuggestion(h.deps)).shown).toBe(false);
      expect(h.calls.shows).toEqual([]);
      expect(h.stored()).toEqual({ shown: 0 });
    }
  });

  it('Show Me opens the start\'s draft (its quick path, trigger prompt); counted, answered, the count saved before it showed', async () => {
    const h = harness({ intent: 'importSqlDdl', choice: SHOW_ME_BUTTON, sqlTables: 24 });
    const run = await runStartSuggestion(h.deps);
    expect(run.shown).toBe(true);
    await run.done;
    expect(h.calls.shows).toEqual([{
      message: 'ERD Studio found CREATE TABLE scripts in this folder (24 tables). Show them as a diagram? Nothing is saved until you keep it.',
      buttons: [SHOW_ME_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON],
    }]);
    expect(SHOW_ME_BUTTON).toBe('Show Me');
    expect(h.calls.savedBeforeShow).toEqual({ shown: 1 });
    expect(h.calls.commands).toEqual([['erdStudio.importSqlDdl', { quick: true, draft: 'prompt' }]]);
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptShowMe']);
    expect(h.calls.suggested).toEqual(['importSqlDdl']);
    expect(h.stored()).toEqual({ shown: 1, answered: true });
  });

  it('Show Me for dbt opens its folder draft; for a project from before 2.0 the button is Convert and runs it', async () => {
    const dbt = harness({ intent: 'drawFromDbt', choice: SHOW_ME_BUTTON });
    await (await runStartSuggestion(dbt.deps)).done;
    expect(dbt.calls.commands).toEqual([['erdStudio.drawFromDbt', { draft: 'prompt' }]]);

    const convert = harness({ intent: 'convert', choice: CONVERT_BUTTON });
    await (await runStartSuggestion(convert.deps)).done;
    expect(convert.calls.shows[0].buttons).toEqual([CONVERT_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON]);
    expect(convert.calls.commands).toEqual([['erdStudio.convertProjectToDbml']]);
    // Convert keeps its own key: suggestPromptAccepted.
    expect(convert.calls.features).toEqual(['suggestPromptShown', 'suggestPromptAccepted']);
  });

  it('no second Convert prompt: when the Convert offer would not be made, nothing shows', async () => {
    const h = harness({ intent: 'convert', convertApplies: false });
    expect((await runStartSuggestion(h.deps)).shown).toBe(false);
  });

  it('More Options… is gone: two buttons only, whatever the start', async () => {
    for (const intent of ['importDbmlFile', 'importSemanticModel', 'drawFromDbt', 'importSqlDdl'] as const) {
      const h = harness({ intent });
      await (await runStartSuggestion(h.deps)).done;
      expect(h.calls.shows[0].buttons).toEqual([SHOW_ME_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON]);
    }
    expect('MORE_OPTIONS_BUTTON' in startSuggestion).toBe(false);
  });

  it("Don't Ask Again's Undo turns suggestions back on with the palette's own command", async () => {
    const h = harness({ intent: 'importSqlDdl', choice: DONT_ASK_AGAIN_FOLDER_BUTTON, undo: true });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.calls.infoButtons).toEqual([['Undo']]);
    expect(h.calls.commands).toEqual([['erdStudio.turnOnStartSuggestions']]);
  });

  it("Don't Ask Again turns it off for this folder and says so in one line, with Undo", async () => {
    const h = harness({ intent: 'importSemanticModel', choice: DONT_ASK_AGAIN_FOLDER_BUTTON });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.stored()).toEqual({ shown: 1, off: true });
    expect(h.calls.offContext).toEqual([true]);
    expect(h.calls.infos).toEqual([START_SUGGESTIONS_OFF_MESSAGE]);
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptOff']);
    expect(h.calls.commands).toEqual([]);
    // The folder then gets no automatic draft either (§3.3).
    expect(autoDraftDue({
      settingOn: true, state: h.stored(), hasDiagrams: false, hasTables: false, canvasOpen: false,
      intent: 'importSemanticModel', exampleShownOnMachine: false,
    })).toBeUndefined();
  });

  it('closed without a choice: counted as dismissed, and never asked again (the sidebar and the icon\'s draft remain)', async () => {
    const h = harness({ intent: 'importSqlDdl' });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.stored()).toEqual({ shown: 1 });
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptDismissed']);
    expect((await runStartSuggestion(h.deps)).shown).toBe(false);
    // The folder's automatic draft is still due: closing the notification is not an answer.
    expect(autoDraftDue({
      settingOn: true, state: h.stored(), hasDiagrams: false, hasTables: false, canvasOpen: false,
      intent: 'importSqlDdl', exampleShownOnMachine: false,
    })).toBe('find');
  });
});

describe('what it rests on', () => {
  it('the session gate: the suggestion comes after an existing project\'s notice and before the walkthrough, and gives the window back', () => {
    // The draft and an example's window are kinds too; nothingFound is gone.
    const kinds: Array<import('../../src/services/activationPrompts').SessionPromptKind> = ['draft', 'exampleOpen'];
    expect(kinds).toHaveLength(2);
    expect(ACTIVATION_PROMPT_PRIORITY).not.toContain('draft');
    expect(ACTIVATION_PROMPT_PRIORITY.slice(0, 3)).toEqual(['diagramsNudge', 'startSuggestion', 'walkthrough']);
    expect(pickActivationPrompt(['walkthrough', 'startSuggestion', 'harnessInstall'])).toBe('startSuggestion');
    const gate = new SessionPromptGate();
    expect(gate.claim('startSuggestion')).toBe(true);
    gate.release('walkthrough'); // not the holder: a no-op
    expect(gate.claim('walkthrough')).toBe(false);
    gate.release('startSuggestion');
    expect(gate.claim('walkthrough')).toBe(true);
  });

  it('counts CREATE TABLEs with a column list, comments ignored; ALTER TABLE keys are keys, not tables', () => {
    expect(countSqlCreateTables('CREATE TABLE a (id int);\n-- CREATE TABLE b (id int);\ncreate table if not exists s.c (x int);\nCREATE TABLE d AS SELECT 1;')).toBe(2);
    expect(looksLikeSqlKeys('ALTER TABLE ONLY s.a\n  ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES s.b (id);')).toBe(true);
    expect(looksLikeSqlKeys('ALTER TABLE a ADD COLUMN b int;')).toBe(false);
  });

  const io = (files: Record<string, string>, more: Partial<DetectImportIo> = {}): DetectImportIo => ({
    root: '/w',
    readDirectory: async (folder) => (folder === '/w' ? Object.keys(files).map((f) => [f, false] as const) : []),
    readStart: async (file, chars) => files[file.slice('/w/'.length)].slice(0, chars),
    ...more,
  });

  it('the start look counts exactly or not at all: every .sql listed and read whole', async () => {
    expect(await detectImportFindings(io({ 'a.sql': 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);', 'q.sql': 'SELECT 1;' }), '.erd-studio', { countTables: true }))
      .toEqual({ sources: new Set(['sqlDdl']), sqlTables: 2 });
    // Without countTables (Import…'s picker) it stops at the first script and counts nothing.
    expect(await detectImportFindings(io({ 'a.sql': 'CREATE TABLE a (id int);' }), '.erd-studio')).toEqual({ sources: new Set(['sqlDdl']) });
    // A file longer than the look reads: no number.
    const big = `CREATE TABLE a (id int);\n${' '.repeat(DETECT_SQL_CHARS)}`;
    expect((await detectImportFindings(io({ 'a.sql': big }), '.erd-studio', { countTables: true })).sqlTables).toBeUndefined();
    // As many files as the look reads, all of them: the number.
    const all = Object.fromEntries(Array.from({ length: DETECT_SQL_FILES }, (_, i) => [`${i}.sql`, 'CREATE TABLE a (id int);']));
    expect((await detectImportFindings(io(all), '.erd-studio', { countTables: true })).sqlTables).toBe(DETECT_SQL_FILES);
    // More files than the look reads: no number.
    const many = Object.fromEntries(Array.from({ length: DETECT_SQL_FILES + 1 }, (_, i) => [`${i}.sql`, 'CREATE TABLE a (id int);']));
    expect((await detectImportFindings(io(many), '.erd-studio', { countTables: true })).sqlTables).toBeUndefined();
  });

  it('the tracker keeps the look\'s count (from either shape a look returns)', async () => {
    const t = new StartIntentTracker({
      context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
      look: vi.fn(async () => ({ sources: new Set(['sqlDdl'] as const), sqlTables: 7 })),
      publish: () => {},
    });
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(t.sqlTableCount()).toBe(7);
    const plain = new StartIntentTracker({
      context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
      look: vi.fn(async () => new Set(['dbml'] as const)),
      publish: () => {},
    });
    expect(await plain.refresh()).toBe('importDbmlFile');
    expect(plain.sqlTableCount()).toBeUndefined();
  });
});

describe('nothing found: no notification any more (the example draft on the ERD Studio icon takes its place)', () => {
  it('runNothingFoundPrompt and its strings are removed', () => {
    for (const name of ['runNothingFoundPrompt', 'nothingFoundDue', 'NOTHING_FOUND_MESSAGE', 'NOTHING_FOUND_FEATURES', 'NEW_DIAGRAM_BUTTON', 'SHOW_ME_HOW_BUTTON', 'CREATE_DIAGRAM_BUTTON']) {
      expect(name in startSuggestion).toBe(false);
    }
  });

  it('a blank folder is offered the example draft once per machine, never a notification', async () => {
    const h = harness({ intent: 'blank' });
    expect((await runStartSuggestion(h.deps)).shown).toBe(false);
    const due = (exampleShownOnMachine: boolean) => autoDraftDue({
      settingOn: true, state: { shown: 0 }, hasDiagrams: false, hasTables: false, canvasOpen: false, intent: 'blank', exampleShownOnMachine,
    });
    expect(due(false)).toBe('example');
    expect(due(true)).toBeUndefined();
  });
});

describe('dbtProjectAboveOpenFolders', () => {
  const root = path.join(path.sep, 'repo', 'analytics');
  it('is true only when every open folder is strictly inside the dbt project', () => {
    expect(dbtProjectAboveOpenFolders(root, [path.join(root, 'models')])).toBe(true);
    expect(dbtProjectAboveOpenFolders(root, [path.join(root, 'models'), path.join(root, 'seeds')])).toBe(true);
    // The project root itself, a folder holding it, or any folder outside it: the project is "in this folder".
    expect(dbtProjectAboveOpenFolders(root, [root])).toBe(false);
    expect(dbtProjectAboveOpenFolders(root, [path.dirname(root)])).toBe(false);
    expect(dbtProjectAboveOpenFolders(root, [path.join(root, 'models'), path.join(path.sep, 'elsewhere')])).toBe(false);
    expect(dbtProjectAboveOpenFolders(root, [path.join(path.dirname(root), 'analytics-docs')])).toBe(false);
    expect(dbtProjectAboveOpenFolders(root, [])).toBe(false);
  });

  it('goes into the message through the run\'s dbtAbove dependency', async () => {
    const show = vi.fn(async () => undefined);
    const run = await startSuggestion.runStartSuggestion({
      intent: async () => 'drawFromDbt',
      sqlTables: () => undefined,
      dbtAbove: () => true,
      hasDiagrams: () => false,
      settingOn: () => true,
      convertApplies: () => false,
      state: () => ({ shown: 0 }),
      saveState: async () => undefined,
      show,
      info: async () => undefined,
      executeCommand: async () => undefined,
      recordSuggested: () => undefined,
      feature: () => undefined,
      setOffContext: () => undefined,
    });
    await run.done;
    expect(show.mock.calls[0][0]).toBe('ERD Studio found a dbt project in a folder above this one. Show its models as a diagram? Nothing is saved until you keep it.');
  });
});

describe('a late Show Me on a stale start notification (cross/9a: qut Bug 6, harbor Bug 6, dbt I2)', () => {
  /** The notification stays up (VS Code 1.85 cannot dismiss it); a diagram is kept meanwhile, then Show Me is pressed. */
  function lateClick(intent: StartIntent, keptMeanwhile: boolean) {
    let diagrams = false;
    let release: (choice: string | undefined) => void = () => {};
    const h = harness({ intent });
    h.deps.hasDiagrams = () => diagrams;
    h.deps.show = (message, ...buttons) => {
      h.calls.shows.push({ message, buttons });
      return new Promise<string | undefined>((resolve) => { release = resolve; });
    };
    return {
      h,
      async run() {
        const run = await runStartSuggestion(h.deps);
        expect(run.shown).toBe(true);
        // Keep (from the sidebar, the automatic draft or another import) while the notification is up.
        diagrams = keptMeanwhile;
        release(startSuggestion.startSuggestionPrimary(intent as startSuggestion.SuggestedStart));
        await run.done;
      },
    };
  }

  it.each(['importDbmlFile', 'importSqlDdl', 'drawFromDbt', 'importSemanticModel'] as const)('%s after Keep: the Diagrams view, never a second draft', async (intent) => {
    const { h, run } = lateClick(intent, true);
    await run();
    expect(h.calls.commands).toEqual([[startSuggestion.DIAGRAMS_VIEW_FOCUS_COMMAND]]);
    expect(h.calls.infos).toEqual([startSuggestion.START_SUGGESTION_ALREADY_KEPT_MESSAGE]);
    expect(h.stored().answered).toBe(true);
  });

  it('after Discard (or nothing kept): Show Me still opens the draft', async () => {
    const { h, run } = lateClick('importDbmlFile', false);
    await run();
    expect(h.calls.commands).toHaveLength(1);
    expect(h.calls.commands[0][0]).not.toBe(startSuggestion.DIAGRAMS_VIEW_FOCUS_COMMAND);
    expect(h.calls.infos).toEqual([]);
  });

  it('Convert converts whatever diagrams the project has: unaffected', async () => {
    const { h, run } = lateClick('convert', true);
    await run();
    expect(h.calls.commands).toHaveLength(1);
    expect(h.calls.commands[0][0]).not.toBe(startSuggestion.DIAGRAMS_VIEW_FOCUS_COMMAND);
  });

  it('the focus command is the Diagrams view\'s own (erdStudio.domainTree in package.json)', () => {
    const views = (packageJson.contributes as { views: Record<string, Array<{ id: string; name: string }>> }).views['erd-studio'];
    expect(views.find((v) => v.name === 'Diagrams')?.id).toBe(startSuggestion.DIAGRAMS_VIEW_FOCUS_COMMAND.replace(/\.focus$/, ''));
  });
});
