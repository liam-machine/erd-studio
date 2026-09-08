/**
 * FeedbackDialog — one dialog for both bug reports and feature requests.
 *
 * The user writes a paragraph; everything else is offered rather than demanded.
 * When a model is configured the analysis panel picks the kind, drafts a title,
 * pulls out the steps and checks the tracker for duplicates — but every one of
 * those lands in an editable field, and with no model configured the panel is
 * absent and the dialog still files a complete report.
 *
 * The kind is a live two-way negotiation. It starts on `bug` because that is
 * what most reports are, the analysis moves it as the description takes shape,
 * and the segmented control in the header is always there for the user to
 * overrule it — after which the analysis stops moving it, until they hand it
 * back with "auto". The control is a permanent header fixture rather than a
 * link inside the analysis panel: on a host where no tier resolves that panel
 * never renders, and the feature-request template has to stay reachable.
 *
 * Two things are deliberately local rather than round-tripped: the readiness
 * meter (so ticking diagnostics moves the bar instantly) and the duplicate
 * takeover state (so the redirect is reversible at any point). Diagnostics come
 * from the host as a finished view and are never rebuilt here.
 *
 * There is no image route at all, and that is the feature. GitHub has no API
 * for attaching an image to a prefilled issue form, so anything captured here
 * could only be handed back to the user to paste on github.com themselves —
 * the job they already have, done twice, with a clipboard that may refuse and a
 * file on disk to explain. The dialog says where images go, once, and stops.
 *
 * Rendered as a fixed overlay rather than a React Flow `Panel` so it also works
 * on the full-screen error page, where the canvas is unmounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DuplicateCandidate,
  FeedbackAiProviderChoice,
  FeedbackKind,
  ReadinessTarget,
} from '../../../src/types/feedback';
import {
  ANALYSIS_DEBOUNCE_MS,
  FEEDBACK_COPY,
  FEEDBACK_IMAGE_NOTE,
  FEEDBACK_KINDS,
  FEEDBACK_PRE_ANALYSIS_TITLE,
  MIN_DESCRIPTION_CHARS,
  applyRegressionPrefix,
  duplicateModeFor,
  footerRoute,
  isVersionOlder,
  pickTakeoverDuplicate,
  readinessScore,
  stripRegressionPrefix,
} from '../../../src/types/feedback';
import type { ExtensionMessage } from '../../../src/types/messages';
import { useEditorStore } from '../../store/editorStore';
import { useMessageBus, useSend } from '../../hooks/useMessageBus';
import { AnalysisPanel } from './AnalysisPanel';
import { DiagnosticsChips } from './DiagnosticsChips';
import { DuplicateTakeover, type FixState } from './DuplicateTakeover';
import { FeedbackFooter } from './FeedbackFooter';
import './FeedbackDialog.css';

/** Elements a Tab press may land on while the dialog owns focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Bug / lightbulb glyph beside the dialog title. */
function KindMark({ kind }: { kind: FeedbackKind }) {
  return (
    <span className="feedback__kindmark" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        {kind === 'bug' ? (
          <>
            <path d="M8 2.9a3 3 0 0 1 3 3v2.8a3 3 0 1 1-6 0V5.9a3 3 0 0 1 3-3Z" />
            <path d="M5 7H2.5m11 0H11M5 9.6H2.8m10.4 0H11" />
          </>
        ) : (
          <>
            <path d="M6 12.4h4M6.6 14h2.8" />
            <path d="M8 1.8a4 4 0 0 1 2.5 7.1c-.4.4-.6.8-.6 1.3H6.1c0-.5-.2-.9-.6-1.3A4 4 0 0 1 8 1.8Z" />
          </>
        )}
      </svg>
    </span>
  );
}

/** Short label for each kind's segment. Kept out of `FEEDBACK_COPY` — that file is the frozen issue-form copy. */
const KIND_SEGMENT_LABEL: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Bug',
  feature: 'Feature',
};

interface KindSwitchProps {
  kind: FeedbackKind;
  /** True once the user has picked a segment themselves. */
  locked: boolean;
  /** True when an analysis has actually chosen the current kind. */
  chosenByAnalysis: boolean;
  /** Whether handing control back to the analysis would do anything. */
  canAuto: boolean;
  disabled: boolean;
  onPick: (kind: FeedbackKind) => void;
  onAuto: () => void;
}

/**
 * The bug/feature segmented control.
 *
 * Both destinations are visible at all times, which is the whole point: the old
 * "Not right? Make it a feature" link was one control that moved between the
 * header and the analysis panel depending on state, and read as though `bug`
 * were a permanent default rather than a first guess.
 *
 * The trailing chip is the negotiation made legible — "auto" while the analysis
 * owns the choice, and a button back to it once the user has taken over.
 */
function KindSwitch({
  kind,
  locked,
  chosenByAnalysis,
  canAuto,
  disabled,
  onPick,
  onAuto,
}: KindSwitchProps) {
  return (
    <div className="feedback__kindswitch">
      <div className="feedback__segmented" role="group" aria-label="What are you filing?">
        {FEEDBACK_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            className={`feedback__segment${option === kind ? ' feedback__segment--on' : ''}`}
            onClick={() => onPick(option)}
            disabled={disabled}
            aria-pressed={option === kind}
          >
            {KIND_SEGMENT_LABEL[option]}
          </button>
        ))}
      </div>
      {locked && canAuto ? (
        <button
          type="button"
          className="feedback__kindauto"
          onClick={onAuto}
          disabled={disabled}
          title="Let the analysis choose again as you type"
        >
          your choice · auto
        </button>
      ) : (
        canAuto && (
          <span
            className="feedback__kindhint"
            title={
              chosenByAnalysis
                ? 'Chosen by the analysis — pick one yourself to overrule it'
                : 'The analysis will choose as you type — pick one yourself to overrule it'
            }
          >
            {chosenByAnalysis ? 'chosen for you' : 'auto'}
          </span>
        )
      )}
    </div>
  );
}

export function FeedbackDialog() {
  const send = useSend();

  const open = useEditorStore((s) => s.feedbackDialogOpen);
  const prefill = useEditorStore((s) => s.feedbackPrefill);
  const setOpen = useEditorStore((s) => s.setFeedbackDialogOpen);
  const domain = useEditorStore((s) => s.domain);
  const diagnostics = useEditorStore((s) => s.feedbackDiagnostics);
  const capabilities = useEditorStore((s) => s.feedbackCapabilities);
  const analysis = useEditorStore((s) => s.feedbackAnalysis);
  const analysisState = useEditorStore((s) => s.feedbackAnalysisState);
  const analysisError = useEditorStore((s) => s.feedbackError);
  const setAnalysis = useEditorStore((s) => s.setFeedbackAnalysis);
  const setAnalysisPending = useEditorStore((s) => s.setFeedbackAnalysisPending);

  const [kind, setKind] = useState<FeedbackKind>('bug');
  // True once the user has picked a kind themselves. While false the analysis
  // owns the choice and re-applies it on every reply; the "auto" button clears
  // it, and the effect below then re-applies the current analysis immediately.
  const [kindLocked, setKindLocked] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [titleFromAnalysis, setTitleFromAnalysis] = useState(false);
  const [userTitle, setUserTitle] = useState('');
  // The duplicate a "file anyway" / "regression" choice was made against, and
  // the raw flags that choice set. The effective values are derived below, so
  // a choice cannot survive the duplicate it belongs to.
  const [choiceFor, setChoiceFor] = useState<number | null>(null);
  const [filingAnywayRaw, setFilingAnyway] = useState(false);
  const [regressionOfRaw, setRegressionOf] = useState<number | undefined>(undefined);
  // Set once a request has actually come back with an analysis, so the primer
  // button gives way to the debounce for the rest of this dialog. The host
  // persists the same fact in globalState for every future dialog; this is only
  // what keeps the button from reappearing between here and the next open.
  const [primedHere, setPrimedHere] = useState(false);
  // Bumped whenever the analysis destination changes. It is in the debounce's
  // dependency list purely so a switch re-runs the analysis on text that has
  // not changed — nothing else about a provider swap need move.
  const [providerEpoch, setProviderEpoch] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const requestIdRef = useRef(0);
  // The description the dialog was *opened* with, if any. Text nobody typed is
  // not text anybody chose to send: the canvas error screen prefills the raw
  // host exception, which carries absolute domain paths and model names, so the
  // debounce must not carry it to a model on its own. Editing a single
  // character makes the description the user's again and the debounce resumes.
  const prefilledDescriptionRef = useRef('');
  // The text and id of the request most recently sent, so a debounce cannot
  // repeat one that is still the current answer. See `runAnalysis`.
  const lastRequestedRef = useRef<{ text: string; id: number } | null>(null);

  // Mirrors of state the async handlers and the debounce read without being
  // re-created (and therefore re-scheduled) on every keystroke.
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const kindLockedRef = useRef(kindLocked);
  kindLockedRef.current = kindLocked;
  const contextRefValue = useRef(context);
  contextRefValue.current = context;
  const userTitleRef = useRef(userTitle);
  userTitleRef.current = userTitle;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  // `send` is stable in production (the VS Code API is a module singleton), but
  // the reset and debounce effects must not restart if it ever is not.
  const sendRef = useRef(send);
  sendRef.current = send;

  const close = useCallback(() => setOpen(false), [setOpen]);

  const domainSummary = useMemo(
    () =>
      domain
        ? {
            // Neither the domain's name nor its layer travels: they are the
            // user's own business vocabulary ("gold/commercial"), the
            // maintainer has no access to the project they name, and the shape
            // of the graph is the part that is actually diagnostic.
            stage: domain.stage,
            modelCount: domain.models.length,
            relationshipCount: domain.relationships.length,
            schemaVersion: domain.schemaVersion,
          }
        : undefined,
    [domain],
  );
  const domainSummaryRef = useRef(domainSummary);
  domainSummaryRef.current = domainSummary;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  // Reset every field each time the dialog opens — a checkbox left over from a
  // previous report is a silent way to attach something nobody meant to send —
  // then ask the host for diagnostics and capabilities.
  //
  // Keyed on `open` alone: a domain reload behind an open dialog must not throw
  // away what the user has typed.
  useEffect(() => {
    if (!open) return;
    const prefill = prefillRef.current;
    setKind(prefill?.kind ?? 'bug');
    // A caller that named a kind has already decided; the analysis may not
    // quietly move it underneath them.
    setKindLocked(Boolean(prefill?.kind));
    setTitle(prefill?.title ?? '');
    setUserTitle(prefill?.title ?? '');
    // The mirror is written during render, so it would still hold the previous
    // value when the analysis effect below runs in this same commit — a
    // prefilled title would then be overwritten by a suggestion.
    userTitleRef.current = prefill?.title ?? '';
    setDescription(prefill?.description ?? '');
    // Written during render for the same reason as `userTitleRef` above: the
    // analysis effect runs in this same commit and has to see it already set,
    // or the very first debounce would carry the prefill to the model.
    prefilledDescriptionRef.current = prefill?.description ?? '';
    lastRequestedRef.current = null;
    setContext('');
    setIncludeDiagnostics(true);
    setBusy(false);
    setSubmitError(null);
    setTitleFromAnalysis(false);
    setChoiceFor(null);
    setFilingAnyway(false);
    setRegressionOf(undefined);
    // Cleared with everything else: the host's `feedbackContext` reply, asked
    // for a few lines below, is the authority on whether the primer is needed,
    // and a stale `true` here would hide a button that is still required.
    setPrimedHere(false);

    sendRef.current({
      type: 'requestFeedbackContext',
      payload: {
        webviewErrors: useEditorStore.getState().recentErrors,
        domain: domainSummaryRef.current,
      },
    });

    const id = window.setTimeout(() => descriptionRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Escape closes. Handled on the capture phase from `window` rather than
  // through the canvas key handler, so it also works on the error screen.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, busy, close]);

  // Keep Tab inside the dialog while it is modal.
  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    // `offsetParent` skips the collapsed form behind a duplicate takeover. It is
    // always null where layout is not computed, so fall back to the full list
    // rather than trapping focus on nothing.
    const visible = all.filter((el) => el.offsetParent !== null);
    const focusable = visible.length > 0 ? visible : all;
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  // The dialog owns the request ids, so it (not App) has to decide which
  // replies are still current — a slow reply to an edited description would
  // otherwise overwrite a newer verdict.
  useMessageBus((message: ExtensionMessage) => {
    if (message.type === 'feedbackAnalysis') {
      if (message.payload.requestId !== requestIdRef.current) return;
      // A reply with an analysis means the model answered — on tier 1 that is
      // VS Code's dialog already dealt with, so the debounce may take over. A
      // null one (declined dialog, timeout) leaves the button where it is.
      if (message.payload.analysis) setPrimedHere(true);
      setAnalysis(message.payload.analysis, message.payload.error);
      return;
    }
    if (message.type === 'feedbackSubmitted') {
      setBusy(false);
      if (message.payload.ok) {
        close();
      } else {
        setSubmitError(message.payload.error ?? 'The report could not be sent.');
      }
    }
  });

  /**
   * Ask the host for one analysis. `trigger` is the difference between the user
   * pressing the primer button and them merely typing: the host refuses a
   * debounced request on the user's own language model until one asked-for run
   * has succeeded, because VS Code's access dialog may not appear out of the
   * blue.
   *
   * A debounced call never repeats the request that is still the current one.
   * Two paths would otherwise duplicate it: the primer reply flipping
   * `needsPriming` false re-runs the debounce effect with an unchanged
   * description (and the run it replaces registered no cleanup, so the id has
   * not moved), and a timer armed by the last keystroke is still pending when
   * the button is pressed within the debounce window. A `'user'` click always
   * goes through, so a failed first run can still be retried by hand.
   *
   * The id is half the comparison because the effect's cleanup increments it on
   * every description change: an A → B → A edit has a moved id and re-runs,
   * while the primer flip — which runs no cleanup — does not.
   */
  const runAnalysis = useCallback(
    (trimmed: string, trigger: 'debounce' | 'user') => {
      const last = lastRequestedRef.current;
      const isRepeat =
        last !== null && last.text === trimmed && last.id === requestIdRef.current;
      if (trigger === 'debounce' && isRepeat) return;
      requestIdRef.current += 1;
      lastRequestedRef.current = { text: trimmed, id: requestIdRef.current };
      setAnalysisPending();
      sendRef.current({
        type: 'analyzeFeedback',
        payload: {
          requestId: requestIdRef.current,
          kind: kindRef.current,
          // The difference between a decision and a default. The host states
          // the kind to the model only when the user actually picked it —
          // otherwise the `bug` this dialog opens on would be presented as
          // something they said, and the model would agree with it.
          kindChosenByUser: kindLockedRef.current,
          description: trimmed,
          context: contextRefValue.current.trim() || undefined,
          trigger,
        },
      });
    },
    [setAnalysisPending],
  );

  // Whether the first run still has to be asked for by a click. The host
  // decides (it owns the globalState flag); `primedHere` only covers the gap
  // between a success and the next `feedbackContext`.
  const needsPriming = capabilities?.aiNeedsPriming === true && !primedHere;

  // True while the description is still exactly the text the dialog was opened
  // with. The canvas error screen prefills the host's raw exception — which
  // names absolute domain file paths and dbt model names — so this is the one
  // description in the dialog the user did not write and may not have read.
  // Nothing auto-sends it; the primer button offers it as a deliberate choice.
  const descriptionIsUntouchedPrefill =
    prefilledDescriptionRef.current.trim().length > 0 &&
    description.trim() === prefilledDescriptionRef.current.trim();

  // One debounced call per description edit, and never below the minimum
  // length — a three-word draft costs a round trip and tells the model nothing.
  useEffect(() => {
    if (!open || !capabilities?.aiAvailable || needsPriming || descriptionIsUntouchedPrefill) return;
    const trimmed = description.trim();
    if (trimmed.length < MIN_DESCRIPTION_CHARS) {
      if (useEditorStore.getState().feedbackAnalysisState !== 'idle') setAnalysis(null);
      return;
    }
    const timer = window.setTimeout(() => {
      runAnalysis(trimmed, 'debounce');
    }, ANALYSIS_DEBOUNCE_MS);
    return () => {
      // Whatever this run put in flight is stale from here on. The cleanup runs
      // when the description changes (including shrinking back below the
      // minimum, where the effect body returns early and would otherwise leave
      // the id matching) and when the dialog closes — so a slow reply can never
      // take over a form the user has since emptied, or a freshly reopened one.
      requestIdRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [
    open,
    description,
    capabilities?.aiAvailable,
    needsPriming,
    descriptionIsUntouchedPrefill,
    providerEpoch,
    runAnalysis,
    setAnalysis,
  ]);

  // Land a reply in the fields, without ever overwriting the user: a title they
  // typed, a context they filled in and a kind they picked all win.
  //
  // `kindLocked` is a dependency rather than a ref precisely so that clearing it
  // re-runs this effect and re-applies the analysis's kind — which is what the
  // "auto" button means. Nothing else here has to know about that button.
  useEffect(() => {
    if (!analysis) return;
    if (!kindLocked) setKind(analysis.kind);
    if (!userTitleRef.current.trim() && analysis.title.trim()) {
      setTitle(analysis.title);
      setTitleFromAnalysis(true);
    }
    if (analysis.context.trim() && !contextRefValue.current.trim()) setContext(analysis.context);
  }, [analysis, kindLocked]);

  // -------------------------------------------------------------------------
  // Which model does the analysis
  // -------------------------------------------------------------------------

  const aiOptions = useMemo(() => capabilities?.aiOptions ?? [], [capabilities]);

  /**
   * Switch the analysis destination.
   *
   * Everything the previous model said is dropped first. A verdict, a title and
   * a duplicate list are that model's answer; carrying them across a switch
   * would leave the panel attributing one model's output to another. The host
   * writes the setting and replies with a fresh `feedbackContext`, and the
   * epoch bump makes the debounce re-run on the description already typed.
   */
  const handleProviderChange = useCallback(
    (provider: FeedbackAiProviderChoice) => {
      if (provider === capabilities?.aiProvider) return;
      // Any reply still in flight belongs to the old destination.
      requestIdRef.current += 1;
      lastRequestedRef.current = null;
      setAnalysis(null);
      // Priming is a fact about a tier, not about the dialog: the new one may
      // need its own first click, and the host's reply is what says so.
      setPrimedHere(false);
      setProviderEpoch((epoch) => epoch + 1);
      send({
        type: 'setFeedbackProvider',
        payload: {
          provider,
          webviewErrors: useEditorStore.getState().recentErrors,
          domain: domainSummary,
        },
      });
    },
    [send, capabilities?.aiProvider, domainSummary, setAnalysis],
  );

  // -------------------------------------------------------------------------
  // Duplicates
  // -------------------------------------------------------------------------

  const takeover = useMemo(
    () => (analysis ? pickTakeoverDuplicate(analysis.duplicates) : null),
    [analysis],
  );
  const takeoverMode = takeover ? duplicateModeFor(takeover) : null;
  const runningVersion = capabilities?.extensionVersion ?? '';

  // Three-valued on purpose. GitHub only records the version a fix shipped in
  // when the issue carries a milestone or a `shipped-in:` label, so `unknown`
  // is the ordinary case — and it is not the same as "we compared and you are
  // current", which is what a boolean would quietly turn it into.
  const fixState: FixState | null =
    takeoverMode !== 'fixed'
      ? null
      : !takeover?.fixedIn || !runningVersion
        ? 'unknown'
        : isVersionOlder(runningVersion, takeover.fixedIn)
          ? 'outdated'
          : 'current';
  const outdated = fixState === 'outdated';

  // A choice about a duplicate ("file anyway", "report it as a regression")
  // belongs to the duplicate it was made against. The analysis re-runs on a
  // debounce, so without this a regression claim could outlive the issue it
  // referred to and be filed against an unrelated one.
  const choiceCurrent = choiceFor !== null && takeover?.number === choiceFor;
  const filingAnyway = filingAnywayRaw && choiceCurrent;
  const regressionOf = choiceCurrent ? regressionOfRaw : undefined;
  const collapsed = Boolean(takeover) && !filingAnyway;

  // Drop a lapsed choice, and with it the "Regression: " the title was given
  // for a duplicate that is no longer on screen.
  useEffect(() => {
    if (choiceFor === null || choiceCurrent) return;
    setChoiceFor(null);
    setFilingAnyway(false);
    if (regressionOfRaw !== undefined) {
      setRegressionOf(undefined);
      setTitle((current) => stripRegressionPrefix(current));
    }
  }, [choiceFor, choiceCurrent, regressionOfRaw]);

  const openIssue = useCallback(
    (candidate: DuplicateCandidate) => {
      send({ type: 'openFeedbackLink', payload: { target: 'issue', issue: candidate.number } });
    },
    [send],
  );

  /** Switch to filing a fresh issue, prefixing the title when it is a regression. */
  const startFilingAnyway = useCallback(
    (regression: boolean) => {
      if (!takeover) return;
      setChoiceFor(takeover.number);
      setFilingAnyway(true);
      if (regression) {
        setRegressionOf(takeover.number);
        setTitle((current) => (current.trim() ? applyRegressionPrefix(current) : current));
      }
    },
    [takeover],
  );

  /**
   * The one predicate that decides whether filing fresh is a regression claim.
   * Both escape hatches (the footer's restlink and the outdated panel's ghost)
   * go through it, so they cannot drift apart: only a user who demonstrably
   * has the fix is reporting a regression.
   */
  const beginFilingAnyway = useCallback(
    () => startFilingAnyway(fixState === 'current'),
    [startFilingAnyway, fixState],
  );

  const toggleFilingAnyway = useCallback(() => {
    if (filingAnyway) {
      setChoiceFor(null);
      setFilingAnyway(false);
      // Withdrawing the choice withdraws the claim it put in the title too.
      if (regressionOfRaw !== undefined) {
        setRegressionOf(undefined);
        setTitle((current) => stripRegressionPrefix(current));
      }
      return;
    }
    beginFilingAnyway();
  }, [filingAnyway, beginFilingAnyway, regressionOfRaw]);

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  const submit = useCallback(
    (options?: { commentOnIssue?: number }) => {
      if (busy) return;
      setBusy(true);
      setSubmitError(null);
      send({
        type: 'submitFeedback',
        payload: {
          kind,
          title: title.trim(),
          description: description.trim(),
          steps: context.trim() || undefined,
          includeDiagnostics,
          webviewErrors: useEditorStore.getState().recentErrors,
          regressionOf,
          commentOnIssue: options?.commentOnIssue,
          domain: domainSummary,
        },
      });
    },
    [
      busy,
      send,
      kind,
      title,
      description,
      context,
      includeDiagnostics,
      regressionOf,
      domainSummary,
    ],
  );

  /** The takeover's primary action — the footer's primary button runs the same one. */
  const handleTakeoverPrimary = useCallback(() => {
    if (!takeover || !takeoverMode) return;
    if (takeoverMode === 'open') {
      submit({ commentOnIssue: takeover.number });
      return;
    }
    if (takeoverMode === 'declined') {
      openIssue(takeover);
      return;
    }
    if (fixState === 'outdated') {
      send({ type: 'openFeedbackLink', payload: { target: 'extension' } });
      return;
    }
    // 'current' is a regression; 'unknown' is only "file it anyway".
    beginFilingAnyway();
  }, [takeover, takeoverMode, fixState, submit, openIssue, send, beginFilingAnyway]);

  const handleTakeoverGhost = useCallback(() => {
    if (!takeover || !takeoverMode) return;
    if (takeoverMode === 'declined') {
      submit({ commentOnIssue: takeover.number });
      return;
    }
    openIssue(takeover);
  }, [takeover, takeoverMode, submit, openIssue]);

  const handleCopyReport = useCallback(() => {
    send({
      type: 'copyFeedbackReport',
      payload: {
        kind,
        title: title.trim(),
        description: description.trim(),
        steps: context.trim() || undefined,
        includeDiagnostics,
        webviewErrors: useEditorStore.getState().recentErrors,
        domain: domainSummary,
      },
    });
  }, [send, kind, title, description, context, includeDiagnostics, domainSummary]);

  // -------------------------------------------------------------------------
  // Readiness & routing
  // -------------------------------------------------------------------------

  const readiness = useMemo(
    () =>
      readinessScore({
        kind,
        descriptionLength: description.trim().length,
        contextLength: context.trim().length,
        includeDiagnostics,
        reasons: analysis?.reasons,
      }),
    [kind, description, context, includeDiagnostics, analysis],
  );

  const route = useMemo(
    () =>
      footerRoute({
        duplicate:
          takeover && takeoverMode
            ? { number: takeover.number, mode: takeoverMode, fixedIn: takeover.fixedIn }
            : null,
        filingAnyway,
        version: runningVersion,
        outdated,
        versionKnown: fixState !== 'unknown',
      }),
    [takeover, takeoverMode, filingAnyway, runningVersion, outdated, fixState],
  );

  const handleJump = useCallback((target: ReadinessTarget) => {
    if (target === 'description') {
      descriptionRef.current?.focus();
      return;
    }
    if (target === 'context') {
      contextRef.current?.focus();
      return;
    }
    setIncludeDiagnostics(true);
  }, []);

  /** Take the kind over from the analysis. */
  const handlePickKind = useCallback((next: FeedbackKind) => {
    setKindLocked(true);
    setKind(next);
  }, []);

  /** Hand it back. The analysis effect re-applies the current verdict. */
  const handleAutoKind = useCallback(() => setKindLocked(false), []);

  if (!open) return null;

  const copy = FEEDBACK_COPY[kind];
  const analysed = analysisState === 'ready' && analysis !== null;
  // The panel renders whenever any destination could work, not only when one
  // currently resolves: pinning a provider that is unavailable here has to
  // leave the picker on screen, or the way back disappears with it.
  const showAi = capabilities?.aiAvailable === true || aiOptions.some((option) => option.available);
  const restlinkLabel = filingAnyway
    ? 'Hide the new-issue form'
    : fixState === 'current'
      ? 'Report it as a regression'
      : 'File it as a new issue anyway';
  const primaryAction = collapsed ? handleTakeoverPrimary : () => submit();

  return (
    <>
      <div className="feedback__backdrop" onClick={busy ? undefined : close} />
      <div
        ref={dialogRef}
        className={`feedback${kind === 'feature' ? ' feedback--feature' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="feedback__header">
          <KindMark kind={kind} />
          <h3 id="feedback-title" className="feedback__title">
            {analysed ? copy.head : FEEDBACK_PRE_ANALYSIS_TITLE}
          </h3>
          {/*
            A permanent header fixture. On a host where no tier resolves the
            analysis panel never renders, and this is then the only route to the
            feature-request template — so it must not move inside that panel.
          */}
          <KindSwitch
            kind={kind}
            locked={kindLocked}
            chosenByAnalysis={analysed && !kindLocked}
            canAuto={showAi}
            disabled={busy}
            onPick={handlePickKind}
            onAuto={handleAutoKind}
          />
          <button
            type="button"
            className="feedback__close"
            onClick={close}
            aria-label="Close"
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div className="feedback__scroll">
          <div className="feedback__field">
            <label className="feedback__label" htmlFor="feedback-description">
              {copy.descLabel}
            </label>
            <textarea
              id="feedback-description"
              ref={descriptionRef}
              className="feedback__textarea"
              rows={4}
              value={description}
              placeholder="Describe it however you like — the analysis sorts out the rest."
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>

          {takeover && takeoverMode && (
            <DuplicateTakeover
              candidate={takeover}
              mode={takeoverMode}
              fixState={fixState ?? 'unknown'}
              runningVersion={runningVersion}
              onPrimary={handleTakeoverPrimary}
              onGhost={handleTakeoverGhost}
              onFileAnyway={beginFilingAnyway}
              onOpenIssue={openIssue}
            />
          )}

          {showAi && (
            <AnalysisPanel
              state={analysisState}
              analysis={analysis}
              readiness={readiness}
              kind={kind}
              onJump={handleJump}
              errorMessage={analysisError ?? undefined}
              providerLabel={capabilities?.aiProviderLabel ?? null}
              provider={capabilities?.aiProvider ?? 'auto'}
              providerOptions={aiOptions}
              onProviderChange={handleProviderChange}
              available={capabilities?.aiAvailable === true}
              onOpenIssue={openIssue}
              needsPriming={needsPriming || descriptionIsUntouchedPrefill}
              primerNote={
                needsPriming
                  ? 'Uses your own model. VS Code will ask once.'
                  : 'This text was filled in for you — nothing is sent until you ask.'
              }
              canAnalyse={description.trim().length >= MIN_DESCRIPTION_CHARS}
              onAnalyse={() => runAnalysis(description.trim(), 'user')}
            />
          )}

          {takeover && (
            <button
              type="button"
              className="feedback__link feedback__restlink"
              onClick={toggleFilingAnyway}
            >
              {restlinkLabel}
            </button>
          )}

          <div className={`feedback__rest${collapsed ? ' feedback__rest--collapsed' : ''}`}>
            <div className="feedback__field">
              <label className="feedback__label" htmlFor="feedback-title-input">
                Title
                {titleFromAnalysis && (
                  <span className="feedback__suggested">
                    · suggested
                    <button
                      type="button"
                      className="feedback__revert"
                      onClick={() => {
                        setTitle(userTitle);
                        setTitleFromAnalysis(false);
                      }}
                    >
                      use mine
                    </button>
                  </span>
                )}
              </label>
              <input
                id="feedback-title-input"
                className="feedback__input"
                type="text"
                value={title}
                maxLength={120}
                placeholder="Filled in for you once you've described it"
                onChange={(e) => {
                  setTitle(e.target.value);
                  setUserTitle(e.target.value);
                  setTitleFromAnalysis(false);
                }}
                disabled={busy}
              />
            </div>

            <div className="feedback__field">
              <label className="feedback__label" htmlFor="feedback-context">
                {copy.contextLabel}
              </label>
              <textarea
                id="feedback-context"
                ref={contextRef}
                className="feedback__textarea"
                rows={3}
                value={context}
                placeholder={copy.contextPlaceholder}
                onChange={(e) => setContext(e.target.value)}
                disabled={busy}
              />
            </div>

            {/*
              Not a control — a fact. GitHub accepts no image through a
              prefilled issue form, so there is nothing here to tick, pick or
              capture; saying where images do go is the entire section.
            */}
            <div className="feedback__field">
              <span className="feedback__group-label">Images</span>
              <p className="feedback__note">{FEEDBACK_IMAGE_NOTE}</p>
            </div>

            <DiagnosticsChips
              view={diagnostics}
              included={includeDiagnostics}
              onToggle={() => setIncludeDiagnostics((current) => !current)}
            />
          </div>

          {submitError && (
            <div className="feedback__status feedback__status--error" role="alert">
              {submitError}
            </div>
          )}
        </div>

        <FeedbackFooter
          route={route}
          primaryLabel={route.primaryLabel}
          primaryDisabled={!collapsed && !description.trim() && !title.trim()}
          busy={busy}
          onCancel={close}
          onPrimary={primaryAction}
          onCopyReport={handleCopyReport}
          githubHandle={capabilities?.githubHandle ?? null}
        />
      </div>
    </>
  );
}
