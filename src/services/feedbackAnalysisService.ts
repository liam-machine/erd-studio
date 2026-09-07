/**
 * FeedbackAnalysisService — the single optional AI call behind the Feedback dialog.
 *
 * One request returns a classification (bug vs feature), a suggested title, the
 * steps/rationale pulled out of the user's prose, one sentence per unmet
 * readiness check, and a ranked list of issues that might already cover the
 * report. Every one of those is a *suggestion*: the dialog stays fully usable
 * with no model at all, and nothing here ever blocks or fails a report.
 *
 * Three tiers, tried in order:
 *   1. VS Code's Language Model API — feature-detected at runtime through
 *      `getLanguageModelApi()`, because `engines.vscode` stays at ^1.85.0 and
 *      `vscode.lm` does not exist in `@types/vscode` 1.85.0. On an older host
 *      the tier simply is not there.
 *   2. An OpenAI-compatible chat-completions endpoint reached with the Node
 *      global `fetch` — base URL and model id from settings, API key from
 *      `context.secrets`, never from settings.json.
 *   3. Nothing configured — `resolveAnalysisTier()` returns `'none'` and the
 *      dialog renders no AI panel at all.
 *
 * Privacy: only what the user typed and the public issue list reach the model.
 * `buildAnalysisPrompt()` deliberately takes no `Diagnostics` parameter, so
 * versions, file paths and dbt model names cannot be routed into a request.
 *
 * The pure helpers at the top have no VS Code dependency so they are
 * unit-testable; the VS Code-facing functions live at the bottom of the file.
 */

import * as vscode from 'vscode';

import { getErdStudioSetting } from './configService';
import { GITHUB_REPO, hostErrorLog } from './feedbackService';
import {
  isFeedbackKind,
  type FeedbackAnalysis,
  type FeedbackAnalysisReasons,
  type FeedbackKind,
  type DuplicateCandidate,
} from '../types/feedback';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Secret storage key for the custom-endpoint API key. */
export const FEEDBACK_API_KEY_SECRET = 'erdStudio.feedback.apiKey';

/**
 * globalState key recording which destination the user consented to.
 *
 * The value is the destination itself (`"Copilot"`, or the endpoint's host) —
 * not a boolean. Consent is a decision about *where* the text goes, so it
 * cannot be inherited by a different endpoint; a changed destination asks
 * again. A value stored by an older build (the boolean `true`) is not a host
 * and therefore re-prompts once, which is the correct side to fail on.
 */
export const FEEDBACK_AI_CONSENT_KEY = 'erdStudio.feedback.aiConsent';

/** Master off switch. Boolean, default false. */
export const FEEDBACK_AI_ASSIST_SETTING = 'feedback.aiAssist';

/** Base URL of an OpenAI-compatible chat-completions API. String, default ''. */
export const FEEDBACK_ENDPOINT_SETTING = 'feedback.endpoint';

/** Model id sent to the endpoint. String, default ''. */
export const FEEDBACK_MODEL_SETTING = 'feedback.model';

/** Timeout for one analysis request. */
export const ANALYSIS_TIMEOUT_MS = 20_000;

/** Unauthenticated issue list the duplicate check is hydrated from. */
const ISSUE_LIST_URL =
  `https://api.github.com/repos/${GITHUB_REPO}/issues?state=all&per_page=50&sort=updated`;

/** How much of an issue body is worth showing the model. */
const ISSUE_BODY_CHARS = 400;

/**
 * How long a fetched issue list is reused for.
 *
 * The dialog re-analyses on an 850 ms debounce, so one report can easily
 * trigger several runs. GitHub allows 60 unauthenticated requests an hour per
 * IP, and an exhausted budget returns an empty list — which reads to the user
 * as "nothing similar has been reported" rather than as a failure. Reusing the
 * list turns a whole editing session into one request.
 */
export const ISSUE_CACHE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal issue shape the prompt is built from and duplicates are hydrated from. */
export interface AnalysisIssueSummary {
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned';
  comments?: number;
  /** True when the issue has an assignee ("being worked on"). */
  assigned?: boolean;
  /** Version the fix shipped in, from a milestone or a `shipped-in:` label. */
  fixedIn?: string;
  /** Maintainer's closing reasoning, when the body states one outright. */
  closingNote?: string;
  url: string;
}

/** Which tier would be used, without performing any network or auth work. */
export type AnalysisTier = 'languageModel' | 'endpoint' | 'none';

/**
 * The bit of a `fetch` response this service reads. Declared structurally so
 * the file needs no DOM lib (it is type-checked by the mcp-server job too).
 */
export interface AnalysisFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The bit of `fetch` this service calls. Injectable so tests stub no globals. */
export type AnalysisFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
) => Promise<AnalysisFetchResponse>;

/** Injectable dependencies. Everything defaults to the real runtime. */
export interface AnalysisDependencies {
  /** Defaults to the Node 20 global `fetch`. */
  fetch?: AnalysisFetch;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * What the model is asked to produce. Deliberately model-agnostic prose — the
 * same string is sent to a Copilot chat model and to an OpenAI-compatible
 * endpoint, so it may not lean on any one vendor's tool or schema syntax.
 */
export const ANALYSIS_SYSTEM_PROMPT = [
  'You triage feedback that a user is about to file against an open-source editor extension.',
  'Reply with a single JSON object and nothing else — no prose, no code fence.',
  '',
  'The object has exactly these keys:',
  '  "kind"        — "bug" or "feature".',
  '  "confidence"  — a number from 0 to 1: how sure you are of "kind".',
  '  "title"       — a short issue title in plain language, no trailing full stop.',
  '  "context"     — the steps to reproduce (for a bug) or the rationale (for a',
  '                  feature), drawn only from what the user wrote. Empty string',
  '                  when they gave none.',
  '  "reasons"     — an object with "desc", "ctx" and "image": one short sentence',
  '                  each, written to the user, saying what is missing and why it',
  '                  would help. Use null for anything already covered.',
  '  "duplicates"  — an array of { "number", "match", "why" } for existing issues',
  '                  that may already cover this report. "number" must be one of',
  '                  the numbers in the issue list. "match" runs 0 to 1, where 0.7',
  '                  or more means "this is the same report". "why" is one sentence.',
  '                  An empty array is the right answer when nothing matches.',
  '',
  'Rules:',
  '- Use only the text you are given. Never invent behaviour, versions or issues.',
  '- Only "number", "match" and "why" are read from each duplicate; do not restate',
  '  an issue\'s title, state or status, and never cite a number that is not listed.',
  '- Prefer no duplicate over a doubtful one: wrongly telling someone their problem',
  '  is already reported talks them out of a real report.',
].join('\n');

/**
 * Build the single user prompt.
 *
 * Only the description, the context field and the public issue list reach the
 * model. There is no `Diagnostics` parameter by design — versions, file paths
 * and model names from a possibly private dbt project are never sent.
 */
export function buildAnalysisPrompt(input: {
  kind: FeedbackKind;
  description: string;
  context?: string;
  issues: readonly AnalysisIssueSummary[];
}): string {
  const parts: string[] = [
    `The user is filing this as a ${input.kind === 'bug' ? 'bug' : 'feature request'}, ` +
      'but decide for yourself from what they wrote.',
    '',
    '--- what they wrote ---',
    input.description.trim(),
  ];

  const context = input.context?.trim();
  if (context) {
    parts.push(
      '',
      input.kind === 'bug' ? '--- steps they gave ---' : '--- why they want it ---',
      context,
    );
  }

  parts.push('', '--- existing issues ---');
  if (input.issues.length === 0) {
    parts.push('(none available)');
  } else {
    for (const issue of input.issues) {
      parts.push(`#${issue.number} [${describeIssueState(issue)}] ${issue.title}`);
      const body = issue.body?.replace(/\s+/g, ' ').trim();
      if (body) parts.push(`    ${body.slice(0, ISSUE_BODY_CHARS)}`);
    }
  }

  return parts.join('\n');
}

/** Short state label for an issue line in the prompt. */
function describeIssueState(issue: AnalysisIssueSummary): string {
  if (issue.state === 'open') return 'open';
  if (issue.stateReason === 'not_planned') return 'closed · not planned';
  return 'closed · done';
}

/**
 * Parse the model's reply into a {@link FeedbackAnalysis}. Tolerates a ```json
 * fence and leading prose.
 *
 * Duplicates are **hydrated, never trusted**: only `number`, `match` and `why`
 * are taken from the model, and every other field — title, state, stateReason,
 * comments, assigned, fixedIn, closingNote, url — is copied from the matching
 * entry in `knownIssues`. A candidate whose number is not in that list is
 * dropped. A hallucinated `stateReason: 'completed'` would otherwise tell a
 * user to update their extension for a bug that is still open, which is the
 * single worst thing this feature could do.
 *
 * Returns null when no JSON object could be recovered.
 */
export function parseAnalysisResponse(
  raw: string,
  fallbackKind: FeedbackKind,
  knownIssues: readonly AnalysisIssueSummary[],
): FeedbackAnalysis | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;

  const byNumber = new Map<number, AnalysisIssueSummary>();
  for (const issue of knownIssues) byNumber.set(issue.number, issue);

  const duplicates: DuplicateCandidate[] = [];
  const seen = new Set<number>();
  for (const entry of asArray(parsed.duplicates)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const number = asInteger(record.number);
    if (number === null || seen.has(number)) continue;
    const issue = byNumber.get(number);
    if (!issue) continue;
    seen.add(number);
    duplicates.push(hydrateDuplicate(issue, clamp01(record.match), asString(record.why)));
  }
  duplicates.sort((a, b) => b.match - a.match || a.number - b.number);

  const reasonsSource = (
    typeof parsed.reasons === 'object' && parsed.reasons !== null ? parsed.reasons : {}
  ) as Record<string, unknown>;
  const reasons: FeedbackAnalysisReasons = {
    desc: asOptionalString(reasonsSource.desc),
    ctx: asOptionalString(reasonsSource.ctx),
    image: asOptionalString(reasonsSource.image),
  };

  return {
    kind: isFeedbackKind(parsed.kind) ? parsed.kind : fallbackKind,
    confidence: clamp01(parsed.confidence),
    title: asString(parsed.title),
    context: asString(parsed.context),
    reasons,
    duplicates,
  };
}

/** Build a candidate from the *known* issue, keeping only the model's judgement. */
function hydrateDuplicate(
  issue: AnalysisIssueSummary,
  match: number,
  why: string,
): DuplicateCandidate {
  const candidate: DuplicateCandidate = {
    number: issue.number,
    title: issue.title,
    match,
    why,
    state: issue.state,
    url: issue.url,
  };
  if (issue.stateReason !== undefined) candidate.stateReason = issue.stateReason;
  if (issue.comments !== undefined) candidate.comments = issue.comments;
  if (issue.assigned !== undefined) candidate.assigned = issue.assigned;
  if (issue.fixedIn !== undefined) candidate.fixedIn = issue.fixedIn;
  if (issue.closingNote !== undefined) candidate.closingNote = issue.closingNote;
  return candidate;
}

/**
 * Recover the first JSON object in `raw`: the whole string, the contents of a
 * fenced block, or a brace-balanced run after leading prose.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const candidates: string[] = [];

  const trimmed = raw.trim();
  if (trimmed) candidates.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]?.trim()) candidates.push(fence[1].trim());

  candidates.push(...balancedObjects(raw));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Every top-level brace-balanced `{…}` run in `raw`, in order, ignoring braces
 * inside strings. All of them are offered as candidates rather than just the
 * first, because a model that prefaces its JSON with prose may well put braces
 * in that prose — and the object we want is then the second run, not the first.
 */
function balancedObjects(raw: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) found.push(raw.slice(start, i + 1));
    }
  }
  return found;
}

/** Coerce to a 0..1 number; anything unusable becomes 0. */
function clamp01(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** A finite integer, or null. */
function asInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

/** A trimmed string, or `''`. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A trimmed non-empty string, or null (the "nothing to say" reason). */
function asOptionalString(value: unknown): string | null {
  const text = asString(value);
  return text === '' ? null : text;
}

/** Anything iterable-ish as an array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Language Model feature detection
// ---------------------------------------------------------------------------

interface LmChatModelShim {
  readonly id?: string;
  readonly name?: string;
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: unknown,
  ): Promise<{ text: AsyncIterable<string> }>;
}

interface LmNamespaceShim {
  selectChatModels(selector?: { vendor?: string; family?: string }): Promise<LmChatModelShim[]>;
}

interface LmMessageCtorShim {
  User(content: string): unknown;
}

/**
 * `vscode.lm` if this host has it, else null.
 *
 * Written as a cast rather than a direct `vscode.lm` reference because the
 * namespace does not exist in `@types/vscode` 1.85.0 — naming it directly would
 * fail `npm run compile`, and calling it on a 1.85 host would throw.
 */
function getLanguageModelApi(): { lm: LmNamespaceShim; message: LmMessageCtorShim } | null {
  const api = vscode as unknown as {
    lm?: LmNamespaceShim;
    LanguageModelChatMessage?: LmMessageCtorShim;
  };
  if (!api.lm || typeof api.lm.selectChatModels !== 'function') return null;
  if (!api.LanguageModelChatMessage || typeof api.LanguageModelChatMessage.User !== 'function') {
    return null;
  }
  return { lm: api.lm, message: api.LanguageModelChatMessage };
}

// ---------------------------------------------------------------------------
// VS Code-facing helpers
// ---------------------------------------------------------------------------

/** Hostnames a plaintext `http:` endpoint is still allowed on (a local model server). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The last endpoint value rejected, so the log records each bad value once. */
let lastRejectedEndpoint: string | null = null;

/**
 * The configured endpoint base URL with any trailing slashes stripped, or `''`
 * when it is not somewhere a stored API key may be sent.
 *
 * Only `https:` is accepted, plus `http:` on a loopback host where a local
 * model server is the point. Anything else — a plaintext remote URL, a
 * `file:`/`data:` scheme, an unparseable string — resolves to `''`, which makes
 * the tier `'none'` and degrades the dialog exactly like an unconfigured one.
 */
function endpointBaseUrl(): string {
  const raw = getErdStudioSetting<string>(FEEDBACK_ENDPOINT_SETTING, '').trim().replace(/\/+$/, '');
  if (!raw) return '';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    rejectEndpoint(raw, 'not a URL');
    return '';
  }
  if (url.protocol === 'https:') return raw;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return raw;
  rejectEndpoint(raw, `${url.protocol}// is not allowed for a remote endpoint`);
  return '';
}

/** Record a refused endpoint once per distinct value — this runs on every keystroke. */
function rejectEndpoint(raw: string, why: string): void {
  if (lastRejectedEndpoint === raw) return;
  lastRejectedEndpoint = raw;
  hostErrorLog.record(
    'feedbackAnalysis.endpointUrl',
    `Ignoring ${FEEDBACK_ENDPOINT_SETTING} "${raw}": ${why}.`,
  );
}

/** The configured model id. */
function endpointModel(): string {
  return getErdStudioSetting<string>(FEEDBACK_MODEL_SETTING, '').trim();
}

/** Whether the user turned AI assist on at all. */
function aiAssistEnabled(): boolean {
  return getErdStudioSetting<boolean>(FEEDBACK_AI_ASSIST_SETTING, false) === true;
}

/** The stored API key, or `''`. Never throws. */
async function readApiKey(context: vscode.ExtensionContext): Promise<string> {
  try {
    return (await context.secrets.get(FEEDBACK_API_KEY_SECRET))?.trim() ?? '';
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.readApiKey', err);
    return '';
  }
}

/** True when this host offers at least one chat model. Never throws. */
async function hasLanguageModel(): Promise<boolean> {
  const api = getLanguageModelApi();
  if (!api) return false;
  try {
    const models = await api.lm.selectChatModels();
    return Array.isArray(models) && models.length > 0;
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.selectChatModels', err);
    return false;
  }
}

/**
 * Which tier is available right now. Returns `'none'` when `feedback.aiAssist`
 * is off, or when neither a language model nor an endpoint + model + key is
 * configured. Performs no network work and never prompts.
 */
export async function resolveAnalysisTier(
  context: vscode.ExtensionContext,
): Promise<AnalysisTier> {
  if (!aiAssistEnabled()) return 'none';
  if (await hasLanguageModel()) return 'languageModel';
  if (endpointBaseUrl() && endpointModel() && (await readApiKey(context))) return 'endpoint';
  return 'none';
}

/** Human label for the resolved tier ("Copilot", or the endpoint's hostname). */
export async function analysisProviderLabel(
  context: vscode.ExtensionContext,
): Promise<string | null> {
  const tier = await resolveAnalysisTier(context);
  if (tier === 'languageModel') return 'Copilot';
  if (tier === 'endpoint') return endpointHost();
  return null;
}

/** Hostname of the configured endpoint, falling back to the raw setting. */
function endpointHost(): string {
  const base = endpointBaseUrl();
  try {
    return new URL(base).host || base;
  } catch {
    return base;
  }
}

/**
 * The destination a consent applies to: the product name for VS Code's own
 * model, otherwise the host the request is actually posted to. Null when
 * nothing is configured.
 */
export function analysisConsentTarget(tier: AnalysisTier): string | null {
  if (tier === 'languageModel') return 'Copilot';
  if (tier === 'endpoint') return endpointHost() || null;
  return null;
}

/**
 * "Not now" answers, per destination, remembered for this session only. Consent
 * that is granted is persisted; consent that is declined is not, so the next
 * window asks again — which is what the "Not now" wording promises — while the
 * debounced typing in one dialog cannot re-prompt on every keystroke.
 */
const declinedThisSession = new Set<string>();

/**
 * Ask once, on first use, naming the actual destination host. Stores the
 * accepted destination under {@link FEEDBACK_AI_CONSENT_KEY}. Returns false
 * when the user declines; the caller then behaves exactly like the no-model
 * path.
 *
 * Consent is bound to the destination it was given for: pointing
 * `feedback.endpoint` somewhere else asks again rather than silently inheriting
 * a "yes" that was about a different host.
 */
export async function ensureAnalysisConsent(
  context: vscode.ExtensionContext,
  tier: AnalysisTier,
): Promise<boolean> {
  const host = analysisConsentTarget(tier);
  if (!host) return false;
  if (context.globalState.get<unknown>(FEEDBACK_AI_CONSENT_KEY) === host) return true;
  if (declinedThisSession.has(host)) return false;

  const choice = await vscode.window.showInformationMessage(
    `ERD Studio: send your feedback description to ${host} to draft a title, pick the type and ` +
      'look for duplicates? Only what you typed is sent — diagnostics, file paths and model ' +
      'names are never included.',
    { modal: true },
    'Enable AI assist',
    'Not now',
  );
  if (choice !== 'Enable AI assist') {
    declinedThisSession.add(host);
    return false;
  }
  await context.globalState.update(FEEDBACK_AI_CONSENT_KEY, host);
  return true;
}

/**
 * Run one analysis. Never throws and never blocks a report: returns
 * `{ analysis: null }` when no tier is configured, when consent was declined,
 * when the call timed out, or when the reply could not be parsed. Errors are
 * recorded on `hostErrorLog`.
 */
export async function analyzeFeedback(
  context: vscode.ExtensionContext,
  request: {
    kind: FeedbackKind;
    description: string;
    context?: string;
  },
  deps: AnalysisDependencies = {},
): Promise<{ analysis: FeedbackAnalysis | null; error?: string }> {
  const tier = await resolveAnalysisTier(context);
  if (tier === 'none') return { analysis: null };
  if (!(await ensureAnalysisConsent(context, tier))) return { analysis: null };

  const issues = await fetchKnownIssues(deps.fetch);
  const prompt = buildAnalysisPrompt({
    kind: request.kind,
    description: request.description,
    context: request.context,
    issues,
  });

  let raw: string | null;
  try {
    raw =
      tier === 'languageModel'
        ? await requestViaLanguageModel(prompt)
        : await requestViaEndpoint(context, prompt, deps.fetch);
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.request', err);
    return { analysis: null, error: 'The analysis could not be completed.' };
  }
  if (raw === null) return { analysis: null, error: 'The analysis could not be completed.' };

  const analysis = parseAnalysisResponse(raw, request.kind, issues);
  if (!analysis) {
    hostErrorLog.record('feedbackAnalysis.parse', 'The reply was not JSON.');
    return { analysis: null, error: 'The analysis reply could not be read.' };
  }
  return { analysis };
}

/** Store the endpoint API key in secret storage. */
export async function setFeedbackApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'API key for the feedback analysis endpoint. Stored in VS Code secret storage.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-…',
  });
  if (key === undefined) return;
  const trimmed = key.trim();
  if (!trimmed) {
    void vscode.window.showWarningMessage('ERD Studio: no API key was entered.');
    return;
  }
  try {
    await context.secrets.store(FEEDBACK_API_KEY_SECRET, trimmed);
    void vscode.window.showInformationMessage('ERD Studio: the feedback API key is stored.');
  } catch (err) {
    hostErrorLog.record('setFeedbackApiKey', err);
    void vscode.window.showErrorMessage('ERD Studio: the feedback API key could not be stored.');
  }
}

/** Remove the endpoint API key from secret storage. */
export async function clearFeedbackApiKey(context: vscode.ExtensionContext): Promise<void> {
  try {
    await context.secrets.delete(FEEDBACK_API_KEY_SECRET);
    void vscode.window.showInformationMessage('ERD Studio: the feedback API key is cleared.');
  } catch (err) {
    hostErrorLog.record('clearFeedbackApiKey', err);
    void vscode.window.showErrorMessage('ERD Studio: the feedback API key could not be cleared.');
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The injected fetch, else the Node 20 global, else null. */
function resolveFetch(injected?: AnalysisFetch): AnalysisFetch | null {
  if (injected) return injected;
  const global = (globalThis as { fetch?: AnalysisFetch }).fetch;
  return typeof global === 'function' ? global : null;
}

/** An abort signal that fires after `ms`, plus its cancel. Null when unsupported. */
function abortAfter(ms: number): { signal: unknown; cancel: () => void } | null {
  const Ctor = (globalThis as {
    AbortController?: new () => { signal: unknown; abort(): void };
  }).AbortController;
  if (typeof Ctor !== 'function') return null;
  const controller = new Ctor();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** Reject `promise` if it has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Tier 1 — VS Code's own language model. Returns the concatenated reply, or
 * null when the host has no model or the request failed.
 */
async function requestViaLanguageModel(prompt: string): Promise<string | null> {
  const api = getLanguageModelApi();
  if (!api) return null;
  const models = await api.lm.selectChatModels();
  const model = models?.[0];
  if (!model) return null;

  const messages = [api.message.User(`${ANALYSIS_SYSTEM_PROMPT}\n\n${prompt}`)];
  const read = (async (): Promise<string> => {
    const response = await model.sendRequest(messages, {}, undefined);
    let text = '';
    for await (const chunk of response.text) text += chunk;
    return text;
  })();

  try {
    return await withTimeout(read, ANALYSIS_TIMEOUT_MS, 'The language model request');
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.languageModel', err);
    return null;
  }
}

/**
 * Tier 2 — an OpenAI-compatible `POST <endpoint>/chat/completions`. Returns the
 * assistant message content, or null when the call failed or the shape was not
 * what we asked for.
 */
async function requestViaEndpoint(
  context: vscode.ExtensionContext,
  prompt: string,
  injectedFetch?: AnalysisFetch,
): Promise<string | null> {
  const doFetch = resolveFetch(injectedFetch);
  const base = endpointBaseUrl();
  const model = endpointModel();
  const key = await readApiKey(context);
  if (!doFetch || !base || !model || !key) return null;

  const abort = abortAfter(ANALYSIS_TIMEOUT_MS);
  try {
    const call = doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: abort?.signal,
    });
    const response = await withTimeout(call, ANALYSIS_TIMEOUT_MS, 'The analysis request');
    if (!response.ok) {
      hostErrorLog.record('feedbackAnalysis.endpoint', `HTTP ${response.status}`);
      return null;
    }
    const json = JSON.parse(await response.text()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.endpoint', err);
    return null;
  } finally {
    abort?.cancel();
  }
}

/** Last successful issue list, reused for {@link ISSUE_CACHE_TTL_MS}. */
let issueCache: { at: number; issues: AnalysisIssueSummary[] } | null = null;

/** In-flight request, so debounced analyses share one call rather than racing. */
let issueCacheInFlight: Promise<AnalysisIssueSummary[]> | null = null;

/** Drop the cached issue list. Exported for tests and for a manual refresh. */
export function clearKnownIssueCache(): void {
  issueCache = null;
  issueCacheInFlight = null;
}

/**
 * The issues the duplicate check is hydrated from, cached across the debounced
 * re-runs of one editing session. A failure is not an error: the analysis
 * simply runs with an empty list and reports no duplicates. Failures are not
 * cached, so the next keystroke retries.
 */
async function fetchKnownIssues(
  injectedFetch?: AnalysisFetch,
  now: number = Date.now(),
): Promise<AnalysisIssueSummary[]> {
  if (issueCache && now - issueCache.at < ISSUE_CACHE_TTL_MS) return issueCache.issues;
  if (issueCacheInFlight) return issueCacheInFlight;

  issueCacheInFlight = requestKnownIssues(injectedFetch)
    .then((issues) => {
      // Only a real list is worth reusing — an empty one is usually a rate limit.
      if (issues.length > 0) issueCache = { at: now, issues };
      return issues;
    })
    .finally(() => {
      issueCacheInFlight = null;
    });

  return issueCacheInFlight;
}

/** One unauthenticated GitHub call for the issue list. */
async function requestKnownIssues(
  injectedFetch?: AnalysisFetch,
): Promise<AnalysisIssueSummary[]> {
  const doFetch = resolveFetch(injectedFetch);
  if (!doFetch) return [];

  const abort = abortAfter(ANALYSIS_TIMEOUT_MS);
  try {
    const call = doFetch(ISSUE_LIST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'erd-studio-vscode',
      },
      signal: abort?.signal,
    });
    const response = await withTimeout(call, ANALYSIS_TIMEOUT_MS, 'The issue list request');
    if (!response.ok) {
      hostErrorLog.record('feedbackAnalysis.issues', `HTTP ${response.status}`);
      return [];
    }
    const json = JSON.parse(await response.text()) as unknown;
    if (!Array.isArray(json)) return [];
    return json
      .map((item) => mapGithubIssue(item))
      .filter((issue): issue is AnalysisIssueSummary => issue !== null);
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.issues', err);
    return [];
  } finally {
    abort?.cancel();
  }
}

/** One GitHub issue payload → an {@link AnalysisIssueSummary}. Pull requests are dropped. */
function mapGithubIssue(value: unknown): AnalysisIssueSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const issue = value as Record<string, unknown>;
  // `/issues` returns pull requests too; they are not feedback.
  if (issue.pull_request) return null;

  const number = asInteger(issue.number);
  const title = asString(issue.title);
  const url = asString(issue.html_url);
  if (number === null || !title || !url) return null;

  const summary: AnalysisIssueSummary = {
    number,
    title,
    state: issue.state === 'closed' ? 'closed' : 'open',
    url,
  };

  const body = asString(issue.body);
  if (body) summary.body = body;
  if (issue.state_reason === 'completed' || issue.state_reason === 'not_planned') {
    summary.stateReason = issue.state_reason;
  }
  const comments = asInteger(issue.comments);
  if (comments !== null) summary.comments = comments;
  summary.assigned = hasAssignee(issue);

  const labels = readLabels(issue);
  const fixedIn = readFixedIn(issue, labels);
  if (fixedIn) summary.fixedIn = fixedIn;
  const closingNote = readClosingNote(body);
  if (closingNote) summary.closingNote = closingNote;

  return summary;
}

/** True when the issue has at least one assignee. */
function hasAssignee(issue: Record<string, unknown>): boolean {
  if (Array.isArray(issue.assignees) && issue.assignees.length > 0) return true;
  return typeof issue.assignee === 'object' && issue.assignee !== null;
}

/** Label names, however GitHub shaped them. */
function readLabels(issue: Record<string, unknown>): string[] {
  if (!Array.isArray(issue.labels)) return [];
  return issue.labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (typeof label === 'object' && label !== null) {
        return asString((label as Record<string, unknown>).name);
      }
      return '';
    })
    .filter((name) => name !== '');
}

/**
 * The version a fix shipped in: the milestone title, else a `shipped-in:<v>`
 * label. A leading `v` is normalised away so `compareVersions` sees digits.
 */
function readFixedIn(issue: Record<string, unknown>, labels: readonly string[]): string | null {
  const milestone = issue.milestone;
  if (typeof milestone === 'object' && milestone !== null) {
    const title = asString((milestone as Record<string, unknown>).title);
    if (title) return title.replace(/^v/i, '');
  }
  for (const label of labels) {
    const match = /^shipped-in:\s*(.+)$/i.exec(label);
    if (match) return match[1].trim().replace(/^v/i, '');
  }
  return null;
}

/**
 * The maintainer's closing reasoning, only when the body states it outright.
 * There is no free API for the closing comment, so nothing is inferred.
 */
function readClosingNote(body: string): string | null {
  const match = /^\s*(?:closing note|closed because)\s*:\s*(.+)$/im.exec(body);
  return match ? match[1].trim() : null;
}
