/**
 * Welcome panel (the "ERD Studio Tour" tab) — the pure protocol/HTML module
 * (`src/types/gettingStarted.ts`) and the host (`GettingStartedPanel.ts`):
 * CSP, the message validator, every host-bound type having a live sender in
 * the panel script and a handler in the host, fixed external URLs, the
 * setupAiHelper branches, Claude Code detection and the Open Claude launch.
 * The panel script itself is run in jsdom to check the step cards switch
 * variants from a `status` message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as vscode from 'vscode';

import {
  GETTING_STARTED_EXTERNAL_URLS,
  GETTING_STARTED_PASSIVE_TYPES,
  GETTING_STARTED_TO_HOST_TYPES,
  SHOW_ME_AROUND_COMMAND,
  SHOW_ME_AROUND_LABEL,
  SHOW_ME_AROUND_SECTION_INTRO,
  SHOW_ME_AROUND_SECTION_TITLE,
  SAMPLE_CODESPACES_LIVE,
  SAMPLE_CODESPACES_URL,
  SAMPLE_REPO_CLONE_URL,
  SAMPLE_REPO_URL,
  SETUP_PROMPT,
  buildGettingStartedCsp,
  buildGettingStartedHtml,
  copyText,
  deriveAiHelperState,
  describeWrittenFiles,
  formatProjectSummary,
  isGettingStartedToHost,
  promptFor,
  setupReadyMessage,
  type GettingStartedHarness,
  type GettingStartedStatus,
  type SetupOutcome,
} from '../../src/types/gettingStarted';
import {
  GETTING_STARTED_VIEW_TYPE,
  GettingStartedPanel,
  SETUP_CANCELLED_MESSAGE,
  SETUP_READY_MESSAGE,
  COPILOT_CHAT_OPEN_COMMAND,
  HELPER_FIRST_MESSAGE,
  SETUP_HELPER_ACTION,
  SAMPLE_CONFIRM_MESSAGE,
  SAMPLE_DOWNLOAD_ACTION,
  SAMPLE_FALLBACK_MESSAGE,
  SAMPLE_OPEN_ON_GITHUB_ACTION,
  TRY_SAMPLE_COMMAND,
  GETTING_STARTED_MEDIA,
  computeProjectSummary,
  gettingStartedCut,
  pageModeForDeps,
  trySampleProject,
  claudeLaunchLine,
  claudeTerminalLaunch,
  detectAiAssistants,
  detectAiAssistantsWith,
  displayLauncherPath,
  isOnPath,
  keepMineInstalls,
  locateClaudeCli,
  openClaudeCode,
  openCopilotChat,
  runSetupAiHelper,
  type GettingStartedDeps,
  type SetupAiHelperDeps,
} from '../../src/providers/GettingStartedPanel';
import { GETTING_STARTED_CUES, GETTING_STARTED_TRANSCRIPT } from '../../src/types/gettingStartedTranscript';
import { LOGICAL_GETTING_STARTED_CUES, LOGICAL_GETTING_STARTED_TRANSCRIPT } from '../../src/types/gettingStartedLogicalTranscript';
import { HELP_ACTIONS } from '../../src/providers/HelpTreeProvider';
import {
  START_ACTIONS,
  START_ACTION_COMMANDS,
  START_INTENTS,
  START_INTENT_REASONS,
  startActionArgs,
  startActionsFor,
  startActionsForIntent,
  startIntentFor,
  type StartAction,
  type StartIntent,
} from '../../src/types/startActions';
import { START_FEATURES, START_INTENT_FEATURES } from '../../src/commands/start';
import { HARNESS_VERSION, HarnessService, extractHarnessVersion } from '../../src/services/harnessService';
import type { RecommendedInstallResult } from '../../src/types/harness';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');

const HTML_INPUT = {
  cspSource: 'https://mock-csp-source',
  nonce: 'abc123',
  videoUri: 'https://mock-csp-source/media/onboarding/getting-started.mp4',
  posterUri: 'https://mock-csp-source/media/onboarding/getting-started-poster.jpg',
  cues: [{ start: 0, end: 1, text: 'Hello </script><b>x</b>' }],
  transcript: 'Welcome <to> ERD Studio & friends',
};

const MISSING_FOLDER = { schemaSkill: 'missing', setupSkill: 'missing' } as const;

const STATUS: GettingStartedStatus = {
  hasProject: true,
  harness: { claude: { schemaSkill: 'current', setupSkill: 'missing' }, agents: MISSING_FOLDER },
  cli: 'missing',
  helper: 'missing',
  claude: 'missing',
  assistants: [],
  domainCount: 0,
  project: { name: 'jaffle_shop', relativePath: null },
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-gs-'));
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  vscode._resetRegisteredCommands();
  vscode.window.terminals.length = 0;
  vi.stubEnv('HOME', tmp);
  vi.stubEnv('USERPROFILE', tmp);
  vi.stubEnv('PATH', path.join(tmp, 'empty-bin'));
});
afterEach(() => {
  for (const panel of [...vscode.window._webviewPanels]) { panel.dispose(); }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HTML + CSP
// ---------------------------------------------------------------------------

describe('buildGettingStartedHtml', () => {
  it('uses the spec CSP: media-src and img-src from cspSource, nonce-only styles and scripts, no unsafe-inline', () => {
    const csp = buildGettingStartedCsp('https://src', 'N');
    expect(csp).toBe("default-src 'none'; img-src https://src; media-src https://src; style-src 'nonce-N'; script-src 'nonce-N';");
    const html = buildGettingStartedHtml(HTML_INPUT);
    expect(html).toContain('media-src https://mock-csp-source');
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    // Every style/script block carries the nonce; no inline style attributes (blocked by the CSP).
    expect(html.match(/<style(?![^>]*nonce="abc123")/g)).toBeNull();
    expect(html.match(/<script(?![^>]*nonce="abc123")/g)).toBeNull();
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/); // no inline event handlers
  });

  it('starts with sound (muted only as a fallback), adds captions from cues (no network <track>) and keeps the transcript', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    expect(html).toMatch(/<video class="gs-video__player" controls playsinline preload="auto" poster="https:\/\/mock-csp-source\/media\/onboarding\/getting-started-poster.jpg">/);
    expect(html).not.toMatch(/<video[^>]*\bmuted\b/);
    expect(html).toContain('video.muted = false;');
    expect(html).toContain('first.catch(startMuted)');
    expect(html).toContain('<button class="gs-video__sound" type="button" hidden>');
    expect(html).toContain('<source src="https://mock-csp-source/media/onboarding/getting-started.mp4" type="video/mp4">');
    expect(html).not.toContain('<track');
    expect(html).toContain("addTextTrack('captions', 'English', 'en')");
    expect(html).toContain('Turn on sound');
    expect(html).toContain('Welcome &lt;to&gt; ERD Studio &amp; friends');
  });

  it('inlines cue text so it can never close the script block', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    expect(html).not.toContain('Hello </script>');
    expect(html).toContain('Hello \\u003c/script>');
  });

  it('renders the fallback (poster + Watch in your browser) straight away when the video file is missing', () => {
    const html = buildGettingStartedHtml({ ...HTML_INPUT, videoUri: null });
    expect(html).toContain('gs-video gs-video--fallback');
    expect(html).not.toContain('<video');
    expect(html).toContain("This editor can't play the video here.");
    expect(html).toContain('data-target="videoOnline"');
    // Each cut's fallback opens its own online copy: never the dbt tour from a page without dbt.
    expect(buildGettingStartedHtml({ ...HTML_INPUT, videoUri: null, mode: 'dbt' })).toContain('data-target="videoOnline"');
    for (const mode of ['logical', 'nofolder'] as const) {
      const page = buildGettingStartedHtml({ ...HTML_INPUT, videoUri: null, mode });
      expect(page, mode).toContain('data-target="videoOnlineLogical"');
      expect(page, mode).not.toContain('data-target="videoOnline"');
    }
  });

  it('has the hero copy, the optional AI cards, the How-to clips and the rewatch footer; no start, Convert or "Open your diagrams" card (Draft-first)', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    // Its own name: never a second tab called Welcome beside VS Code's.
    expect(html).toContain('<title>ERD Studio Tour</title>');
    expect(html).toContain('<h1 class="gs-hero__title">The tour</h1>');
    expect(html).not.toMatch(/Welcome to ERD Studio|getting-started video/i);
    expect(html).toContain('Turn the dbt project you already have into a data model you can see.');
    const order = ['assistant', 'helper', 'start'].map((step) => html.indexOf(`data-step="${step}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The draft, the sidebar and the Convert offer are the starts: none of them here.
    for (const gone of ['data-step="canvas"', 'data-step="convert"', 'data-step="open"', 'data-step="begin"', 'data-action="openDomain"',
      'data-action="showImportGuide"', 'Draw your dbt project', '>Open your diagrams<', 'data-start-group', 'data-step="new"', 'data-step="dbml"', 'data-step="draw"']) {
      expect(html, gone).not.toContain(gone);
    }
    expect(html).toContain('Enrich with your AI assistant (optional)');
    expect(html).toContain('keys, grain, rationale and your team\'s modelling style');
    expect(html).toContain('ERD Studio: Watch the Tour');
    expect(html).toContain('Open the folder your data model lives in');
    expect(html).toContain('Any folder works');
    expect(html).toContain('data-action="openFolder"');
    expect(html).toContain('Your AI assistant');
    expect(html).toContain('Start the guided setup');
  });

  it('renders a chip and a start row for every assistant, each with exactly what to type', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    for (const [id, prompt] of [
      ['claude', '/erd-studio-setup'],
      ['copilot', '/erd-studio-setup'],
      ['codex', '$erd-studio-setup'],
      ['gemini', 'Set up ERD Studio for this project'],
      ['cursor', '/erd-studio-setup'],
    ]) {
      expect(html).toContain(`<li class="gs-chip" data-assistant-row="${id}" hidden>`);
      const row = html.slice(html.indexOf(`<div class="gs-launch__row" data-assistant-row="${id}"`));
      expect(row).toMatch(/^<div[^>]*>\s*<span class="gs-launch__name">[^<]+<\/span>\s*<code class="gs-launch__prompt">([^<]+)<\/code>/);
      expect(row.match(/<code class="gs-launch__prompt">([^<]+)<\/code>/)![1]).toBe(prompt);
      expect(html).toContain(`data-action="copyPrompt" data-assistant="${id}"`);
    }
    // Install links for every assistant (fixed targets only).
    for (const target of ['claudeCodeDocs', 'copilotDocs', 'codexDocs', 'geminiCliDocs', 'cursorDocs']) {
      expect(html).toContain(`data-target="${target}"`);
    }
  });

  it('every GettingStartedToHost type has a live sender in the panel markup/script', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    for (const type of GETTING_STARTED_TO_HOST_TYPES) {
      const sent = html.includes(`data-action="${type}"`) || html.includes(`type: '${type}'`);
      expect(sent, type).toBe(true);
    }
    // openExternal targets in the markup are all known.
    for (const [, target] of html.matchAll(/data-target="([^"]+)"/g)) {
      expect(Object.keys(GETTING_STARTED_EXTERNAL_URLS)).toContain(target);
    }
  });
});

// ---------------------------------------------------------------------------
// Panel script (jsdom)
// ---------------------------------------------------------------------------

/** A status as the host posts it: `intent` and `starts` from the start rule unless the test set its own. */
function withStarts(data: unknown): unknown {
  const m = data as { type?: string; payload?: GettingStartedStatus };
  if (m?.type !== 'status' || !m.payload || m.payload.starts !== undefined) { return data; }
  const s = m.payload;
  const hasDbt = s.hasProject && !s.logicalOnly;
  const intent = s.intent ?? startIntentFor({ hasProject: s.hasProject, hasDbt, storage: s.storage, hasDiagrams: s.domainCount > 0 });
  return { ...m, payload: { ...s, ...(intent ? { intent } : {}), starts: startActionsForIntent(intent, hasDbt) } };
}

function runPanelScript(html: string) {
  const posted: unknown[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    // jsdom has no media playback (addTextTrack, pause); keep its "not implemented" noise out of the run.
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => posted.push(m),
      });
    },
  });
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: withStarts(data) }));
  const visible = (selector: string) =>
    [...dom.window.document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.closest('[hidden]') === null).map((el) => el.textContent?.trim());
  return { dom, posted, send, visible, doc: dom.window.document };
}

describe('panel script', () => {
  it('posts ready, and switches card variants from a status message', () => {
    const { dom, posted, send, visible, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      expect(posted[0]).toEqual({ type: 'ready' });
      send({ type: 'status', payload: STATUS });

      expect(doc.querySelector('.gs')?.getAttribute('data-project')).toBe('true');
      // None detected: the install links, Claude Code first; no chips, no start rows.
      expect(visible('[data-step="assistant"] .gs-step__text').join()).toContain('none was found');
      expect(visible('[data-step="assistant"] .gs-btn').join()).toContain('Get Claude Code');
      expect(visible('[data-step="assistant"] .gs-get .gs-link')).toEqual(['GitHub Copilot', 'Codex', 'Gemini CLI', 'Cursor']);
      expect(visible('.gs-chip')).toEqual([]);
      expect(visible('.gs-launch__row')).toEqual([]);
      expect(visible('[data-step="helper"] .gs-step__text').join()).toContain('every supported assistant (so it\'s ready whichever you install)');
      expect(visible('[data-step="start"] .gs-step__hint').join()).toContain('see exactly what to type');
      // The skill detects the modelling style and confirms it (SKILL.md Stage 3b) — it never asks cold.
      expect(visible('[data-step="start"] .gs-step__text').join()).toContain('works out how your project is modelled and checks with you');
      expect(visible('[data-step="start"] .gs-step__text').join()).not.toContain('asks how your team');
      // Draft-first: no start card (the draft and the sidebar are the starts); the AI cards, numbered from 1.
      expect(visible('.gs-steps-wrap [data-action="start"]')).toEqual([]);
      expect(visible('.gs-step__num')).toEqual(['1', '2', '3']);
      expect(doc.querySelector('.gs-project-path')?.textContent).toBe('jaffle_shop');

      send({ type: 'status', payload: {
        ...STATUS, claude: 'cli', assistants: ['claude', 'copilot'], helper: 'ready', domainCount: 3,
        project: { name: 'dbt', relativePath: 'analytics/dbt' },
      } });
      expect(visible('.gs-chip')).toEqual(['Claude Code', 'GitHub Copilot']);
      expect(visible('[data-step="assistant"] .gs-get')).toEqual([]);
      expect(doc.querySelector('.gs-helper-for')?.textContent).toBe('Claude Code and GitHub Copilot');
      expect((doc.querySelector('.gs-helper-later') as HTMLElement).hidden).toBe(true);
      expect(visible('[data-step="helper"] .gs-step__status')).toEqual(['Installed']);
      expect(visible('.gs-launch__name')).toEqual(['Claude Code', 'GitHub Copilot']);
      expect(visible('.gs-launch__prompt')).toEqual(['/erd-studio-setup', '/erd-studio-setup']);
      expect(visible('[data-step="start"] .gs-btn').join()).toContain('Open Claude Code');
      expect(visible('[data-step="start"] .gs-btn').join()).toContain('Open Copilot Chat');
      expect(visible('[data-step="start"] .gs-btn').join()).toContain('Copy start command'); // Claude, nested
      expect((doc.querySelector('.gs-nested-hint') as HTMLElement).hidden).toBe(false);
      // Diagrams or not, the same cards: no "Open your diagrams" (the sidebar opens them).
      expect(visible('.gs-step__num')).toEqual(['1', '2', '3']);
      const shown = [...doc.querySelectorAll<HTMLElement>('.gs-step')].filter((el) => !el.hidden).map((el) => el.dataset.step);
      expect(shown).toEqual(['assistant', 'helper', 'start']);
    } finally {
      dom.window.close();
    }
  });

  it('hides the launch rows until step 2 has installed the guide', () => {
    const { dom, send, visible } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      send({ type: 'status', payload: { ...STATUS, assistants: ['claude'], helper: 'missing' } });
      expect(visible('.gs-chip')).toEqual(['Claude Code']);
      expect(visible('.gs-launch__row')).toEqual([]);
      expect(visible('[data-step="start"] .gs-btn')).toEqual([]);
      expect(visible('[data-step="start"] .gs-step__hint').join()).toContain('First press Set up my AI helper above: it installs the guide your assistant runs.');
      expect(visible('[data-step="assistant"] .gs-recheck').join()).toContain('ERD Studio: Install AI Helper Files… → Agent Skills');
      send({ type: 'status', payload: { ...STATUS, assistants: ['claude'], helper: 'ready' } });
      expect(visible('.gs-launch__name')).toEqual(['Claude Code']);
      expect(visible('[data-step="start"] .gs-step__hint').join()).not.toContain('First press');
    } finally {
      dom.window.close();
    }
  });

  it('shows the no-project line instead of the steps', () => {
    const { dom, send, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      send({ type: 'status', payload: { ...STATUS, hasProject: false, project: null } });
      expect(doc.querySelector('.gs')?.getAttribute('data-project')).toBe('false');
    } finally {
      dom.window.close();
    }
  });

  it('the open-a-folder card is one short line, a button and the example: no format parenthetical, not "saved as DBML"', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    const card = html.slice(html.indexOf('<section class="gs-noproject"'), html.indexOf('<div class="gs-steps-wrap">'));
    expect(card).toContain('Any folder works: ERD Studio keeps your design in <code>.erd-studio/</code>, next to your code.');
    expect(card).not.toContain('saved as DBML');
    expect(card).not.toMatch(/open format|YAML|JSON/);
  });

  it('offers the sample project (a dbt project) only on the dbt page: a small link above the steps, no card without a folder', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    // The empty window names no dbt control, and the sample is a dbt project.
    expect(html).not.toContain('<section class="gs-sample"');
    expect(html).not.toContain('Or try the sample project');
    expect(html).toContain('.gs[data-project="true"] .gs-noproject { display: none; }');
    expect(html).toContain('.gs[data-project="false"] .gs-steps-wrap { display: none; }');
    // The project-state link lives inside the steps (hidden with them when there is no project).
    const steps = html.slice(html.indexOf('<div class="gs-steps-wrap">'));
    expect(steps).toContain('<p class="gs-sample-link" data-modes="unknown dbt">');
    expect(steps).toContain('data-action="trySample">New to this? Try it on the sample project first</button>');
    expect(html.match(/data-action="trySample"/g)).toHaveLength(1);

    const { dom, posted, send, doc } = runPanelScript(html);
    try {
      send({ type: 'status', payload: STATUS });
      (doc.querySelector('.gs-sample-link [data-action="trySample"]') as HTMLElement).click();
      expect(posted.slice(1)).toEqual([{ type: 'trySample' }]);
    } finally {
      dom.window.close();
    }
  });

  it('shows the project summary line only when the host sent one, as text', () => {
    const { dom, send, visible, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      send({ type: 'status', payload: STATUS });
      expect(visible('.gs-summary')).toEqual([]);
      const line = 'Found 42 dbt models \u00b7 medallion layout \u00b7 manifest 3 days old <b>';
      send({ type: 'status', payload: { ...STATUS, summary: { modelCount: 42, layering: 'medallion', manifest: { state: 'present', ageDays: 3 }, line } } });
      expect(visible('.gs-summary')).toEqual([line]);
      expect(doc.querySelector('.gs-summary b')).toBeNull(); // text, never HTML
      send({ type: 'status', payload: { ...STATUS, hasProject: false, project: null, summary: { modelCount: 1, layering: null, manifest: { state: 'unknown' }, line: 'x' } } });
      expect((doc.querySelector('.gs-summary') as HTMLElement).hidden).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('leaves the Codespaces button off until the sample repo is ready for it', () => {
    expect(SAMPLE_CODESPACES_LIVE).toBe(false);
    const html = buildGettingStartedHtml(HTML_INPUT);
    expect(html).not.toContain('data-target="sampleCodespaces"');
    expect(html).toContain('data-action="trySample"');
  });

  it('on the dbt page, the sample link can also open the sample in Codespaces', () => {
    const html = buildGettingStartedHtml({ ...HTML_INPUT, codespaces: true });
    const sampleLink = html.slice(html.indexOf('<p class="gs-sample-link"'), html.indexOf('<h2 class="gs-section-title">Enrich'));
    expect(sampleLink).toContain('data-action="openExternal" data-target="sampleCodespaces"');
    expect(sampleLink).toContain('Open it in Codespaces');
    expect(sampleLink).toContain('Runs in your browser &mdash; nothing to install.');
    const { dom, posted, send, doc } = runPanelScript(html);
    try {
      send({ type: 'status', payload: { ...STATUS, domainCount: 0 } });
      (doc.querySelector('.gs-sample-link [data-target="sampleCodespaces"]') as HTMLElement).click();
      expect(posted.slice(1)).toEqual([{ type: 'openExternal', target: 'sampleCodespaces' }]);
    } finally {
      dom.window.close();
    }
  });

  it('buttons post their messages; setup disables itself until the result arrives', () => {
    const { dom, posted, send, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      send({ type: 'status', payload: STATUS });
      const click = (sel: string) => (doc.querySelector(sel) as HTMLElement).click();
      click('[data-action="setupAiHelper"]');
      click('[data-action="refreshStatus"]');
      click('[data-target="claudeCodeDocs"]');
      click('[data-action="copyPrompt"][data-assistant="codex"]');
      click('[data-action="openCopilotChat"]');
      expect(posted.slice(1)).toEqual([
        { type: 'setupAiHelper' },
        { type: 'refreshStatus' },
        { type: 'openExternal', target: 'claudeCodeDocs' },
        { type: 'copyPrompt', assistant: 'codex' },
        { type: 'openCopilotChat' },
      ]);
      expect((doc.querySelector('[data-action="setupAiHelper"]') as HTMLButtonElement).disabled).toBe(true);

      send({
        type: 'setupResult',
        payload: { ok: true, filesWritten: ['.gitignore'], message: 'Done <b>', groups: describeWrittenFiles(['.gitignore']) },
      });
      const result = doc.querySelector('.gs-result') as HTMLElement;
      expect(result.hidden).toBe(false);
      expect(result.querySelector('.gs-result__message')?.textContent).toBe('Done <b>'); // text, never HTML
      expect(result.querySelector('code')?.textContent).toBe('.gitignore');
    } finally {
      dom.window.close();
    }
  });

  it('logical-only: the AI cards and the guided setup, no start card, and no dbt step or line', () => {
    const { dom, posted, send, visible, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      const summary = { modelCount: 3, layering: null, manifest: { state: 'unknown' as const }, line: 'Found 3 dbt models' };
      send({ type: 'status', payload: { ...STATUS, logicalOnly: true, summary } });
      expect(doc.querySelector('.gs')?.getAttribute('data-mode')).toBe('logical');
      expect(doc.querySelector('.gs')?.getAttribute('data-project')).toBe('true');
      expect(visible('.gs-hero__sub')).toEqual(['Design your data model in Git. Let your AI build from it.']);
      const shown = [...doc.querySelectorAll<HTMLElement>('.gs-step')].filter((el) => !el.hidden).map((el) => el.dataset.step);
      expect(shown).toEqual(['assistant', 'helper', 'start']);
      expect(visible('.gs-step__num')).toEqual(['1', '2', '3']);
      expect(visible('.gs-steps-wrap [data-action="start"]')).toEqual([]);
      // No dbt wording where it no longer applies; the summary describes dbt models, so it stays off.
      expect(visible('.gs-section-intro').join()).not.toContain('dbt');
      expect(visible('.gs-sample-link')).toEqual([]);
      expect(visible('.gs-summary')).toEqual([]);
      // It says what it installs, and no longer that the guide needs dbt.
      expect(visible('[data-step="helper"] .gs-step__text span').join('')).toContain(
        'It also adds the /erd-studio-setup guide and a small checking tool your assistant uses behind the scenes.',
      );
      expect(visible('[data-step="helper"] .gs-step__text span').join('')).not.toContain('dbt');
      // The guided setup card, with its no-dbt text: design it with your assistant, no dbt wording.
      expect(visible('[data-step="start"] .gs-step__title')).toEqual(['Start the guided setup']);
      expect(visible('[data-step="start"] .gs-step__text span')).toEqual([
        'Your assistant asks what your business does and designs a first diagram with you — tables, keys, grain and how they connect — or builds on a DBML import or the tables you already have, then checks the files, explaining each step.',
      ]);
      expect(visible('[data-step="start"] .gs-step__hint').join(' ')).not.toContain('dbt');
      // With an assistant and the helper installed: where to start it, without "dbt project folder".
      send({ type: 'status', payload: { ...STATUS, logicalOnly: true, assistants: ['claude'], claude: 'cli', helper: 'ready' } });
      const shownText = (sel: string) => [...doc.querySelectorAll<HTMLElement>(sel)]
        .filter((el) => el.closest('[hidden]') === null)
        .map((el) => {
          const copy = el.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('[hidden]').forEach((h) => h.remove());
          return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
        });
      expect(shownText('[data-step="start"] .gs-step__hint')[0]).toBe('Start your assistant in your project folder: jaffle_shop');
      expect(shownText('[data-step="start"] .gs-step__hint').join(' ')).not.toContain('dbt');
      send({ type: 'status', payload: { ...STATUS, logicalOnly: true, summary } });
      expect(visible('[data-step="assistant"] .gs-step__text span').join('')).not.toContain('tested with');
      // No "Using dbt?" teaser, sample dbt project or dbt install link in a folder without dbt.
      expect(doc.querySelector('.gs-usedbt')).toBeNull();
      expect(visible('[data-target="dbtInstallDocs"]')).toEqual([]);

      // No start, no "Open your diagrams", whatever the diagrams.
      send({ type: 'status', payload: { ...STATUS, logicalOnly: true, domainCount: 2 } });
      const withDiagrams = [...doc.querySelectorAll<HTMLElement>('.gs-step')].filter((el) => !el.hidden).map((el) => el.dataset.step);
      expect(withDiagrams).toEqual(['assistant', 'helper', 'start']);
      expect(posted.filter((m) => (m as { type: string }).type === 'start')).toEqual([]);

      // The same panel turning into a dbt project (a status always wins) shows the dbt page.
      send({ type: 'status', payload: STATUS });
      const dbt = [...doc.querySelectorAll<HTMLElement>('.gs-step')].filter((el) => !el.hidden).map((el) => el.dataset.step);
      expect(dbt).toEqual(['assistant', 'helper', 'start']);
      expect(visible('.gs-hero__sub')).toEqual(['Turn the dbt project you already have into a data model you can see.']);
      expect(visible('[data-target="dbtInstallDocs"]')).toEqual(['New to dbt? How to install it']);
    } finally {
      dom.window.close();
    }
  });

  it('a project from before 2.0 (YAML or mixed) gets no Convert card here (the sidebar row, the notice and the canvas offer it)', () => {
    const { dom, send, doc } = runPanelScript(buildGettingStartedHtml({ ...HTML_INPUT, mode: 'logical' }));
    try {
      const steps = () => [...doc.querySelectorAll<HTMLElement>('.gs-step')].filter((el) => !el.hidden).map((el) => el.dataset.step);
      for (const storage of ['yaml', 'mixed', 'dbml', undefined] as const) {
        send({ type: 'status', payload: { ...STATUS, logicalOnly: true, storage } });
        expect(steps(), String(storage)).toEqual(['assistant', 'helper', 'start']);
      }
      expect(doc.querySelector('[data-start="convert"]')).toBeNull();
      // DBML is an open format, never an open standard.
      expect(doc.body.textContent).not.toMatch(/open standard/i);
    } finally {
      dom.window.close();
    }
  });

  it('the only start button is the no-folder page\'s example, rendered up front (no HTML from host data)', () => {
    const html = buildGettingStartedHtml({ ...HTML_INPUT, mode: 'logical' });
    const buttons = html.match(/<button[^>]*data-action="start"[^>]*>/g) ?? [];
    expect(buttons).toEqual(['<button class="gs-btn" type="button" data-action="start" data-start="example">']);
    const { dom, send, visible, doc } = runPanelScript(html);
    try {
      // A status listing every start (or nonsense) shows no start on a project page (the no-folder card is hidden by its CSS there).
      send({ type: 'status', payload: { ...STATUS, logicalOnly: true, starts: ['nope', '<b>x</b>', ...START_ACTIONS] as unknown as StartAction[] } });
      expect(visible('.gs-steps-wrap [data-action="start"]')).toEqual([]);
      expect(doc.querySelector('.gs')?.getAttribute('data-project')).toBe('true');
      expect(doc.querySelector('b')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('no folder: the open-a-folder card, with a finished example as the other start, under the tagline', () => {
    const { dom, posted, send, visible, doc } = runPanelScript(buildGettingStartedHtml({ ...HTML_INPUT, mode: 'nofolder' }));
    try {
      send({ type: 'status', payload: { ...STATUS, hasProject: false, logicalOnly: true, project: null } });
      expect(doc.querySelector('.gs')?.getAttribute('data-mode')).toBe('nofolder'); // no folder wins over logicalOnly
      expect(visible('.gs-hero__sub')).toEqual(['Design your data model in Git. Let your AI build from it.']);
      expect(visible('[data-target="dbtInstallDocs"]')).toEqual([]);
      expect(visible('.gs-noproject .gs-btn')).toEqual(['Open Folder\u2026', 'Open an Example\u2026']);
      expect(visible('.gs-noproject__example').join()).toContain('Or see a finished data model first:');
      (doc.querySelector('.gs-noproject [data-start="example"]') as HTMLElement).click();
      expect(posted.at(-1)).toEqual({ type: 'start', action: 'example' });
    } finally {
      dom.window.close();
    }
  });

  it('renders the page the host expects straight away, so the headline never flashes', () => {
    const subs = (html: string) => {
      const { dom, visible } = runPanelScript(html);
      try { return visible('.gs-hero__sub'); } finally { dom.window.close(); }
    };
    expect(subs(buildGettingStartedHtml({ ...HTML_INPUT, mode: 'logical' }))).toEqual(['Design your data model in Git. Let your AI build from it.']);
    expect(subs(buildGettingStartedHtml({ ...HTML_INPUT, mode: 'dbt' }))).toEqual(['Turn the dbt project you already have into a data model you can see.']);
    expect(subs(buildGettingStartedHtml({ ...HTML_INPUT, mode: 'nofolder' }))).toEqual(['Design your data model in Git. Let your AI build from it.']);
    expect(subs(buildGettingStartedHtml(HTML_INPUT))).toEqual(['Design your data model in Git. Let your AI build from it.']);
    // Server-side: the AI cards, numbered from 1, on every page; no start card on any.
    const logical = buildGettingStartedHtml({ ...HTML_INPUT, mode: 'logical' });
    expect(logical).toContain('<main class="gs" data-project="unknown" data-mode="logical">');
    expect(logical).toContain('<section class="gs-step" data-step="start" data-state="loading">');
    for (const mode of ['logical', 'dbt', 'nofolder'] as const) {
      const page = buildGettingStartedHtml({ ...HTML_INPUT, mode });
      expect(page, mode).not.toContain('data-step="begin"');
      expect([...page.matchAll(/<span class="gs-step__num">(\d)<\/span>/g)].map((m) => m[1]), mode).toEqual(['1', '2', '3']);
    }
  });

  it('never autoplays: on every page the tour waits behind its one button, and a click plays it with sound', () => {
    const page = (mode?: 'nofolder' | 'logical' | 'dbt') => {
      let calls = 0;
      let mutedAtPlay: boolean | undefined;
      const dom = new JSDOM(buildGettingStartedHtml({ ...HTML_INPUT, mode }), {
        runScripts: 'dangerously',
        virtualConsole: new VirtualConsole(),
        beforeParse(window) {
          (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => {} });
          window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { calls += 1; mutedAtPlay = this.muted; return Promise.resolve(); };
          window.HTMLMediaElement.prototype.pause = function () {};
        },
      });
      const tour = dom.window.document.querySelector('.gs-video__tour') as HTMLElement;
      const player = dom.window.document.querySelector('.gs-video__player') as HTMLVideoElement;
      const tourLabel = () => [...tour.querySelectorAll<HTMLElement>('span')].filter((el) => !el.hidden).map((el) => el.textContent).join('');
      return { dom, tour, player, tourLabel, plays: () => calls, muted: () => mutedAtPlay };
    };

    for (const mode of ['dbt', 'logical', 'nofolder', undefined] as const) {
      const p = page(mode);
      try {
        expect(p.plays(), String(mode)).toBe(0);
        expect(p.player.hasAttribute('autoplay'), String(mode)).toBe(false);
        expect(p.tour.hidden, String(mode)).toBe(false);
        // One name for the tour, on every page.
        expect(p.tourLabel(), String(mode)).toBe('Watch the Tour');
        // A status (the dbt page, a folder without dbt) never starts it either.
        for (const payload of [STATUS, { ...STATUS, logicalOnly: true }]) {
          p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: { type: 'status', payload } }));
        }
        expect(p.plays(), String(mode)).toBe(0);
        p.tour.click(); // the viewer asks: it plays with sound and the button goes
        expect(p.plays()).toBe(1);
        expect(p.muted()).toBe(false);
        expect(p.tour.hidden).toBe(true);
        p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: { type: 'status', payload: STATUS } }));
        expect(p.plays()).toBe(1);
      } finally {
        p.dom.window.close();
      }
    }
  });

  describe('dbt is an add-on: no dbt text without a dbt project, all of it in one', () => {
    const DBT = /\bdbt\b/i;
    /**
     * Everything a viewer of this page can reach: text not under `[hidden]` or
     * a CSS `display: none` (the data-project rules), with the closed
     * Transcript included (one click away), every `data-when` variant the
     * statuses reveal, the captions (inline cues) and aria-label / title text.
     */
    const reachableText = (mode: 'nofolder' | 'logical' | 'dbt', statuses: GettingStartedStatus[]): string[] => {
      const cut = gettingStartedCut(mode);
      const html = buildGettingStartedHtml({
        ...HTML_INPUT, mode, cues: cut.cues, transcript: cut.transcript,
        videoUri: `https://mock-csp-source/media/onboarding/${cut.video}`,
        posterUri: `https://mock-csp-source/media/onboarding/${cut.poster}`,
      });
      const { dom, send, doc } = runPanelScript(html);
      const out: string[] = [];
      try {
        const win = dom.window;
        const shown = (el: Element): boolean => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            if ((e as HTMLElement).hidden || win.getComputedStyle(e).display === 'none') { return false; }
          }
          return true;
        };
        const collect = () => {
          const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement!;
            if (parent.closest('script, style')) { continue; }
            const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t && shown(parent)) { out.push(t); }
          }
          for (const el of doc.querySelectorAll('[aria-label], [title]')) {
            if (!shown(el)) { continue; }
            out.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '');
          }
        };
        collect(); // before any status: the page the host expects
        for (const status of statuses) { send({ type: 'status', payload: status }); collect(); }
        out.push(doc.title);
        const data = JSON.parse(doc.getElementById('gs-data')!.textContent!) as { cues: Array<{ text: string }> };
        out.push(...data.cues.map((c) => c.text));
      } finally {
        dom.window.close();
      }
      return out.filter(Boolean);
    };
    const variants = (base: GettingStartedStatus): GettingStartedStatus[] => [
      base,
      { ...base, domainCount: 2 },
      // A YAML project from before 2.0 (the Convert card), and a status listing every start: Import from dbt
      // is gated to the dbt page by its data-modes, so even a wrong list cannot show it elsewhere.
      { ...base, storage: 'yaml' },
      { ...base, starts: [...START_ACTIONS] },
      { ...base, domainCount: 2, storage: 'mixed', starts: [...START_ACTIONS] },
      { ...base, assistants: ['claude', 'copilot'], claude: 'cli', helper: 'missing' },
      { ...base, assistants: ['claude', 'copilot'], claude: 'cli', helper: 'ready' },
      { ...base, assistants: ['claude'], claude: 'cli', helper: 'update' },
      { ...base, assistants: ['claude'], claude: 'cli', helper: 'unmanaged' },
      { ...base, assistants: ['claude'], claude: 'extension', helper: 'ready', project: { name: 'model', relativePath: 'model' } },
    ];

    it('the logical page (a folder without dbt_project.yml) shows no dbt word, in any card state, video or transcript', () => {
      const text = reachableText('logical', variants({ ...STATUS, logicalOnly: true }));
      expect(text.join(' ')).toContain('Design your data model in Git');
      expect(text.join(' ')).toContain('Start the guided setup');
      expect(text.filter((t) => DBT.test(t))).toEqual([]);
    });

    it('the no-folder page shows no dbt word either', () => {
      const noFolder = { ...STATUS, hasProject: false, logicalOnly: true, project: null };
      const text = reachableText('nofolder', [noFolder, { ...noFolder, starts: [...START_ACTIONS] }]);
      expect(text.join(' ')).toContain('Open the folder your data model lives in');
      expect(text.join(' ')).toContain('Or see a finished data model first:');
      expect(text.filter((t) => DBT.test(t))).toEqual([]);
    });

    it('the logical cut its pages play names no dbt (captions and transcript)', () => {
      expect(LOGICAL_GETTING_STARTED_CUES.filter((c) => DBT.test(c.text))).toEqual([]);
      expect(LOGICAL_GETTING_STARTED_TRANSCRIPT).not.toMatch(DBT);
    });

    it('the dbt page keeps all of its dbt text', () => {
      const text = reachableText('dbt', variants(STATUS)).join(' ').replace(/\s+/g, ' ');
      for (const line of [
        'Turn the dbt project you already have into a data model you can see.',
        "Your assistant adds what dbt doesn't record",
        'Your assistant checks your dbt setup',
        'Start your assistant in your dbt project folder',
        'New to this? Try it on the sample project first',
        'New to dbt? How to install it',
      ]) {
        expect(text, line).toContain(line);
      }
      // The dbt tour, its captions and transcript.
      expect(text).toContain(GETTING_STARTED_CUES[0].text);
      expect(text).toContain(GETTING_STARTED_TRANSCRIPT.split('\n\n')[0]);
    });
  });

  it('describeWrittenFiles: the checking tool names dbt only in a dbt project', () => {
    const files = ['~/.erd-studio-cli/bin/erd-studio', '.claude/skills/erd-studio-setup/SKILL.md', '.gitignore'];
    const tool = (groups: ReturnType<typeof describeWrittenFiles>) => groups.find((g) => g.title === 'A small checking tool')!;
    expect(tool(describeWrittenFiles(files)).why)
      .toBe('Your assistant runs it to compare your logical data model with your dbt project. It sits in your home folder, outside the project.');
    const logical = describeWrittenFiles(files, { logicalOnly: true });
    expect(tool(logical).why).toBe('Your assistant runs it to check your diagram files. It sits in your home folder, outside the project.');
    expect(logical.flatMap((g) => [g.title, g.why]).filter((t) => /\bdbt\b/i.test(t))).toEqual([]);
  });

  it('the Help & Feedback rows name no dbt (they show in every folder)', () => {
    expect(HELP_ACTIONS.flatMap((a) => [a.label, a.tooltip]).filter((t) => /\bdbt\b/i.test(t))).toEqual([]);
  });

  it('falls back to the poster and reports videoError when the video errors', () => {
    const { dom, posted, doc } = runPanelScript(buildGettingStartedHtml(HTML_INPUT));
    try {
      doc.querySelector('video')!.dispatchEvent(new dom.window.Event('error'));
      expect(doc.querySelector('.gs-video')?.classList.contains('gs-video--fallback')).toBe(true);
      expect(posted).toContainEqual({ type: 'videoError', code: 0 });
    } finally {
      dom.window.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Validator + pure helpers
// ---------------------------------------------------------------------------

describe('isGettingStartedToHost', () => {
  it('accepts every declared type with its payload', () => {
    const samples: Record<string, unknown> = {
      openExternal: { type: 'openExternal', target: 'videoOnline' },
      videoError: { type: 'videoError', code: 3 },
      start: { type: 'start', action: 'blank' },
    };
    for (const type of GETTING_STARTED_TO_HOST_TYPES) {
      expect(isGettingStartedToHost(samples[type] ?? { type }), type).toBe(true);
    }
  });

  it('accepts trySample (no payload needed) and start with a known action only', () => {
    expect(isGettingStartedToHost({ type: 'trySample' })).toBe(true);
    expect(isGettingStartedToHost({ type: 'openExternal', target: 'sampleCodespaces' })).toBe(true);
    for (const action of START_ACTIONS) {
      expect(isGettingStartedToHost({ type: 'start', action }), action).toBe(true);
    }
    for (const action of [undefined, null, 7, '', 'Blank', 'runCommand', 'erdStudio.createDomain', 'toString', '__proto__', ['blank']]) {
      expect(isGettingStartedToHost({ type: 'start', action }), String(action)).toBe(false);
    }
    // The four separate start messages are gone: one `start` message replaced them.
    for (const type of ['drawFromDbt', 'createDomain', 'importDbml', 'openExample']) {
      expect(isGettingStartedToHost({ type }), type).toBe(false);
    }
  });

  it('copyPrompt takes an optional known assistant only', () => {
    expect(isGettingStartedToHost({ type: 'copyPrompt' })).toBe(true);
    expect(isGettingStartedToHost({ type: 'copyPrompt', assistant: 'gemini' })).toBe(true);
    expect(isGettingStartedToHost({ type: 'copyPrompt', assistant: 'bard' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'copyPrompt', assistant: 7 })).toBe(false);
  });

  it('rejects unknown types, URLs as targets and bad codes', () => {
    expect(isGettingStartedToHost({ type: 'runCommand' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'openExternal', target: 'https://evil.example' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'openExternal', target: 'toString' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'videoError', code: 'x' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'videoError', code: Number.NaN })).toBe(false);
    expect(isGettingStartedToHost(null)).toBe(false);
    expect(isGettingStartedToHost('ready')).toBe(false);
  });

  it('external targets map only to fixed https URLs', () => {
    expect(Object.keys(GETTING_STARTED_EXTERNAL_URLS).sort()).toEqual([
      'claudeCodeDocs', 'codexDocs', 'copilotDocs', 'cursorDocs', 'dbtInstallDocs', 'geminiCliDocs', 'sampleCodespaces',
      'sampleRepo', 'videoOnline', 'videoOnlineLogical',
    ]);
    expect(GETTING_STARTED_EXTERNAL_URLS.sampleCodespaces)
      .toBe('https://codespaces.new/liam-machine/erd-studio-sample?quickstart=1');
    expect(SAMPLE_CODESPACES_URL).toBe(GETTING_STARTED_EXTERNAL_URLS.sampleCodespaces);
    for (const url of Object.values(GETTING_STARTED_EXTERNAL_URLS)) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(GETTING_STARTED_EXTERNAL_URLS.sampleRepo).toBe('https://github.com/liam-machine/erd-studio-sample');
    expect(SAMPLE_REPO_URL).toBe('https://github.com/liam-machine/erd-studio-sample');
    expect(SAMPLE_REPO_CLONE_URL).toBe('https://github.com/liam-machine/erd-studio-sample.git');
    // Not the github.com blob page: it refuses to preview an 8 MB video.
    expect(GETTING_STARTED_EXTERNAL_URLS.videoOnline)
      .toBe('https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started.mp4');
    expect(GETTING_STARTED_EXTERNAL_URLS.videoOnlineLogical)
      .toBe('https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started-logical.mp4');
  });
});

describe('pure helpers', () => {
  it('formatProjectSummary joins only the known parts', () => {
    expect(formatProjectSummary({ modelCount: 42, layering: 'medallion', manifest: { state: 'present', ageDays: 3.9 } }))
      .toBe('Found 42 dbt models \u00b7 medallion layout \u00b7 manifest 3 days old');
    expect(formatProjectSummary({ modelCount: 1, layering: 'dbt-layered', manifest: { state: 'present', ageDays: 0.2 } }))
      .toBe('Found 1 dbt model \u00b7 staging \u2192 marts layout \u00b7 manifest from today');
    expect(formatProjectSummary({ modelCount: 5, layering: null, manifest: { state: 'present', ageDays: 1 } }))
      .toBe('Found 5 dbt models \u00b7 manifest 1 day old');
    expect(formatProjectSummary({ modelCount: 0, layering: null, manifest: { state: 'absent' } }))
      .toBe('No documented dbt models found yet \u00b7 no manifest yet');
    expect(formatProjectSummary({ modelCount: null, layering: null, manifest: { state: 'unknown' } })).toBe('');
  });

  it('computeProjectSummary counts models, reads layering from folders/schemas and ages the manifest', () => {
    const now = Date.UTC(2026, 8, 28, 12);
    const models = [
      { name: 'brz_orders', folder: 'bronze', description: '' },
      { name: 'slv_orders', folder: 'silver', description: '' },
      { name: 'fct_orders', folder: 'gold', description: '' },
      { name: 'dim_customer', folder: null, description: '' },
    ];
    const s = computeProjectSummary({ models, manifestMtime: now - 3 * 86_400_000 - 1000, now });
    expect(s).toMatchObject({ modelCount: 4, layering: 'medallion', manifest: { state: 'present', ageDays: 3 } });
    expect(s.line).toBe('Found 4 dbt models \u00b7 medallion layout \u00b7 manifest 3 days old');

    const flat = computeProjectSummary({ models: [{ name: 'orders', folder: null, description: '' }], manifestMtime: null, now });
    expect(flat).toMatchObject({ modelCount: 1, layering: null, manifest: { state: 'absent' } });
    expect(computeProjectSummary({ models: [], now })).toMatchObject({ modelCount: 0, layering: null, manifest: { state: 'unknown' } });
  });

  it('computeProjectSummary also sees layers in manifest schemas', () => {
    const manifest = {
      models: new Map([
        ['a', { name: 'a', schema: 'analytics_bronze' }],
        ['b', { name: 'b', schema: 'analytics_silver' }],
        ['c', { name: 'c', schema: 'analytics_gold' }],
      ]),
    } as unknown as import('../../src/types/manifest').ManifestData;
    const models = ['a', 'b', 'c'].map((name) => ({ name, folder: null, description: '' }));
    expect(computeProjectSummary({ models, manifest, now: 0 }).layering).toBe('medallion');
  });

  it('deriveAiHelperState (Claude Code only)', () => {
    const claude = (schemaSkill: string, setupSkill: string): GettingStartedHarness =>
      ({ claude: { schemaSkill, setupSkill }, agents: MISSING_FOLDER } as GettingStartedHarness);
    const only = ['claude'] as const;
    expect(deriveAiHelperState(claude('missing', 'missing'), 'missing', only)).toBe('missing');
    expect(deriveAiHelperState(claude('current', 'missing'), 'missing', only)).toBe('missing');
    expect(deriveAiHelperState(claude('current', 'current'), 'ready', only)).toBe('ready');
    expect(deriveAiHelperState(claude('current', 'current'), 'stale', only)).toBe('update');
    expect(deriveAiHelperState(claude('outdated', 'outdated'), 'ready', only)).toBe('update');
    expect(deriveAiHelperState(claude('current', 'current'), 'missing', only)).toBe('update');
    expect(deriveAiHelperState(claude('unmanaged', 'current'), 'ready', only)).toBe('unmanaged');
  });

  it('deriveAiHelperState judges only the folders setup would write for the detected assistants', () => {
    const current = { schemaSkill: 'current', setupSkill: 'current' } as const;
    const claudeOnly: GettingStartedHarness = { claude: current, agents: MISSING_FOLDER };
    const both: GettingStartedHarness = { claude: current, agents: current };
    expect(deriveAiHelperState(claudeOnly, 'ready', ['claude'])).toBe('ready');
    // Copilot reads .claude/skills too, so Claude's copy covers it.
    expect(deriveAiHelperState(claudeOnly, 'ready', ['claude', 'copilot'])).toBe('ready');
    // Codex appears later: its .agents copy is not there yet.
    expect(deriveAiHelperState(claudeOnly, 'ready', ['claude', 'codex'])).toBe('update');
    // None detected installs both folders.
    expect(deriveAiHelperState(claudeOnly, 'ready', [])).toBe('update');
    expect(deriveAiHelperState(both, 'ready', [])).toBe('ready');
    expect(deriveAiHelperState({ claude: MISSING_FOLDER, agents: current }, 'ready', ['codex'])).toBe('ready');
    // A hand-written copy in a folder setup will not touch does not matter.
    expect(deriveAiHelperState({ claude: { schemaSkill: 'unmanaged', setupSkill: 'missing' }, agents: current }, 'ready', ['gemini']))
      .toBe('ready');
    expect(deriveAiHelperState({ claude: current, agents: { schemaSkill: 'current', setupSkill: 'unmanaged' } }, 'ready', ['cursor']))
      .toBe('unmanaged');
  });

  it('promptFor gives each assistant exactly what to type; only Claude Code gets the cd line', () => {
    expect(promptFor('claude', '/w', '/w', 'darwin')).toBe('/erd-studio-setup');
    expect(promptFor('claude', '/w/dbt', '/w', 'darwin')).toBe(`cd '/w/dbt' && claude "/erd-studio-setup"`);
    expect(promptFor('copilot', '/w/dbt', '/w', 'darwin')).toBe('/erd-studio-setup');
    expect(promptFor('codex', '/w', '/w', 'darwin')).toBe('$erd-studio-setup');
    expect(promptFor('gemini', '/w', '/w', 'darwin')).toBe('Set up ERD Studio for this project');
    expect(promptFor('cursor', '/w', '/w', 'darwin')).toBe('/erd-studio-setup');
  });

  it('setupReadyMessage names the assistants it installed for', () => {
    expect(setupReadyMessage(['claude'])).toBe("AI helper ready for Claude Code: run /erd-studio-setup there (restart it if it's already open).");
    expect(setupReadyMessage(['codex'])).toContain('run $erd-studio-setup there');
    expect(setupReadyMessage(['gemini'])).toContain('ask “Set up ERD Studio for this project”');
    expect(setupReadyMessage(['claude', 'copilot', 'cursor'])).toContain('AI helper ready for Claude Code, GitHub Copilot and Cursor.');
    expect(setupReadyMessage([])).toContain('Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor');
    expect(SETUP_READY_MESSAGE).toBe(setupReadyMessage(['claude']));
  });

  it('setupReadyMessage without dbt points at the guided setup, for designing the model with you', () => {
    expect(setupReadyMessage(['claude'], { logicalOnly: true })).toBe(
      "AI helper ready for Claude Code: run /erd-studio-setup there to design your data model with you (restart it if it's already open).",
    );
    expect(setupReadyMessage(['codex'], { logicalOnly: true })).toContain('run $erd-studio-setup there to design your data model with you');
    expect(setupReadyMessage(['claude', 'copilot'], { logicalOnly: true })).toContain(
      'AI helper ready for Claude Code and GitHub Copilot. Start the guided setup in any of them to design your data model with you',
    );
    expect(setupReadyMessage([], { logicalOnly: true })).toContain('then start the guided setup to design your data model with you');
  });

  it('copyText copies the bare prompt at the root and the whole start line from a subfolder', () => {
    expect(copyText('/w', '/w', 'darwin')).toBe(SETUP_PROMPT);
    expect(copyText('/w/', '/w', 'darwin')).toBe(SETUP_PROMPT);
    expect(copyText('C:\\W\\', 'c:\\w', 'win32')).toBe(SETUP_PROMPT);
    expect(copyText(null, '/w', 'darwin')).toBe(SETUP_PROMPT);
    expect(copyText('/w/analytics dbt', '/w', 'linux')).toBe(`cd '/w/analytics dbt' && claude "/erd-studio-setup"`);
  });

  it('copyText quotes the folder as data: no $(…), backticks or $VAR expansion, and PowerShell on Windows', () => {
    // POSIX: single quotes, with an embedded ' closed, escaped and reopened.
    expect(copyText('/w/models$(curl -s x|sh)', '/w', 'darwin')).toBe(`cd '/w/models$(curl -s x|sh)' && claude "/erd-studio-setup"`);
    expect(copyText("/w/o'neil `id`", '/w', 'linux')).toBe(`cd '/w/o'\\''neil \`id\`' && claude "/erd-studio-setup"`);
    // Windows: PowerShell 5.1 has no &&; -LiteralPath with single quotes (doubled) expands nothing.
    expect(copyText('D:\\repo\\dbt $env:X', 'C:\\w', 'win32')).toBe(`Set-Location -LiteralPath 'D:\\repo\\dbt $env:X'; claude "/erd-studio-setup"`);
    expect(copyText("C:\\w\\it's", 'C:\\w', 'win32')).toBe(`Set-Location -LiteralPath 'C:\\w\\it''s'; claude "/erd-studio-setup"`);
    // A line break cannot be pasted as one command: fall back to the bare prompt.
    expect(copyText('/w/a\nb', '/w', 'linux')).toBe(SETUP_PROMPT);
  });

  it('describeWrittenFiles groups paths under plain explanations, in a fixed order', () => {
    const groups = describeWrittenFiles([
      '~/.erd-studio-cli/bin/erd-studio',
      '.claude/skills/erd-studio/SKILL.md',
      '.claude/skills/erd-studio-setup/SKILL.md',
      '.claude/settings.local.json',
      '.claude/skills/erd-studio/enforce-skill.sh',
      '.gitignore',
      'weird.txt',
    ]);
    expect(groups.map((g) => g.title)).toEqual([
      'The guided setup for Claude Code',
      "ERD Studio's file-format rules",
      'A safety check for Claude Code',
      'A small checking tool',
      'Your .gitignore',
      'Other files',
    ]);
    expect(groups[2].paths).toEqual(['.claude/settings.local.json', '.claude/skills/erd-studio/enforce-skill.sh']);
    expect(groups[2].why).toContain('settings.local.json');
    expect(describeWrittenFiles([])).toEqual([]);
  });

  it('describeWrittenFiles explains the .agents copies separately and folds both rule files together', () => {
    const groups = describeWrittenFiles([
      '.agents/skills/erd-studio/SKILL.md',
      '.agents/skills/erd-studio/SYNC.md',
      '.agents/skills/erd-studio-setup/SKILL.md',
      '.claude/skills/erd-studio/SKILL.md',
    ]);
    expect(groups.map((g) => g.title)).toEqual([
      'The guided setup for GitHub Copilot, Codex, Gemini CLI and Cursor',
      "ERD Studio's file-format rules",
    ]);
    expect(groups[1].paths).toEqual([
      '.agents/skills/erd-studio/SKILL.md', '.agents/skills/erd-studio/SYNC.md', '.claude/skills/erd-studio/SKILL.md',
    ]);
  });

  it('displayLauncherPath abbreviates the home dir and never leaks another absolute path', () => {
    expect(displayLauncherPath(path.join('/home/u', '.erd-studio-cli', 'lib', 'cli.js'), '/home/u')).toBe('~/.erd-studio-cli/lib/cli.js');
    expect(displayLauncherPath('/elsewhere/cli.js', '/home/u')).toBe('cli.js');
  });

  it('claudeLaunchLine shows an absolute CLI path quoted for reading', () => {
    expect(claudeLaunchLine('claude', 'darwin')).toBe('claude "/erd-studio-setup"');
    expect(claudeLaunchLine("/Users/o'neil/.local/bin/claude", 'darwin')).toBe(`'/Users/o'\\''neil/.local/bin/claude' "/erd-studio-setup"`);
    expect(claudeLaunchLine('C:\\Users\\a\\.local\\bin\\claude.exe', 'win32')).toBe('"C:\\Users\\a\\.local\\bin\\claude.exe" "/erd-studio-setup"');
  });

  it('claudeTerminalLaunch types the on-PATH line but runs an absolute path as the terminal process', () => {
    expect(claudeTerminalLaunch('claude', 'win32')).toEqual({ kind: 'sendText', display: 'claude "/erd-studio-setup"', line: 'claude "/erd-studio-setup"' });
    const exe = 'C:\\Users\\a\\.local\\bin\\claude.exe';
    expect(claudeTerminalLaunch(exe, 'win32')).toEqual({
      kind: 'process', display: `"${exe}" "/erd-studio-setup"`, shellPath: exe, shellArgs: ['/erd-studio-setup'],
    });
  });

  it('claudeTerminalLaunch passes another prompt as claude\'s initial-prompt argument, after its flags', () => {
    const prompt = 'Execute the erd-studio sync plan at .erd-studio/.sync-plan.json using the erd-studio skill.';
    const line = `claude --dangerously-skip-permissions "${prompt}"`;
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(claudeTerminalLaunch('claude', platform, { prompt, args: ['--dangerously-skip-permissions'] }))
        .toEqual({ kind: 'sendText', display: line, line });
    }
  });

  it('claudeTerminalLaunch runs the venv activation first on the typed line, and shows it', () => {
    const launch = claudeTerminalLaunch('claude', 'darwin', { prompt: 'Run it.', venvDir: "/p/o'neil/.venv" });
    const line = `source '/p/o'\\''neil/.venv/bin/activate' && claude "Run it."`;
    expect(launch).toEqual({ kind: 'sendText', display: line, line });
  });

  it('claudeTerminalLaunch never types a prompt a shell would expand: it runs claude as the terminal process', () => {
    // A semanticDir setting can hold anything; `$`, backticks, quotes, `%` and `!` all expand in some shell.
    for (const bad of ['$HOME', '`id`', '"x"', '%PATH%', 'a!b', 'a\\b', "it's"]) {
      const prompt = `Execute the plan at ${bad}/.sync-plan.json`;
      const launch = claudeTerminalLaunch('claude', 'darwin', {
        prompt, args: ['--dangerously-skip-permissions'], venvDir: '/p/.venv', envPath: '/usr/bin',
      });
      expect(launch).toMatchObject({
        kind: 'process', shellPath: 'claude', shellArgs: ['--dangerously-skip-permissions', prompt],
        // The activation a typed line would run, as the environment it sets.
        env: { VIRTUAL_ENV: '/p/.venv', PATH: '/p/.venv/bin:/usr/bin' },
      });
    }
    const win = claudeTerminalLaunch('claude', 'win32', { prompt: 'a $b', venvDir: 'C:\\p\\.venv', envPath: 'C:\\Windows' });
    expect(win).toMatchObject({ kind: 'process', env: { VIRTUAL_ENV: 'C:\\p\\.venv', PATH: 'C:\\p\\.venv\\Scripts;C:\\Windows' } });
    expect(claudeTerminalLaunch('claude', 'darwin', { prompt: 'a $b' })).not.toHaveProperty('env');
  });

  it('keepMineInstalls names what Keep mine still installs', () => {
    expect(keepMineInstalls(['.claude/skills/erd-studio/SKILL.md'])).toBe('the /erd-studio-setup guide and the safety check');
    expect(keepMineInstalls(['.claude/skills/erd-studio-setup/SKILL.md'])).toBe("ERD Studio's file-format rules and the safety check");
    expect(keepMineInstalls(['.claude/skills/erd-studio/SKILL.md', '.claude/skills/erd-studio-setup/SKILL.md'])).toBe('the safety check');
    // Both folders: a hand-written Claude copy still leaves the .agents copies to install.
    expect(keepMineInstalls(['.claude/skills/erd-studio/SKILL.md', '.claude/skills/erd-studio-setup/SKILL.md'], ['claude', 'agents']))
      .toBe("the /erd-studio-setup guide, ERD Studio's file-format rules and the safety check");
    expect(keepMineInstalls(['.agents/skills/erd-studio/SKILL.md', '.agents/skills/erd-studio-setup/SKILL.md'], ['agents']))
      .toBe('nothing else in this project');
  });
});

describe('locateClaudeCli (PATH scan, never spawns)', () => {
  const files = (set: string[]) => (p: string) => set.includes(p);

  it('finds claude on a POSIX PATH', () => {
    expect(locateClaudeCli({
      env: { PATH: '/usr/bin:/opt/claude/bin' }, platform: 'darwin', homeDir: '/h', isFile: files(['/opt/claude/bin/claude']),
    })).toEqual({ command: 'claude', onPath: true });
  });

  it('honours PATHEXT on Windows', () => {
    expect(locateClaudeCli({
      env: { Path: 'C:\\npm;C:\\bin', PATHEXT: '.EXE;.CMD' }, platform: 'win32', homeDir: 'C:\\h',
      isFile: files(['C:\\bin\\claude.cmd']),
    })).toEqual({ command: 'claude', onPath: true });
  });

  it('falls back to the installer homes a GUI PATH can miss', () => {
    expect(locateClaudeCli({
      env: { PATH: '/usr/bin' }, platform: 'linux', homeDir: '/h', isFile: files(['/h/.claude/local/claude']),
    })).toEqual({ command: '/h/.claude/local/claude', onPath: false });
  });

  it('returns null when there is nothing', () => {
    expect(locateClaudeCli({ env: {}, platform: 'darwin', homeDir: '/h', isFile: () => false })).toBeNull();
  });
});

describe('AI assistant detection (host inputs, never spawns)', () => {
  const files = (set: string[]) => (p: string) => set.includes(p);

  it('isOnPath scans PATH (and PATHEXT on Windows) for any executable name', () => {
    expect(isOnPath('codex', { env: { PATH: '/a:/b' }, platform: 'linux', homeDir: '/h', isFile: files(['/b/codex']) })).toBe(true);
    expect(isOnPath('codex', { env: { PATH: '/a:/b' }, platform: 'linux', homeDir: '/h', isFile: files(['/b/codexx']) })).toBe(false);
    expect(isOnPath('gemini', { env: { Path: 'C:\\n', PATHEXT: '.CMD' }, platform: 'win32', homeDir: 'C:\\h', isFile: files(['C:\\n\\gemini.cmd']) }))
      .toBe(true);
  });

  it('combines CLIs, extensions and the editor name', () => {
    const detect = (clis: string[], exts: string[], appName = 'Visual Studio Code') => detectAiAssistantsWith({
      locate: { env: { PATH: '/bin' }, platform: 'linux', homeDir: '/h', isFile: files(clis.map((c) => `/bin/${c}`)) },
      hasExtension: (id) => exts.includes(id),
      appName,
    });
    expect(detect([], [])).toEqual([]);
    expect(detect(['codex', 'gemini'], [])).toEqual(['codex', 'gemini']);
    expect(detect([], ['github.copilot-chat', 'anthropic.claude-code'])).toEqual(['claude', 'copilot']);
    expect(detect(['cursor-agent'], [])).toEqual(['cursor']);
    expect(detect([], [], 'Cursor')).toEqual(['cursor']);
    expect(detect(['copilot'], ['openai.chatgpt', 'google.gemini-cli-vscode-ide-companion'])).toEqual(['copilot', 'codex', 'gemini']);
    // Gemini Code Assist is a different product from Gemini CLI: not detected as it.
    expect(detect([], ['google.geminicodeassist'])).toEqual([]);
  });

  it('counts the Claude CLI in its installer home even when a GUI PATH misses it', () => {
    expect(detectAiAssistantsWith({
      locate: { env: { PATH: '/bin' }, platform: 'linux', homeDir: '/h', isFile: files(['/h/.local/bin/claude']) },
      hasExtension: () => false,
      appName: 'Code',
    })).toEqual(['claude']);
  });

  it('detectAiAssistants reads the live editor: extensions and appName', () => {
    vscode._setMockExtensions(['github.copilot']);
    expect(detectAiAssistants()).toEqual(['copilot']);
  });
});

// ---------------------------------------------------------------------------
// setupAiHelper flow
// ---------------------------------------------------------------------------

function setupDeps(overrides: Partial<SetupAiHelperDeps> & {
  results?: RecommendedInstallResult[];
  launcherOk?: boolean;
} = {}) {
  const results = [...(overrides.results ?? [
    { status: 'installed', unmanaged: [], filesWritten: ['.claude/skills/erd-studio/SKILL.md'], targets: ['claude'] },
  ] as RecommendedInstallResult[])];
  const installRecommended = vi.fn((
    _root: string,
    _opts: { replaceUnmanaged: boolean; keepUnmanaged?: boolean; assistants?: readonly string[] },
  ) => results.shift()!);
  const launcherInstall = vi.fn(async () => overrides.launcherOk === false
    ? { ok: false, binPath: '/h/.erd-studio-cli/bin/erd-studio', filesWritten: [], runtimeVerified: false, error: 'EACCES' }
    : { ok: true, binPath: '/h/.erd-studio-cli/bin/erd-studio', filesWritten: ['/h/.erd-studio-cli/lib/cli.js'], runtimeVerified: true });
  const deps: SetupAiHelperDeps = {
    root: '/w',
    harness: { installRecommended },
    launcher: { install: launcherInstall },
    launcherOptions: { homeDir: '/h', extensionVersion: '1.0.11', execPath: '/x/Code', cliSourcePath: '/ext/dist/cli.js' },
    assistants: overrides.assistants ?? ['claude'],
    confirmReplace: overrides.confirmReplace ?? vi.fn(async () => 'replace' as const),
  };
  return { deps, installRecommended, launcherInstall };
}

describe('runSetupAiHelper', () => {
  it('installed: harness then launcher, with launcher paths shown as ~/…', async () => {
    const { deps, installRecommended, launcherInstall } = setupDeps();
    const outcome = await runSetupAiHelper(deps);
    expect(installRecommended).toHaveBeenCalledWith('/w', { replaceUnmanaged: false, assistants: ['claude'] });
    expect(launcherInstall).toHaveBeenCalledWith(deps.launcherOptions);
    expect(outcome).toEqual({
      ok: true,
      filesWritten: ['.claude/skills/erd-studio/SKILL.md', '~/.erd-studio-cli/lib/cli.js'],
      message: SETUP_READY_MESSAGE,
    });
  });

  it('says in one sentence when a safety check was left out on purpose', async () => {
    const { deps } = setupDeps({
      assistants: ['gemini'],
      results: [{ status: 'unchanged', unmanaged: [], filesWritten: [], targets: ['agents'], skippedHooks: [{ id: 'gemini', reason: 'jsonc' }] }],
    });
    const outcome = await runSetupAiHelper(deps);
    expect(outcome.ok).toBe(true);
    expect(outcome.message.endsWith(" .gemini/settings.json has comments in it, so ERD Studio left it alone and didn't add Gemini CLI's safety check.")).toBe(true);
  });

  it('logical-only: the success message is the logical-only wording', async () => {
    const { deps } = setupDeps();
    const outcome = await runSetupAiHelper({ ...deps, logicalOnly: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toBe(setupReadyMessage(['claude'], { logicalOnly: true }));
  });

  it('needs-confirmation → Replace re-runs with replaceUnmanaged', async () => {
    const { deps, installRecommended } = setupDeps({
      results: [
        { status: 'needs-confirmation', unmanaged: ['.claude/skills/erd-studio/SKILL.md'], filesWritten: [], targets: ['claude'] },
        { status: 'updated', unmanaged: [], filesWritten: ['.claude/skills/erd-studio/SKILL.md'], targets: ['claude'] },
      ],
    });
    const outcome = await runSetupAiHelper(deps);
    expect(deps.confirmReplace).toHaveBeenCalledWith(['.claude/skills/erd-studio/SKILL.md'], ['claude']);
    expect(installRecommended.mock.calls.map((c) => c[1])).toEqual([
      { replaceUnmanaged: false, assistants: ['claude'] },
      { replaceUnmanaged: true, assistants: ['claude'] },
    ]);
    expect(outcome.ok).toBe(true);
  });

  it('needs-confirmation → Keep mine installs everything not hand-written, then the launcher', async () => {
    const { deps, installRecommended, launcherInstall } = setupDeps({
      results: [
        { status: 'needs-confirmation', unmanaged: ['.claude/skills/erd-studio-setup/SKILL.md'], filesWritten: [], targets: ['claude'] },
        {
          status: 'installed', unmanaged: [], targets: ['claude'],
          filesWritten: ['.claude/skills/erd-studio/SKILL.md', '.claude/skills/erd-studio/enforce-skill.sh'],
        },
      ],
      confirmReplace: vi.fn(async () => 'keep' as const),
    });
    const outcome = await runSetupAiHelper(deps);
    expect(installRecommended.mock.calls.map((c) => c[1])).toEqual([
      { replaceUnmanaged: false, assistants: ['claude'] },
      { replaceUnmanaged: false, keepUnmanaged: true, assistants: ['claude'] },
    ]);
    expect(launcherInstall).toHaveBeenCalledTimes(1);
    expect(outcome.filesWritten).toContain('.claude/skills/erd-studio/SKILL.md');
    expect(outcome.ok).toBe(true);
  });

  it('Keep mine against a real HarnessService: only the setup SKILL.md hand-written still installs the schema skill and hook', async () => {
    const setup = path.join(tmp, '.claude/skills/erd-studio-setup/SKILL.md');
    fs.mkdirSync(path.dirname(setup), { recursive: true });
    fs.writeFileSync(setup, 'mine');
    const harness = new HarnessService('.erd-studio');
    const { deps } = setupDeps({ confirmReplace: vi.fn(async () => 'keep' as const) });
    deps.root = tmp;
    deps.harness = harness;
    const outcome = await runSetupAiHelper(deps);
    expect(outcome.ok).toBe(true);
    expect(fs.readFileSync(setup, 'utf-8')).toBe('mine');
    expect(harness.harnessStatus(tmp).claude).toEqual({ schemaSkill: 'current', setupSkill: 'unmanaged', hookRegistered: true });
    // Claude Code only: no .agents copy.
    expect(fs.existsSync(path.join(tmp, '.agents'))).toBe(false);
  });

  it('installs for the detected assistants against a real HarnessService and says which', async () => {
    const harness = new HarnessService('.erd-studio');
    const { deps } = setupDeps({ assistants: ['codex', 'gemini'] });
    deps.root = tmp;
    deps.harness = harness;
    const outcome = await runSetupAiHelper(deps);
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('AI helper ready for Codex and Gemini CLI.');
    expect(outcome.filesWritten).toContain('.agents/skills/erd-studio-setup/SKILL.md');
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false);
    expect(harness.harnessStatus(tmp).agents).toEqual({ schemaSkill: 'current', setupSkill: 'current' });
  });

  it('needs-confirmation dismissed → nothing is written and the launcher is not touched', async () => {
    const { deps, launcherInstall } = setupDeps({
      results: [{ status: 'needs-confirmation', unmanaged: ['x'], filesWritten: [], targets: ['claude'] }],
      confirmReplace: vi.fn(async () => undefined),
    });
    expect(await runSetupAiHelper(deps)).toEqual({ ok: false, filesWritten: [], message: SETUP_CANCELLED_MESSAGE });
    expect(launcherInstall).not.toHaveBeenCalled();
  });

  it('a launcher failure is reported but keeps the skill install', async () => {
    const { deps } = setupDeps({ launcherOk: false });
    const outcome = await runSetupAiHelper(deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.filesWritten).toEqual(['.claude/skills/erd-studio/SKILL.md']);
    expect(outcome.message).toContain('checking tool');
    expect(outcome.message).toContain('EACCES');
  });

  it('a harness failure stops before the launcher', async () => {
    const { deps, launcherInstall } = setupDeps({
      results: [{ status: 'failed', unmanaged: [], filesWritten: [], targets: ['claude'], error: 'disk full' }],
    });
    const outcome = await runSetupAiHelper(deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('disk full');
    expect(launcherInstall).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { deps } = setupDeps();
    deps.harness.installRecommended = () => { throw new Error('boom'); };
    expect(await runSetupAiHelper(deps)).toMatchObject({ ok: false, message: 'Setup failed: boom' });
  });
});

// ---------------------------------------------------------------------------
// Open Claude Code
// ---------------------------------------------------------------------------

function fakeClaudeOnPath(): void {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
  vi.stubEnv('PATH', bin);
}

describe('openClaudeCode', () => {
  it('with the CLI: shows the exact command in a modal, then starts it in a terminal at the dbt root', async () => {
    fakeClaudeOnPath();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open Terminal' as never);

    await openClaudeCode({ dbtRoot: '/w/dbt', clipboardText: SETUP_PROMPT });

    const [, options] = info.mock.calls[0] as unknown as [string, { modal: boolean; detail: string }];
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Command: claude "/erd-studio-setup"');
    expect(options.detail).toContain('Folder: /w/dbt');
    const terminal = vscode.window.terminals[0];
    expect(terminal._options).toEqual({ name: 'Claude Code', cwd: '/w/dbt', env: { MSYS_NO_PATHCONV: '1' } });
    expect(terminal._sentText).toEqual(['claude "/erd-studio-setup"']);
  });

  it.skipIf(process.platform === 'win32')('with the CLI off PATH: runs it as the terminal process, so no shell parses the path', async () => {
    const exe = path.join(tmp, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    vi.stubEnv('PATH', '');
    vi.stubEnv('HOME', tmp);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open Terminal' as never);

    await openClaudeCode({ dbtRoot: '/w/dbt', clipboardText: SETUP_PROMPT });

    const [, options] = info.mock.calls[0] as unknown as [string, { detail: string }];
    expect(options.detail).toContain(`Command: '${exe}' "/erd-studio-setup"`);
    const terminal = vscode.window.terminals[0];
    expect(terminal._options).toEqual({
      name: 'Claude Code', cwd: '/w/dbt', env: { MSYS_NO_PATHCONV: '1' }, shellPath: exe, shellArgs: ['/erd-studio-setup'],
    });
    expect(terminal._sentText).toEqual([]);
  });

  it('with the CLI: dismissing the modal opens nothing', async () => {
    fakeClaudeOnPath();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(vscode.window.terminals).toHaveLength(0);
  });

  it('with only the VS Code extension: copies the prompt and runs its open command', async () => {
    vscode._setMockExtensions(['anthropic.claude-code']);
    const opened = vi.fn();
    vscode.commands.registerCommand('claude-vscode.sidebar.open', opened);
    const clip = vi.spyOn(vscode.env.clipboard, 'writeText');

    await openClaudeCode({ dbtRoot: '/w', clipboardText: 'cd "/w" && claude "/erd-studio-setup"' });

    expect(clip).toHaveBeenCalledWith(SETUP_PROMPT); // the chat takes the prompt, never a cd line
    expect(opened).toHaveBeenCalledTimes(1);
    expect(vscode.window.terminals).toHaveLength(0);
  });

  it('with only the VS Code extension and a nested project: offers to open the dbt folder itself', async () => {
    vscode._setMockExtensions(['anthropic.claude-code']);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open analytics' as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await openClaudeCode({ dbtRoot: '/w/analytics', clipboardText: `cd '/w/analytics' && claude "/erd-studio-setup"` });

    const [message, button] = info.mock.calls[0] as unknown as [string, string];
    expect(message).toContain('File > Open Folder');
    expect(button).toBe('Open analytics');
    const openFolder = exec.mock.calls.find((c) => c[0] === 'vscode.openFolder')!;
    expect((openFolder[1] as { fsPath: string }).fsPath).toBe('/w/analytics');
  });

  it('nested project message: "Your dbt project" only when the folder is a dbt project', async () => {
    vscode._setMockExtensions(['anthropic.claude-code']);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const nested = { dbtRoot: path.join(tmp, 'analytics'), clipboardText: `cd '${tmp}/analytics' && claude "/erd-studio-setup"` };
    fs.mkdirSync(nested.dbtRoot);

    await openClaudeCode({ ...nested, logicalOnly: true });
    expect(String(info.mock.calls.at(-1)![0])).toContain('Your project, analytics, is a subfolder here');
    expect(String(info.mock.calls.at(-1)![0])).not.toMatch(/\bdbt\b/i);
    await openClaudeCode({ ...nested, logicalOnly: false });
    expect(String(info.mock.calls.at(-1)![0])).toContain('Your dbt project, analytics, is a subfolder here');

    // A caller that does not say: read from the folder itself.
    await openClaudeCode(nested);
    expect(String(info.mock.calls.at(-1)![0])).not.toMatch(/\bdbt\b/i);
    fs.writeFileSync(path.join(nested.dbtRoot, 'dbt_project.yml'), 'name: analytics\n');
    await openClaudeCode(nested);
    expect(String(info.mock.calls.at(-1)![0])).toContain('Your dbt project, analytics, is a subfolder here');
  });

  it('with neither: opens the Claude Code install page', async () => {
    const open = vi.spyOn(vscode.env, 'openExternal');
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(String(open.mock.calls[0][0])).toBe(GETTING_STARTED_EXTERNAL_URLS.claudeCodeDocs);
  });
});

// ---------------------------------------------------------------------------
// Open Copilot Chat
// ---------------------------------------------------------------------------

describe('openCopilotChat', () => {
  it('copies the prompt and opens the chat with it typed in but not sent', async () => {
    const opened = vi.fn();
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, opened);
    const clip = vi.spyOn(vscode.env.clipboard, 'writeText');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await openCopilotChat({ dbtRoot: '/w', workspaceFolder: '/w' });

    expect(clip).toHaveBeenCalledWith(SETUP_PROMPT);
    expect(opened).toHaveBeenCalledWith({ query: SETUP_PROMPT, isPartialQuery: true, mode: 'agent' });
    expect(String(info.mock.calls[0][0])).toContain('Agent mode');
  });

  it('falls back to a bare open when the argument form throws, and warns about a nested project', async () => {
    const calls: unknown[][] = [];
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, (...args: unknown[]) => {
      calls.push(args);
      if (args.length > 0) { throw new Error('bad args'); }
    });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    await openCopilotChat({ dbtRoot: '/w/analytics', workspaceFolder: '/w' });
    expect(calls).toEqual([[{ query: SETUP_PROMPT, isPartialQuery: true, mode: 'agent' }], []]);
    expect(String(info.mock.calls[0][0])).toContain('File > Open Folder');
  });

  it('nested project message: "Your dbt project" only when the folder is a dbt project', async () => {
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, () => {});
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const dbtRoot = path.join(tmp, 'analytics');
    fs.mkdirSync(dbtRoot);

    await openCopilotChat({ dbtRoot, workspaceFolder: tmp, logicalOnly: true });
    expect(String(info.mock.calls.at(-1)![0])).toContain('Your project, analytics, is a subfolder here');
    expect(String(info.mock.calls.at(-1)![0])).not.toMatch(/\bdbt\b/i);
    await openCopilotChat({ dbtRoot, workspaceFolder: tmp });
    expect(String(info.mock.calls.at(-1)![0])).not.toMatch(/\bdbt\b/i);
    fs.writeFileSync(path.join(dbtRoot, 'dbt_project.yml'), 'name: analytics\n');
    await openCopilotChat({ dbtRoot, workspaceFolder: tmp });
    expect(String(info.mock.calls.at(-1)![0])).toContain('Your dbt project, analytics, is a subfolder here');
  });

  it('without a chat command: opens the Copilot setup page', async () => {
    const open = vi.spyOn(vscode.env, 'openExternal');
    await openCopilotChat({ dbtRoot: '/w', workspaceFolder: '/w' });
    expect(String(open.mock.calls[0][0])).toBe(GETTING_STARTED_EXTERNAL_URLS.copilotDocs);
  });
});

// ---------------------------------------------------------------------------
// Panel host
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<GettingStartedDeps> = {}): GettingStartedDeps {
  return {
    workspaceRoot: '/w',
    semanticDir: '.erd-studio',
    runSetup: vi.fn(async (): Promise<SetupOutcome> => ({ ok: true, filesWritten: ['.gitignore'], message: 'ok' })),
    getStatus: vi.fn(async () => STATUS),
    clipboardText: (assistant) => `COPY-ME:${assistant ?? 'none'}`,
    ...overrides,
  };
}

function makeContext() {
  return vscode.createMockExtensionContext({ storageRoot: tmp, extensionRoot: REPO_ROOT }) as unknown as import('vscode').ExtensionContext;
}

describe('GettingStartedPanel', () => {
  it('opens one panel with scripts on, media-only resource roots and no retained context', () => {
    GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    const panel = vscode.window._webviewPanels[0];
    expect(panel.viewType).toBe(GETTING_STARTED_VIEW_TYPE);
    expect(panel._column).toBe(vscode.ViewColumn.One);
    expect(panel.webview.options.enableScripts).toBe(true);
    expect(panel.webview.options.retainContextWhenHidden).toBe(false);
    // The media folder only (the per-start clips' folder went with the clips).
    expect((panel.webview.options.localResourceRoots as Array<{ path: string }>).map((u) => u.path))
      .toEqual([`${REPO_ROOT}/media/onboarding`]);
    expect(panel.webview.html).toContain("media-src https://mock-csp-source");
    // Shipped media are referenced when present (WP6 output).
    if (fs.existsSync(path.join(REPO_ROOT, 'media/onboarding/getting-started.mp4'))) {
      expect(panel.webview.html).toContain('media/onboarding/getting-started.mp4');
    }
    expect(panel.webview.html).toContain(JSON.stringify(GETTING_STARTED_CUES[0].text).slice(1, 20));
  });

  it('handles every GettingStartedToHost type and ignores unknown ones', async () => {
    const deps = makeDeps({ getStatus: vi.fn(async () => ({ ...STATUS, helper: 'ready' as const })) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const clip = vi.spyOn(vscode.env.clipboard, 'writeText');
    const open = vi.spyOn(vscode.env, 'openExternal');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    const trySample = vi.fn();
    vscode.commands.registerCommand(TRY_SAMPLE_COMMAND, trySample);
    const openFolder = vi.fn();
    vscode.commands.registerCommand('vscode.openFolder', openFolder);
    const createDomain = vi.fn();
    vscode.commands.registerCommand(START_ACTION_COMMANDS.blank, createDomain);
    const showMeAround = vi.fn();
    vscode.commands.registerCommand(SHOW_ME_AROUND_COMMAND, showMeAround);

    const messages: Record<string, unknown> = {
      openExternal: { type: 'openExternal', target: 'dbtInstallDocs' },
      videoError: { type: 'videoError', code: 4 },
      start: { type: 'start', action: 'blank' },
    };
    for (const type of GETTING_STARTED_TO_HOST_TYPES) {
      await panel._simulateMessage(messages[type] ?? { type });
    }

    expect(trySample).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledWith(); // no URI: VS Code's own folder picker
    expect(createDomain).toHaveBeenCalledTimes(1);
    expect(createDomain).toHaveBeenCalledWith(); // no argument from the webview
    expect(showMeAround).toHaveBeenCalledTimes(1);
    expect(showMeAround).toHaveBeenCalledWith();

    // ready, refreshStatus, after setupAiHelper, before openClaude / openCopilotChat, after start
    expect(deps.getStatus).toHaveBeenCalledTimes(6);
    expect(deps.runSetup).toHaveBeenCalledTimes(1);
    expect(clip).toHaveBeenCalledWith('COPY-ME:claude'); // copyPrompt without an assistant means Claude Code
    expect(clip).toHaveBeenCalledWith(SETUP_PROMPT); // openCopilotChat (no chat command here → docs page)
    await panel._simulateMessage({ type: 'copyPrompt', assistant: 'gemini' });
    expect(clip).toHaveBeenLastCalledWith('COPY-ME:gemini');
    // "Open your diagrams" is gone with the start card: openDomain is no longer a message.
    expect(isGettingStartedToHost({ type: 'openDomain' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'showImportGuide' })).toBe(false);
    expect(String(open.mock.calls.at(-1)?.[0])).toBe(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code 4'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring unknown'), expect.anything());

    const setupResult = panel._postedMessages.find((m) => (m as { type: string }).type === 'setupResult') as {
      payload: { groups: Array<{ title: string }> };
    };
    expect(setupResult.payload.groups.map((g) => g.title)).toEqual(['Your .gitignore']);

    open.mockClear();
    await panel._simulateMessage({ type: 'openExternal', target: 'https://evil.example' });
    await panel._simulateMessage({ type: 'nope' });
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring unknown'), expect.anything());
  });

  it('start: records the welcome key, runs the start\'s fixed command with its fixed argument, then posts a fresh status', async () => {
    const deps = makeDeps();
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const feature = vi.spyOn(telemetry, 'feature');
    expect(START_ACTION_COMMANDS).toEqual({
      convert: 'erdStudio.convertProjectToDbml',
      drawFromDbt: 'erdStudio.drawFromDbt',
      importSemanticModel: 'erdStudio.importSemanticModel',
      importSqlDdl: 'erdStudio.importSqlDdl',
      importDbmlFile: 'erdStudio.importDbml',
      blank: 'erdStudio.createDomain',
      import: 'erdStudio.importModel',
      example: 'erdStudio.openExampleProject',
    });
    const ran: Array<{ command: string; args: unknown[] }> = [];
    for (const command of Object.values(START_ACTION_COMMANDS)) {
      vscode.commands.registerCommand(command, (...args: unknown[]) => { ran.push({ command, args }); });
    }
    for (const action of START_ACTIONS) {
      feature.mockClear();
      const statusCalls = (deps.getStatus as ReturnType<typeof vi.fn>).mock.calls.length;
      await panel._simulateMessage({ type: 'start', action });
      expect(feature.mock.calls.map((c) => c[0]), action).toEqual([START_FEATURES.welcome[action]]);
      // A fixed argument, never one from the webview: a direct import's quick path, nothing for the others.
      expect(ran.at(-1), action).toEqual({ command: START_ACTION_COMMANDS[action], args: startActionArgs(action) });
      expect((deps.getStatus as ReturnType<typeof vi.fn>).mock.calls.length, action).toBe(statusCalls + 1);
    }
    expect(Object.values(START_FEATURES.welcome)).toEqual([
      'welcomeConvert', 'welcomeDrawFromDbt', 'welcomeImportSemanticModel', 'welcomeImportSqlDdl', 'welcomeImportDbmlFile',
      'welcomeBlank', 'welcomeImport', 'welcomeExample',
    ]);
    expect(ran).toHaveLength(START_ACTIONS.length);

    // A start the validator does not know runs nothing and counts nothing.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    feature.mockClear();
    await panel._simulateMessage({ type: 'start', action: 'erdStudio.createDomain' });
    await panel._simulateMessage({ type: 'start' });
    expect(ran).toHaveLength(START_ACTIONS.length);
    expect(feature).not.toHaveBeenCalled();
  });

  it('every status carries the suggestion and the starts the start rule gives: Convert alone for a YAML or mixed project, Import from dbt with dbt, only the example with no folder', async () => {
    const deps = makeDeps();
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const lastStarts = () => (panel._postedMessages.filter((m) => (m as { type: string }).type === 'status').at(-1) as { payload: GettingStartedStatus }).payload.starts;
    const lastIntent = () => (panel._postedMessages.filter((m) => (m as { type: string }).type === 'status').at(-1) as { payload: GettingStartedStatus }).payload.intent;
    const cases: Array<[Partial<GettingStartedStatus>, StartIntent | undefined, StartAction[]]> = [
      [{}, 'drawFromDbt', ['drawFromDbt', 'blank', 'import', 'example']], // no storage reads as DBML
      [{ storage: 'dbml' }, 'drawFromDbt', ['drawFromDbt', 'blank', 'import', 'example']],
      [{ storage: 'yaml' }, 'convert', ['convert', 'drawFromDbt', 'blank', 'import']],
      [{ logicalOnly: true }, 'blank', ['blank', 'example', 'import']],
      [{ logicalOnly: true, storage: 'mixed' }, 'convert', ['convert', 'blank', 'example', 'import']],
      [{ hasProject: false, project: null }, undefined, ['example']],
      [{ hasProject: false, project: null, storage: 'yaml' }, undefined, ['example']],
    ];
    for (const [over, intent, starts] of cases) {
      (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, ...over });
      await panel._simulateMessage({ type: 'refreshStatus' });
      expect(lastIntent(), JSON.stringify(over)).toBe(intent);
      expect(lastStarts(), JSON.stringify(over)).toEqual(starts);
    }
    // The deps' logicalOnly counts when the status leaves it out.
    panel.dispose();
    GettingStartedPanel.createOrShow(makeContext(), makeDeps({ logicalOnly: true }));
    const logical = vscode.window._webviewPanels.at(-1)!;
    await logical._simulateMessage({ type: 'ready' });
    const status = logical._postedMessages.filter((m) => (m as { type: string }).type === 'status').at(-1) as { payload: GettingStartedStatus };
    expect(status.payload.starts).toEqual(['blank', 'example', 'import']);
  });

  it('closing the panel without choosing anything records welcomeLeftNoChoice, once; any choice clears it', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const left = () => feature.mock.calls.filter((c) => c[0] === 'welcomeLeftNoChoice').length;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Only the page's own messages (and an invalid one): a bounce.
    GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    let panel = vscode.window._webviewPanels.at(-1)!;
    for (const m of [
      { type: 'ready' }, { type: 'refreshStatus' }, { type: 'videoProgress', milestone: 'half' },
      { type: 'videoError', code: 4 }, { type: 'start', action: 'nope' }, { type: 'nope' },
    ]) { await panel._simulateMessage(m); }
    expect(left()).toBe(0);
    panel.dispose();
    expect(left()).toBe(1);
    panel.dispose();
    expect(left()).toBe(1);

    // A start or a link: a choice.
    vscode.commands.registerCommand(START_ACTION_COMMANDS.example, () => undefined);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    for (const choice of [
      { type: 'start', action: 'example' }, { type: 'openExternal', target: 'claudeCodeDocs' }, { type: 'openFolder' },
    ]) {
      GettingStartedPanel.createOrShow(makeContext(), makeDeps());
      panel = vscode.window._webviewPanels.at(-1)!;
      await panel._simulateMessage({ type: 'ready' });
      await panel._simulateMessage(choice);
      panel.dispose();
      expect(left(), choice.type).toBe(1);
    }
  });

  it('offers step 2 instead of launching an assistant while no guide is installed', async () => {
    const deps = makeDeps(); // STATUS.helper === 'missing'
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const opened = vi.fn();
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, opened);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const terminals = vscode.window.terminals.length;

    await panel._simulateMessage({ type: 'openClaude' });
    await panel._simulateMessage({ type: 'openCopilotChat' });
    expect(opened).not.toHaveBeenCalled();
    expect(vscode.window.terminals.length).toBe(terminals);
    expect(info).toHaveBeenCalledWith(HELPER_FIRST_MESSAGE, SETUP_HELPER_ACTION);
    expect(deps.runSetup).not.toHaveBeenCalled();

    // Choosing the action runs step 2 and still does not launch.
    info.mockResolvedValue(SETUP_HELPER_ACTION as never);
    await panel._simulateMessage({ type: 'openCopilotChat' });
    expect(deps.runSetup).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(panel._postedMessages.some((m) => (m as { type: string }).type === 'setupResult')).toBe(true);
  });

  it('adds the project summary to status, and leaves it off when it fails or there is no project', async () => {
    const summary = { modelCount: 2, layering: null, manifest: { state: 'absent' as const }, line: 'Found 2 dbt models \u00b7 no manifest yet' };
    const deps = makeDeps({ getProjectSummary: vi.fn(async () => summary) });
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const statuses = () => panel._postedMessages.filter((m) => (m as { type: string }).type === 'status') as Array<{ payload: GettingStartedStatus }>;

    await panel._simulateMessage({ type: 'ready' });
    expect(statuses().at(-1)!.payload.summary).toEqual(summary);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (deps.getProjectSummary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('manifest mid-write'));
    await panel._simulateMessage({ type: 'refreshStatus' });
    expect(statuses().at(-1)!.payload.summary).toBeNull();
    expect(statuses().at(-1)!.payload.hasProject).toBe(true); // the rest of the status still goes out

    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, hasProject: false, project: null });
    const calls = (deps.getProjectSummary as ReturnType<typeof vi.fn>).mock.calls.length;
    await panel._simulateMessage({ type: 'refreshStatus' });
    expect(statuses().at(-1)!.payload.summary).toBeNull();
    expect((deps.getProjectSummary as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('posts the cards before a slow summary resolves, then the summary in a second status', async () => {
    const summary = { modelCount: 2, layering: null, manifest: { state: 'absent' as const }, line: 'Found 2 dbt models · no manifest yet' };
    let resolveSummary!: (s: typeof summary) => void;
    const deps = makeDeps({ getProjectSummary: vi.fn(() => new Promise<typeof summary>((r) => { resolveSummary = r; })) });
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const statuses = () => panel._postedMessages.filter((m) => (m as { type: string }).type === 'status') as Array<{ payload: GettingStartedStatus }>;

    const ready = panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(statuses().length).toBeGreaterThan(0));
    expect(statuses().at(-1)!.payload.summary).toBeNull();
    expect(statuses().at(-1)!.payload.hasProject).toBe(true);

    resolveSummary(summary);
    await ready;
    await vi.waitFor(() => expect(statuses().at(-1)!.payload.summary).toEqual(summary));
  });

  it('drops a slow summary a setup or a newer status has overtaken', async () => {
    const summary = { modelCount: 2, layering: null, manifest: { state: 'absent' as const }, line: 'Found 2 dbt models' };
    const pending: Array<(s: typeof summary) => void> = [];
    let finishSetup!: (o: SetupOutcome) => void;
    const deps = makeDeps({
      getProjectSummary: vi.fn(() => new Promise<typeof summary>((r) => { pending.push(r); })),
      runSetup: vi.fn(() => new Promise<SetupOutcome>((r) => { finishSetup = r; })),
    });
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const statuses = () => panel._postedMessages.filter((m) => (m as { type: string }).type === 'status') as Array<{ payload: GettingStartedStatus }>;

    const ready = panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const setup = panel._simulateMessage({ type: 'setupAiHelper' });
    await vi.waitFor(() => expect(deps.runSetup).toHaveBeenCalled());

    // The first summary lands mid-setup: its stale status (which would re-enable the button) is not posted.
    const before = statuses().length;
    pending[0](summary);
    await ready;
    expect(statuses()).toHaveLength(before);

    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, helper: 'ready', domainCount: 4 });
    finishSetup({ ok: true, filesWritten: [], message: 'ok' });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(statuses().at(-1)!.payload.domainCount).toBe(4);
    pending[1](summary);
    await setup;
    await vi.waitFor(() => expect(statuses().at(-1)!.payload).toMatchObject({ domainCount: 4, summary }));
  });

  it('logical-only deps: the first page is the logical one, status carries logicalOnly, and no dbt summary is asked for', async () => {
    expect(pageModeForDeps({ workspaceRoot: null, logicalOnly: true })).toBe('nofolder');
    expect(pageModeForDeps({ workspaceRoot: '/w', logicalOnly: true })).toBe('logical');
    expect(pageModeForDeps({ workspaceRoot: '/w' })).toBe('dbt');

    const getProjectSummary = vi.fn(async () => ({ modelCount: 1, layering: null, manifest: { state: 'unknown' as const }, line: 'x' }));
    const deps = makeDeps({ logicalOnly: true, getProjectSummary });
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    expect(panel.webview.html).toContain('data-mode="logical"');
    const statuses = () => panel._postedMessages.filter((m) => (m as { type: string }).type === 'status') as Array<{ payload: GettingStartedStatus }>;

    await panel._simulateMessage({ type: 'ready' });
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0].payload).toMatchObject({ hasProject: true, logicalOnly: true, summary: null });
    expect(getProjectSummary).not.toHaveBeenCalled();

    // A status that says it itself wins over the deps; no folder is never logical-only.
    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, logicalOnly: false });
    await panel._simulateMessage({ type: 'refreshStatus' });
    await vi.waitFor(() => expect(getProjectSummary).toHaveBeenCalledTimes(1));
    expect(statuses().at(-1)!.payload.logicalOnly).toBe(false);
    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, hasProject: false, project: null });
    await panel._simulateMessage({ type: 'refreshStatus' });
    expect(statuses().at(-1)!.payload.logicalOnly).toBe(false);
  });

  it('dbt deps (logicalOnly absent) keep the page as it was: logicalOnly false and the dbt summary', async () => {
    const getProjectSummary = vi.fn(async () => ({ modelCount: 1, layering: null, manifest: { state: 'unknown' as const }, line: 'x' }));
    GettingStartedPanel.createOrShow(makeContext(), makeDeps({ getProjectSummary }));
    const panel = vscode.window._webviewPanels[0];
    expect(panel.webview.html).toContain('data-mode="dbt"');
    await panel._simulateMessage({ type: 'ready' });
    const last = panel._postedMessages.filter((m) => (m as { type: string }).type === 'status').at(-1) as { payload: GettingStartedStatus };
    expect(last.payload).toMatchObject({ logicalOnly: false, summary: { line: 'x' } });
  });

  it('plays the dbt tour on the dbt page and the logical-first cut, with its own captions and transcript, elsewhere', () => {
    expect(GETTING_STARTED_MEDIA).toMatchObject({
      video: 'getting-started.mp4', poster: 'getting-started-poster.jpg',
      logicalVideo: 'getting-started-logical.mp4', logicalPoster: 'getting-started-logical-poster.jpg',
    });
    expect(gettingStartedCut('dbt')).toEqual({
      video: 'getting-started.mp4', poster: 'getting-started-poster.jpg', cues: GETTING_STARTED_CUES, transcript: GETTING_STARTED_TRANSCRIPT,
    });
    for (const mode of ['logical', 'nofolder'] as const) {
      expect(gettingStartedCut(mode), mode).toEqual({
        video: 'getting-started-logical.mp4',
        poster: 'getting-started-logical-poster.jpg',
        cues: LOGICAL_GETTING_STARTED_CUES,
        transcript: LOGICAL_GETTING_STARTED_TRANSCRIPT,
      });
    }

    const escaped = (t: string) => JSON.stringify(t).slice(1, 20);
    for (const deps of [makeDeps({ logicalOnly: true }), makeDeps({ workspaceRoot: null })]) {
      GettingStartedPanel.createOrShow(makeContext(), deps);
      // The panel this pass opened (the one before it is disposed).
      const html = vscode.window._webviewPanels.at(-1)!.webview.html;
      if (fs.existsSync(path.join(REPO_ROOT, 'media/onboarding', GETTING_STARTED_MEDIA.logicalVideo))) {
        expect(html).toContain('media/onboarding/getting-started-logical.mp4');
      }
      expect(html).not.toContain('media/onboarding/getting-started.mp4');
      expect(html).not.toContain('media/onboarding/getting-started-poster.jpg');
      expect(html).toContain(escaped(LOGICAL_GETTING_STARTED_CUES[0].text));
      // The two cuts share every scene but the default cut's dbt beat: its captions stay off these pages.
      const dbtCue = GETTING_STARTED_CUES.find((c) => /\bdbt\b/.test(c.text))!;
      expect(html).not.toContain(JSON.stringify(dbtCue.text).slice(1, -1));
      vscode.window._webviewPanels.at(-1)!.dispose();
    }
  });

  it('logical-only deps: the setup result explains the checking tool without naming dbt', async () => {
    const runSetup = vi.fn(async (): Promise<SetupOutcome> => ({ ok: true, filesWritten: ['~/.erd-studio-cli/bin/erd-studio'], message: 'ok' }));
    GettingStartedPanel.createOrShow(makeContext(), makeDeps({ logicalOnly: true, runSetup }));
    const panel = vscode.window._webviewPanels[0];
    await panel._simulateMessage({ type: 'setupAiHelper' });
    const result = panel._postedMessages.find((m) => (m as { type: string }).type === 'setupResult') as
      { payload: { groups: Array<{ title: string; why: string }> } };
    expect(result.payload.groups.map((g) => g.why)).toEqual([
      'Your assistant runs it to check your diagram files. It sits in your home folder, outside the project.',
    ]);
  });

  it('createOrShow on an open panel reveals it with the new deps; dispose clears the singleton', async () => {
    const first = GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    const second = makeDeps({ getStatus: vi.fn(async () => ({ ...STATUS, domainCount: 9 })) });
    expect(GettingStartedPanel.createOrShow(makeContext(), second)).toBe(first);
    const panel = vscode.window._webviewPanels[0];
    expect(vscode.window._webviewPanels).toHaveLength(1);
    expect(panel._reveals).toEqual([vscode.ViewColumn.One]);
    await vi.waitFor(() => expect(second.getStatus).toHaveBeenCalled());

    panel.dispose();
    expect(GettingStartedPanel.currentPanel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Try the sample project
// ---------------------------------------------------------------------------

describe('trySampleProject', () => {
  it('confirms in a modal, then hands the fixed clone URL to git.clone', async () => {
    vscode._setMockExtensions(['vscode.git']);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(SAMPLE_DOWNLOAD_ACTION as never);
    const clone = vi.fn();
    vscode.commands.registerCommand('git.clone', clone);
    const open = vi.spyOn(vscode.env, 'openExternal');

    await expect(trySampleProject()).resolves.toBe('cloned');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(SAMPLE_CONFIRM_MESSAGE, { modal: true }, 'Download');
    expect(SAMPLE_CONFIRM_MESSAGE).toBe(
      "Download the ERD Studio sample project? It's a small dbt project with fake coffee-shop data from " +
      "github.com/liam-machine/erd-studio-sample (about 1 MB). You'll choose where to save it.",
    );
    expect(clone).toHaveBeenCalledWith('https://github.com/liam-machine/erd-studio-sample.git');
    expect(open).not.toHaveBeenCalled();
  });

  it('Cancel does nothing', async () => {
    vscode._setMockExtensions(['vscode.git']);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const clone = vi.fn();
    vscode.commands.registerCommand('git.clone', clone);
    const open = vi.spyOn(vscode.env, 'openExternal');

    await expect(trySampleProject()).resolves.toBe('cancelled');
    expect(info).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('without the Git extension, offers the GitHub page (fixed URL) instead', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never)
      .mockResolvedValueOnce(SAMPLE_OPEN_ON_GITHUB_ACTION as never);
    const clone = vi.fn();
    vscode.commands.registerCommand('git.clone', clone);
    const open = vi.spyOn(vscode.env, 'openExternal');

    await expect(trySampleProject()).resolves.toBe('fallback');
    expect(clone).not.toHaveBeenCalled();
    expect(info).toHaveBeenLastCalledWith(SAMPLE_FALLBACK_MESSAGE, 'Download ZIP', 'Open on GitHub');
    expect(SAMPLE_FALLBACK_MESSAGE).toContain('Download ZIP');
    expect(SAMPLE_FALLBACK_MESSAGE).toContain('erd-studio-sample-main');
    expect(SAMPLE_FALLBACK_MESSAGE).toContain('Open Folder');
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toBe('https://github.com/liam-machine/erd-studio-sample');
  });

  it('falls back when git.clone throws, and opens nothing if the notice is dismissed', async () => {
    vscode._setMockExtensions(['vscode.git']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never)
      .mockResolvedValueOnce(undefined);
    vscode.commands.registerCommand('git.clone', () => { throw new Error('git not found'); });
    const open = vi.spyOn(vscode.env, 'openExternal');

    await expect(trySampleProject()).resolves.toBe('fallback');
    expect(info).toHaveBeenLastCalledWith(SAMPLE_FALLBACK_MESSAGE, 'Download ZIP', 'Open on GitHub');
    expect(open).not.toHaveBeenCalled();
  });

  it('treats the built-in Git extension without a git.clone command as no Git (Git not installed)', async () => {
    // VS Code's Git extension is always present; with no git binary it never
    // registers its commands, so `git.clone` would throw "command not found".
    vscode._setMockExtensions(['vscode.git']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execute = vi.spyOn(vscode.commands, 'executeCommand');
    vi.spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never)
      .mockResolvedValueOnce('Download ZIP' as never);
    const open = vi.spyOn(vscode.env, 'openExternal');

    await expect(trySampleProject()).resolves.toBe('fallback');
    expect(execute).not.toHaveBeenCalledWith('git.clone', expect.anything());
    expect(warn).not.toHaveBeenCalled();
    expect(String(open.mock.calls[0][0])).toBe('https://github.com/liam-machine/erd-studio-sample/archive/refs/heads/main.zip');
  });
});

// ---------------------------------------------------------------------------
// Canvas entry point: openGettingStarted
// ---------------------------------------------------------------------------

describe('canvas openGettingStarted', () => {
  it('runs erdStudio.showGettingStarted, including on the read-only physical stage', async () => {
    const { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE } = await import('../../src/providers/SemanticEditorProvider');
    const { SubjectAreaService } = await import('../../src/services/domainService');
    const { LayerService } = await import('../../src/services/layerService');
    const { TableLibraryService } = await import('../../src/services/logicalModelService');
    const { ManifestService } = await import('../../src/services/manifestService');
    const { YmlParserService } = await import('../../src/services/ymlParserService');
    const { TemplateService } = await import('../../src/services/templateService');
    const { SelectorsService } = await import('../../src/services/selectorsService');

    const root = path.join(tmp, 'project');
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project'), root, { recursive: true });
    const layerService = new LayerService(root, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(root, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const provider = new SemanticEditorProvider(
      makeContext(),
      subjectAreaService,
      new ManifestService(),
      new YmlParserService(),
      new TemplateService(),
      layerService,
      root,
      new SelectorsService(subjectAreaService, root, '.erd-studio'),
      tableLibraryService,
    );
    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const text = fs.readFileSync(file, 'utf-8');
    const doc = { uri: vscode.Uri.file(file), isDirty: false, isClosed: false, getText: () => text, positionAt: (o: number) => ({ o }), save: async () => true };
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    const types = () => (panel._postedMessages as Array<{ type: string }>).map((m) => m.type);
    panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(types()).toContain('domainLoaded'), { timeout: 4000, interval: 10 });
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(types()).toContain('stageData'), { timeout: 4000, interval: 10 });

    const shown = vi.fn();
    vscode.commands.registerCommand('erdStudio.showGettingStarted', shown);
    await panel._simulateMessage({ type: 'openGettingStarted' });

    expect(shown).toHaveBeenCalledTimes(1);
    const errors = (panel._postedMessages as Array<{ type: string; payload?: { message?: string } }>)
      .filter((m) => m.type === 'error');
    expect(errors.map((e) => e.payload?.message)).not.toContain(PHYSICAL_READ_ONLY_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Getting-started telemetry: cancels and routes are features, breakage is an error
// ---------------------------------------------------------------------------

describe('getting-started telemetry', () => {
  const spies = () => ({ feature: vi.spyOn(telemetry, 'feature'), error: vi.spyOn(telemetry, 'error') });
  const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0]);

  it('setup: a dismissed Replace / Keep mine modal is a conflict and a cancel, not an error', async () => {
    const { feature, error } = spies();
    const { deps } = setupDeps({
      results: [{ status: 'needs-confirmation', unmanaged: ['x'], filesWritten: [], targets: ['claude'] }],
      confirmReplace: vi.fn(async () => undefined),
    });
    await runSetupAiHelper(deps);
    expect(keys(feature)).toEqual(['setupHelperConflict', 'setupHelperCancelled']);
    expect(error).not.toHaveBeenCalled();
  });

  it('setup: a harness failure, a launcher failure and a throw are errors', async () => {
    const { error } = spies();
    await runSetupAiHelper(setupDeps({
      results: [{ status: 'failed', unmanaged: [], filesWritten: [], targets: ['claude'], error: 'disk full' }],
    }).deps);
    // No failed target or errno reported: the total only (B16).
    expect(keys(error)).toEqual(['setupHarnessFailed', 'harnessInstallFailed']);

    error.mockClear();
    await runSetupAiHelper(setupDeps({ launcherOk: false }).deps);
    expect(keys(error)).toEqual(['launcherRuntimeUnverified', 'launcherInstallFailed']);

    error.mockClear();
    const { deps } = setupDeps();
    deps.harness.installRecommended = () => { throw new Error('boom'); };
    await runSetupAiHelper(deps);
    expect(keys(error)).toEqual(['setupFailed']);
  });

  it('setup: a failed install names its target and write class, never the message (B16)', async () => {
    const { feature, error } = spies();
    await runSetupAiHelper(setupDeps({
      results: [{
        status: 'failed', unmanaged: [], filesWritten: [], targets: ['claude', 'agents'],
        error: "EACCES: permission denied, open '/secret/path/SKILL.md'", failedTarget: 'agents', errno: 'EACCES',
      }],
    }).deps);
    expect(keys(error)).toEqual(['setupHarnessFailed', 'harnessInstallFailed', 'harnessInstallFailedAgents']);
    expect(keys(feature)).toEqual(['writeFailedPermission']);
  });

  it('setup: hooks left out on purpose are presence flags by reason and by tool (B16)', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    await runSetupAiHelper(setupDeps({
      results: [{
        status: 'unchanged', unmanaged: [], filesWritten: [], targets: ['agents'],
        skippedHooks: [{ id: 'copilot', reason: 'jsonc' }, { id: 'gemini', reason: 'jsonc' }],
      }],
    }).deps);
    expect(featureOnce.mock.calls.map((c) => c[0])).toEqual(['hookSkippedJsonc', 'hookSkippedCopilot', 'hookSkippedGemini']);
  });

  it('setup: a clean run records no error', async () => {
    const { feature, error } = spies();
    await runSetupAiHelper(setupDeps().deps);
    expect(error).not.toHaveBeenCalled();
    expect(keys(feature)).toContain('setupAiHelper');
  });

  it('Open Claude Code: records the route, and a dismissed confirm as a cancel', async () => {
    const { feature, error } = spies();
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(keys(feature)).toEqual(['openClaudeNotFound']);

    feature.mockClear();
    fakeClaudeOnPath();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(keys(feature)).toEqual(['openClaudeCancelled']);

    feature.mockClear();
    info.mockResolvedValue('Open Terminal' as never);
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(keys(feature)).toEqual(['openClaudeCli']);
    expect(error).not.toHaveBeenCalled();
  });

  it('Open Claude Code: the extension with no known open command, or one that throws, is an error', async () => {
    vscode._setMockExtensions(['anthropic.claude-code']);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { feature, error } = spies();
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(keys(feature)).toEqual(['openClaudeExtension']);
    expect(keys(error)).toEqual(['claudeOpenCommandMissing']);

    error.mockClear();
    vscode.commands.registerCommand('claude-vscode.sidebar.open', () => { throw new Error('nope'); });
    await openClaudeCode({ dbtRoot: '/w', clipboardText: SETUP_PROMPT });
    expect(keys(error)).toEqual(['claudeOpenFailed']);
  });

  it('Open Copilot Chat: no chat command is a route; the bare-open fallback is a route; both throwing is an error', async () => {
    const { feature, error } = spies();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openCopilotChat({ dbtRoot: '/w', workspaceFolder: '/w' });
    expect(keys(feature)).toEqual(['copilotChatNotFound']);

    feature.mockClear();
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, (...args: unknown[]) => {
      if (args.length > 0) { throw new Error('bad args'); }
    });
    await openCopilotChat({ dbtRoot: '/w', workspaceFolder: '/w' });
    expect(keys(feature)).toEqual(['copilotChatNoArgs']);
    expect(error).not.toHaveBeenCalled();

    vscode._resetRegisteredCommands();
    vscode.commands.registerCommand(COPILOT_CHAT_OPEN_COMMAND, () => { throw new Error('broken'); });
    await openCopilotChat({ dbtRoot: '/w', workspaceFolder: '/w' });
    expect(keys(error)).toEqual(['copilotChatOpenFailed']);
  });

  it('Try the sample: Git not installed (no git.clone command) is trySampleNoGit, not a failed clone', async () => {
    const { feature, error } = spies();
    vscode._setMockExtensions(['vscode.git']);
    vi.spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never)
      .mockResolvedValueOnce(undefined);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleNoGit']);
    expect(error).not.toHaveBeenCalled();
  });

  it('Try the sample: cancel and no Git are features; a failed clone is an error', async () => {
    const { feature, error } = spies();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleCancelled']);

    feature.mockClear();
    info.mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never).mockResolvedValueOnce(undefined);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleNoGit']);
    expect(error).not.toHaveBeenCalled();

    vscode._setMockExtensions(['vscode.git']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vscode.commands.registerCommand('git.clone', () => { throw new Error('git not found'); });
    info.mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never).mockResolvedValueOnce(undefined);
    await trySampleProject();
    expect(keys(error)).toEqual(['sampleCloneFailed']);
  });

  it('Try the sample: a git.clone that resolves, a zip and the GitHub page are each counted (B18)', async () => {
    const { feature } = spies();
    vscode._setMockExtensions(['vscode.git']);
    vscode.commands.registerCommand('git.clone', vi.fn(async () => undefined));
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleCloned']);

    feature.mockClear();
    vscode._resetRegisteredCommands();
    vscode._setMockExtensions([]);
    info.mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never).mockResolvedValueOnce('Download ZIP' as never);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleNoGit', 'trySampleZip']);

    feature.mockClear();
    info.mockResolvedValueOnce(SAMPLE_DOWNLOAD_ACTION as never).mockResolvedValueOnce(SAMPLE_OPEN_ON_GITHUB_ACTION as never);
    await trySampleProject();
    expect(keys(feature)).toEqual(['trySampleNoGit', 'trySampleGithub']);
  });

  it('a Welcome button whose handler throws names the button, beside welcomePanelFailed (B18)', async () => {
    const { error } = spies();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    const panel = vscode.window._webviewPanels[0];
    vscode.commands.registerCommand(TRY_SAMPLE_COMMAND, () => { throw new Error('/private/path broke'); });
    vscode.commands.registerCommand(START_ACTION_COMMANDS.blank, () => { throw new Error('boom'); });

    await panel._simulateMessage({ type: 'trySample' });
    await vi.waitFor(() => expect(keys(error)).toEqual(['welcomePanelFailed', 'welcomeFailedSample']));
    error.mockClear();
    await panel._simulateMessage({ type: 'start', action: 'blank' });
    await vi.waitFor(() => expect(keys(error)).toEqual(['welcomePanelFailed', 'welcomeFailedStart']));
  });
});

// ---------------------------------------------------------------------------
// The suggested start's reason line, and Show Me Around (in place of the per-start clips)
// ---------------------------------------------------------------------------

describe('Show Me Around, and the suggested start (Draft-first: no clip, no start card)', () => {
  it('reason lines name the kind of file only (no names), say "diagram", and never "open standard"', () => {
    for (const reason of Object.values(START_INTENT_REASONS)) {
      expect(reason).toMatch(/^This folder has /);
      expect(reason).not.toMatch(/\.(sql|dbml|bim|pbip|tmdl)\b|open standard|\bdbt\b/i);
    }
    expect(Object.keys(START_INTENT_REASONS).sort()).toEqual(['importDbmlFile', 'importSemanticModel', 'importSqlDdl']);
  });

  it('the strings: a heading, one line and the button, with no dbt word, "diagram" in prose and no question', () => {
    expect(SHOW_ME_AROUND_COMMAND).toBe('erdStudio.showMeAround');
    expect(SHOW_ME_AROUND_LABEL).toBe('Show Me Around');
    expect(SHOW_ME_AROUND_SECTION_TITLE).toBe('Find your way around');
    expect(SHOW_ME_AROUND_SECTION_INTRO).toMatch(/^Show Me Around /);
    for (const text of [SHOW_ME_AROUND_LABEL, SHOW_ME_AROUND_SECTION_TITLE, SHOW_ME_AROUND_SECTION_INTRO]) {
      expect(text).not.toMatch(/\bdbt\b|\?/i);
    }
  });

  it('every page shows the section and its button, after the AI cards, outside the steps (shown with no folder too); no clip, no video but the tour', () => {
    for (const mode of [undefined, 'nofolder', 'logical', 'dbt'] as const) {
      const html = buildGettingStartedHtml({ ...HTML_INPUT, ...(mode ? { mode } : {}) });
      const label = mode ?? 'unknown';
      expect(html.match(/data-action="showMeAround"/g), label).toHaveLength(1);
      expect(html, label).toContain(`<section class="gs-around" aria-label="${SHOW_ME_AROUND_SECTION_TITLE}">`);
      expect(html, label).toContain(`<h2 class="gs-section-title">${SHOW_ME_AROUND_SECTION_TITLE}</h2>`);
      expect(html, label).toContain(`<p class="gs-section-intro">${SHOW_ME_AROUND_SECTION_INTRO}</p>`);
      expect(html, label).toContain(`<button class="gs-btn" type="button" data-action="showMeAround">${SHOW_ME_AROUND_LABEL}</button>`);
      expect(html.indexOf('class="gs-around"'), label).toBeGreaterThan(html.indexOf('data-step="start"'));
      // The per-start clips are gone: no section, no clip, no second <video>.
      expect(html, label).not.toMatch(/gs-howto|data-clip|Ways to start, in short videos|onboarding\/stories/);
      expect(html.match(/<video /g) ?? [], label).toHaveLength(1);
    }
  });

  it.each(['nofolder', 'logical', 'dbt'] as const)('%s page: the button is visible once the status lands, and a click posts showMeAround', (mode) => {
    const status: GettingStartedStatus = mode === 'nofolder'
      ? { ...STATUS, hasProject: false, project: null }
      : mode === 'logical' ? { ...STATUS, logicalOnly: true } : STATUS;
    const { dom, posted, send, visible, doc } = runPanelScript(buildGettingStartedHtml({ ...HTML_INPUT, mode }));
    try {
      send({ type: 'status', payload: status });
      const button = doc.querySelector<HTMLElement>('[data-action="showMeAround"]')!;
      expect(button.closest('[hidden]')).toBeNull();
      expect(dom.window.getComputedStyle(button.closest('.gs-around')!).display).not.toBe('none');
      expect(visible('.gs-around .gs-section-title')).toEqual([SHOW_ME_AROUND_SECTION_TITLE]);
      expect(visible('[data-action="showMeAround"]')).toEqual([SHOW_ME_AROUND_LABEL]);
      posted.length = 0;
      button.click();
      expect(posted).toEqual([{ type: 'showMeAround' }]);
    } finally {
      dom.window.close();
    }
  });

  it('showMeAround is validated and runs exactly the fixed command, with no argument; it is a choice, not passive', async () => {
    expect(isGettingStartedToHost({ type: 'showMeAround' })).toBe(true);
    expect(GETTING_STARTED_TO_HOST_TYPES).toContain('showMeAround');
    expect(GETTING_STARTED_PASSIVE_TYPES).not.toContain('showMeAround');
    const feature = vi.spyOn(telemetry, 'feature');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    const panel = vscode.window._webviewPanels.at(-1)!;
    await panel._simulateMessage({ type: 'ready' });
    exec.mockClear();
    // Whatever else the page sends rides along, never a command id.
    await panel._simulateMessage({ type: 'showMeAround', command: 'workbench.action.terminal.new' });
    expect(exec.mock.calls).toEqual([['erdStudio.showMeAround']]);
    panel.dispose();
    expect(feature.mock.calls.filter((c) => c[0] === 'welcomeLeftNoChoice')).toHaveLength(0);
  });

  it('howToClipPlayed is gone: rejected, not a type, never sent, never counted', async () => {
    expect(isGettingStartedToHost({ type: 'howToClipPlayed' })).toBe(false);
    expect(GETTING_STARTED_TO_HOST_TYPES as readonly string[]).not.toContain('howToClipPlayed');
    expect(GETTING_STARTED_PASSIVE_TYPES as readonly string[]).not.toContain('howToClipPlayed');
    expect(buildGettingStartedHtml(HTML_INPUT)).not.toContain('howToClipPlayed');
    const feature = vi.spyOn(telemetry, 'feature');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    GettingStartedPanel.createOrShow(makeContext(), makeDeps());
    const panel = vscode.window._webviewPanels.at(-1)!;
    await panel._simulateMessage({ type: 'howToClipPlayed' });
    expect(feature).not.toHaveBeenCalledWith('howToClipPlayed');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring unknown'), expect.anything());
    panel.dispose();
  });

  it('with the host\'s tracker: the first status carries the known suggestion, a second the one after the look; nothing is counted as suggested (the tab shows no suggestion)', async () => {
    const once = vi.spyOn(telemetry, 'featureOnce');
    let resolveLook!: (i: StartIntent) => void;
    const tracker = {
      known: vi.fn((): StartIntent => 'blank'),
      refresh: vi.fn(() => new Promise<StartIntent>((r) => { resolveLook = r; })),
    };
    const deps = makeDeps({ logicalOnly: true, startIntent: tracker });
    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, logicalOnly: true });
    GettingStartedPanel.createOrShow(makeContext(), deps);
    const panel = vscode.window._webviewPanels[0];
    const statuses = () => panel._postedMessages.filter((m) => (m as { type: string }).type === 'status') as Array<{ payload: GettingStartedStatus }>;
    const ready = panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(statuses().length).toBe(1));
    expect(statuses()[0].payload).toMatchObject({ intent: 'blank' });
    resolveLook('importSqlDdl');
    await ready;
    await vi.waitFor(() => expect(statuses().length).toBe(2));
    expect(statuses()[1].payload).toMatchObject({ intent: 'importSqlDdl' });
    expect(once).not.toHaveBeenCalledWith(START_INTENT_FEATURES.importSqlDdl);

    // No folder: the tracker is not asked.
    (deps.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ ...STATUS, hasProject: false, project: null });
    await panel._simulateMessage({ type: 'refreshStatus' });
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.refresh).toHaveBeenCalledTimes(1);
    expect(statuses().at(-1)!.payload.intent).toBeUndefined();
  });
});
