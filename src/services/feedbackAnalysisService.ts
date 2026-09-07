/**
 * FeedbackAnalysisService — the single optional AI call behind the Feedback dialog.
 *
 * One request returns a classification (bug vs feature), a suggested title, the
 * steps/rationale pulled out of the user's prose, one sentence per unmet
 * readiness check, and a ranked list of issues that might already cover the
 * report. Every one of those is a *suggestion*: the dialog stays fully usable
 * with no model at all, and nothing here ever blocks or fails a report.
 *
 * Four tiers, tried in order. The user's own model and the user's own endpoint
 * always win; the hosted service is the last resort:
 *   1. VS Code's Language Model API — feature-detected at runtime through
 *      `getLanguageModelApi()`, because `engines.vscode` stays at ^1.85.0 and
 *      `vscode.lm` does not exist in `@types/vscode` 1.85.0. On an older host
 *      the tier simply is not there.
 *   2. An OpenAI-compatible chat-completions endpoint reached with the Node
 *      global `fetch` — base URL and model id from settings, API key from
 *      `context.secrets`, never from settings.json.
 *   3. The author's hosted proxy — the same OpenAI-compatible request with no
 *      Authorization header (the proxy holds the key), at the build-time
 *      {@link HOSTED_ANALYSIS_ENDPOINT}. While that constant — or
 *      {@link HOSTED_ANALYSIS_PROVIDER}, which names the third party the proxy
 *      forwards to — ships empty, the tier does not exist and behaviour is
 *      identical to the three-tier build.
 *   4. Nothing configured — `resolveAnalysisTier()` returns `'none'` and the
 *      dialog renders no AI panel at all.
 *
 * Consent is split by who chose the destination. Tier 1 shows no modal of our
 * own: VS Code owns that dialog, it already names the extension, and a second
 * modal in front of it is noise. What tier 1 does instead is honour the API
 * guidance that `selectChatModels` be called "as part of a user-initiated
 * action" — the first request on a machine must carry `userInitiated`, which is
 * the dialog's "Analyse this for me" button; once one has succeeded,
 * {@link FEEDBACK_LM_PRIMED_KEY} is set and the debounce runs freely for ever
 * after. Tiers 2 and 3 always ask, naming the host the text is posted to,
 * because the user did not pick that destination in an OS-owned dialog.
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

/**
 * globalState key recording that one tier-1 request has completed on this
 * machine.
 *
 * VS Code's own consent dialog is an authentication prompt it owns, and the
 * API guidance is that `selectChatModels` "should be called as part of a
 * user-initiated action ... and not 'out of the blue'". An 850 ms debounce
 * while someone types is exactly the case that warns against, so the first
 * tier-1 request has to come from a button. Once one has *succeeded* the user
 * has already answered VS Code's dialog and there is nothing left to be
 * surprised by, so the flag is set and the debounce takes over. A dismissed
 * dialog fails the request and leaves the flag unset, which brings the button
 * back rather than leaving the feature silently dead.
 */
export const FEEDBACK_LM_PRIMED_KEY = 'erdStudio.feedback.lmPrimed';

/** Master switch. Boolean, default **true**. */
export const FEEDBACK_AI_ASSIST_SETTING = 'feedback.aiAssist';

/** Off switch for the hosted last-resort tier. Boolean, default true. */
export const FEEDBACK_HOSTED_FALLBACK_SETTING = 'feedback.hostedFallback';

/**
 * Base URL of the hosted analysis proxy — a build-time constant, not a setting,
 * because it is the extension author's own service rather than something a user
 * or a repository configures.
 *
 * **It ships empty on purpose.** While it is `''` the hosted tier does not
 * exist: `resolveAnalysisTier()` can never return `'hosted'`, no consent modal
 * mentioning it can ever appear, and the extension behaves exactly as it did
 * with three tiers. The client is ready before the service is; filling this in
 * (see `proxy/`) is what turns the tier on, in one place, for one release.
 *
 * Only `https:` is accepted, plus `http:` on loopback for a local
 * `wrangler dev`. The proxy holds the API key, so no key is ever sent with a
 * hosted request.
 */
export const HOSTED_ANALYSIS_ENDPOINT = '';

/**
 * The third party that actually receives the text, named as a user should see
 * it (e.g. `'DeepSeek'`).
 *
 * The proxy is a relay: it holds the operator's key and forwards the prose to
 * an upstream model provider under that provider's terms. The consent modal has
 * to name that provider, not just the relay — the user cannot refuse a
 * processor they were never told about, and this is the one tier where the
 * extension, not the user, chose the destination.
 *
 * **Fill this in with the same commit that fills {@link
 * HOSTED_ANALYSIS_ENDPOINT}.** It is not a nicety: `resolveAnalysisTier()`
 * treats the hosted tier as absent while either constant is empty, so an
 * endpoint shipped without a named provider simply resolves to `'none'` rather
 * than sending text under a disclosure that omits the recipient.
 */
export const HOSTED_ANALYSIS_PROVIDER = '';

/**
 * Model id sent to {@link HOSTED_ANALYSIS_ENDPOINT}. Advisory only — the proxy
 * rewrites `model` to its own allowlisted value rather than trusting the
 * client, so this is what the request *asks* for, not what it gets. It is
 * therefore **not** a disclosure: {@link HOSTED_ANALYSIS_PROVIDER} is.
 */
export const HOSTED_ANALYSIS_MODEL = 'deepseek-chat';

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
export type AnalysisTier = 'languageModel' | 'endpoint' | 'hosted' | 'none';

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
  return safeBaseUrl(getErdStudioSetting<string>(FEEDBACK_ENDPOINT_SETTING, ''));
}

/**
 * `value` with trailing slashes stripped, or `''` when it is not somewhere a
 * request may be sent. Shared by the user's endpoint and the hosted proxy so
 * there is one rule about what a base URL may be, not two.
 */
function safeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '');
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

let hostedTargetOverride: { endpoint: string; model: string; provider?: string } | null = null;

/**
 * Overrides the build-time hosted target. **Tests only** — nothing in the
 * extension calls this.
 *
 * {@link HOSTED_ANALYSIS_ENDPOINT} ships empty, so without a seam the hosted
 * tier would be untestable in exactly the build that ships. Pass `null` to go
 * back to the constants.
 */
export function setHostedAnalysisTargetForTests(
  target: { endpoint: string; model: string; provider?: string } | null,
): void {
  hostedTargetOverride = target;
}

/** The hosted proxy's base URL, or `''` when the tier is not built in. */
function hostedBaseUrl(): string {
  return safeBaseUrl(hostedTargetOverride?.endpoint ?? HOSTED_ANALYSIS_ENDPOINT);
}

/** The model id asked of the hosted proxy (which is free to rewrite it). */
function hostedModel(): string {
  return (hostedTargetOverride?.model ?? HOSTED_ANALYSIS_MODEL).trim();
}

/**
 * The third party the proxy forwards to, or `''` when the build did not name
 * one — in which case the tier does not exist. See
 * {@link HOSTED_ANALYSIS_PROVIDER}.
 */
function hostedProvider(): string {
  return (hostedTargetOverride?.provider ?? HOSTED_ANALYSIS_PROVIDER).trim();
}

/** Whether the user (or their organisation) left the hosted last resort on. */
function hostedFallbackEnabled(): boolean {
  return getErdStudioSetting<boolean>(FEEDBACK_HOSTED_FALLBACK_SETTING, true) === true;
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

/**
 * Whether AI assist is on at all. Defaults to **true**: with tier 1 the model
 * is the user's own and VS Code gates it with its own dialog, and with no tier
 * configured this switch changes nothing. It stays user-scoped, so a repository
 * cannot flip it either way.
 */
function aiAssistEnabled(): boolean {
  return getErdStudioSetting<boolean>(FEEDBACK_AI_ASSIST_SETTING, true) === true;
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
 * Which tier is available right now, in the order the user's own choices win:
 * their language model, then their endpoint, then the author's hosted proxy,
 * then nothing. Returns `'none'` when `feedback.aiAssist` is off, or when none
 * of the three is configured. Performs no network work and never prompts.
 */
export async function resolveAnalysisTier(
  context: vscode.ExtensionContext,
): Promise<AnalysisTier> {
  if (!aiAssistEnabled()) return 'none';
  if (await hasLanguageModel()) return 'languageModel';
  if (endpointBaseUrl() && endpointModel() && (await readApiKey(context))) return 'endpoint';
  // The provider is part of the gate, not just the copy: without a named
  // recipient there is no disclosure that could be consented to, so the tier is
  // treated as if it were not built in.
  if (hostedFallbackEnabled() && hostedBaseUrl() && hostedModel() && hostedProvider()) {
    return 'hosted';
  }
  return 'none';
}

/**
 * True when the resolved tier may not run on the debounce yet: the user's own
 * model, on a machine where no tier-1 request has succeeded. The dialog renders
 * its "Analyse this for me" button instead of auto-running, and that click is
 * the user-initiated action VS Code's guidance asks for.
 */
export function analysisNeedsPriming(
  context: vscode.ExtensionContext,
  tier: AnalysisTier,
): boolean {
  return tier === 'languageModel' && !isLanguageModelPrimed(context);
}

/** Whether one tier-1 request has already completed on this machine. */
function isLanguageModelPrimed(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<unknown>(FEEDBACK_LM_PRIMED_KEY) === true;
}

/** Record that tier 1 works here, so the debounce may run from now on. */
async function markLanguageModelPrimed(context: vscode.ExtensionContext): Promise<void> {
  if (isLanguageModelPrimed(context)) return;
  try {
    await context.globalState.update(FEEDBACK_LM_PRIMED_KEY, true);
  } catch (err) {
    // Losing the flag only costs one more button click, so this never throws.
    hostErrorLog.record('feedbackAnalysis.primed', err);
  }
}

/**
 * Human label for the resolved tier: "Copilot", the endpoint's hostname, or
 * "<relay host> → <provider>" for the hosted tier, which has two parties.
 */
export async function analysisProviderLabel(
  context: vscode.ExtensionContext,
): Promise<string | null> {
  const tier = await resolveAnalysisTier(context);
  if (tier === 'languageModel') return 'Copilot';
  if (tier === 'endpoint') return endpointHost();
  // Named as the relay *and* the onward recipient, so the panel does not
  // re-establish "the author is who reads this" after the modal said otherwise.
  if (tier === 'hosted') return `${hostedHost()} \u2192 ${hostedProvider()}`;
  return null;
}

/** Hostname of the configured endpoint, falling back to the raw setting. */
function endpointHost(): string {
  return hostOf(endpointBaseUrl());
}

/** Hostname of the hosted proxy — what the consent modal has to name. */
function hostedHost(): string {
  return hostOf(hostedBaseUrl());
}

/** The host part of a base URL, falling back to the URL itself. */
function hostOf(base: string): string {
  try {
    return new URL(base).host || base;
  } catch {
    return base;
  }
}

/**
 * The destination a consent of **ours** applies to: the host the request is
 * posted to. Null for tier 1, which is not ours to gate — VS Code's own
 * authentication dialog is the consent there, and it already names the
 * extension — and null when nothing is configured.
 *
 * For the hosted tier the value is `"<relay host>|<provider>"` rather than the
 * host alone, because the disclosure names both and consent belongs to the
 * disclosure it was given against. Repointing the relay at a different model
 * provider therefore asks again instead of inheriting a "yes" that was about a
 * different processor — and a build that shipped the older, host-only copy
 * re-asks once, which is the correct side to fail on.
 */
export function analysisConsentTarget(tier: AnalysisTier): string | null {
  if (tier === 'endpoint') return endpointHost() || null;
  if (tier === 'hosted') {
    const host = hostedHost();
    const provider = hostedProvider();
    return host && provider ? `${host}|${provider}` : null;
  }
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
  // Tier 1 is the user's own model, reached through VS Code's own consent
  // dialog — which names this extension and is the real gate. A modal of ours
  // in front of it would be a second question about the same decision.
  if (tier === 'languageModel') return true;

  // What consent is stored and compared against — the whole disclosure, not
  // just the hostname (see `analysisConsentTarget`).
  const target = analysisConsentTarget(tier);
  if (!target) return false;
  if (context.globalState.get<unknown>(FEEDBACK_AI_CONSENT_KEY) === target) return true;
  if (declinedThisSession.has(target)) return false;

  const { message, accept, decline } =
    tier === 'hosted'
      ? hostedConsentCopy(hostedHost(), hostedProvider())
      : endpointConsentCopy(endpointHost());
  const choice = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    accept,
    decline,
  );
  if (choice !== accept) {
    declinedThisSession.add(target);
    return false;
  }
  await context.globalState.update(FEEDBACK_AI_CONSENT_KEY, target);
  return true;
}

/** The prompt for an endpoint the user configured themselves. */
function endpointConsentCopy(host: string): {
  message: string;
  accept: string;
  decline: string;
} {
  return {
    message:
      `ERD Studio: send your feedback description to ${host} to draft a title, pick the type ` +
      'and look for duplicates? Only what you typed is sent — diagnostics, file paths and ' +
      'model names are never included.',
    accept: 'Enable AI assist',
    decline: 'Not now',
  };
}

/**
 * The prompt for the author's hosted service.
 *
 * This one always asks, even though tier 1 no longer does, because the user did
 * not choose this destination — the extension did. So it says whose service it
 * is, **who it is forwarded to**, what leaves the machine, and how to turn it
 * off.
 *
 * Naming `provider` is the point of the sentence: the author's Worker is a
 * relay holding the author's key, and the text is processed by a third party
 * under that party's terms. A consent given about the relay alone would not
 * cover the party that actually receives the prose.
 */
function hostedConsentCopy(
  host: string,
  provider: string,
): { message: string; accept: string; decline: string } {
  return {
    message:
      'ERD Studio: no language model is configured, so your feedback description can be sent ' +
      `to ${host}, a relay run by the extension author, which forwards it to ${provider} — a ` +
      "third-party AI provider — under the author's account and that provider's terms, to " +
      'draft a title, pick the type and look for duplicates. Only what you typed is sent — ' +
      'diagnostics, file paths and model names are never included. You can turn this off in ' +
      'settings.',
    accept: 'Use it',
    decline: 'No thanks',
  };
}

/**
 * Run one analysis. Never throws and never blocks a report: returns
 * `{ analysis: null }` when no tier is configured, when tier 1 is still waiting
 * for its first user-initiated run, when consent was declined, when the call
 * timed out, or when the reply could not be parsed. Errors are recorded on
 * `hostErrorLog`.
 *
 * `request.userInitiated` says the user pressed a button for this one. It only
 * matters for an unprimed tier 1, where a debounced request is declined rather
 * than made — see {@link FEEDBACK_LM_PRIMED_KEY}.
 */
export async function analyzeFeedback(
  context: vscode.ExtensionContext,
  request: {
    kind: FeedbackKind;
    description: string;
    context?: string;
    userInitiated?: boolean;
  },
  deps: AnalysisDependencies = {},
): Promise<{ analysis: FeedbackAnalysis | null; error?: string }> {
  const tier = await resolveAnalysisTier(context);
  if (tier === 'none') return { analysis: null };
  // Not a failure: the dialog is showing its button and is waiting for a click.
  if (analysisNeedsPriming(context, tier) && request.userInitiated !== true) {
    return { analysis: null };
  }
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
    raw = await requestForTier(context, tier, prompt, deps.fetch);
  } catch (err) {
    hostErrorLog.record('feedbackAnalysis.request', err);
    return { analysis: null, error: 'The analysis could not be completed.' };
  }
  if (raw === null) return { analysis: null, error: 'The analysis could not be completed.' };

  // One tier-1 request has now gone all the way through VS Code's dialog, so
  // the debounce may run unattended from here on — in this report and every
  // future one. A failure above never reaches this line, which is the point:
  // a dismissed dialog leaves the button in place.
  if (tier === 'languageModel') await markLanguageModelPrimed(context);

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

/** Dispatch one request to whichever tier resolved. */
async function requestForTier(
  context: vscode.ExtensionContext,
  tier: AnalysisTier,
  prompt: string,
  injectedFetch?: AnalysisFetch,
): Promise<string | null> {
  if (tier === 'languageModel') return requestViaLanguageModel(prompt);
  if (tier === 'hosted') {
    // No key: the proxy holds it. Everything else is the tier-2 request.
    return postChatCompletion(hostedBaseUrl(), hostedModel(), null, prompt, injectedFetch);
  }
  return postChatCompletion(
    endpointBaseUrl(),
    endpointModel(),
    await readApiKey(context),
    prompt,
    injectedFetch,
  );
}

/**
 * Tiers 2 and 3 — an OpenAI-compatible `POST <base>/chat/completions`. Returns
 * the assistant message content, or null when the call failed or the shape was
 * not what we asked for.
 *
 * `key` is the bearer token for the user's own endpoint, and `null` for the
 * hosted proxy, which authenticates itself and must never be sent one. That is
 * the only difference between the two tiers on the wire, which is why they
 * share this function rather than having a client each.
 */
async function postChatCompletion(
  base: string,
  model: string,
  key: string | null,
  prompt: string,
  injectedFetch?: AnalysisFetch,
): Promise<string | null> {
  const doFetch = resolveFetch(injectedFetch);
  if (!doFetch || !base || !model) return null;
  if (key !== null && !key) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const abort = abortAfter(ANALYSIS_TIMEOUT_MS);
  try {
    const call = doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
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
