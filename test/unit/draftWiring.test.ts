/**
 * Draft-first's host wiring (`src/providers/draftWiring.ts`,
 * `docs/dev/draft-first.md` §2.1, §3, §11): the fixed command of each Other
 * Way to Start, the funnel keys the shared preview counts, the gate it
 * claims and Keep's bookkeeping. vscode-free, with plain fakes.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DRAFT_OTHER_START_COMMANDS,
  DRAFT_SOURCE_FEATURES,
  DraftGeneration,
  draftPreviewEvents,
  trackedDraftPreview,
} from '../../src/providers/draftWiring';
import { FEATURES, ERROR_CODES } from '../../src/services/telemetryPayload';
import { DRAFT_OTHER_STARTS, DRAFT_SOURCES, type Draft, type DraftSource, type DraftTrigger } from '../../src/types/draft';
import { fakeDraftPreview, type ScriptedAnswer } from './helpers/draftDriver';

function draft(source: DraftSource, trigger: DraftTrigger, keep: Draft['keep'] = { writer: 'none' }): Draft {
  return {
    id: `${source}-${Math.random()}`,
    source,
    title: 'Draft: x',
    banner: { headline: 'h', detail: 'd', primary: 'keep', changeOptions: false, shownStarts: [] },
    otherStarts: [],
    summary: { tables: 0, relationships: 0, newTables: 0, reusedTables: 0, changedTables: 0, schemas: [], notes: 0, leftOut: 0 },
    display: {} as Draft['display'],
    autoLayout: false,
    logicalOnly: true,
    panelOpen: false,
    details: [],
    keep,
    trigger,
  };
}

const IMPORT_KEEP: Draft['keep'] = {
  writer: 'importDbml', importSource: 'sql', fingerprint: 'f',
  target: { layer: 'main', layerLabel: 'Main', name: 'sales', diagramFile: '.erd-studio/main/diagrams/sales.dbml' },
};

function wired(answers: ScriptedAnswer[]) {
  const inner = fakeDraftPreview(answers);
  const features: string[] = [];
  const commands: Array<[string, ...unknown[]]> = [];
  const kept: Draft[] = [];
  const claim = vi.fn();
  const preview = trackedDraftPreview(inner, {
    claim,
    executeCommand: async (command, ...args) => { commands.push([command, ...args]); },
    feature: (key) => { features.push(key); },
    onKept: (d) => { kept.push(d); },
  });
  return { inner, preview, features, commands, kept, claim };
}

describe('DRAFT_OTHER_START_COMMANDS: the fixed host table', () => {
  it('maps every Other Way to Start to its command, with fixed arguments', () => {
    expect(Object.keys(DRAFT_OTHER_START_COMMANDS).sort()).toEqual([...DRAFT_OTHER_STARTS].sort());
    expect(DRAFT_OTHER_START_COMMANDS).toEqual({
      blank: { command: 'erdStudio.createDomain', args: [] },
      import: { command: 'erdStudio.importModel', args: [] },
      guide: { command: 'erdStudio.showImportGuide', args: [{ from: 'draft' }] },
      example: { command: 'erdStudio.openExampleProject', args: [] },
      openFolder: { command: 'vscode.openFolder', args: [] },
    });
    expect(Object.isFrozen(DRAFT_OTHER_START_COMMANDS)).toBe(true);
  });

  it('every command it names is contributed or VS Code\'s own', async () => {
    const pkg = (await import('../../package.json')).default as { contributes: { commands: Array<{ command: string }> } };
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const { command } of Object.values(DRAFT_OTHER_START_COMMANDS)) {
      expect(command.startsWith('vscode.') || contributed.has(command), command).toBe(true);
    }
  });

  it.each(DRAFT_OTHER_STARTS)('%s: the page sends the id; the host runs its command after the page closed, counted draftOtherStart', async (start) => {
    const w = wired([{ otherStart: start }]);
    const answer = await w.preview.ask(draft('example', 'example'));
    expect(answer).toEqual({ kind: 'otherStart', start });
    const { command, args } = DRAFT_OTHER_START_COMMANDS[start];
    expect(w.commands).toEqual([[command, ...args]]);
    expect(w.features).toContain('draftOtherStart');
  });
});

describe('trackedDraftPreview: the gate and the funnel', () => {
  it('claims the window\'s one prompt on every ask, and counts what was shown (fixed keys only)', async () => {
    const w = wired(['discard']);
    await w.preview.ask(draft('sqlDdl', 'sidebar'));
    expect(w.claim).toHaveBeenCalledTimes(1);
    expect(w.features).toEqual(['draftShown', 'draftShownAuto', 'draftSourceSqlDdl', 'draftDiscarded']);
  });

  it('counts each source and the examples apart', async () => {
    for (const source of DRAFT_SOURCES) {
      const w = wired(['closed']);
      await w.preview.ask(draft(source, 'start'));
      const expected = ['draftShown', ...(source === 'example' || source === 'exampleProject' ? ['draftExampleShown'] : []),
        ...(DRAFT_SOURCE_FEATURES[source] ? [DRAFT_SOURCE_FEATURES[source]!] : []), 'draftClosed'];
      expect(w.features, source).toEqual(expected);
    }
  });

  it('a redraw of the page on show (the switcher\'s next draft, a Keep that found the files changed) is not another draftShown', async () => {
    const w = wired([{ scope: 'b' }, 'keep', 'discard']);
    await w.preview.ask(draft('dbt', 'sidebar'));
    const keep = await w.preview.ask(draft('dbt', 'sidebar'));
    if (keep.kind !== 'keep') throw new Error('expected keep');
    keep.settle({ kept: false });
    await w.preview.ask(draft('dbt', 'sidebar'));
    expect(w.features.filter((k) => k === 'draftShown')).toHaveLength(1);
    expect(w.features).toEqual(['draftShown', 'draftShownAuto', 'draftSourceDbt', 'draftScopeChanged', 'draftDiscarded']);
  });

  it('Keep: counted only when it wrote, once; the folder is marked started for an import or Draw from dbt, never for an example project', async () => {
    const w = wired(['keep']);
    const d = draft('sqlDdl', 'prompt', IMPORT_KEEP);
    const answer = await w.preview.ask(d);
    if (answer.kind !== 'keep') throw new Error('expected keep');
    answer.settle({ kept: true });
    answer.settle({ kept: true });
    await Promise.resolve();
    expect(w.features.filter((k) => k === 'draftKept')).toHaveLength(1);
    expect(w.kept).toEqual([d]);
    expect(w.inner.settled).toEqual([{ kept: true }]);

    const project = wired(['keep']);
    const a = await project.preview.ask(draft('exampleProject', 'example', { writer: 'exampleProject', exampleId: 'medallion' }));
    if (a.kind !== 'keep') throw new Error('expected keep');
    a.settle({ kept: true });
    expect(project.features).toContain('draftKept');
    expect(project.kept).toEqual([]);

    const failed = wired(['keep']);
    const f = await failed.preview.ask(draft('dbml', 'start', IMPORT_KEEP));
    if (f.kind !== 'keep') throw new Error('expected keep');
    f.settle({ kept: false });
    expect(failed.features).not.toContain('draftKept');
    expect(failed.kept).toEqual([]);
  });

  it('superseded counts nothing (another flow took the page); Change options… counts draftChangeOptions', async () => {
    const w = wired(['superseded', 'changeOptions']);
    await w.preview.ask(draft('dbml', 'palette'));
    expect(w.features).toEqual(['draftShown', 'draftSourceDbml']);
    await w.preview.ask(draft('dbml', 'palette'));
    expect(w.features).toContain('draftChangeOptions');
  });

  it('the passive events: details opened is a feature, a failed layout an error code', () => {
    const features: string[] = [];
    const errors: string[] = [];
    const events = draftPreviewEvents((k) => features.push(k), (c) => errors.push(c));
    events.detailsOpened('sqlDdl');
    events.layoutFailed('sqlDdl');
    expect(features).toEqual(['draftDetailsOpened']);
    expect(errors).toEqual(['draftLayoutFailed']);
  });

  it('every key it counts is an allowlisted feature or error code (user cancels are features)', () => {
    for (const key of ['draftShown', 'draftShownAuto', 'draftExampleShown', 'draftKept', 'draftChangeOptions', 'draftDiscarded',
      'draftClosed', 'draftOtherStart', 'draftScopeChanged', 'draftDetailsOpened', 'draftRefreshed', 'draftUnavailable',
      ...Object.values(DRAFT_SOURCE_FEATURES)]) {
      expect(FEATURES as readonly string[]).toContain(key);
    }
    expect(ERROR_CODES as readonly string[]).toEqual(expect.arrayContaining(['draftBuildFailed', 'draftLayoutFailed']));
    expect(ERROR_CODES as readonly string[]).not.toContain('draftDiscarded');
  });
});

describe('DraftGeneration', () => {
  it('counts the bumps (the watchers\' changes that are not ERD Studio\'s own)', () => {
    const g = new DraftGeneration();
    expect(g.value).toBe(0);
    g.bump();
    g.bump();
    expect(g.value).toBe(2);
  });
});
