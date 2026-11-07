/**
 * DiagnosticsChips — the "attached automatically" block of the Feedback dialog.
 *
 * Diagnostics ride along by default, so the dialog has to be honest about what
 * they contain: the chips summarise them at a glance, the disclosure shows the
 * byte-for-byte text the host would put in the issue, and the toggle takes them
 * off the report without hiding what was on offer.
 *
 * The view (chips + text) is built by the host — the webview never reconstructs
 * diagnostics, so a chip can never disagree with the text below it.
 */

import { FEEDBACK_LOG_LABEL, FEEDBACK_LOG_NOTE, type FeedbackDiagnosticsView } from '../../../src/types/feedback';

export interface DiagnosticsChipsProps {
  /** Host-supplied chips and exact text, or null before the first `feedbackContext`. */
  view: FeedbackDiagnosticsView | null;
  /** Whether the diagnostics are on the report. */
  included: boolean;
  /** Flip `included`. */
  onToggle: () => void;
  /** Whether the recent ERD Studio log rides along (opt-in, off by default). */
  includeLog?: boolean;
  /** Flip `includeLog`. Absent: the log box is not offered. */
  onToggleLog?: () => void;
}

export function DiagnosticsChips({ view, included, onToggle, includeLog = false, onToggleLog }: DiagnosticsChipsProps) {
  if (!view) return null;
  const logLines = view.log ?? [];
  // Offered only with something to add, and only while diagnostics are on the report (the log rides in them).
  const offerLog = onToggleLog !== undefined && logLines.length > 0;

  return (
    <div className="feedback__diagnostics">
      <div className="feedback__diagnostics-top">
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M8 7.4v3.4M8 5.3h.01" />
        </svg>
        <span>Attached automatically</span>
        <button
          type="button"
          className="feedback__revert feedback__diagnostics-toggle"
          onClick={onToggle}
        >
          {included ? 'remove' : 'put back'}
        </button>
      </div>

      <div className={`feedback__chips${included ? '' : ' feedback__chips--muted'}`}>
        {view.chips.map((chip) => (
          <span
            key={chip.label}
            className={`feedback__chip${chip.tone === 'error' ? ' feedback__chip--error' : ''}`}
          >
            {chip.label}
          </span>
        ))}
      </div>

      <details className="feedback__details">
        <summary>See the exact text</summary>
        <pre className="feedback__pre">{view.text}</pre>
      </details>

      {offerLog && (
        <div className={`feedback__log${included ? '' : ' feedback__log--muted'}`}>
          <label className="feedback__log-option">
            <input
              type="checkbox"
              className="feedback__log-checkbox"
              checked={included && includeLog}
              disabled={!included}
              onChange={onToggleLog}
            />
            <span>{FEEDBACK_LOG_LABEL} ({logLines.length} line{logLines.length === 1 ? '' : 's'})</span>
          </label>
          <p className="feedback__note">{FEEDBACK_LOG_NOTE}</p>
          {included && includeLog && (
            <pre className="feedback__pre feedback__log-pre" aria-label="Log lines added to the report">{logLines.join('\n')}</pre>
          )}
        </div>
      )}
    </div>
  );
}
