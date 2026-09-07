/**
 * Shared feedback types — the contract between the Feedback dialog (webview),
 * the feedback services (extension host) and the GitHub issue forms.
 *
 * This module is imported by BOTH tsconfigs and by the mcp-server type-check,
 * so it must stay free of `vscode` and of DOM types. The pure helpers at the
 * bottom (readiness scoring, version compare, duplicate mode, footer routing)
 * live here rather than in a service because the webview needs them too and
 * cannot import anything that touches `vscode`.
 */

// ---------------------------------------------------------------------------
// Kind
// ---------------------------------------------------------------------------

/** What the user is filing. Drives the issue template, copy and field ids. */
export type FeedbackKind = 'bug' | 'feature';

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'feature'];

// ---------------------------------------------------------------------------
// Dialog copy
// ---------------------------------------------------------------------------

/** The per-kind strings the dialog swaps when the kind changes. */
export interface FeedbackKindCopy {
  head: string;
  descLabel: string;
  contextLabel: string;
  contextPlaceholder: string;
  verdict: string;
  template: string;
}

/** Dialog title before the analysis has decided on a kind. */
export const FEEDBACK_PRE_ANALYSIS_TITLE = 'Send feedback';

/**
 * Frozen dialog copy. Lives here (not in the component) so the webview and the
 * tests read the same literals instead of hard-coding them twice.
 */
export const FEEDBACK_COPY: Readonly<Record<FeedbackKind, FeedbackKindCopy>> = {
  bug: {
    head: 'Report a bug',
    descLabel: 'Tell us what happened',
    contextLabel: 'Steps to reproduce',
    contextPlaceholder: '1. Open silver/orders\n2. …',
    verdict: 'Bug',
    template: 'bug_report.yml',
  },
  feature: {
    head: 'Request a feature',
    descLabel: 'What would you like to be able to do?',
    contextLabel: 'Why do you want it?',
    contextPlaceholder: 'Today I work around this by…',
    verdict: 'Feature request',
    template: 'feature_request.yml',
  },
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Standing note shown where the Images section used to be.
 *
 * There is no image route in the dialog at all, and there deliberately is not
 * one. GitHub has no API for putting an image on a prefilled issue form, so
 * whatever the extension captured could only ever be handed back to the user
 * to paste on github.com themselves — which is the job they already have, done
 * twice. Saying so once, here, is the whole feature.
 */
export const FEEDBACK_IMAGE_NOTE =
  'Images are added on the GitHub page. When the form opens, click the Screenshot box and paste (Ctrl+V / \u2318V) or drag them in \u2014 GitHub accepts no image from here.';

// ---------------------------------------------------------------------------
// Which model does the analysis
// ---------------------------------------------------------------------------

/**
 * Where the user wants the one analysis request to go.
 *
 * `auto` is the shipped default and keeps the old precedence: the user's own
 * VS Code language model, then their configured endpoint, then the hosted
 * relay. The other three pin a single tier — which is what makes "I have
 * Copilot but I would rather not spend it on this" expressible, and equally
 * "I have Copilot and nothing else may be used".
 */
export type FeedbackAiProviderChoice = 'auto' | 'vscode' | 'endpoint' | 'hosted';

export const FEEDBACK_AI_PROVIDER_CHOICES: readonly FeedbackAiProviderChoice[] = [
  'auto',
  'vscode',
  'endpoint',
  'hosted',
];

/** True when `value` is one of the four provider choices. */
export function isFeedbackAiProviderChoice(value: unknown): value is FeedbackAiProviderChoice {
  return (
    typeof value === 'string' && (FEEDBACK_AI_PROVIDER_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * One row in the dialog's provider picker.
 *
 * Unavailable options are still listed, with `note` saying why — a picker that
 * silently omits "ERD Studio service" on a machine where the fallback setting
 * is off leaves the user hunting through settings for a switch they cannot see.
 */
export interface FeedbackAiOption {
  id: FeedbackAiProviderChoice;
  /** What the destination is called, e.g. "Copilot" or "erd-studio.liam-is-an.ai \u2192 DeepSeek". */
  label: string;
  /** Whether picking this would actually resolve to a working tier. */
  available: boolean;
  /** One short line: what it does, or why it cannot be picked. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

/**
 * What the user has in the dialog when they press the primary button.
 *
 * Structurally a superset of `BugReportDraft` in feedbackService.ts, so it can
 * be passed straight to `composeIssueFields()`. `steps` carries the context
 * field for BOTH kinds (steps to reproduce for `bug`, rationale for `feature`);
 * `composeFeedbackFields()` maps it to the right issue-form field id.
 */
export interface FeedbackDraft {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** Steps to reproduce (bug) or rationale (feature). */
  steps?: string;
  includeDiagnostics: boolean;
  /** Recent errors observed by the webview (oldest → newest). */
  webviewErrors?: string[];
  /** Filing fresh against an issue that was closed as fixed — title gets "Regression: ". */
  regressionOf?: number;
  /** Post the description as a comment on this issue instead of filing anything new. */
  commentOnIssue?: number;
}

// ---------------------------------------------------------------------------
// Diagnostics (webview-facing view of the host's Diagnostics)
// ---------------------------------------------------------------------------

/** One diagnostics chip rendered in the dialog. */
export interface FeedbackDiagnosticsChip {
  label: string;
  tone: 'normal' | 'error';
}

/**
 * What the host pushes to the dialog so it can show chips and the exact text
 * without ever reconstructing diagnostics in the webview.
 */
export interface FeedbackDiagnosticsView {
  chips: FeedbackDiagnosticsChip[];
  /** Verbatim `formatDiagnostics()` output, shown in the `<details><pre>`. */
  text: string;
}

/** Capability snapshot pushed alongside the diagnostics view. */
export interface FeedbackCapabilities {
  /** Running extension version, e.g. "0.6.49". */
  extensionVersion: string;
  /** True when at least one AI tier is configured AND `feedback.aiAssist` is on. */
  aiAvailable: boolean;
  /** Human label for the configured tier, e.g. "Copilot" or "api.example.com". Null when unavailable. */
  aiProviderLabel: string | null;
  /** Which destination the user has pinned, or `auto`. Mirrors `feedback.provider`. */
  aiProvider: FeedbackAiProviderChoice;
  /**
   * Every destination the picker offers, available or not.
   *
   * The dialog renders the picker whenever *any* of these is available — not
   * only when the resolved tier is — so pinning a provider that then stops
   * being available (Copilot on a machine without it) leaves a visible way back
   * rather than making the whole panel disappear.
   */
  aiOptions: FeedbackAiOption[];
  /**
   * True when the analysis may not auto-run yet: the tier is the user's own
   * language model and no request has succeeded on this machine. The panel
   * renders its "Analyse this for me" button instead of running on the
   * debounce, because VS Code's own access dialog must be triggered by
   * something the user pressed rather than by them typing.
   */
  aiNeedsPriming: boolean;
  /** GitHub handle from a silent session, or null. Never triggers a sign-in prompt. */
  githubHandle: string | null;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Which takeover UI a strong duplicate gets. Derived from GitHub state + state_reason. */
export type DuplicateMode = 'open' | 'fixed' | 'declined';

export const DUPLICATE_MODES: readonly DuplicateMode[] = ['open', 'fixed', 'declined'];

/**
 * A ranked existing issue that might already cover this report.
 *
 * Only `number`, `match` and `why` ever come from the model — every other
 * field is hydrated from the issue list the host fetched, because a
 * hallucinated `stateReason` / `fixedIn` would tell a user to update for a bug
 * that is still open.
 */
export interface DuplicateCandidate {
  number: number;
  title: string;
  /** 0..1 confidence that this is the same thing. */
  match: number;
  /** One sentence from the model on why it matched. */
  why: string;
  state: 'open' | 'closed';
  /** Mirrors GitHub's `issue.state_reason`. Absent while open. */
  stateReason?: 'completed' | 'not_planned';
  comments?: number;
  /** True when the issue has an assignee ("being worked on"). */
  assigned?: boolean;
  /** Version the fix shipped in, for `fixed` mode. */
  fixedIn?: string;
  /** Maintainer's closing reasoning, for `declined` mode. */
  closingNote?: string;
  url: string;
}

/** Model-supplied prose for the unmet readiness checks. Never scores. */
export interface FeedbackAnalysisReasons {
  desc?: string | null;
  ctx?: string | null;
}

/** The single AI call's whole result. Every field is a suggestion, never a decision. */
export interface FeedbackAnalysis {
  kind: FeedbackKind;
  /** 0..1. */
  confidence: number;
  /** Suggested issue title. */
  title: string;
  /** Extracted steps to reproduce (bug) or rationale (feature). */
  context: string;
  reasons: FeedbackAnalysisReasons;
  /** Ranked, highest `match` first. */
  duplicates: DuplicateCandidate[];
}

// ---------------------------------------------------------------------------
// Thresholds & readiness weights
// ---------------------------------------------------------------------------

/** At or above this match, the duplicate takes the dialog over. */
export const DUPLICATE_TAKEOVER_THRESHOLD = 0.7;

/** At or above this (and below takeover), the duplicate is a quiet "Possibly related" row. */
export const DUPLICATE_RELATED_THRESHOLD = 0.3;

/**
 * Below this confidence the two kinds are close enough that presenting one as
 * the answer would overstate what the model actually said.
 */
export const KIND_CONFIDENCE_CLOSE = 0.65;

/** Debounce before re-running the analysis after a description edit. */
export const ANALYSIS_DEBOUNCE_MS = 850;

/** Below this description length the dialog never calls the model. */
export const MIN_DESCRIPTION_CHARS = 12;

/** Point weights for the readiness meter. They sum to 100. */
export const READINESS_WEIGHTS = {
  description: 45,
  /** Partial credit for a description between THIN and CLEAR. */
  descriptionThin: 25,
  context: 35,
  diagnostics: 20,
} as const;

/**
 * The denominator. Every check now applies to every report: the dialog attaches
 * no images, so there is no longer a check that exists on one kind of report
 * and not another, and the score is a plain fraction of a fixed total.
 */
export const READINESS_MAX =
  READINESS_WEIGHTS.description + READINESS_WEIGHTS.context + READINESS_WEIGHTS.diagnostics;

/** Description length that earns full marks. */
export const DESCRIPTION_CLEAR_CHARS = 90;

/** Description length that earns partial marks. */
export const DESCRIPTION_THIN_CHARS = 40;

/** Context (steps/rationale) must be strictly longer than this to count. */
export const CONTEXT_MIN_CHARS = 8;

/** Percentage at which the readiness bar turns green. */
export const READINESS_GOOD_PCT = 70;

/** Which UI element a failed check's jump-to action focuses. */
export type ReadinessTarget = 'description' | 'context' | 'diagnostics';

/** One row under the readiness bar. */
export interface ReadinessCheck {
  ok: boolean;
  label: string;
  /** Model-supplied prose, or a local fallback. Only on unmet checks. */
  why?: string | null;
  /** Action label, e.g. "Add them". Only on unmet checks that can be fixed in the dialog. */
  act?: string;
  target?: ReadinessTarget;
}

export interface ReadinessResult {
  /** 0..100, rounded. */
  score: number;
  checks: ReadinessCheck[];
}

/** Inputs to the readiness meter. All lengths are of already-trimmed text. */
export interface ReadinessInput {
  kind: FeedbackKind;
  descriptionLength: number;
  contextLength: number;
  includeDiagnostics: boolean;
  reasons?: FeedbackAnalysisReasons;
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** One issue the user filed, as tracked in the "My Reports" view. */
export interface TrackedReport {
  number: number;
  title: string;
  url: string;
  kind: FeedbackKind;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned';
  comments: number;
  /**
   * Version the fix shipped in, when known. Read from the issue's milestone
   * title or a `shipped-in:<version>` label — never guessed.
   */
  shippedIn?: string;
  /** ISO timestamps from the GitHub API. */
  createdAt: string;
  updatedAt: string;
  /** True once the "shipped in vX" notification has been shown. */
  notifiedShipped?: boolean;
}

/** A submission the extension opened in the browser but has not yet reconciled. */
export interface PendingReport {
  title: string;
  kind: FeedbackKind;
  /** Epoch ms when the browser was opened; issues created after this are candidates. */
  openedAt: number;
}

/** Shape persisted in `globalState` under `TRACKED_REPORTS_KEY`. */
export interface TrackedReportsCache {
  handle: string;
  /** Epoch ms of the last successful poll. */
  fetchedAt: number;
  reports: TrackedReport[];
  pending: PendingReport[];
}

/** How often the tracker re-polls GitHub (6 hours). */
export const TRACKING_REFRESH_MS = 6 * 60 * 60 * 1000;

/** How long an unreconciled pending report is kept before it is dropped (7 days). */
export const TRACKING_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Footer routing
// ---------------------------------------------------------------------------

/** Everything the footer's label and route line depend on. */
export interface FooterRouteInput {
  duplicate: { number: number; mode: DuplicateMode; fixedIn?: string } | null;
  filingAnyway: boolean;
  version: string;
  outdated: boolean;
  /**
   * For a `fixed` duplicate: whether the comparison could be made at all.
   *
   * GitHub only tells us the version a fix shipped in when the issue carries a
   * milestone or a `shipped-in:` label, so most closed issues leave it unknown.
   * `false` means "we could not compare" — neither `outdated` nor "you already
   * have the fix" may then be asserted. Defaults to true so the two frozen
   * `fixed` rows are unchanged.
   */
  versionKnown?: boolean;
}

/** The footer's primary button label and its two-part explanation line. */
export interface FooterRoute {
  primaryLabel: string;
  /** Bolded lead-in, then the rest. Kept as two strings so no markup lives in a string. */
  lead: string;
  rest: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by host and webview)
// ---------------------------------------------------------------------------

/** True when `value` is one of the two feedback kinds. */
export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

/** The opposite kind, for the "Not right? Make it a …" flip link. */
export function otherKind(kind: FeedbackKind): FeedbackKind {
  return kind === 'bug' ? 'feature' : 'bug';
}

/** How the analysis's confidence divides between the two kinds. */
export interface KindSplit {
  /** The kind the model picked. */
  kind: FeedbackKind;
  /** Its share, 0-100, rounded. */
  percent: number;
  /** The kind it did not pick. */
  other: FeedbackKind;
  /** The remainder, 0-100, rounded. Always `100 - percent`. */
  otherPercent: number;
  /** True when the winner is too slim to present as settled. */
  closeCall: boolean;
}

/**
 * Split one confidence across the two kinds.
 *
 * The choice is binary, so a single confidence already describes both sides and
 * the model is not asked for two numbers — two numbers can disagree about what
 * they sum to, and reconciling that would be inventing an answer.
 *
 * A confidence below 0.5 is incoherent (the model picked the side it thinks is
 * less likely), so the winner's share is floored at 50: showing "Bug 30% /
 * Feature 70%" under a verdict chip that reads *Bug* would be a worse answer
 * than admitting it is a coin toss.
 */
export function kindSplit(kind: FeedbackKind, confidence: number): KindSplit {
  const raw = Number.isFinite(confidence) ? confidence : 0.5;
  const share = Math.min(1, Math.max(0.5, raw));
  const percent = Math.round(share * 100);
  return {
    kind,
    percent,
    other: otherKind(kind),
    otherPercent: 100 - percent,
    closeCall: share < KIND_CONFIDENCE_CLOSE,
  };
}

/**
 * Compare two dotted numeric versions. Returns <0 when `a` is older than `b`,
 * 0 when equal, >0 when newer. Missing segments count as 0; non-numeric
 * segments count as 0 ("0.6.44-beta" compares as "0.6.44").
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v)
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** True when the running version is older than the version a fix shipped in. */
export function isVersionOlder(running: string, fixedIn: string): boolean {
  return compareVersions(running, fixedIn) < 0;
}

/** Which takeover a duplicate gets. `closed` without a reason is treated as `fixed`. */
export function duplicateModeFor(candidate: DuplicateCandidate): DuplicateMode {
  if (candidate.state === 'open') return 'open';
  return candidate.stateReason === 'not_planned' ? 'declined' : 'fixed';
}

/**
 * The single duplicate that takes the dialog over, or null. Only a candidate at
 * or above {@link DUPLICATE_TAKEOVER_THRESHOLD} qualifies; ties break on the
 * lower issue number (the older thread).
 */
export function pickTakeoverDuplicate(
  duplicates: readonly DuplicateCandidate[],
): DuplicateCandidate | null {
  let best: DuplicateCandidate | null = null;
  for (const candidate of duplicates) {
    if (candidate.match < DUPLICATE_TAKEOVER_THRESHOLD) continue;
    if (
      !best ||
      candidate.match > best.match ||
      (candidate.match === best.match && candidate.number < best.number)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The quiet "Possibly related" list: below takeover, at or above related. */
export function relatedDuplicates(
  duplicates: readonly DuplicateCandidate[],
): DuplicateCandidate[] {
  return duplicates
    .filter((d) => d.match >= DUPLICATE_RELATED_THRESHOLD && d.match < DUPLICATE_TAKEOVER_THRESHOLD)
    .sort((a, b) => b.match - a.match);
}

/** Prefix a title for a regression report, idempotently. */
export function applyRegressionPrefix(title: string): string {
  const trimmed = title.trim();
  return /^regression:\s/i.test(trimmed) ? trimmed : `Regression: ${trimmed}`;
}

/**
 * The inverse of {@link applyRegressionPrefix}, for when the regression claim
 * it was applied for is withdrawn — the analysis moved on to a different
 * duplicate, or to none. Removes one prefix only, so a title that genuinely
 * begins "Regression: Regression: …" is not silently rewritten twice.
 */
export function stripRegressionPrefix(title: string): string {
  return title.trim().replace(/^regression:\s+/i, '');
}

/**
 * The footer's primary label and route line.
 *
 * A strong duplicate owns the footer until the user chooses to file anyway;
 * otherwise the line says what pressing the button actually does, because the
 * whole flow ends on github.com with the user pressing Submit themselves.
 */
export function footerRoute(input: FooterRouteInput): FooterRoute {
  const { duplicate, filingAnyway, version, outdated } = input;
  const versionKnown = input.versionKnown !== false;

  if (duplicate && !filingAnyway) {
    const number = duplicate.number;
    if (duplicate.mode === 'open') {
      return {
        primaryLabel: `Add to #${number}`,
        lead: 'Nothing new gets filed.',
        rest: ` Your description is posted as a comment on #${number}.`,
      };
    }
    if (duplicate.mode === 'declined') {
      return {
        primaryLabel: `Open #${number}`,
        lead: 'Closed as not planned.',
        rest: ' Read the reasoning first — reopening that thread beats a second issue.',
      };
    }
    // 'fixed'
    if (outdated) {
      return {
        primaryLabel: 'Update ERD Studio',
        lead: `Already fixed in ${duplicate.fixedIn ?? 'a newer version'}.`,
        rest: ` Updating is quicker than filing — you're on ${version}.`,
      };
    }
    // Closed as done, but nothing records which release carried the fix. Say
    // that, rather than claiming the user has it — calling this a regression
    // puts an unverifiable claim in the tracker, and telling them to update
    // could talk someone out of a real report.
    if (!versionKnown) {
      return {
        primaryLabel: 'File it anyway',
        lead: 'Closed as fixed.',
        rest: ` Update first; if it still happens, file it referencing #${number}.`,
      };
    }
    return {
      primaryLabel: 'Report as a regression',
      lead: 'You already have the fix,',
      rest: ` so this is a regression — worth its own issue, referencing #${number}.`,
    };
  }

  return {
    primaryLabel: 'Open GitHub issue',
    lead: 'Opens the prefilled form.',
    rest: ' You review it and press Submit on GitHub — nothing is sent from VS Code.',
  };
}

/**
 * Deterministic readiness score. The model supplies only the `why` strings via
 * `input.reasons`; every point here is computed locally so attaching an image
 * moves the bar with no round trip.
 */
export function readinessScore(input: ReadinessInput): ReadinessResult {
  const checks: ReadinessCheck[] = [];
  let points = 0;

  if (input.descriptionLength >= DESCRIPTION_CLEAR_CHARS) {
    points += READINESS_WEIGHTS.description;
    checks.push({ ok: true, label: 'Clear description' });
  } else if (input.descriptionLength >= DESCRIPTION_THIN_CHARS) {
    points += READINESS_WEIGHTS.descriptionThin;
    checks.push({
      ok: false,
      label: 'Description is thin',
      why: input.reasons?.desc ?? 'A sentence or two more would help — what did you expect instead?',
      act: 'Add more',
      target: 'description',
    });
  } else {
    checks.push({
      ok: false,
      label: 'Description is very short',
      why: input.reasons?.desc ?? 'A sentence or two more would help — what did you expect instead?',
      act: 'Add more',
      target: 'description',
    });
  }

  if (input.contextLength > CONTEXT_MIN_CHARS) {
    points += READINESS_WEIGHTS.context;
    checks.push({ ok: true, label: input.kind === 'bug' ? 'Steps to reproduce' : 'Rationale given' });
  } else {
    checks.push({
      ok: false,
      label: input.kind === 'bug' ? 'No steps to reproduce' : 'No rationale',
      why:
        input.reasons?.ctx ??
        (input.kind === 'bug'
          ? 'Without steps, this can only be guessed at.'
          : 'Saying why you want it shapes how it gets built.'),
      act: 'Add them',
      target: 'context',
    });
  }

  if (input.includeDiagnostics) {
    points += READINESS_WEIGHTS.diagnostics;
    checks.push({ ok: true, label: 'Versions and recent errors attached' });
  } else {
    checks.push({
      ok: false,
      label: 'Diagnostics removed',
      why: 'Versions make most bugs far quicker to place.',
      act: 'Put back',
      target: 'diagnostics',
    });
  }

  return { score: Math.round((points / READINESS_MAX) * 100), checks };
}
