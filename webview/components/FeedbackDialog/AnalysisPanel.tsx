/**
 * AnalysisPanel — the optional assist panel above the form.
 *
 * It renders only when a model is actually configured; with no tier the whole
 * panel is absent and the dialog is exactly the one it was before, because
 * assistance here is never load-bearing.
 *
 * Everything it shows is a suggestion. The verdict is one click from being
 * flipped, and the readiness meter is computed locally from what is in the
 * dialog right now — the model supplies only the prose for the unmet checks,
 * so attaching an image moves the bar with no round trip.
 */

import type {
  DuplicateCandidate,
  FeedbackAnalysis,
  FeedbackKind,
  ReadinessResult,
  ReadinessTarget,
} from '../../../src/types/feedback';
import {
  FEEDBACK_COPY,
  READINESS_GOOD_PCT,
  otherKind,
  pickTakeoverDuplicate,
  relatedDuplicates,
} from '../../../src/types/feedback';

export interface AnalysisPanelProps {
  state: 'idle' | 'thinking' | 'ready' | 'error';
  analysis: FeedbackAnalysis | null;
  /** Locally computed — never returned by the model. */
  readiness: ReadinessResult;
  kind: FeedbackKind;
  onFlipKind: () => void;
  /** Focus (or highlight) whatever the unmet check is about. */
  onJump: (target: ReadinessTarget) => void;
  errorMessage?: string;
  /** "Copilot", or the endpoint's hostname. */
  providerLabel: string | null;
  /** Open one of the possibly-related issues on GitHub. */
  onOpenIssue: (candidate: DuplicateCandidate) => void;
  /**
   * True while the first run on this machine still has to be asked for. The
   * panel then offers a button instead of running on the debounce, because the
   * tier is the user's own model and VS Code raises its access dialog on the
   * back of this request — that has to follow something they pressed.
   */
  needsPriming: boolean;
  /**
   * The line under the primer button, saying why it is there: VS Code's access
   * dialog on tier 1, or "this text was filled in for you" when the dialog was
   * opened with a description the user has not touched.
   */
  primerNote: string;
  /** False while the description is too short to be worth a request. */
  canAnalyse: boolean;
  /** Run the first analysis. Only ever called from the primer button. */
  onAnalyse: () => void;
}

/** Tick / warning glyph beside a readiness row. */
function CheckIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M3.4 8.4 6.4 11.4 12.6 5" />
    </svg>
  ) : (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.1v3.6M8 11h.01" />
    </svg>
  );
}

export function AnalysisPanel({
  state,
  analysis,
  readiness,
  kind,
  onFlipKind,
  onJump,
  errorMessage,
  providerLabel,
  onOpenIssue,
  needsPriming,
  primerNote,
  canAnalyse,
  onAnalyse,
}: AnalysisPanelProps) {
  const ready = state === 'ready' && analysis !== null;
  // The primer replaces the idle prose, never a result or a request in flight:
  // a failed first run has to leave the button there, or a dismissed VS Code
  // dialog would kill the feature silently for the rest of the session.
  const showPrimer = needsPriming && !ready && state !== 'thinking';
  const related = analysis ? relatedDuplicates(analysis.duplicates) : [];
  const takeover = analysis ? pickTakeoverDuplicate(analysis.duplicates) : null;

  return (
    <>
      <div className="feedback__ai">
        <div className="feedback__ai-head">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            <path d="M8 1.9 9.6 6 13.8 7.6 9.6 9.2 8 13.3 6.4 9.2 2.2 7.6 6.4 6Z" />
          </svg>
          <span>{providerLabel ?? 'Analysis'}</span>
          <span className="feedback__ai-note">
            {state === 'thinking' ? 'analysing' : 'reads only what you typed'}
          </span>
        </div>

        <div className="feedback__ai-body">
          {state === 'thinking' && (
            <div className="feedback__thinking">
              <span className="feedback__pulse" />
              <span>Reading your description and the open issues…</span>
            </div>
          )}

          {state === 'error' && (
            <div className="feedback__error">
              {errorMessage ?? 'The analysis could not be completed.'}
            </div>
          )}

          {showPrimer && (
            <div className="feedback__primer">
              <button
                type="button"
                className="feedback__button feedback__button--primary feedback__primer-button"
                onClick={onAnalyse}
                disabled={!canAnalyse}
              >
                Analyse this for me
              </button>
              <span className="feedback__primer-note">{primerNote}</span>
            </div>
          )}

          {!showPrimer && !ready && state !== 'thinking' && state !== 'error' && (
            <div className="feedback__idle">
              Describe the problem above and the analysis will pick the type, draft a title, pull out
              the steps and check whether it has already been reported.
            </div>
          )}

          {ready && analysis && (
            <>
              <div className="feedback__verdict">
                <span className="feedback__verdict-chip">
                  {FEEDBACK_COPY[kind].verdict}
                  <span className="feedback__verdict-confidence">
                    {Math.round(analysis.confidence * 100)}%
                  </span>
                </span>
                <button type="button" className="feedback__check-act" onClick={onFlipKind}>
                  Not right? Make it a {otherKind(kind)}
                </button>
              </div>

              <div className="feedback__meter">
                <div className="feedback__meter-row">
                  <span>Ready to file</span>
                  <span>{readiness.score}%</span>
                </div>
                <div className="feedback__meter-track">
                  <div
                    className={`feedback__meter-fill${
                      readiness.score >= READINESS_GOOD_PCT ? ' feedback__meter-fill--good' : ''
                    }`}
                    style={{ width: `${readiness.score}%` }}
                  />
                </div>
              </div>

              <div className="feedback__checks">
                {readiness.checks.map((check) => (
                  <div
                    key={check.label}
                    className={`feedback__check ${
                      check.ok ? 'feedback__check--ok' : 'feedback__check--warn'
                    }`}
                  >
                    <span className="feedback__check-icon">
                      <CheckIcon ok={check.ok} />
                    </span>
                    <span>
                      <b className="feedback__check-label">{check.label}</b>
                      {check.why ? ` — ${check.why}` : ''}
                      {check.act && check.target && (
                        <button
                          type="button"
                          className="feedback__check-act"
                          onClick={() => onJump(check.target as ReadinessTarget)}
                        >
                          {check.act}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {ready && related.length > 0 && (
        <div className="feedback__dupes">
          <div className="feedback__dupes-head">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.2" />
              <path d="M10.2 10.2 14 14" />
            </svg>
            <span>{takeover ? 'Also possibly related' : 'Possibly related — worth a glance'}</span>
          </div>
          {related.map((candidate) => (
            <button
              type="button"
              key={candidate.number}
              className="feedback__dupe"
              onClick={() => onOpenIssue(candidate)}
            >
              <span className="feedback__dupe-top">
                <span className="feedback__dupe-num">#{candidate.number}</span>
                <span className="feedback__dupe-title">{candidate.title}</span>
                <span className="feedback__dupe-match">{Math.round(candidate.match * 100)}%</span>
                <span
                  className={`feedback__dupe-state ${
                    candidate.state === 'open'
                      ? 'feedback__dupe-state--open'
                      : 'feedback__dupe-state--closed'
                  }`}
                >
                  {candidate.state === 'open'
                    ? 'open'
                    : candidate.stateReason === 'not_planned'
                      ? 'not planned'
                      : 'fixed'}
                </span>
              </span>
              <span className="feedback__dupe-why">{candidate.why}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
