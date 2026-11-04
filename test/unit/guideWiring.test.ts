/**
 * The onboarding guide's host side (Show Me Around, src/providers/guideWiring.ts):
 * the fixed command and URL behind each action id, the once-per-machine
 * flags (skip ends it for good, the command runs it again), the deferral of
 * other prompts while its canvas part is owed or on screen, its place in the
 * shared draft preview and its messages on the draft page and the canvas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import {
  GUIDE_AI_HELPER_COMMAND,
  GUIDE_DEFERRED_PROMPTS,
  GUIDE_REVEAL_SIDEBAR_COMMAND,
  GUIDE_STAR_URL,
  OnboardingGuide,
  guideDefersPrompt,
  type OnboardingGuideDeps,
} from '../../src/providers/guideWiring';
import { draftPreviewEvents, trackedDraftPreview } from '../../src/providers/draftWiring';
import { DraftPreviewPanel, createDraftPreview } from '../../src/providers/DraftPreviewPanel';
import { validateGuidePayload } from '../../src/providers/payloadValidation';
import { ACTIVATION_PROMPT_PRIORITY, SessionPromptGate } from '../../src/services/activationPrompts';
import { GITHUB_REPO } from '../../src/services/feedbackService';
import { draftAllowance, isDraftToWebview, parseDraftToHost, type Draft, type DraftSource, type DraftTrigger, type DraftView } from '../../src/types/draft';
import type { GuideStatus } from '../../src/types/onboardingGuide';
import { fakeDraftPreview, type ScriptedAnswer } from './helpers/draftDriver';

const ROOT = path.resolve(__dirname, '../..');
const fixture = (name: string): DraftView => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/draft', `${name}.json`), 'utf8')) as DraftView;
const draftOf = (name: string, trigger: DraftTrigger = 'start', patch: Partial<Draft> = {}): Draft => ({ ...fixture(name), keep: { writer: 'none' }, trigger, ...patch });
const IMPORT_KEEP: Draft['keep'] = {
  writer: 'importDbml', importSource: 'sql', fingerprint: 'f',
  target: { layer: 'main', layerLabel: 'Main', name: 'sales', diagramFile: '.erd-studio/main/diagrams/sales.dbml' },
};
const sqlDraft = (trigger: DraftTrigger = 'prompt'): Draft => draftOf('small', trigger, { keep: IMPORT_KEEP, id: `small-${Math.random()}` });
const exampleDraft = (trigger: DraftTrigger, source: DraftSource = 'example'): Draft => draftOf('example-no-folder', trigger, { source, id: `ex-${Math.random()}` });

function host(initial?: GuideStatus) {
  let status: GuideStatus | undefined = initial;
  const features: string[] = [];
  const commands: unknown[][] = [];
  const opened: string[] = [];
  const statuses: GuideStatus[] = [];
  const holdPrompts = vi.fn();
  const deps: OnboardingGuideDeps = {
    getStatus: () => status,
    setStatus: (s) => { status = s; statuses.push(s); },
    feature: (key) => { features.push(key); },
    executeCommand: async (...args) => { commands.push(args); },
    openExternal: async (url) => { opened.push(url); },
    semanticDir: () => '.erd-studio',
    dbml: () => true,
    holdPrompts,
  };
  return { guide: new OnboardingGuide(deps), features, commands, opened, statuses, holdPrompts, status: () => status };
}

describe('the fixed effects of each action id', () => {
  it('Star on GitHub opens exactly the repository page, built from GITHUB_REPO, and finishes the guide', () => {
    expect(GUIDE_STAR_URL).toBe('https://github.com/liam-machine/erd-studio');
    expect(GUIDE_STAR_URL).toBe(`https://github.com/${GITHUB_REPO}`);
    const h = host('draft');
    h.guide.takeCanvas();
    h.guide.onCanvasAction({ action: 'star' });
    expect(h.opened).toEqual(['https://github.com/liam-machine/erd-studio']);
    expect(h.commands).toEqual([]);
    expect(h.features).toEqual(['guideCanvasStarted', 'guideStarClicked', 'guideCompleted']);
    expect(h.status()).toBe('done');
  });

  it('Set Up My AI Helper runs the existing command, and the guide goes on', () => {
    const h = host('draft');
    h.guide.takeCanvas();
    h.guide.onCanvasAction({ action: 'aiHelper' });
    expect(GUIDE_AI_HELPER_COMMAND).toBe('erdStudio.setupAiHelper');
    expect(h.commands).toEqual([['erdStudio.setupAiHelper']]);
    expect(h.features).toContain('guideAiHelperClicked');
    expect(h.status()).toBe('canvas');
  });

  it('the sidebar step reveals the ERD Studio view container, the one package.json contributes', async () => {
    const h = host('draft');
    h.guide.onCanvasAction({ action: 'revealSidebar' });
    expect(h.commands).toEqual([['workbench.view.extension.erd-studio']]);
    const pkg = (await import('../../package.json')).default as { contributes: { viewsContainers: { activitybar: Array<{ id: string }> } } };
    expect(GUIDE_REVEAL_SIDEBAR_COMMAND).toBe(`workbench.view.extension.${pkg.contributes.viewsContainers.activitybar[0].id}`);
  });

  it('Set Up My AI Helper is a contributed command', async () => {
    const pkg = (await import('../../package.json')).default as { contributes: { commands: Array<{ command: string }> } };
    expect(pkg.contributes.commands.map((c) => c.command)).toContain(GUIDE_AI_HELPER_COMMAND);
    expect(pkg.contributes.commands.map((c) => c.command)).toContain('erdStudio.showMeAround');
  });

  it('Done finishes once; a step is only logged', () => {
    const h = host('draft');
    h.guide.takeCanvas();
    h.guide.onCanvasAction({ action: 'step', step: 'canvasTable' });
    h.guide.onCanvasAction({ action: 'complete' });
    h.guide.onCanvasAction({ action: 'complete' });
    expect(h.features.filter((f) => f === 'guideCompleted')).toHaveLength(1);
    expect(h.status()).toBe('done');
  });
});

describe('once per machine: when each phase runs', () => {
  it('phase A on the first draft only, its flag written before it shows', () => {
    const h = host();
    const start = h.guide.takeDraft(sqlDraft());
    expect(start).toEqual({ semanticDir: '.erd-studio' });
    expect(h.statuses).toEqual(['draft']);
    expect(h.features).toEqual(['guideStarted']);
    h.guide.draftLeft(sqlDraft());
    expect(h.guide.takeDraft(sqlDraft())).toBeUndefined();
  });

  it('phase A carries on to the next draft (Change options…, another start) until Keep, Discard or Skip', () => {
    const h = host();
    h.guide.takeDraft(sqlDraft());
    expect(h.guide.takeDraft(sqlDraft('changeOptions'))).toBeDefined();
    expect(h.features).toEqual(['guideStarted']);
    h.guide.draftKept(sqlDraft());
    expect(h.features).toEqual(['guideStarted', 'guideDraftDone']);
    expect(h.guide.takeDraft(sqlDraft())).toBeUndefined();
  });

  it('an automatic example says nothing was found; one the user asked for does not', () => {
    expect(host().guide.takeDraft(exampleDraft('sidebar'))).toEqual({ nothingFound: true, semanticDir: '.erd-studio' });
    expect(host().guide.takeDraft(exampleDraft('example'))).toEqual({ semanticDir: '.erd-studio' });
    const h = host('done');
    h.guide.requestDraft({ nothingFound: true });
    expect(h.guide.takeDraft(exampleDraft('example'))).toEqual({ nothingFound: true, semanticDir: '.erd-studio' });
  });

  it('phase B on the first diagram after phase A, once, holding the window\'s prompts', () => {
    const h = host();
    expect(h.guide.takeCanvas()).toBeUndefined();
    h.guide.takeDraft(sqlDraft());
    h.guide.draftKept(sqlDraft());
    expect(h.guide.takeCanvas()).toEqual({ dbml: true, semanticDir: '.erd-studio' });
    expect(h.status()).toBe('canvas');
    expect(h.holdPrompts).toHaveBeenCalledTimes(1);
    expect(h.guide.takeCanvas()).toBeUndefined();
  });

  it('phase B in a later window: the status alone decides', () => {
    const later = host('draft');
    expect(later.guide.takeCanvas()).toBeDefined();
    expect(later.features).toEqual(['guideCanvasStarted']);
    expect(host('canvas').guide.takeCanvas()).toBeUndefined();
  });

  it('Skip on the draft ends it for good: no phase B, no phase A on the next draft', () => {
    const h = host();
    h.guide.takeDraft(sqlDraft());
    h.guide.onDraftAction({ action: 'skip' });
    expect(h.status()).toBe('skipped');
    expect(h.features).toEqual(['guideStarted', 'guideSkippedOnDraft']);
    expect(h.guide.takeDraft(sqlDraft())).toBeUndefined();
    expect(h.guide.takeCanvas()).toBeUndefined();
  });

  it('Skip on the canvas ends it for good', () => {
    const h = host('draft');
    h.guide.takeCanvas();
    h.guide.onCanvasAction({ action: 'skip' });
    expect(h.status()).toBe('skipped');
    expect(h.features).toEqual(['guideCanvasStarted', 'guideSkippedOnCanvas']);
    expect(h.guide.takeCanvas()).toBeUndefined();
    expect(h.guide.takeDraft(sqlDraft())).toBeUndefined();
  });

  it('the command runs it again after a skip: on a draft, on the open canvas, on the diagram it opens', () => {
    const h = host('skipped');
    h.guide.requestDraft();
    expect(h.guide.takeDraft(sqlDraft())).toBeDefined();
    expect(h.features).toEqual(['guideStarted', 'guideStartedFromCommand']);

    const c = host('done');
    expect(c.guide.startOnCanvas()).toEqual({ dbml: true, semanticDir: '.erd-studio' });
    expect(c.features).toEqual(['guideStarted', 'guideStartedFromCommand', 'guideCanvasStarted']);

    const o = host('skipped');
    o.guide.requestCanvas();
    expect(o.guide.canvasRequested()).toBe(true);
    expect(o.guide.takeCanvas()).toBeDefined();
    expect(o.guide.canvasRequested()).toBe(false);
    expect(o.features).toEqual(['guideStarted', 'guideStartedFromCommand', 'guideCanvasStarted']);

    const d = host('done');
    d.guide.startOnOpenDraft();
    expect(d.status()).toBe('draft');
  });
});

describe('nothing else pops over the canvas part', () => {
  it('while phase B is owed, activation holds back the prompts that would cover its canvas (each keeps its flag)', () => {
    for (const kind of ['diagramsNudge', 'harnessInstall', 'harnessUpdate', 'upgradeNotice', 'migrateToV5', 'saveLayers'] as const) {
      expect(guideDefersPrompt(kind, 'draft'), kind).toBe(true);
      expect(guideDefersPrompt(kind, undefined), kind).toBe(false);
      expect(guideDefersPrompt(kind, 'done'), kind).toBe(false);
      expect(guideDefersPrompt(kind, 'skipped'), kind).toBe(false);
    }
    // The starts lead to the canvas: they still show.
    expect(guideDefersPrompt('startSuggestion', 'draft')).toBe(false);
    expect(guideDefersPrompt('walkthrough', 'draft')).toBe(false);
    expect(ACTIVATION_PROMPT_PRIORITY.filter((k) => !GUIDE_DEFERRED_PROMPTS.has(k))).toEqual(['startSuggestion', 'walkthrough']);
  });

  it('while phase B is on screen it holds the window\'s one prompt: the AI helper offer and the canvas offers are refused', () => {
    const gate = new SessionPromptGate();
    const h = new OnboardingGuide({
      getStatus: () => 'draft', setStatus: () => undefined, feature: () => undefined,
      executeCommand: async () => undefined, openExternal: async () => undefined,
      semanticDir: () => '.erd-studio', dbml: () => true,
      holdPrompts: () => gate.reserve('guide'),
    });
    h.takeCanvas();
    expect(gate.claimed).toBe('guide');
    for (const kind of ['harnessInstall', 'diagramsNudge', 'dbmlConversion', 'namingMigration'] as const) expect(gate.claim(kind)).toBe(false);
  });

  it('a phase B that starts while the start suggestion still looks takes the window as soon as it is handed on', () => {
    const gate = new SessionPromptGate();
    gate.claim('startSuggestion');
    gate.reserve('guide');
    gate.release('startSuggestion');
    expect(gate.claimed).toBe('guide');
    expect(gate.claim('harnessInstall')).toBe(false);
  });
});

describe('in the shared draft preview', () => {
  function wired(answers: ScriptedAnswer[], status?: GuideStatus) {
    const inner = fakeDraftPreview(answers);
    const startGuide = vi.fn();
    const h = host(status);
    const order: string[] = [];
    const preview = trackedDraftPreview({ ...inner, startGuide: (s) => { order.push('startGuide'); startGuide(s); }, ask: (d) => { order.push(`ask:${h.status()}`); return inner.ask(d); } }, {
      claim: () => undefined,
      executeCommand: async () => undefined,
      feature: () => undefined,
      onKept: () => undefined,
      guide: {
        takeDraft: (d) => h.guide.takeDraft(d),
        draftKept: (d) => h.guide.draftKept(d),
        draftLeft: (d) => h.guide.draftLeft(d),
      },
    });
    return { preview, startGuide, h, order };
  }

  it('the first draft gets phase A: its flag is written before the page is asked, then the page is told', async () => {
    const w = wired(['keep']);
    const answer = await w.preview.ask(sqlDraft());
    expect(w.order).toEqual(['ask:draft', 'startGuide']);
    expect(w.startGuide).toHaveBeenCalledWith({ semanticDir: '.erd-studio' });
    if (answer.kind === 'keep') answer.settle({ kept: true });
    expect(w.h.features).toEqual(['guideStarted', 'guideDraftDone']);
  });

  it('a Keep that did not save is not phase A done', async () => {
    const w = wired(['keep']);
    const answer = await w.preview.ask(sqlDraft());
    if (answer.kind === 'keep') answer.settle({ kept: false });
    expect(w.h.features).toEqual(['guideStarted']);
  });

  it('Discard stops phase A; the next draft has no guide, phase B is still owed', async () => {
    const w = wired(['discard', 'closed']);
    await w.preview.ask(sqlDraft());
    await w.preview.ask(sqlDraft());
    expect(w.startGuide).toHaveBeenCalledTimes(1);
    expect(w.h.guide.takeCanvas()).toBeDefined();
  });

  it('Change options… carries phase A on to its draft', async () => {
    const w = wired(['changeOptions', 'closed']);
    await w.preview.ask(sqlDraft());
    await w.preview.ask(sqlDraft('changeOptions'));
    expect(w.startGuide).toHaveBeenCalledTimes(2);
    expect(w.h.features).toEqual(['guideStarted']);
  });

  it('a later draft on a machine that has had the guide gets none', async () => {
    const w = wired(['closed'], 'done');
    await w.preview.ask(sqlDraft());
    expect(w.startGuide).not.toHaveBeenCalled();
  });
});

describe('the draft page\'s guide messages', () => {
  const view = fixture('small');

  it('parseDraftToHost accepts step and skip only, rebuilt; the host may tell the page to run it', () => {
    const allowed = draftAllowance(view);
    expect(parseDraftToHost({ type: 'guide', action: 'step', step: 'draftBanner' }, allowed)).toEqual({ type: 'guide', action: 'step', step: 'draftBanner' });
    expect(parseDraftToHost({ type: 'guide', action: 'skip', extra: 1 }, allowed)).toEqual({ type: 'guide', action: 'skip' });
    for (const bad of [{ type: 'guide', action: 'star' }, { type: 'guide', action: 'aiHelper' }, { type: 'guide', action: 'step' }, { type: 'guide', action: 'step', step: 'x' }, { type: 'guide' }]) {
      expect(parseDraftToHost(bad, allowed), JSON.stringify(bad)).toBeUndefined();
    }
    expect(isDraftToWebview({ type: 'guide' })).toBe(true);
    expect(isDraftToWebview({ type: 'guide', nothingFound: true, semanticDir: '.erd-studio' })).toBe(true);
    expect(isDraftToWebview({ type: 'guide', nothingFound: 'yes' })).toBe(false);
  });

  it('draftPreviewEvents hands the guide\'s messages to the host', () => {
    const guide = vi.fn();
    const events = draftPreviewEvents(() => undefined, () => undefined, guide);
    events.guide?.({ action: 'skip' }, view);
    expect(guide).toHaveBeenCalledWith({ action: 'skip' });
    expect(draftPreviewEvents(() => undefined, () => undefined).guide).toBeUndefined();
  });

  describe('through the real preview tab', () => {
    beforeEach(() => { DraftPreviewPanel.close(); _resetMockWebviewPanels(); });
    afterEach(() => DraftPreviewPanel.close());

    type MockPanel = { _postedMessages: unknown[]; _simulateMessage(m: unknown): Promise<void> };
    const lastPanel = (): MockPanel => {
      const panels = (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels;
      return panels[panels.length - 1];
    };

    it('posts the guide after the draft once the page is ready, and reports its passive messages', async () => {
      const guide = vi.fn();
      const preview = createDraftPreview(vscode.Uri.file('/ext'), { guide });
      void preview.ask(draftOf('small'));
      preview.startGuide?.({ nothingFound: true, semanticDir: '.erd-studio' });
      const panel = lastPanel();
      expect(panel._postedMessages).toEqual([]);
      await panel._simulateMessage({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 0));
      expect(panel._postedMessages.map((m) => (m as { type: string }).type)).toEqual(['draft', 'guide']);
      expect(panel._postedMessages[1]).toEqual({ type: 'guide', nothingFound: true, semanticDir: '.erd-studio' });
      await panel._simulateMessage({ type: 'guide', action: 'skip' });
      await panel._simulateMessage({ type: 'guide', action: 'star' });
      expect(guide).toHaveBeenCalledTimes(1);
      expect(guide.mock.calls[0][0]).toEqual({ action: 'skip' });
      // Passive: the draft is still waiting for its answer.
      expect(preview.isOpen()).toBe(true);
    });
  });
});

describe('the canvas\'s guide message', () => {
  it('validateGuidePayload accepts the fixed actions only', () => {
    expect(validateGuidePayload({ action: 'star' })).toBeNull();
    expect(validateGuidePayload({ action: 'step', step: 'canvasFinish' })).toBeNull();
    expect(validateGuidePayload({ action: 'openUrl', url: 'https://x' })).not.toBeNull();
    expect(validateGuidePayload(undefined)).not.toBeNull();
  });
});
