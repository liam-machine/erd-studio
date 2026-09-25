/**
 * Welcome panel ("Welcome to ERD Studio") — the pure protocol/HTML module
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
  GETTING_STARTED_TO_HOST_TYPES,
  SAMPLE_REPO_CLONE_URL,
  SAMPLE_REPO_URL,
  SETUP_PROMPT,
  buildGettingStartedCsp,
  buildGettingStartedHtml,
  copyText,
  deriveAiHelperState,
  describeWrittenFiles,
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
import { GETTING_STARTED_CUES } from '../../src/types/gettingStartedTranscript';
import { HARNESS_VERSION, HarnessService, extractHarnessVersion } from '../../src/services/harnessService';
import type { RecommendedInstallResult } from '../../src/types/harness';

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
  });

  it('has the hero copy, the four steps and the rewatch footer', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    expect(html).toContain('Welcome to ERD Studio');
    expect(html).toContain('Turn the dbt project you already have into a data model you can see.');
    for (const step of ['assistant', 'helper', 'start', 'canvas']) {
      expect(html).toContain(`data-step="${step}"`);
    }
    expect(html).toContain('ERD Studio: Watch Getting Started Video');
    expect(html).toContain('Open a folder containing <code>dbt_project.yml</code> to continue.');
    expect(html).toContain('Your AI assistant');
    expect(html).toContain('Start the guided setup');
  });

  it('renders a chip and a start row for every assistant, each with exactly what to type', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    for (const [id, prompt] of [
      ['claude', '/erd-studio-setup'],
      ['copilot', '/erd-studio-setup'],
      ['codex', '$erd-studio-setup'],
      ['gemini', 'Set up ERD Studio for this dbt project'],
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
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
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
      expect(visible('[data-step="canvas"] .gs-btn')).toEqual(['Create your first domain']);
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
      expect(doc.querySelector('.gs-domain-count')?.textContent).toBe('You have 3 domains.');
      expect(visible('[data-step="canvas"] .gs-btn')).toEqual(['Open a domain']);
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
      expect(visible('[data-step="start"] .gs-step__hint').join()).toContain('Do step 2 first: Set up my AI helper installs the guide your assistant runs.');
      expect(visible('[data-step="assistant"] .gs-recheck').join()).toContain('ERD Studio: Install AI Coding Harness → Agent Skills');
      send({ type: 'status', payload: { ...STATUS, assistants: ['claude'], helper: 'ready' } });
      expect(visible('.gs-launch__name')).toEqual(['Claude Code']);
      expect(visible('[data-step="start"] .gs-step__hint').join()).not.toContain('Do step 2 first');
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

  it('offers the sample project: a card with no project, a small link with one', () => {
    const html = buildGettingStartedHtml(HTML_INPUT);
    // Visibility is CSS-driven by data-project; pin both the markup and the rules.
    expect(html).toContain('<h2 class="gs-sample__title">No dbt project yet? Try the sample</h2>');
    expect(html).toContain('A small Kimball-style dbt project with fake coffee-shop data &mdash; runs on your computer, no account needed.');
    expect(html).toContain('<button class="gs-btn gs-btn--primary" type="button" data-action="trySample">Try the sample project</button>');
    expect(html).toContain('.gs[data-project="true"] .gs-noproject, .gs[data-project="true"] .gs-sample { display: none; }');
    expect(html).toContain('.gs[data-project="false"] .gs-steps-wrap { display: none; }');
    // The project-state link lives inside the steps (hidden with them when there is no project).
    const steps = html.slice(html.indexOf('<div class="gs-steps-wrap">'));
    expect(steps).toContain('data-action="trySample">New to this? Try it on the sample project first</button>');
    const sampleCard = html.slice(html.indexOf('<section class="gs-sample"'), html.indexOf('<div class="gs-steps-wrap">'));
    expect(sampleCard).toContain('data-action="trySample"');

    const { dom, posted, send, doc } = runPanelScript(html);
    try {
      send({ type: 'status', payload: { ...STATUS, hasProject: false, project: null } });
      (doc.querySelector('.gs-sample [data-action="trySample"]') as HTMLElement).click();
      send({ type: 'status', payload: STATUS });
      (doc.querySelector('.gs-sample-link [data-action="trySample"]') as HTMLElement).click();
      expect(posted.slice(1)).toEqual([{ type: 'trySample' }, { type: 'trySample' }]);
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
      click('[data-action="openDomain"]');
      click('[data-action="copyPrompt"][data-assistant="codex"]');
      click('[data-action="openCopilotChat"]');
      expect(posted.slice(1)).toEqual([
        { type: 'setupAiHelper' },
        { type: 'refreshStatus' },
        { type: 'openExternal', target: 'claudeCodeDocs' },
        { type: 'openDomain' },
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
    };
    for (const type of GETTING_STARTED_TO_HOST_TYPES) {
      expect(isGettingStartedToHost(samples[type] ?? { type }), type).toBe(true);
    }
  });

  it('accepts trySample (no payload needed)', () => {
    expect(isGettingStartedToHost({ type: 'trySample' })).toBe(true);
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
      'claudeCodeDocs', 'codexDocs', 'copilotDocs', 'cursorDocs', 'dbtInstallDocs', 'geminiCliDocs', 'sampleRepo',
      'videoOnline',
    ]);
    for (const url of Object.values(GETTING_STARTED_EXTERNAL_URLS)) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(GETTING_STARTED_EXTERNAL_URLS.sampleRepo).toBe('https://github.com/liam-machine/erd-studio-sample');
    expect(SAMPLE_REPO_URL).toBe('https://github.com/liam-machine/erd-studio-sample');
    expect(SAMPLE_REPO_CLONE_URL).toBe('https://github.com/liam-machine/erd-studio-sample.git');
    expect(GETTING_STARTED_EXTERNAL_URLS.videoOnline)
      .toBe('https://github.com/liam-machine/erd-studio/blob/main/media/onboarding/getting-started.mp4');
  });
});

describe('pure helpers', () => {
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
    expect(promptFor('gemini', '/w', '/w', 'darwin')).toBe('Set up ERD Studio for this dbt project');
    expect(promptFor('cursor', '/w', '/w', 'darwin')).toBe('/erd-studio-setup');
  });

  it('setupReadyMessage names the assistants it installed for', () => {
    expect(setupReadyMessage(['claude'])).toBe("AI helper ready for Claude Code: run /erd-studio-setup there (restart it if it's already open).");
    expect(setupReadyMessage(['codex'])).toContain('run $erd-studio-setup there');
    expect(setupReadyMessage(['gemini'])).toContain('ask “Set up ERD Studio for this dbt project”');
    expect(setupReadyMessage(['claude', 'copilot', 'cursor'])).toContain('AI helper ready for Claude Code, GitHub Copilot and Cursor.');
    expect(setupReadyMessage([])).toContain('Claude Code, GitHub Copilot, Codex, Gemini CLI and Cursor');
    expect(SETUP_READY_MESSAGE).toBe(setupReadyMessage(['claude']));
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
    openCanvas: vi.fn(async () => {}),
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

    const messages: Record<string, unknown> = {
      openExternal: { type: 'openExternal', target: 'dbtInstallDocs' },
      videoError: { type: 'videoError', code: 4 },
    };
    for (const type of GETTING_STARTED_TO_HOST_TYPES) {
      await panel._simulateMessage(messages[type] ?? { type });
    }

    expect(trySample).toHaveBeenCalledTimes(1);

    // ready, refreshStatus, after setupAiHelper, and before openClaude / openCopilotChat
    expect(deps.getStatus).toHaveBeenCalledTimes(5);
    expect(deps.runSetup).toHaveBeenCalledTimes(1);
    expect(clip).toHaveBeenCalledWith('COPY-ME:claude'); // copyPrompt without an assistant means Claude Code
    expect(clip).toHaveBeenCalledWith(SETUP_PROMPT); // openCopilotChat (no chat command here → docs page)
    await panel._simulateMessage({ type: 'copyPrompt', assistant: 'gemini' });
    expect(clip).toHaveBeenLastCalledWith('COPY-ME:gemini');
    expect(deps.openCanvas).toHaveBeenCalledTimes(1);
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
    expect(info).toHaveBeenLastCalledWith(SAMPLE_FALLBACK_MESSAGE, 'Open on GitHub');
    expect(SAMPLE_FALLBACK_MESSAGE).toContain('Download ZIP');
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
    expect(info).toHaveBeenLastCalledWith(SAMPLE_FALLBACK_MESSAGE, 'Open on GitHub');
    expect(open).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Canvas entry point: openGettingStarted
// ---------------------------------------------------------------------------

describe('canvas openGettingStarted', () => {
  it('runs erdStudio.showGettingStarted, including on the read-only physical stage', async () => {
    const { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE } = await import('../../src/providers/SemanticEditorProvider');
    const { DomainService } = await import('../../src/services/domainService');
    const { LayerService } = await import('../../src/services/layerService');
    const { LogicalModelService } = await import('../../src/services/logicalModelService');
    const { ManifestService } = await import('../../src/services/manifestService');
    const { YmlParserService } = await import('../../src/services/ymlParserService');
    const { TemplateService } = await import('../../src/services/templateService');
    const { SelectorsService } = await import('../../src/services/selectorsService');

    const root = path.join(tmp, 'project');
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project'), root, { recursive: true });
    const layerService = new LayerService(root, '.erd-studio');
    const domainService = new DomainService(layerService);
    const logicalModelService = new LogicalModelService(root, '.erd-studio');
    domainService.setLogicalModelService(logicalModelService);
    const provider = new SemanticEditorProvider(
      makeContext(),
      domainService,
      new ManifestService(),
      new YmlParserService(),
      new TemplateService(),
      layerService,
      root,
      new SelectorsService(domainService, root, '.erd-studio'),
      logicalModelService,
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
