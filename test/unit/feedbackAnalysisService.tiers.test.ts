/**
 * feedbackAnalysisService — tier resolution and the no-throw guarantee.
 *
 * Four tiers, in order: VS Code's Language Model API (feature-detected, so it
 * simply is not there on the 1.85 host this extension targets), an
 * OpenAI-compatible endpoint the user configured, the author's hosted proxy,
 * and nothing. `feedback.aiAssist` gates all of them, and every failure path
 * has to degrade to "no analysis" rather than failing the report — the dialog
 * must stay usable with no model at all.
 *
 * `feedback.aiAssist` now defaults to **on**, so the tests that are about the
 * switch set it explicitly rather than leaning on the default.
 *
 * The hosted tier's endpoint is a build-time constant that ships empty, so
 * these tests install one through `setHostedAnalysisTargetForTests` and clear
 * it again in `afterEach` — a leaked override would give every later test a
 * tier it never asked for.
 *
 * `fetch` is injected through the service's optional dependency parameter, so
 * nothing here can reach the network even if a stub is forgotten.
 *
 * Consent: a declined prompt is remembered in a module-level flag that no test
 * can reset, so the declining tests run LAST in this file. Every other test
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
  FEEDBACK_HOSTED_FALLBACK_SETTING,
  FEEDBACK_LM_PRIMED_KEY,
  FEEDBACK_MODEL_SETTING,
  HOSTED_ANALYSIS_ENDPOINT,
  HOSTED_ANALYSIS_PROVIDER,
  analysisNeedsPriming,
  analysisProviderLabel,
  analyzeFeedback,
  clearFeedbackApiKey,
  clearKnownIssueCache,
  resolveAnalysisTier,
  setFeedbackApiKey,
  setHostedAnalysisTargetForTests,
  type AnalysisFetch,
} from '../../src/services/feedbackAnalysisService';

type Context = import('vscode').ExtensionContext;

/**
 * A context whose consent is already granted, unless a test says otherwise.
 *
 * Consent is stored as the destination it was given for, so the seed names the
 * host the endpoint tests use; a language-model test passes `'Copilot'`.
 */
function makeContext(
  options: { consented?: boolean; consentTarget?: string; primed?: boolean } = {},
): Context {
  const seed: Array<[string, unknown]> =
    options.consented === false
      ? []
      : [[FEEDBACK_AI_CONSENT_KEY, options.consentTarget ?? 'api.example.com']];
  // Tier 1 asks for one user-initiated run before the debounce may use it;
  // `primed: true` is the machine where that has already happened.
  if (options.primed) seed.push([FEEDBACK_LM_PRIMED_KEY, true]);
  const context = vscode.createMockExtensionContext({
    storageRoot: path.join(os.tmpdir(), 'erd-analysis'),
    extensionRoot: path.resolve(__dirname, '../..'),
    globalStateSeed: seed,
  });
  return context as unknown as Context;
}

/** Turn the master switch explicitly off — it now defaults to on. */
function disableAiAssist(): void {
  vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: false });
}

/**
 * Pretend the build shipped a hosted proxy. Cleared again in `afterEach`.
 *
 * `provider` is the third party the relay forwards to, and it is part of the
 * gate as well as the copy — a build that names an endpoint but no provider
 * has no disclosure to consent to, so the tier stays off.
 */
function configureHosted(
  endpoint = 'https://feedback.erd.example',
  model = 'fixture-model',
  provider = 'DeepSeek',
): void {
  setHostedAnalysisTargetForTests({ endpoint, model, provider });
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
  // Start every test with NO hosted tier, whatever the shipped build points at.
  // Falling through to the real constant would make these assertions change
  // meaning the day the service goes live — which is exactly what happened.
  // A test that wants the tier calls configureHosted().
  setHostedAnalysisTargetForTests({ endpoint: '', model: '', provider: '' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vscode._resetMockLanguageModels();
  setHostedAnalysisTargetForTests(null);
});

describe('resolveAnalysisTier', () => {
  it('is "none" while feedback.aiAssist is off, however well configured everything else is', async () => {
    disableAiAssist();
    const context = makeContext();
    configureEndpoint();
    configureHosted();
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

describe('the hosted last resort', () => {
  it('does not exist when the build compiled in no endpoint', async () => {
    // The behaviour, not the shipped value: an empty endpoint means no tier, so
    // a build that has not deployed a proxy yet behaves exactly as it did with
    // three tiers. `beforeEach` has already cleared the target.
    enableAiAssist();
    expect(await resolveAnalysisTier(makeContext())).toBe('none');
  });

  it('ships an endpoint and a provider together, or neither', () => {
    // The disclosure invariant, checked against what this build actually ships:
    // an endpoint with no named recipient cannot be consented to honestly, and
    // resolveAnalysisTier() would silently drop to 'none' rather than send.
    const endpoint = HOSTED_ANALYSIS_ENDPOINT.trim();
    const provider = HOSTED_ANALYSIS_PROVIDER.trim();
    expect(Boolean(endpoint)).toBe(Boolean(provider));
    if (endpoint) {
      // Only https reaches a real user; loopback is for `wrangler dev`.
      expect(endpoint.startsWith('https://')).toBe(true);
      expect(endpoint.endsWith('/chat/completions')).toBe(false);
    }
  });

  it('is used when the user has neither a language model nor an endpoint', async () => {
    enableAiAssist();
    configureHosted();
    const context = makeContext();

    expect(await resolveAnalysisTier(context)).toBe('hosted');
    // The label names both parties: the relay the text is posted to and the
    // provider that actually reads it. Naming only the relay would let the
    // panel re-establish the impression the consent modal exists to correct.
    expect(await analysisProviderLabel(context)).toBe('feedback.erd.example \u2192 DeepSeek');
  });

  it('stays off when the build named an endpoint but no provider', async () => {
    // An endpoint without a named recipient cannot be disclosed honestly, so
    // the invariant is enforced in the resolver rather than left to the copy.
    enableAiAssist();
    setHostedAnalysisTargetForTests({
      endpoint: 'https://feedback.erd.example',
      model: 'fixture-model',
      provider: '   ',
    });
    const context = makeContext();

    // (What this build itself ships is pinned separately, above.)
    expect(await resolveAnalysisTier(context)).toBe('none');
    expect(await analysisProviderLabel(context)).toBeNull();
  });

  it('loses to the user\'s own endpoint', async () => {
    enableAiAssist();
    configureHosted();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    expect(await resolveAnalysisTier(context)).toBe('endpoint');
  });

  it('loses to the user\'s own language model', async () => {
    enableAiAssist();
    configureHosted();
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);

    expect(await resolveAnalysisTier(makeContext())).toBe('languageModel');
  });

  it('is removed entirely by feedback.hostedFallback: false', async () => {
    enableAiAssist();
    configureHosted();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_HOSTED_FALLBACK_SETTING, {
      globalValue: false,
    });
    const context = makeContext();

    expect(await resolveAnalysisTier(context)).toBe('none');
    expect(await analysisProviderLabel(context)).toBeNull();
  });

  it('ignores a workspace attempt to switch the hosted tier off or on', async () => {
    enableAiAssist();
    configureHosted();
    // A repo cannot decide where a user's feedback goes, in either direction.
    vscode._setMockConfiguration('erdStudio', FEEDBACK_HOSTED_FALLBACK_SETTING, {
      workspaceValue: false,
    });

    expect(await resolveAnalysisTier(makeContext())).toBe('hosted');
  });

  it('refuses a plaintext remote hosted endpoint, exactly as it refuses a configured one', async () => {
    enableAiAssist();
    configureHosted('http://feedback.erd.example');

    expect(await resolveAnalysisTier(makeContext())).toBe('none');
  });

  it('posts the same OpenAI-compatible body with no Authorization header', async () => {
    enableAiAssist();
    configureHosted();
    // Consent for this destination has already been given.
    const context = makeContext({ consentTarget: 'feedback.erd.example|DeepSeek' });
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );

    expect(result.analysis?.title).toBe('Edge vanished');
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[0]).toBe('https://feedback.erd.example/chat/completions');
    expect(call[1].method).toBe('POST');
    // The proxy holds the key; a client that sent one would be sending the
    // user's, to somebody else's server.
    expect(call[1].headers.Authorization).toBeUndefined();
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('fixture-model');
    expect(body.messages[1].content).toContain('Renamed a model and the edge vanished.');
  });
});

describe('priming the user\'s own language model', () => {
  const request = { kind: 'bug' as const, description: 'Renamed a model and the edge vanished.' };

  /** A host offering one model, with tier 1 therefore resolved. */
  function withLanguageModel(reply: string | { error: unknown }): void {
    enableAiAssist();
    vscode._setMockLanguageModels([
      typeof reply === 'string'
        ? { id: 'gpt-4o', name: 'GPT-4o', reply }
        : { id: 'gpt-4o', name: 'GPT-4o', reply: '', error: reply.error },
    ]);
  }

  it('needs priming for the language model until one request has succeeded', () => {
    expect(analysisNeedsPriming(makeContext(), 'languageModel')).toBe(true);
    expect(analysisNeedsPriming(makeContext({ primed: true }), 'languageModel')).toBe(false);
  });

  it('never needs priming for a tier whose consent is our own modal', () => {
    const context = makeContext();
    expect(analysisNeedsPriming(context, 'endpoint')).toBe(false);
    expect(analysisNeedsPriming(context, 'hosted')).toBe(false);
    expect(analysisNeedsPriming(context, 'none')).toBe(false);
  });

  it('declines a debounced first request rather than raising VS Code\'s dialog out of the blue', async () => {
    withLanguageModel(REPLY.choices[0].message.content);
    const context = makeContext();

    const result = await analyzeFeedback(context, request, { fetch: fakeFetch({}) });

    // Benign: the dialog is showing its button and waiting to be pressed.
    expect(result).toEqual({ analysis: null });
    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBeUndefined();
  });

  it('runs the same request when the user asks for it, and primes the machine', async () => {
    withLanguageModel(REPLY.choices[0].message.content);
    const context = makeContext();

    const result = await analyzeFeedback(
      context,
      { ...request, userInitiated: true },
      { fetch: fakeFetch({}) },
    );

    expect(result.analysis?.title).toBe('Edge vanished');
    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBe(true);

    // From here on the debounce needs no button.
    const again = await analyzeFeedback(context, request, { fetch: fakeFetch({}) });
    expect(again.analysis?.title).toBe('Edge vanished');
  });

  it('does not prime when the request fails — a dismissed dialog brings the button back', async () => {
    withLanguageModel({ error: new Error('User denied access to the language model.') });
    const context = makeContext();

    const result = await analyzeFeedback(
      context,
      { ...request, userInitiated: true },
      { fetch: fakeFetch({}) },
    );

    expect(result.analysis).toBeNull();
    expect(result.error).toBe('The analysis could not be completed.');
    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBeUndefined();
    // And the next debounced run is still declined rather than firing.
    expect(analysisNeedsPriming(context, 'languageModel')).toBe(true);
  });

  it('does not prime a machine whose analysis came from another tier', async () => {
    enableAiAssist();
    configureEndpoint();
    const context = makeContext();
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, 'sk-test');

    await analyzeFeedback(context, request, { fetch: fakeFetch(REPLY) });

    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBeUndefined();
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

  it('ignores a workspace attempt to switch the master toggle, either way', async () => {
    // The user has turned it off in their own settings; a checked-in
    // .vscode/settings.json says otherwise and is not listened to.
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, {
      globalValue: false,
      workspaceValue: true,
    });
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
      makeContext({ primed: true }),
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
  it('shows no modal of our own for the user\'s own model — VS Code owns that dialog', async () => {
    enableAiAssist();
    vscode._setMockLanguageModels([
      { id: 'gpt-4o', name: 'GPT-4o', reply: REPLY.choices[0].message.content },
    ]);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    // No consent seeded at all: tier 1 must not need one.
    const context = makeContext({ consented: false });

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.', userInitiated: true },
      { fetch: fakeFetch({}) },
    );

    expect(result.analysis?.title).toBe('Edge vanished');
    // A second question in front of VS Code's own is noise, not safety.
    expect(info).not.toHaveBeenCalled();
  });

  it('always asks for the hosted service, naming the host and whose it is', async () => {
    enableAiAssist();
    configureHosted();
    const context = makeContext({ consented: false });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Use it');
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );

    expect(info).toHaveBeenCalledTimes(1);
    const [message, options, ...buttons] = info.mock.calls[0];
    expect(options).toEqual({ modal: true });
    expect(message).toContain('feedback.erd.example');
    expect(message).toContain('a relay run by the extension author');
    // The onward recipient is the disclosure that matters: the author's Worker
    // holds the key and forwards the prose to a third party under that party's
    // terms. A consent given about the relay alone would not cover them.
    expect(message).toContain('which forwards it to DeepSeek');
    expect(message).toContain('third-party AI provider');
    expect(message).toContain('Only what you typed is sent');
    expect(message).toContain('You can turn this off in settings.');
    expect(buttons).toEqual(['Use it', 'No thanks']);
    expect(result.analysis?.title).toBe('Edge vanished');

    // Accepting is remembered against that host, so it is asked once.
    const again = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(again.analysis?.title).toBe('Edge vanished');
  });

  it('asks again when the relay starts forwarding to a different provider', async () => {
    // Consent belongs to the disclosure it was given against, not to the
    // hostname: a changed processor is a changed question.
    enableAiAssist();
    configureHosted('https://switched.erd.example');
    const context = makeContext({ consentTarget: 'switched.erd.example|DeepSeek' });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Use it');
    const fetch = fakeFetch(REPLY);
    const request = { kind: 'bug' as const, description: 'Renamed a model and the edge vanished.' };

    await analyzeFeedback(context, request, { fetch });
    expect(info).not.toHaveBeenCalled();

    configureHosted('https://switched.erd.example', 'fixture-model', 'SomeOtherAI');
    await analyzeFeedback(context, request, { fetch });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('which forwards it to SomeOtherAI');
  });

  it('sends nothing to the hosted service when the answer is "No thanks"', async () => {
    enableAiAssist();
    // A host of its own, so this decline cannot leak into another test's tier.
    configureHosted('https://declined.erd.example');
    const context = makeContext({ consented: false });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('No thanks');
    const fetch = fakeFetch(REPLY);

    const result = await analyzeFeedback(
      context,
      { kind: 'bug', description: 'Renamed a model and the edge vanished.' },
      { fetch },
    );

    expect(result).toEqual({ analysis: null });
    expect(info).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

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
