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

import type { FeedbackDiagnosticsView } from '../../../src/types/feedback';

export interface DiagnosticsChipsProps {
  /** Host-supplied chips and exact text, or null before the first `feedbackContext`. */
  view: FeedbackDiagnosticsView | null;
  /** Whether the diagnostics are on the report. */
  included: boolean;
  /** Flip `included`. */
  onToggle: () => void;
}

export function DiagnosticsChips({ view, included, onToggle }: DiagnosticsChipsProps) {
  if (!view) return null;

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
    </div>
  );
}
