/**
 * The start suggestion (A), its pure half: the wording per start (counts and
 * kinds only, never a file name), when it is due (at most three times per
 * folder, never once answered or turned off), what each button does, and the
 * pieces it rests on — the look's exact CREATE TABLE count, the tracker that
 * keeps it, and the session gate it hands on when there is nothing concrete.
 */

import { describe, expect, it, vi } from 'vitest';

import { StartIntentTracker } from '../../src/commands/startIntent';
import { detectImportFindings, DETECT_SQL_CHARS, DETECT_SQL_FILES, type DetectImportIo } from '../../src/commands/importModel';
import { ACTIVATION_PROMPT_PRIORITY, SessionPromptGate, pickActivationPrompt } from '../../src/services/activationPrompts';
import { countSqlCreateTables, looksLikeSqlKeys } from '../../src/services/importSources';
import {
  CONVERT_BUTTON,
  CREATE_DIAGRAM_BUTTON,
  DONT_ASK_AGAIN_FOLDER_BUTTON,
  MAX_START_SUGGESTION_SHOWS,
  MORE_OPTIONS_BUTTON,
  NEW_DIAGRAM_BUTTON,
  NOTHING_FOUND_FEATURES,
  NOTHING_FOUND_MESSAGE,
  SHOW_ME_HOW_BUTTON,
  SHOW_ME_HOW_COMMAND,
  START_SUGGESTIONS_OFF_MESSAGE,
  TURN_ON_START_SUGGESTIONS_TITLE,
  nothingFoundDue,
  readStartSuggestionState,
  runNothingFoundPrompt,
  runStartSuggestion,
  startSuggestionDue,
  startSuggestionMessage,
  startSuggestionsOff,
  type NothingFoundDeps,
  type StartSuggestionDeps,
  type StartSuggestionState,
} from '../../src/services/startSuggestion';
import { IMPORT_GUIDE_COMMAND, type StartIntent } from '../../src/types/startActions';
import packageJson from '../../package.json';

describe('the notification text', () => {
  it('names the kind of file and, for SQL, an exact table count only — never a file name', () => {
    expect(startSuggestionMessage('importSqlDdl', { sqlTables: 24 }))
      .toBe('ERD Studio found CREATE TABLE scripts in this folder (24 tables). Create a diagram from them?');
    expect(startSuggestionMessage('importSqlDdl', { sqlTables: 1 })).toContain('(1 table)');
    expect(startSuggestionMessage('importSqlDdl')).toBe('ERD Studio found CREATE TABLE scripts in this folder. Create a diagram from them?');
    expect(startSuggestionMessage('importSemanticModel')).toBe('ERD Studio found a Power BI or Fabric semantic model in this folder. Create a diagram from it?');
    expect(startSuggestionMessage('importDbmlFile')).toBe('ERD Studio found a DBML file in this folder. Create a diagram from it?');
    expect(startSuggestionMessage('drawFromDbt')).toBe('ERD Studio found a dbt project in this folder. Create a diagram from its models?');
    expect(startSuggestionMessage('convert')).toContain('DBML, an open format');
    // dbt is named only for a dbt project.
    for (const intent of ['importSqlDdl', 'importSemanticModel', 'importDbmlFile', 'convert'] as const) {
      expect(startSuggestionMessage(intent)).not.toMatch(/\bdbt\b/i);
    }
    expect(START_SUGGESTIONS_OFF_MESSAGE).toContain(TURN_ON_START_SUGGESTIONS_TITLE);
  });

  it('every command a message names exists as written', () => {
    const titles = packageJson.contributes.commands.map((c: { title: string; category?: string }) => `${c.category ? `${c.category}: ` : ''}${c.title}`);
    expect(titles).toContain(TURN_ON_START_SUGGESTIONS_TITLE);
    expect(titles).toContain('ERD Studio: Turn Off Start Suggestions for This Folder');
  });
});

describe('when it is due', () => {
  const state = (s: Partial<StartSuggestionState> = {}): StartSuggestionState => ({ shown: 0, ...s });
  it('at most three times per folder, never with a diagram, once answered, turned off or with the setting off', () => {
    expect(MAX_START_SUGGESTION_SHOWS).toBe(3);
    expect(startSuggestionDue({ settingOn: true, state: state(), hasDiagrams: false })).toBe(true);
    expect(startSuggestionDue({ settingOn: true, state: state({ shown: 2 }), hasDiagrams: false })).toBe(true);
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
  });
});

function harness(options: { intent?: StartIntent; choice?: string; state?: StartSuggestionState; convertApplies?: boolean; sqlTables?: number } = {}) {
  let stored: StartSuggestionState = options.state ?? { shown: 0 };
  const calls = {
    shows: [] as Array<{ message: string; buttons: string[] }>,
    commands: [] as unknown[][],
    features: [] as string[],
    suggested: [] as StartIntent[],
    infos: [] as string[],
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
    info: (m) => { calls.infos.push(m); },
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

  it('Create Diagram runs the start on its quick path; counted, answered, the count saved before it showed', async () => {
    const h = harness({ intent: 'importSqlDdl', choice: CREATE_DIAGRAM_BUTTON, sqlTables: 24 });
    const run = await runStartSuggestion(h.deps);
    expect(run.shown).toBe(true);
    await run.done;
    expect(h.calls.shows).toEqual([{
      message: 'ERD Studio found CREATE TABLE scripts in this folder (24 tables). Create a diagram from them?',
      buttons: [CREATE_DIAGRAM_BUTTON, MORE_OPTIONS_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON],
    }]);
    expect(h.calls.savedBeforeShow).toEqual({ shown: 1 });
    expect(h.calls.commands).toEqual([['erdStudio.importSqlDdl', { quick: true }]]);
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptAccepted']);
    expect(h.calls.suggested).toEqual(['importSqlDdl']);
    expect(h.stored()).toEqual({ shown: 1, answered: true });
  });

  it('Create Diagram for dbt draws from dbt; for a project from before 2.0 the button is Convert and runs it', async () => {
    const dbt = harness({ intent: 'drawFromDbt', choice: CREATE_DIAGRAM_BUTTON });
    await (await runStartSuggestion(dbt.deps)).done;
    expect(dbt.calls.commands).toEqual([['erdStudio.drawFromDbt']]);

    const convert = harness({ intent: 'convert', choice: CONVERT_BUTTON });
    await (await runStartSuggestion(convert.deps)).done;
    expect(convert.calls.shows[0].buttons[0]).toBe(CONVERT_BUTTON);
    expect(convert.calls.commands).toEqual([['erdStudio.convertProjectToDbml']]);
  });

  it('no second Convert prompt: when the Convert offer would not be made, nothing shows', async () => {
    const h = harness({ intent: 'convert', convertApplies: false });
    expect((await runStartSuggestion(h.deps)).shown).toBe(false);
  });

  it('More Options… opens the start quick pick', async () => {
    const h = harness({ intent: 'importDbmlFile', choice: MORE_OPTIONS_BUTTON });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.calls.commands).toEqual([['erdStudio.start']]);
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptMore']);
  });

  it("Don't Ask Again turns it off for this folder and says how to turn it back on", async () => {
    const h = harness({ intent: 'importSemanticModel', choice: DONT_ASK_AGAIN_FOLDER_BUTTON });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.stored()).toEqual({ shown: 1, off: true });
    expect(h.calls.offContext).toEqual([true]);
    expect(h.calls.infos).toEqual([START_SUGGESTIONS_OFF_MESSAGE]);
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptOff']);
    expect(h.calls.commands).toEqual([]);
  });

  it('closed without a choice: counted as dismissed, asked again later (the count only grows)', async () => {
    const h = harness({ intent: 'importSqlDdl', state: { shown: 2 } });
    await (await runStartSuggestion(h.deps)).done;
    expect(h.stored()).toEqual({ shown: 3 });
    expect(h.calls.features).toEqual(['suggestPromptShown', 'suggestPromptDismissed']);
    // The third time was the last.
    expect((await runStartSuggestion(h.deps)).shown).toBe(false);
  });
});

describe('what it rests on', () => {
  it('the session gate: the suggestion comes after an existing project\'s notice and before the walkthrough, and gives the window back', () => {
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

describe('nothing found: a folder with no diagram and nothing concrete, whose empty Diagrams view was opened', () => {
  const state = (s: Partial<StartSuggestionState> = {}): StartSuggestionState => ({ shown: 0, ...s });

  function nothingDeps(over: Partial<NothingFoundDeps> & { stored?: StartSuggestionState; answer?: string } = {}) {
    let stored = over.stored ?? state();
    const calls = {
      shown: [] as unknown[][], info: [] as string[], ran: [] as unknown[][], features: [] as string[], off: [] as boolean[], claims: 0,
    };
    const deps: NothingFoundDeps = {
      intent: async () => 'blank',
      hasDiagrams: () => false,
      hasTables: () => false,
      settingOn: () => true,
      state: () => stored,
      saveState: async (s) => { stored = s; },
      claim: () => { calls.claims += 1; return true; },
      show: async (message, ...buttons) => { calls.shown.push([message, ...buttons]); return over.answer; },
      info: (m) => { calls.info.push(m); },
      executeCommand: async (...args) => { calls.ran.push(args); },
      feature: (k) => { calls.features.push(k); },
      setOffContext: (off) => { calls.off.push(off); },
      ...over,
    };
    return { deps, calls, stored: () => stored };
  }

  it('says what ERD Studio is for in the wording rules\' words, with New Diagram, Show Me How and Don\'t Ask Again', async () => {
    expect(NOTHING_FOUND_MESSAGE).toBe(
      'No data model found in this folder yet. Start a new diagram, or bring in your data model from Databricks, Snowflake, Power BI, Fabric and more as DBML, an open format. ERD Studio is free to use.',
    );
    expect(NOTHING_FOUND_MESSAGE).not.toMatch(/open standard|open source|\bdbt\b/i);
    const { deps, calls, stored } = nothingDeps();
    const run = await runNothingFoundPrompt(deps);
    expect(run.shown).toBe(true);
    expect(calls.shown).toEqual([[NOTHING_FOUND_MESSAGE, NEW_DIAGRAM_BUTTON, SHOW_ME_HOW_BUTTON, DONT_ASK_AGAIN_FOLDER_BUTTON]]);
    expect([NEW_DIAGRAM_BUTTON, SHOW_ME_HOW_BUTTON]).toEqual(['New Diagram', 'Show Me How']);
    // The count is saved before it shows, its own: the concrete suggestion's count is untouched.
    expect(stored()).toEqual({ shown: 0, nothingShown: 1 });
    expect(calls.features).toEqual([NOTHING_FOUND_FEATURES.shown]);
  });

  it('New Diagram runs New Diagram…; Show Me How opens the import guide from the prompt; both answer it for good', async () => {
    const blank = nothingDeps({ answer: NEW_DIAGRAM_BUTTON });
    await (await runNothingFoundPrompt(blank.deps)).done;
    expect(blank.calls.ran).toEqual([['erdStudio.createDomain']]);
    expect(blank.stored()).toEqual({ shown: 0, nothingShown: 1, nothingAnswered: true });
    expect(blank.calls.features).toEqual(['suggestPromptNothingShown', 'suggestPromptNothingNewDiagram']);

    const guide = nothingDeps({ answer: SHOW_ME_HOW_BUTTON });
    await (await runNothingFoundPrompt(guide.deps)).done;
    expect(guide.calls.ran).toEqual([[IMPORT_GUIDE_COMMAND, { from: 'prompt' }]]);
    expect(SHOW_ME_HOW_COMMAND).toBe('erdStudio.showImportGuide');
    expect(guide.calls.features).toEqual(['suggestPromptNothingShown', 'suggestPromptNothingGuide']);
    expect(nothingFoundDue({ settingOn: true, state: guide.stored(), hasDiagrams: false })).toBe(false);
  });

  it("Don't Ask Again turns start suggestions off for the folder (both notifications) and says how to turn them back on", async () => {
    const { deps, calls, stored } = nothingDeps({ answer: DONT_ASK_AGAIN_FOLDER_BUTTON });
    await (await runNothingFoundPrompt(deps)).done;
    expect(stored()).toEqual({ shown: 0, nothingShown: 1, off: true });
    expect(calls.off).toEqual([true]);
    expect(calls.info).toEqual([START_SUGGESTIONS_OFF_MESSAGE]);
    expect(calls.features).toEqual(['suggestPromptNothingShown', 'suggestPromptNothingOff']);
    expect(startSuggestionDue({ settingOn: true, state: stored(), hasDiagrams: false })).toBe(false);
  });

  it('closed: asked again later, at most three times per folder; never once off, answered, with a diagram or a table, or with the setting off', () => {
    expect(nothingFoundDue({ settingOn: true, state: state({ nothingShown: 2 }), hasDiagrams: false })).toBe(true);
    expect(nothingFoundDue({ settingOn: true, state: state({ nothingShown: 3 }), hasDiagrams: false })).toBe(false);
    expect(nothingFoundDue({ settingOn: true, state: state({ off: true }), hasDiagrams: false })).toBe(false);
    expect(nothingFoundDue({ settingOn: true, state: state({ nothingAnswered: true }), hasDiagrams: false })).toBe(false);
    expect(nothingFoundDue({ settingOn: true, state: state(), hasDiagrams: true })).toBe(false);
    expect(nothingFoundDue({ settingOn: true, state: state(), hasDiagrams: false, hasTables: true })).toBe(false);
    expect(nothingFoundDue({ settingOn: false, state: state(), hasDiagrams: false })).toBe(false);
    // The concrete suggestion's own answer or count does not decide this one.
    expect(nothingFoundDue({ settingOn: true, state: state({ shown: 3, answered: true }), hasDiagrams: false })).toBe(true);
    expect(readStartSuggestionState({ shown: 1, nothingShown: 2.5, nothingAnswered: true })).toEqual({ shown: 1, nothingShown: 2, nothingAnswered: true });
    expect(readStartSuggestionState({ nothingShown: 'x', nothingAnswered: 1 })).toEqual({ shown: 0 });
  });

  it('only for a blank suggestion: a concrete start has its own notification, and an unknown one shows nothing', async () => {
    for (const intent of ['convert', 'drawFromDbt', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile', undefined] as const) {
      const { deps, calls } = nothingDeps({ intent: async () => intent });
      expect((await runNothingFoundPrompt(deps)).shown).toBe(false);
      expect(calls.shown).toEqual([]);
      expect(calls.claims).toBe(0);
    }
    const failing = nothingDeps({ intent: async () => { throw new Error('look failed'); } });
    expect((await runNothingFoundPrompt(failing.deps)).shown).toBe(false);
  });

  it('never takes a window another prompt has (the session gate), and writes nothing then', async () => {
    const gate = new SessionPromptGate();
    expect(gate.claim('walkthrough')).toBe(true);
    const { deps, calls, stored } = nothingDeps({ claim: () => gate.claim('nothingFound') });
    expect((await runNothingFoundPrompt(deps)).shown).toBe(false);
    expect(calls.shown).toEqual([]);
    expect(stored()).toEqual({ shown: 0 });
    // It is not an activation prompt: activation never picks it.
    expect(ACTIVATION_PROMPT_PRIORITY).not.toContain('nothingFound');
  });

  it('checks again after the look: a diagram made, or the setting turned off, meanwhile', async () => {
    let diagrams = false;
    const made = nothingDeps({ intent: async () => { diagrams = true; return 'blank'; }, hasDiagrams: () => diagrams });
    expect((await runNothingFoundPrompt(made.deps)).shown).toBe(false);
    let on = true;
    const off = nothingDeps({ intent: async () => { on = false; return 'blank'; }, settingOn: () => on });
    expect((await runNothingFoundPrompt(off.deps)).shown).toBe(false);
  });
});
