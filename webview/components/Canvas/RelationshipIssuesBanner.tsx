/**
 * RelationshipIssuesBanner — the logical canvas's "N relationships need
 * attention" strip (issue #133).
 *
 * The host sends the relationship findings that concern this domain on every
 * editable logical payload (`DisplayDomain.relationshipIssues`). Three of them
 * cannot be seen on the line itself and stop a relationship from meaning what
 * it says: REL003 (an endpoint model is missing from the model library),
 * REL004 (an endpoint column is missing) and REL008 (a model file entry could
 * not be read and was skipped or defaulted). While any is present, this strip
 * offers **Repair Relationships…**, which posts `repairRelationships`; the
 * command never changes these (only the user can say what a relationship to
 * something missing should be) — it lists each with **Open File**, beside
 * any automatic fixes it previews before writing. A diagram in
 * the older (v4) format is never changed by that command, so there the strip
 * points at the migration instead of offering it.
 *
 * Duplicates, one-side copies and direction doubts (REL001 / REL002 / REL006)
 * are flagged on the edge instead (FkEdge's "?" badge). Never on the physical
 * stage, a read-only payload or an empty diagram. The × hides it until the
 * set of findings changes.
 */

import React, { useState } from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import type { DisplayRelationshipIssue } from '@erd-studio/core';
import { countAffectedRelationships } from '../../../src/types/relationshipIssues';
import './RelationshipIssuesBanner.css';

/** The finding codes the banner speaks for. */
export const BANNER_ISSUE_CODES: ReadonlyArray<DisplayRelationshipIssue['code']> = ['REL003', 'REL004', 'REL008'];

/** The findings the banner counts, in the order the host sent them. */
export function bannerIssues(issues: readonly DisplayRelationshipIssue[] | undefined): DisplayRelationshipIssue[] {
  return (issues ?? []).filter((issue) => BANNER_ISSUE_CODES.includes(issue.code));
}

/** What the banner says instead of offering a repair, on a diagram in the older (v4) format. */
export const OLDER_FORMAT_HINT =
  'This diagram is in the older format, which Repair Relationships… does not change — hover for what each needs, and run "ERD Studio: Migrate Domains to Central Model Store" to bring it up to date.';

/**
 * "1 relationship needs attention" / "N relationships need attention".
 * `count` is relationships (`countAffectedRelationships`), never findings:
 * one relationship missing both its columns is one, not two.
 */
export function bannerHeadline(count: number): string {
  return count === 1 ? '1 relationship needs attention' : `${count} relationships need attention`;
}

export const RelationshipIssuesBanner: React.FC = () => {
  const domain = useEditorStore((s) => s.domain);
  const send = useSend();
  // The findings the user hid the strip for; a different set shows it again.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  if (!domain || domain.stage !== 'logical' || domain.readOnly || domain.models.length === 0) { return null; }
  const issues = bannerIssues(domain.relationshipIssues);
  if (issues.length === 0) { return null; }
  const signature = issues.map((i) => `${i.code}|${i.link ?? ''}|${i.message}`).join('\n');
  const olderFormat = domain.schemaVersion < 5;
  if (dismissedFor === signature) { return null; }

  return (
    <div className="relationship-issues-banner" role="status">
      <span className="relationship-issues-banner__icon" aria-hidden="true">&#9888;</span>
      <span
        className="relationship-issues-banner__text"
        title={issues.map((i) => `${i.code}: ${i.message}`).join('\n')}
      >
        {bannerHeadline(countAffectedRelationships(issues))}
      </span>
      {olderFormat ? (
        // Repair Relationships… does not change a diagram in the older
        // (inline-model) format, so it is not offered here: it would only
        // report that it cannot help.
        <span className="relationship-issues-banner__text">{OLDER_FORMAT_HINT}</span>
      ) : (
        <button
          type="button"
          className="relationship-issues-banner__action"
          onClick={() => send({ type: 'repairRelationships' })}
        >
          Repair Relationships…
        </button>
      )}
      <button
        type="button"
        className="relationship-issues-banner__dismiss"
        onClick={() => setDismissedFor(signature)}
        aria-label="Hide until something changes"
        title="Hide until something changes"
      >
        &times;
      </button>
    </div>
  );
};
