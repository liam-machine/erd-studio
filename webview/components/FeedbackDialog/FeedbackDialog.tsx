/**
 * FeedbackDialog — one dialog for both bug reports and feature requests.
 *
 * The user writes a paragraph; everything else is offered rather than demanded.
 * When a model is configured the analysis panel picks the kind, drafts a title,
 * pulls out the steps and checks the tracker for duplicates — but every one of
 * those lands in an editable field, and with no model configured the panel is
 * absent and the dialog still files a complete report.
 *
 * Two things are deliberately local rather than round-tripped: the readiness
 * meter (so attaching the screenshot moves the bar instantly) and the duplicate
 * takeover state (so the redirect is reversible at any point). Diagnostics come
 * from the host as a finished view and are never rebuilt here.
 *
 * There is exactly one image route: the canvas capture. GitHub has no API for
 * attaching an image to a prefilled issue form, so any other image has to be
 * pasted or dropped onto the GitHub page by the user anyway — the dialog says
 * so once, rather than running a picker whose output it cannot deliver.
 *
 * Rendered as a fixed overlay rather than a React Flow `Panel` so it also works
 * on the full-screen error page, where the canvas is unmounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DuplicateCandidate,
  FeedbackAttachment,
  FeedbackImageMime,
  FeedbackKind,
  ReadinessTarget,
} from '../../../src/types/feedback';
import {
  ANALYSIS_DEBOUNCE_MS,
  FEEDBACK_COPY,
  FEEDBACK_PRE_ANALYSIS_TITLE,
  MIN_DESCRIPTION_CHARS,
  applyRegressionPrefix,
  duplicateModeFor,
  footerRoute,
  isVersionOlder,
  otherKind,
  pickTakeoverDuplicate,
  readinessScore,
  stripRegressionPrefix,
} from '../../../src/types/feedback';
import type { ExtensionMessage } from '../../../src/types/messages';
import { useEditorStore } from '../../store/editorStore';
import { useMessageBus, useSend } from '../../hooks/useMessageBus';
import { canvasAttachment } from '../../lib/feedbackAttachments';
import { captureScreenshot, copyImageToClipboard } from '../../lib/screenshot';
import { AnalysisPanel } from './AnalysisPanel';
import { DiagnosticsChips } from './DiagnosticsChips';
import { DuplicateTakeover, type FixState } from './DuplicateTakeover';
import { FeedbackFooter } from './FeedbackFooter';
import './FeedbackDialog.css';

/** Selector for everything the canvas screenshot must leave out (this dialog). */
const EXCLUDE_FROM_SCREENSHOT = '.feedback, .feedback__backdrop';

/** How long the Images section stays highlighted after an "Attach one" jump. */
const URGE_MS = 1600;

/** Elements a Tab press may land on while the dialog owns focus. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Rebuild a blob from an attachment's data URL so it can go on the clipboard.
 * Returns null for a payload `atob` refuses, which is treated as "not copied".
 */
function dataUrlToBlob(dataUrl: string, mime: FeedbackImageMime): Blob | null {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeCanvasScreenshot, setIncludeCanvasScreenshot] = useState(false);
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [titleFromAnalysis, setTitleFromAnalysis] = useState(false);
  const [userTitle, setUserTitle] = useState('');
  // The duplicate a "file anyway" / "regression" choice was made against, and
  // the raw flags that choice set. The effective values are derived below, so
  // a choice cannot survive the duplicate it belongs to.
  const [choiceFor, setChoiceFor] = useState<number | null>(null);
  const [filingAnywayRaw, setFilingAnyway] = useState(false);
  const [regressionOfRaw, setRegressionOf] = useState<number | undefined>(undefined);
  const [imagesUrged, setImagesUrged] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const requestIdRef = useRef(0);
  const kindOverridden = useRef(false);

  // Mirrors of state the async handlers and the debounce read without being
  // re-created (and therefore re-scheduled) on every keystroke. `attachments`
  // is the exception: it is written only through `applyAttachments`, because a
  // render-phase assignment could rewind a change an in-flight file read has
  // already made.
  const attachmentsRef = useRef(attachments);
  const kindRef = useRef(kind);
  kindRef.current = kind;
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

  /** The single writer for the attachment list, keeping state and ref in step. */
  const applyAttachments = useCallback((next: FeedbackAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const domainSummary = useMemo(
    () =>
      domain
        ? {
            name: domain.domain,
            layer: domain.layer,
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
    setTitle(prefill?.title ?? '');
    setUserTitle(prefill?.title ?? '');
    // The mirror is written during render, so it would still hold the previous
    // value when the analysis effect below runs in this same commit — a
    // prefilled title would then be overwritten by a suggestion.
    userTitleRef.current = prefill?.title ?? '';
    setDescription(prefill?.description ?? '');
    setContext('');
    setIncludeDiagnostics(true);
    setIncludeCanvasScreenshot(false);
    applyAttachments([]);
    setScreenshotError(undefined);
    setBusy(false);
    setStatus(null);
    setSubmitError(null);
    setTitleFromAnalysis(false);
    setChoiceFor(null);
    setFilingAnyway(false);
    setRegressionOf(undefined);
    setImagesUrged(false);
    kindOverridden.current = Boolean(prefill?.kind);

    sendRef.current({
      type: 'requestFeedbackContext',
      payload: {
        webviewErrors: useEditorStore.getState().recentErrors,
        domain: domainSummaryRef.current,
      },
    });

    const id = window.setTimeout(() => descriptionRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, applyAttachments]);

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

  // One debounced call per description edit, and never below the minimum
  // length — a three-word draft costs a round trip and tells the model nothing.
  useEffect(() => {
    if (!open || !capabilities?.aiAvailable) return;
    const trimmed = description.trim();
    if (trimmed.length < MIN_DESCRIPTION_CHARS) {
      if (useEditorStore.getState().feedbackAnalysisState !== 'idle') setAnalysis(null);
      return;
    }
    const timer = window.setTimeout(() => {
      requestIdRef.current += 1;
      setAnalysisPending();
      sendRef.current({
        type: 'analyzeFeedback',
        payload: {
          requestId: requestIdRef.current,
          kind: kindRef.current,
          description: trimmed,
          context: contextRefValue.current.trim() || undefined,
        },
      });
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
  }, [open, description, capabilities?.aiAvailable, setAnalysis, setAnalysisPending]);

  // Land a reply in the fields, without ever overwriting the user: a title they
  // typed and a context they filled in both win.
  useEffect(() => {
    if (!analysis) return;
    if (!kindOverridden.current) setKind(analysis.kind);
    if (!userTitleRef.current.trim() && analysis.title.trim()) {
      setTitle(analysis.title);
      setTitleFromAnalysis(true);
    }
    if (analysis.context.trim() && !contextRefValue.current.trim()) setContext(analysis.context);
  }, [analysis]);

  // -------------------------------------------------------------------------
  // The canvas screenshot
  // -------------------------------------------------------------------------

  /**
   * Tick / untick the canvas screenshot. Ticking captures immediately so the
   * user finds out here whether it worked (and whether the clipboard took it),
   * rather than at submit time when the browser is already opening.
   *
   * Every failure path unticks the box: a checkbox left ticked with nothing
   * behind it promises an image the report does not carry.
   */
  const handleCanvasToggle = useCallback(
    async (checked: boolean) => {
      setIncludeCanvasScreenshot(checked);
      setScreenshotError(undefined);
      if (!checked) {
        applyAttachments([]);
        return;
      }
      if (attachmentsRef.current.length > 0) return;

      const root = document.getElementById('root');
      if (!root) {
        setIncludeCanvasScreenshot(false);
        return;
      }
      setStatus('Capturing the canvas…');
      const shot = await captureScreenshot(root, EXCLUDE_FROM_SCREENSHOT);
      setStatus(null);
      if (!shot.dataUrl) {
        const reason = shot.error ?? 'capture failed';
        setScreenshotError(reason);
        setIncludeCanvasScreenshot(false);
        useEditorStore.getState().recordError('screenshot', reason);
        return;
      }
      const attachment = canvasAttachment(shot.dataUrl);
      if (!attachment) {
        setScreenshotError('The screenshot could not be attached — it may be over the 10 MB limit.');
        setIncludeCanvasScreenshot(false);
        return;
      }
      // `captureScreenshot` already tried the clipboard; record what happened so
      // the dialog can say which of the two hand-offs the user is getting.
      applyAttachments([{ ...attachment, onClipboard: shot.onClipboard }]);
    },
    [applyAttachments],
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

  /**
   * Re-copy the screenshot to the clipboard on the way out and stamp the result
   * on it. Re-copied because the capture may have been minutes ago and the user
   * has had a whole dialog to put something else on the clipboard since; the
   * flag is recorded rather than assumed because the host branches both the
   * GitHub "Screenshot" body text and its notification on it, and a browser is
   * free to refuse the write.
   */
  const withClipboardFlag = useCallback(async (): Promise<FeedbackAttachment[]> => {
    const list = attachmentsRef.current;
    if (list.length === 0) return [];
    const [image] = list;
    const blob = dataUrlToBlob(image.dataUrl, image.mime);
    const onClipboard = blob ? await copyImageToClipboard(blob, image.mime) : false;
    return [{ ...image, onClipboard }];
  }, []);

  const submit = useCallback(
    async (options?: { commentOnIssue?: number }) => {
      if (busy) return;
      setBusy(true);
      setSubmitError(null);
      const outgoing = await withClipboardFlag();
      send({
        type: 'submitFeedback',
        payload: {
          kind,
          title: title.trim(),
          description: description.trim(),
          steps: context.trim() || undefined,
          includeDiagnostics,
          attachments: outgoing.length > 0 ? outgoing : undefined,
          screenshotError,
          webviewErrors: useEditorStore.getState().recentErrors,
          regressionOf,
          commentOnIssue: options?.commentOnIssue,
          domain: domainSummary,
        },
      });
    },
    [
      busy,
      withClipboardFlag,
      send,
      kind,
      title,
      description,
      context,
      includeDiagnostics,
      screenshotError,
      regressionOf,
      domainSummary,
    ],
  );

  /** The takeover's primary action — the footer's primary button runs the same one. */
  const handleTakeoverPrimary = useCallback(() => {
    if (!takeover || !takeoverMode) return;
    if (takeoverMode === 'open') {
      void submit({ commentOnIssue: takeover.number });
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
      void submit({ commentOnIssue: takeover.number });
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
        attachmentNames: attachments.map((a) => a.name),
        webviewErrors: useEditorStore.getState().recentErrors,
        domain: domainSummary,
      },
    });
  }, [send, kind, title, description, context, includeDiagnostics, attachments, domainSummary]);

  // -------------------------------------------------------------------------
  // Readiness & routing
  // -------------------------------------------------------------------------

  /** The canvas capture is bug-only, and only where a canvas sits behind the dialog. */
  const canCaptureCanvas = kind === 'bug' && capabilities?.canCaptureCanvas === true;

  const readiness = useMemo(
    () =>
      readinessScore({
        kind,
        descriptionLength: description.trim().length,
        contextLength: context.trim().length,
        attachmentCount: attachments.length,
        includeDiagnostics,
        // The capture is the dialog's only image route, so where it is
        // unavailable the meter must not ask for an image it cannot take.
        canAttachImage: canCaptureCanvas,
        reasons: analysis?.reasons,
      }),
    [kind, description, context, attachments.length, includeDiagnostics, canCaptureCanvas, analysis],
  );

  const route = useMemo(
    () =>
      footerRoute({
        duplicate:
          takeover && takeoverMode
            ? { number: takeover.number, mode: takeoverMode, fixedIn: takeover.fixedIn }
            : null,
        filingAnyway,
        attachmentCount: attachments.length,
        version: runningVersion,
        outdated,
        versionKnown: fixState !== 'unknown',
      }),
    [takeover, takeoverMode, filingAnyway, attachments.length, runningVersion, outdated, fixState],
  );

  const handleJump = useCallback(
    (target: ReadinessTarget) => {
      if (target === 'description') {
        descriptionRef.current?.focus();
        return;
      }
      if (target === 'context') {
        contextRef.current?.focus();
        return;
      }
      if (target === 'diagnostics') {
        setIncludeDiagnostics(true);
        return;
      }
      // "Attach one" has exactly one thing to attach, so attach it rather than
      // pointing at a control. The check is only offered where that capture
      // exists; when it is already asked for and failed, the highlight falls
      // back to the note that says where images do go.
      setImagesUrged(true);
      window.setTimeout(() => setImagesUrged(false), URGE_MS);
      if (canCaptureCanvas && !includeCanvasScreenshot) void handleCanvasToggle(true);
    },
    [canCaptureCanvas, includeCanvasScreenshot, handleCanvasToggle],
  );

  /**
   * Change what is being filed. Available with or without an analysis — the
   * bug/feature choice is core, and hanging it off the optional AI panel would
   * make a feature request unreachable in the shipped default configuration.
   *
   * A canvas screenshot is bug-only, so the flip to `feature` takes it with it:
   * its checkbox disappears, and an attachment nobody can see or untick must
   * not ride along on the report.
   */
  const handleFlipKind = useCallback(() => {
    kindOverridden.current = true;
    const next = otherKind(kindRef.current);
    if (next === 'feature') void handleCanvasToggle(false);
    setKind(next);
  }, [handleCanvasToggle]);

  if (!open) return null;

  const copy = FEEDBACK_COPY[kind];
  const analysed = analysisState === 'ready' && analysis !== null;
  const showAi = capabilities?.aiAvailable === true;
  const canvasShot = attachments[0] ?? null;
  const restlinkLabel = filingAnyway
    ? 'Hide the new-issue form'
    : fixState === 'current'
      ? 'Report it as a regression'
      : 'File it as a new issue anyway';
  const primaryAction = collapsed ? handleTakeoverPrimary : () => void submit();

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
            The kind switch lives here whenever the analysis panel is not
            showing its own copy of it — with `feedback.aiAssist` off (the
            shipped default) that panel never renders, and this is the only way
            to reach the feature-request template from a canvas.
          */}
          {!(showAi && analysed) && (
            <button
              type="button"
              className="feedback__check-act feedback__flip"
              onClick={handleFlipKind}
              disabled={busy}
            >
              Not right? Make it a {otherKind(kind)}
            </button>
          )}
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
              onFlipKind={handleFlipKind}
              onJump={handleJump}
              errorMessage={analysisError ?? undefined}
              providerLabel={capabilities?.aiProviderLabel ?? null}
              onOpenIssue={openIssue}
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

            <div className={`feedback__field${imagesUrged ? ' feedback__field--urged' : ''}`}>
              <span className="feedback__group-label">Images</span>
              {canCaptureCanvas && (
                <label className="feedback__checkbox">
                  <input
                    type="checkbox"
                    checked={includeCanvasScreenshot}
                    onChange={(e) => void handleCanvasToggle(e.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    Attach a screenshot of the canvas{' '}
                    {domain && (
                      <span className="feedback__hint">
                        ({domain.layer}/{domain.domain}, {domain.stage})
                      </span>
                    )}
                  </span>
                </label>
              )}
              {canvasShot && (
                <div className="feedback__attached" role="status">
                  {canvasShot.onClipboard
                    ? 'Copied to your clipboard — paste it into the Screenshot box on GitHub.'
                    : 'Attached. Your clipboard refused it, so it is saved to a file the notification can reveal.'}
                </div>
              )}
              {/*
                Standing, and deliberately unconditional: GitHub takes no image
                through a prefilled form, so every image but this one is the
                user's own paste or drop on that page. Saying it once here beats
                a picker that could only hand them the same job back.
              */}
              <p className="feedback__note">
                Any other images are added on the GitHub page: click the Screenshot box there and
                paste or drag them in.
              </p>
              {screenshotError && (
                <div className="feedback__status" role="status">
                  {screenshotError}
                </div>
              )}
            </div>

            <DiagnosticsChips
              view={diagnostics}
              included={includeDiagnostics}
              onToggle={() => setIncludeDiagnostics((current) => !current)}
            />
          </div>

          {status && (
            <div className="feedback__status" role="status">
              {status}
            </div>
          )}
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
