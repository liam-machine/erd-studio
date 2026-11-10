/**
 * The banner across the top of the preview (docs/dev/draft-first.md §2.1):
 * the headline and detail (final text from the host), the notice line, the
 * Change options… link, the notes count with Show details and the Show
 * Import Report link (an import's draft), the switcher,
 * and the buttons — exactly one primary (`banner.primary`), the starts the
 * banner shows beside it, Keep as a quiet button when it is not the primary,
 * More ways to start ▾ for the rest, and Discard.
 */

import type { DraftOtherStart, DraftView } from '../../src/types/draft';
import { ScopeSwitcher } from './ScopeSwitcher';
import { OtherStartsMenu } from './OtherStartsMenu';
import { CHANGE_OPTIONS, DISCARD, SHOW_DETAILS, SHOW_IMPORT_REPORT, notesLine } from '../lib/wording';
import { GUIDE_TARGETS } from '../../src/types/onboardingGuide';

export interface DraftBannerProps {
  view: DraftView;
  /** A line under the detail (the host's `idle` notice, else the banner's own). */
  notice?: string;
  /** The status line while the host works or the page lays out (`Saving…`). */
  status?: string;
  /** The host is working on an answer: every choice is disabled. */
  busy: boolean;
  onKeep(): void;
  onChangeOptions(): void;
  onDiscard(): void;
  onOtherStart(start: DraftOtherStart): void;
  onScope(scopeId: string): void;
  onShowDetails(): void;
  /** The banner's Show Import Report link (only drawn when `banner.importReport`). */
  onImportReport(): void;
}

export function DraftBanner({
  view, notice, status, busy, onKeep, onChangeOptions, onDiscard, onOtherStart, onScope, onShowDetails, onImportReport,
}: DraftBannerProps) {
  const { banner, otherStarts, summary } = view;
  const labelOf = (id: DraftOtherStart) => otherStarts.find((s) => s.id === id)?.label;
  const keepable = banner.keepLabel !== undefined;
  const primaryIsKeep = banner.primary === 'keep';
  const primaryStart = primaryIsKeep ? undefined : (banner.primary as DraftOtherStart);
  const primaryLabel = primaryIsKeep ? banner.keepLabel : labelOf(primaryStart as DraftOtherStart);

  // Beside the primary: the starts the banner names (each offered by the draft), never the primary again.
  const shown = banner.shownStarts.filter((id) => id !== primaryStart && labelOf(id) !== undefined);
  const inMenu = otherStarts.filter((s) => s.id !== primaryStart && !shown.includes(s.id));
  const counts = notesLine(summary.notes, summary.leftOut);
  const hasDetails = view.details.length > 0;
  const importReport = banner.importReport === true;
  const showSecondLine = banner.changeOptions || counts !== '' || hasDetails || importReport;

  return (
    <header className="draft-banner">
      <div className="draft-banner__text" data-guide={GUIDE_TARGETS.draftBanner}>
        <h1 className="draft-banner__headline">{banner.headline}</h1>
        <p className="draft-banner__detail">{banner.detail}</p>
        {showSecondLine && (
          <p className="draft-banner__links">
            {banner.changeOptions && (
              <button type="button" className="draft-banner__link" disabled={busy} onClick={onChangeOptions}>
                {CHANGE_OPTIONS}
              </button>
            )}
            {banner.changeOptions && (counts !== '' || hasDetails) && (
              <span className="draft-banner__separator" aria-hidden="true"> · </span>
            )}
            {counts !== '' && <span className="draft-banner__counts">{hasDetails ? `${counts}: ` : counts}</span>}
            {hasDetails && (
              <button type="button" className="draft-banner__link" onClick={onShowDetails}>
                {SHOW_DETAILS}
              </button>
            )}
            {importReport && (banner.changeOptions || counts !== '' || hasDetails) && (
              <span className="draft-banner__separator" aria-hidden="true"> · </span>
            )}
            {importReport && (
              <button type="button" className="draft-banner__link" onClick={onImportReport}>
                {SHOW_IMPORT_REPORT}
              </button>
            )}
          </p>
        )}
        {notice && <p className="draft-banner__notice" role="status">{notice}</p>}
      </div>
      <div className="draft-banner__controls">
        {view.scopes && <ScopeSwitcher scopes={view.scopes} disabled={busy} onScope={onScope} />}
        <div className="draft-banner__actions">
          {status && <span className="draft-banner__status" role="status" aria-live="polite">{status}</span>}
          {primaryLabel !== undefined && (
            <button
              type="button"
              className="draft-button draft-button--primary"
              data-guide={primaryIsKeep ? GUIDE_TARGETS.draftKeep : GUIDE_TARGETS.draftPrimary}
              disabled={busy}
              onClick={() => (primaryIsKeep ? onKeep() : onOtherStart(primaryStart as DraftOtherStart))}
            >
              {primaryLabel}
            </button>
          )}
          {shown.map((id) => (
            <button
              key={id}
              type="button"
              className="draft-button draft-button--secondary"
              data-guide={id === 'guide' ? GUIDE_TARGETS.draftGuideStart : undefined}
              disabled={busy}
              onClick={() => onOtherStart(id)}
            >
              {labelOf(id)}
            </button>
          ))}
          {keepable && !primaryIsKeep && (
            <button type="button" className="draft-button draft-button--quiet" data-guide={GUIDE_TARGETS.draftKeep} disabled={busy} onClick={onKeep}>
              {banner.keepLabel}
            </button>
          )}
          <OtherStartsMenu items={inMenu} disabled={busy} onStart={onOtherStart} />
          <button type="button" className="draft-button draft-button--secondary" disabled={busy} onClick={onDiscard}>
            {DISCARD}
          </button>
        </div>
      </div>
    </header>
  );
}
