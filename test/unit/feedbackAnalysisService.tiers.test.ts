/**
 * feedbackAnalysisService — tier resolution and the no-throw guarantee.
 *
 * Three tiers, in order: VS Code's Language Model API (feature-detected, so it
 * simply is not there on the 1.85 host this extension targets), an
 * OpenAI-compatible endpoint, and nothing. `feedback.aiAssist` gates all of
 * them, and every failure path has to degrade to "no analysis" rather than
 * failing the report — the dialog must stay usable with no model at all.
 *
 * `fetch` is injected through the service's optional dependency parameter, so
 * nothing here can reach the network even if a stub is forgotten.
 *
 * Consent: a declined prompt is remembered in a module-level flag that no test
 * can reset, so the declining test runs LAST in this file. Every other test
 * seeds `globalState` instead of clicking through the modal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  FEEDBACK_AI_ASSIST_SETTING,
  FEEDBACK_AI_CONSENT_KEY,
  FEEDBACK_API_KEY_SECRET,
  FEEDBACK_ENDPOINT_SETTING,
  FEEDBACK_MODEL_SETTING,
  analysisProviderLabel,
  analyzeFeedback,
  clearFeedbackApiKey,
  clearKnownIssueCache,
  resolveAnalysisTier,
  setFeedbackApiKey,
  type AnalysisFetch,
} from '../../src/services/feedbackAnalysisService';

type Context = import('vscode').ExtensionContext;

/**
 * A context whose consent is already granted, unless a test says otherwise.
 *
 * Consent is stored as the destination it was given for, so the seed names the
 * host the endpoint tests use; a language-model test passes `'Copilot'`.
 */
function makeContext(options: { consented?: boolean; consentTarget?: string } = {}): Context {
  const context = vscode.createMockExtensionContext({
    storageRoot: path.join(os.tmpdir(), 'erd-analysis'),
    extensionRoot: path.resolve(__dirname, '../..'),
    globalStateSeed:
      options.consented === false
        ? []
        : [[FEEDBACK_AI_CONSENT_KEY, options.consentTarget ?? 'api.example.com']],
  });
  return context as unknown as Context;
}

/** Turn the master switch on; without it every tier is `'none'`. */
function enableAiAssist(): void {
  vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
}

/** Configure the endpoint tier's two settings. */
function configureEndpoint(base = 'https://api.example.com/v1', model = 'gpt-test'): void {
  vscode._setMockConfiguration('erdStudio', FEEDBACK_ENDPOINT_SETTING, { globalValue: base });
  vscode._setMockConfiguration('erdStudio', FEEDBACK_MODEL_SETTING, { globalValue: model });
}

/** A fetch that answers the issue list with `[]` and the endpoint with `body`. */
function fakeFetch(body: unknown, ok = true): AnalysisFetch {
  return vi.fn(async (url: string) => ({
    ok,
    status: ok ? 200 : 500,
    text: async () => (url.includes('api.github.com') ? '[]' : JSON.stringify(body)),
  }));
}

const REPLY = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          kind: 'bug',
          confidence: 0.8,
          title: 'Edge vanished',
          context: '',
          reasons: {},
          duplicates: [],
        }),
      },
    },
  ],
};

beforeEach(() => {
  vscode._resetMockConfiguration();
  vscode._resetMockLanguageModels();
  clearKnownIssueCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vscode._resetMockLanguageModels();
});

describe('resolveAnalysisTier', () => {
  it('is "none" while feedback.aiAssist is off, however well configured everything else is', async () => {
    const context = makeContext();
    configureEndpoint();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);

    expect(await resolveAnalysisTier(context)).toBe('none');
    expect(await analysisProviderLabel(context)).toBeNull();
  });

  it('is "none" on a host with no language model and nothing configured', async () => {
    enableAiAssist();
    expect(await resolveAnalysisTier(makeContext())).toBe('none');
  });

  it('prefers the language model when the host offers one', async () => {
    enableAiAssist();
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    const context = makeContext();
    configureEndpoint();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    expect(await resolveAnalysisTier(context)).toBe('languageModel');
    expect(await analysisProviderLabel(context)).toBe('Copilot');
  });

  it('ignores a language-model namespace that offers no models', async () => {
    enableAiAssist();
    vscode._setMockLanguageModels([]);
    expect(await resolveAnalysisTier(makeContext())).toBe('none');
  });

  it('falls back to the endpoint when there is no language model', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    expect(await resolveAnalysisTier(context)).toBe('endpoint');
    // The label names the host the text actually goes to, not a product name.
    expect(await analysisProviderLabel(context)).toBe('api.example.com');
  });

  it('is "none" with an endpoint but no stored key — a key is never read from settings', async () => {
    enableAiAssist();
    configureEndpoint();
    expect(await resolveAnalysisTier(makeContext())).toBe('none');
  });

  it('is "none" with a key but no model id', async () => {
    enableAiAssist();
    configureEndpoint('https://api.example.com/v1', '');
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    expect(await resolveAnalysisTier(context)).toBe('none');
  });
});

describe('where the key is allowed to go', () => {
  /** Everything except the endpoint URL, which each case sets for itself. */
  async function configuredContext(): Promise<Context> {
    enableAiAssist();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_MODEL_SETTING, { globalValue: 'gpt-test' });
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    return context;
  }

  it('ignores an endpoint a workspace tries to set — a repo cannot redirect the key', async () => {
    const context = await configuredContext();
    // What a checked-in .vscode/settings.json would produce.
    vscode._setMockConfiguration('erdStudio', FEEDBACK_ENDPOINT_SETTING, {
      workspaceValue: 'https://evil.example/v1',
    });

    expect(await resolveAnalysisTier(context)).toBe('none');
  });

  it('ignores a workspace attempt to switch the master toggle on', async () => {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { workspaceValue: true });
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    expect(await resolveAnalysisTier(context)).toBe('none');
  });

  it('refuses a plaintext remote endpoint rather than putting the key on the wire', async () => {
    const context = await configuredContext();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_ENDPOINT_SETTING, {
      globalValue: 'http://169.254.169.254/latest',
    });

    expect(await resolveAnalysisTier(context)).toBe('none');
  });

  it('refuses a scheme that is not http(s) at all', async () => {
    const context = await configuredContext();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_ENDPOINT_SETTING, {
      globalValue: 'file:///etc/passwd',
    });

    expect(await resolveAnalysisTier(context)).toBe('none');
  });

  it('still allows plain http on loopback, where a local model server lives', async () => {
    const context = await configuredContext();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_ENDPOINT_SETTING, {
      globalValue: 'http://localhost:11434/v1',
    });

    expect(await resolveAnalysisTier(context)).toBe('endpoint');
    expect(await analysisProviderLabel(context)).toBe('localhost:11434');
  });
});

describe('analyzeFeedback', () => {
  const request = { kind: 'bug' as const, description: 'Renamed a model and the edge vanished.' };

  it('returns no analysis and no error when no tier is configured', async () => {
    const fetch = vi.fn();
    const result = await analyzeFeedback(makeContext(), request, { fetch });
    expect(result).toEqual({ analysis: null });
    // Benign, so nothing is fetched and the panel shows its idle prose.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to <endpoint>/chat/completions with a bearer key and parses the reply', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(context, request, { fetch });

    expect(result.analysis?.title).toBe('Edge vanished');
    expect(result.error).toBeUndefined();
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe('https://api.example.com/v1/chat/completions');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content).toContain('Renamed a model and the edge vanished.');
  });

  it('streams the language model tier\'s reply back through the same parser', async () => {
    enableAiAssist();
    vscode._setMockLanguageModels([
      { id: 'gpt-4o', name: 'GPT-4o', reply: REPLY.choices[0].message.content },
    ]);

    const result = await analyzeFeedback(
      makeContext({ consentTarget: 'Copilot' }),
      request,
      { fetch: fakeFetch({}) },
    );
    expect(result.analysis?.title).toBe('Edge vanished');
  });

  it('degrades to a short sentence, never a throw, when the transport rejects', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch: AnalysisFetch = vi.fn(async (url: string) => {
      if (url.includes('api.github.com')) return { ok: true, status: 200, text: async () => '[]' };
      throw new Error('ECONNREFUSED');
    });

    const result = await analyzeFeedback(context, request, { fetch });

    expect(result.analysis).toBeNull();
    expect(result.error).toBe('The analysis could not be completed.');
  });

  it('degrades when the endpoint answers with an HTTP error', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch: AnalysisFetch = vi.fn(async (url: string) =>
      url.includes('api.github.com')
        ? { ok: true, status: 200, text: async () => '[]' }
        : { ok: false, status: 503, text: async () => '' },
    );

    const result = await analyzeFeedback(context, request, { fetch });
    expect(result).toEqual({ analysis: null, error: 'The analysis could not be completed.' });
  });

  it('says the reply could not be read when it is not JSON', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    const result = await analyzeFeedback(
      context,
      request,
      { fetch: fakeFetch({ choices: [{ message: { content: 'I am not sure.' } }] }) },
    );

    expect(result).toEqual({ analysis: null, error: 'The analysis reply could not be read.' });
  });

  it('still analyses when the issue list cannot be fetched — there are simply no duplicates', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch: AnalysisFetch = vi.fn(async (url: string) =>
      url.includes('api.github.com')
        ? { ok: false, status: 403, text: async () => '' }
        : { ok: true, status: 200, text: async () => JSON.stringify(REPLY) },
    );

    const result = await analyzeFeedback(context, request, { fetch });
    expect(result.analysis?.duplicates).toEqual([]);
  });
});

describe('the API key commands', () => {
  it('stores a trimmed key and clears it again', async () => {
    const context = makeContext();
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('  sk-typed  ');
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await setFeedbackApiKey(context);
    expect(await context.secrets.get(FEEDBACK_API_KEY_SECRET)).toBe('sk-typed');

    await clearFeedbackApiKey(context);
    expect(await context.secrets.get(FEEDBACK_API_KEY_SECRET)).toBeUndefined();
  });

  it('stores nothing when the input box is cancelled or left blank', async () => {
    const context = makeContext();
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

    await setFeedbackApiKey(context);
    expect(await context.secrets.get(FEEDBACK_API_KEY_SECRET)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    input.mockResolvedValue('   ');
    await setFeedbackApiKey(context);
    expect(await context.secrets.get(FEEDBACK_API_KEY_SECRET)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no API key'));
  });
});

// A declined prompt is remembered for the life of the module, so this must be
// the last test in the file — anything after it would silently get "declined".
describe('consent (runs last: declining is remembered for the session)', () => {
  it('asks once, naming the real destination, and behaves like the no-model path when declined', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext({ consented: false });
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not now');
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );

    expect(result).toEqual({ analysis: null });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('api.example.com');
    expect(info.mock.calls[0]).toContain('Enable AI assist');
    expect(info.mock.calls[0]).toContain('Not now');
    // Declining is not a failure — nothing is reported to the dialog.
    expect(result.error).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks again when the endpoint changes — a yes is about one destination', async () => {
    enableAiAssist();
    // Consent was given for api.example.com; the endpoint now points elsewhere.
    configureEndpoint('https://other.example/v1');
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Not now');
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );

    expect(result).toEqual({ analysis: null });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('other.example');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('known-issue cache', () => {
  /** Answers GitHub with a real issue and the endpoint with a valid reply. */
  function fetchWithIssues(): AnalysisFetch {
    return vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('api.github.com')
          ? JSON.stringify([
              { number: 212, title: 'Edge vanishes on rename', state: 'open', html_url: 'u' },
            ])
          : JSON.stringify(REPLY),
    }));
  }

  const request = { kind: 'bug' as const, description: 'Renamed a column and the edge vanished.' };

  const githubCalls = (fetch: AnalysisFetch): number =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('api.github.com'),
    ).length;

  it('fetches the issue list once across repeated analyses', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch = fetchWithIssues();

    // The dialog re-analyses on a debounce; three runs must not be three requests.
    await analyzeFeedback(context, request, { fetch });
    await analyzeFeedback(context, request, { fetch });
    await analyzeFeedback(context, request, { fetch });

    expect(githubCalls(fetch)).toBe(1);
  });

  it('shares one request between analyses that overlap', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch = fetchWithIssues();

    await Promise.all([
      analyzeFeedback(context, request, { fetch }),
      analyzeFeedback(context, request, { fetch }),
    ]);

    expect(githubCalls(fetch)).toBe(1);
  });

  it('does not cache an empty list, so a rate-limited call is retried', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    // `[]` is what an exhausted rate limit looks like — caching it would hide
    // every duplicate for the next ten minutes.
    const fetch = fakeFetch(REPLY);

    await analyzeFeedback(context, request, { fetch });
    await analyzeFeedback(context, request, { fetch });

    expect(githubCalls(fetch)).toBe(2);
  });

  it('clearKnownIssueCache forces the next analysis to refetch', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');
    const fetch = fetchWithIssues();

    await analyzeFeedback(context, request, { fetch });
    clearKnownIssueCache();
    await analyzeFeedback(context, request, { fetch });

    expect(githubCalls(fetch)).toBe(2);
  });
});
