/**
 * FeedbackFooter — the route line and the action row.
 *
 * The route line is the dialog's honesty about what the primary button will
 * actually do: file nothing and comment on an existing thread, open the
 * Extensions view, or open a prefilled form the user submits themselves. It is
 * computed by `footerRoute()` in src/types/feedback.ts and arrives here as a
 * bolded lead plus the rest of the sentence, so no markup lives in a string.
 *
 * The auth pill is read-only. The handle comes from a silent session that only
 * powers the My Reports view; the dialog never asks anyone to sign in, because
 * nothing here needs write access to the user's GitHub account.
 */

import type { FooterRoute } from '../../../src/types/feedback';

export interface FeedbackFooterProps {
  /** Bolded lead + rest, and the primary label, from `footerRoute()`. */
  route: FooterRoute;
  primaryLabel: string;
  primaryDisabled: boolean;
  busy: boolean;
  onCancel: () => void;
  onPrimary: () => void;
  onCopyReport: () => void;
  /** GitHub handle from a silent session, or null when there is none. */
  githubHandle: string | null;
}

export function FeedbackFooter(props: FeedbackFooterProps) {
  const { route, primaryLabel, primaryDisabled, busy, onCancel, onPrimary, onCopyReport, githubHandle } =
    props;

  return (
    <div className="feedback__footer">
      <div className="feedback__route">
        <svg
          className="feedback__route-icon"
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5.2v3.4M8 10.6h.01" />
        </svg>
        <span>
          <b className="feedback__route-lead">{route.lead}</b>
          {route.rest}
        </span>
      </div>

      <div className="feedback__actions">
        {githubHandle ? (
          <span className="feedback__auth">Signed in as @{githubHandle}</span>
        ) : (
          <span className="feedback__spacer" />
        )}

        <button type="button" className="feedback__button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>

        <button
          type="button"
          className="feedback__button feedback__button--ghost"
          onClick={onCopyReport}
          disabled={busy}
        >
          Copy report
        </button>

        <button
          type="button"
          className="feedback__button feedback__button--primary"
          onClick={onPrimary}
          disabled={primaryDisabled || busy}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
