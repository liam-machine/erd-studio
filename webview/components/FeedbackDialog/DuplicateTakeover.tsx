/**
 * DuplicateTakeover — what replaces the new-issue form when the analysis is
 * confident (>= 70%) that this report already exists.
 *
 * A warning does not stop anyone filing a duplicate; an easier alternative
 * does. So each of GitHub's three outcomes gets its own panel rather than one
 * generic "are you sure": an open thread offers to carry the description over
 * as a comment, a completed one compares the fix version with the running one
 * (behind → update, level → this is a regression and filing is correct, and
 * — the common case — no recorded fix version at all → say so and let them
 * file), and a `not_planned` one shows the reasoning and points at the thread.
 *
 * Nothing here discards what the user wrote — every route either carries the
 * description somewhere or re-expands the form.
 */

import type { DuplicateCandidate, DuplicateMode } from '../../../src/types/feedback';

/**
 * How the fix version compares with the running one, for `fixed` mode.
 *
 * `unknown` is the common case, not an edge: GitHub only surfaces the version a
 * fix shipped in when the issue carries a milestone or a `shipped-in:` label.
 * It is kept distinct from `current` because "you already have the fix" and
 * "we could not tell" call for different advice — asserting the first when the
 * second is true files a regression against a fix the user may never have had.
 */
export type FixState = 'outdated' | 'current' | 'unknown';

export interface DuplicateTakeoverProps {
  candidate: DuplicateCandidate;
  mode: DuplicateMode;
  /** For `fixed` mode: outdated, current, or not comparable. */
  fixState: FixState;
  runningVersion: string;
  /** The panel's primary action; the footer's primary button runs the same thing. */
  onPrimary: () => void;
  /** The panel's secondary action. */
  onGhost: () => void;
  /** Abandon the redirect and expand the new-issue form (the outdated ghost). */
  onFileAnyway: () => void;
  /** Open the issue on GitHub without filing or commenting. */
  onOpenIssue: (candidate: DuplicateCandidate) => void;
}

/** Panel heading per mode, keyed on whether the fix is already installed. */
function headFor(mode: DuplicateMode, fixState: FixState): string {
  if (mode === 'open') return 'Someone has already reported this';
  if (mode === 'declined') return 'This has been asked for before';
  return fixState === 'outdated'
    ? "This is already fixed — you're on an older version"
    : 'This was fixed once already';
}

export function DuplicateTakeover({
  candidate,
  mode,
  fixState,
  runningVersion,
  onPrimary,
  onGhost,
  onFileAnyway,
  onOpenIssue,
}: DuplicateTakeoverProps) {
  const outdated = fixState === 'outdated';
  const modifier =
    mode === 'fixed'
      ? ' feedback__takeover--fixed'
      : mode === 'declined'
        ? ' feedback__takeover--declined'
        : '';

  const primaryLabel =
    mode === 'open'
      ? `Add my details to #${candidate.number}`
      : mode === 'declined'
        ? `Read the discussion on #${candidate.number}`
        : fixState === 'outdated'
          ? 'Update ERD Studio'
          : fixState === 'current'
            ? 'Report it as a regression'
            : 'File it anyway';

  const ghostLabel =
    mode === 'open'
      ? `Just open #${candidate.number}`
      : mode === 'declined'
        ? 'Add my case to the thread'
        : outdated
          ? `It still happens on ${runningVersion}`
          : `Open #${candidate.number}`;

  const onGhostClick = mode === 'fixed' && outdated ? onFileAnyway : onGhost;

  return (
    <div className={`feedback__takeover${modifier}`}>
      <div className="feedback__takeover-head">
        {mode === 'fixed' ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
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
        )}
        <span>{headFor(mode, fixState)}</span>
      </div>

      <div className="feedback__takeover-body">
        <button
          type="button"
          className="feedback__takeover-issue"
          onClick={() => onOpenIssue(candidate)}
        >
          <span className="feedback__takeover-num">#{candidate.number}</span>
          <span className="feedback__takeover-title">{candidate.title}</span>
          <span className="feedback__takeover-match">
            {Math.round(candidate.match * 100)}% match
          </span>
        </button>

        <div className="feedback__takeover-why">{candidate.why}</div>

        <div className="feedback__takeover-meta">
          {mode === 'open' && (
            <>
              <span className="feedback__verchip feedback__verchip--dim">open</span>
              <span className="feedback__verchip feedback__verchip--dim">
                {candidate.comments ?? 0} comments
              </span>
              {candidate.assigned && (
                <span className="feedback__verchip feedback__verchip--fix">being worked on</span>
              )}
            </>
          )}
          {mode === 'fixed' &&
            (fixState === 'unknown' ? (
              // No `you have X` on its own: with nothing to compare it against
              // it reads as the result of a comparison that never happened.
              <span className="feedback__verchip feedback__verchip--dim">
                fix version not recorded
              </span>
            ) : (
              <>
                <span className="feedback__verchip feedback__verchip--fix">
                  fixed in {candidate.fixedIn}
                </span>
                <span
                  className={`feedback__verchip ${
                    outdated ? 'feedback__verchip--old' : 'feedback__verchip--dim'
                  }`}
                >
                  you have {runningVersion}
                </span>
              </>
            ))}
          {mode === 'declined' && (
            <span className="feedback__verchip feedback__verchip--dim">closed · not planned</span>
          )}
        </div>

        {mode === 'open' && (
          <div className="feedback__takeover-why">
            Adding your details there helps more than a new issue: it keeps the discussion in one
            place and bumps it for everyone watching.
          </div>
        )}

        {mode === 'fixed' && fixState === 'outdated' && (
          <div className="feedback__takeover-why">
            Updating should be all you need — no issue to file. If it still happens on{' '}
            {candidate.fixedIn ?? 'the fixed version'} or later, that is a <b>regression</b> and
            worth reporting separately.
          </div>
        )}

        {mode === 'fixed' && fixState === 'current' && (
          <div className="feedback__takeover-why">
            You are already on a version that has the fix, so this looks like a <b>regression</b>.
            Filing it fresh is the right move — reference #{candidate.number} in the description.
          </div>
        )}

        {mode === 'fixed' && fixState === 'unknown' && (
          <div className="feedback__takeover-why">
            The version this shipped in isn&apos;t recorded, so check you are on the latest ERD
            Studio first — if it still happens there, file it fresh and reference #
            {candidate.number}.
          </div>
        )}

        {mode === 'declined' && (
          <>
            {candidate.closingNote && (
              <div className="feedback__takeover-why">
                <b>Why it was closed:</b> {candidate.closingNote}
              </div>
            )}
            <div className="feedback__takeover-why">
              If your situation is different, say so on the thread — reopening beats a second issue.
            </div>
          </>
        )}

        <div className="feedback__takeover-acts">
          <button
            type="button"
            className="feedback__button feedback__button--primary"
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            className="feedback__button feedback__button--ghost"
            onClick={onGhostClick}
          >
            {ghostLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
