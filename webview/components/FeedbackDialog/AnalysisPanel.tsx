/**
 * AnalysisPanel — the optional assist panel above the form.
 *
 * It renders whenever *some* destination could do the analysis — not only when
 * one currently resolves. That difference matters: pinning a provider that is
 * unavailable on this machine has to leave the picker on screen, or the switch
 * that caused the problem takes the way back down with it. With nothing
 * configured at all the whole panel is absent and the dialog is exactly the one
 * it was before, because assistance here is never load-bearing.
 *
 * Everything it shows is a suggestion. The kind lives in the dialog header (a
 * permanent segmented control, reachable with or without a model); the
 * readiness meter is computed locally from what is in the dialog right now, and
 * the model supplies only the prose for the unmet checks.
 */

import type {
  DuplicateCandidate,
  FeedbackAiOption,
  FeedbackAiProviderChoice,
  FeedbackAnalysis,
  FeedbackKind,
  ReadinessResult,
  ReadinessTarget,
} from '../../../src/types/feedback';
import {
  FEEDBACK_COPY,
  READINESS_GOOD_PCT,
  kindSplit,
  pickTakeoverDuplicate,
  relatedDuplicates,
} from '../../../src/types/feedback';

export interface AnalysisPanelProps {
  state: 'idle' | 'thinking' | 'ready' | 'error';
  analysis: FeedbackAnalysis | null;
  /** Locally computed — never returned by the model. */
  readiness: ReadinessResult;
  /**
   * The kind the dialog is currently on. The split below is always the model's
   * own answer, so this is only used to notice that the user has overruled it
   * and say so, rather than leaving two panels quietly disagreeing.
   */
  kind: FeedbackKind;
  /** Focus (or highlight) whatever the unmet check is about. */
  onJump: (target: ReadinessTarget) => void;
  errorMessage?: string;
  /** "Copilot", the endpoint's hostname, or "<relay> → <provider>". Null when nothing resolves. */
  providerLabel: string | null;
  /** The pinned destination, or `auto`. */
  provider: FeedbackAiProviderChoice;
  /** Every destination the picker offers, available or not. */
  providerOptions: FeedbackAiOption[];
  onProviderChange: (provider: FeedbackAiProviderChoice) => void;
  /** False when the pinned destination cannot run here — the picker stays, the analysis does not. */
  available: boolean;
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
  onJump,
  errorMessage,
  providerLabel,
  provider,
  providerOptions,
  onProviderChange,
  available,
  onOpenIssue,
  needsPriming,
  primerNote,
  canAnalyse,
  onAnalyse,
}: AnalysisPanelProps) {
  const ready = available && state === 'ready' && analysis !== null;
  // The primer replaces the idle prose, never a result or a request in flight:
  // a failed first run has to leave the button there, or a dismissed VS Code
  // dialog would kill the feature silently for the rest of the session.
  //
  // `canAnalyse` is part of the condition rather than only the disabled state:
  // with nothing written yet there is nothing to analyse, and a greyed-out
  // button whose note talks about VS Code's dialog reads as "this feature is
  // broken" rather than "write something first". The idle prose below says
  // exactly what to do, so show that until there is something to send.
  const showPrimer = available && needsPriming && canAnalyse && !ready && state !== 'thinking';
  const related = ready && analysis ? relatedDuplicates(analysis.duplicates) : [];
  const takeover = analysis ? pickTakeoverDuplicate(analysis.duplicates) : null;
  const selected = providerOptions.find((option) => option.id === provider) ?? null;

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
          {/*
            A picker rather than a label. Someone with Copilot could not
            previously reach any other destination — the resolver tried theirs
            first and stopped — so "I have Copilot but would rather not spend it
            triaging my own bug report" was unsayable. Unavailable rows stay in
            the list, disabled, with their reason in the note below.
          */}
          <label className="feedback__ai-picker">
            <span className="feedback__sr-only">Which model analyses this</span>
            <select
              className="feedback__ai-select"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as FeedbackAiProviderChoice)}
            >
              {providerOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.id === 'auto' && providerLabel
                    ? `Automatic — ${providerLabel}`
                    : option.label}
                  {option.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </label>
          <span className="feedback__ai-note">
            {state === 'thinking' && available ? 'analysing' : 'reads only what you typed'}
          </span>
        </div>

        <div className="feedback__ai-body">
          {/*
            The pinned destination cannot run here. Never silently fall back to
            another one — the point of pinning is that the text goes where the
            user said and nowhere else — so say what is wrong and leave the
            picker above as the fix.
          */}
          {!available && (
            <div className="feedback__idle">
              No analysis will run.{selected?.note ? ` ${selected.note}` : ''} Pick another
              destination above, or file the report as it is — nothing here is required.
            </div>
          )}

          {available && state === 'thinking' && (
            <div className="feedback__thinking">
              <span className="feedback__pulse" />
              <span>Reading your description and the open issues…</span>
            </div>
          )}

          {available && state === 'error' && (
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

          {available && !showPrimer && !ready && state !== 'thinking' && state !== 'error' && (
            <div className="feedback__idle">
              Describe the problem above and the analysis will pick the type, draft a title, pull out
              the steps and check whether it has already been reported.
            </div>
          )}

          {ready && analysis && (
            <>
              {/*
                Both sides, always, and always the model's own answer — the
                confidence belongs to what it picked, not to what the user
                subsequently chose. One chip reading "Feature request 86%" said
                nothing about how close the other side came, so a 51/49 guess
                and a near-certainty looked identical, and the case where the
                user most needs the header switch was the one case the panel
                gave them no reason to reach for it. Read-only: the control that
                changes the kind is in the header, where it is reachable whether
                or not this panel exists at all.
              */}
              <div className="feedback__verdict">
                {(() => {
                  const split = kindSplit(analysis.kind, analysis.confidence);
                  return (
                    <>
                      <span
                        className={`feedback__verdict-chip${
                          split.closeCall ? ' feedback__verdict-chip--unsure' : ''
                        }`}
                      >
                        {FEEDBACK_COPY[split.kind].verdict}
                        <span className="feedback__verdict-confidence">{split.percent}%</span>
                      </span>
                      <span className="feedback__verdict-other">
                        {FEEDBACK_COPY[split.other].verdict}
                        <span className="feedback__verdict-confidence">{split.otherPercent}%</span>
                      </span>
                      <span className="feedback__verdict-hint">
                        {kind !== split.kind
                          ? `You chose ${FEEDBACK_COPY[kind].verdict.toLowerCase()} — this is the analysis's own read`
                          : split.closeCall
                            ? 'Close call — pick one in the header'
                            : 'Change it in the header if it is wrong'}
                      </span>
                    </>
                  );
                })()}
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
