/**
 * The no-folder route: a draft's Open Folder… (the no-folder example's
 * primary, the guide's "Open your folder") reloads the window into a folder,
 * and that folder's draft shows at once, with the guide carrying on. The mark
 * (src/services/draftTriggers.ts) is written and awaited before Open Folder
 * runs (src/providers/draftWiring.ts); the guide resumes without counting a
 * new run and without More ways to start (src/providers/guideWiring.ts,
 * src/types/onboardingGuide.ts).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  DRAFT_AFTER_OPEN_FOLDER_MS,
  draftAfterOpenFolderDue,
  draftAfterOpenFolderShows,
} from '../../src/services/draftTriggers';
import { trackedDraftPreview } from '../../src/providers/draftWiring';
import { OnboardingGuide, type OnboardingGuideDeps } from '../../src/providers/guideWiring';
import { isDraftToWebview, type Draft, type DraftView } from '../../src/types/draft';
import { draftGuideSteps, type GuideStatus } from '../../src/types/onboardingGuide';
import { fakeDraftPreview } from './helpers/draftDriver';

const ROOT = path.resolve(__dirname, '../..');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/draft', `${name}.json`), 'utf8')) as DraftView;
const NOW = Date.parse('2026-11-05T10:00:00Z');

describe('the mark', () => {
  it('is due only while fresh and well-formed', () => {
    expect(draftAfterOpenFolderDue({ at: NOW - 1000, guide: true }, NOW)).toEqual({ at: NOW - 1000, guide: true });
    expect(draftAfterOpenFolderDue({ at: NOW - DRAFT_AFTER_OPEN_FOLDER_MS, guide: false }, NOW)).toEqual({ at: NOW - DRAFT_AFTER_OPEN_FOLDER_MS, guide: false });
    expect(draftAfterOpenFolderDue({ at: NOW - DRAFT_AFTER_OPEN_FOLDER_MS - 1, guide: true }, NOW)).toBeUndefined();
    expect(draftAfterOpenFolderDue({ at: NOW + 60_000, guide: true }, NOW)).toBeUndefined();
    for (const junk of [undefined, null, 'yes', 42, {}, { at: 'now' }, { at: Number.NaN }]) expect(draftAfterOpenFolderDue(junk, NOW)).toBeUndefined();
    expect(draftAfterOpenFolderDue({ at: NOW, guide: 'yes' }, NOW)?.guide).toBe(false);
  });

  it('shows the folder\'s find, else the example; with diagrams, the newest diagram only when the guide runs', () => {
    expect(draftAfterOpenFolderShows({ hasDiagrams: false, guide: true, intent: 'importSqlDdl' })).toBe('find');
    expect(draftAfterOpenFolderShows({ hasDiagrams: false, guide: false, intent: 'drawFromDbt' })).toBe('find');
    expect(draftAfterOpenFolderShows({ hasDiagrams: false, guide: true, intent: 'blank' })).toBe('example');
    expect(draftAfterOpenFolderShows({ hasDiagrams: false, guide: true, intent: undefined })).toBe('example');
    expect(draftAfterOpenFolderShows({ hasDiagrams: true, guide: true, intent: 'importSqlDdl' })).toBe('diagram');
    expect(draftAfterOpenFolderShows({ hasDiagrams: true, guide: false, intent: 'importSqlDdl' })).toBeUndefined();
  });
});

describe('Open Folder… from a draft', () => {
  it('writes the mark, and waits for it, before VS Code\'s Open Folder runs', async () => {
    const order: string[] = [];
    let landed: () => void = () => {};
    const preview = trackedDraftPreview(fakeDraftPreview([{ otherStart: 'openFolder' }]), {
      claim: () => undefined,
      feature: () => undefined,
      onKept: () => undefined,
      executeCommand: async (command) => { order.push(command); },
      beforeOpenFolder: () => new Promise<void>((resolve) => { order.push('mark:start'); landed = () => { order.push('mark:landed'); resolve(); }; }),
    });
    await preview.ask({ ...fixture('example-no-folder'), keep: { writer: 'none' }, trigger: 'start' } as Draft);
    await Promise.resolve();
    expect(order).toEqual(['mark:start']);
    landed();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['mark:start', 'mark:landed', 'vscode.openFolder']);
  });

  it('another start runs at once, with no mark', async () => {
    const order: string[] = [];
    const preview = trackedDraftPreview(fakeDraftPreview([{ otherStart: 'import' }]), {
      claim: () => undefined, feature: () => undefined, onKept: () => undefined,
      executeCommand: async (command) => { order.push(command); },
      beforeOpenFolder: async () => { order.push('mark'); },
    });
    await preview.ask({ ...fixture('small'), keep: { writer: 'none' }, trigger: 'start' } as Draft);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['erdStudio.importModel']);
  });
});

describe('the guide carries on in the window that opened', () => {
  function guideAt(status: GuideStatus | undefined) {
    const features: string[] = [];
    const deps: OnboardingGuideDeps = {
      getStatus: () => status, setStatus: (s) => { status = s; }, feature: (k) => { features.push(k); },
      executeCommand: async () => undefined, openExternal: async () => undefined,
      semanticDir: () => '.erd-studio', dbml: () => true, holdPrompts: () => undefined,
    };
    return { guide: new OnboardingGuide(deps), features };
  }
  const sql = (): Draft => ({ ...fixture('small'), keep: { writer: 'none' }, trigger: 'sidebar' } as Draft);

  it('reports whether phase A is running, for the mark', () => {
    const g = guideAt(undefined);
    expect(g.guide.draftRunning()).toBe(false);
    g.guide.takeDraft(sql());
    expect(g.guide.draftRunning()).toBe(true);
  });

  it('resumes phase A on the next draft as the same run: resumed, nothing counted again', () => {
    const g = guideAt('draft');
    expect(g.guide.takeDraft(sql())).toBeUndefined();
    g.guide.resumeDraft();
    expect(g.guide.takeDraft(sql())).toEqual({ resumed: true, semanticDir: '.erd-studio' });
    expect(g.features).toEqual([]);
    // Only once: a later draft in the same run is not "resumed".
    expect(g.guide.takeDraft(sql())).toEqual({ semanticDir: '.erd-studio' });
  });

  it('does not resume a guide that was skipped or finished meanwhile', () => {
    for (const status of ['skipped', 'done', 'canvas', undefined] as const) {
      const g = guideAt(status);
      g.guide.resumeDraft();
      expect(g.guide.draftRunning()).toBe(false);
    }
  });

  it('a resumed draft leaves out More ways to start, already shown; it keeps the draft and Keep', () => {
    const view = fixture('small');
    const normal = draftGuideSteps({ view }).map((s) => s.id);
    expect(normal).toContain('draftMoreWays');
    expect(draftGuideSteps({ view, resumed: true }).map((s) => s.id)).toEqual(normal.filter((id) => id !== 'draftMoreWays'));
  });

  it('the page message carries resumed, checked', () => {
    expect(isDraftToWebview({ type: 'guide', resumed: true, semanticDir: '.erd-studio' })).toBe(true);
    expect(isDraftToWebview({ type: 'guide', resumed: 'yes' })).toBe(false);
  });
});
