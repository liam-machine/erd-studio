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
 * command itself previews every change and asks before writing.
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
import './RelationshipIssuesBanner.css';

/** The finding codes the banner speaks for. */
export const BANNER_ISSUE_CODES: ReadonlyArray<DisplayRelationshipIssue['code']> = ['REL003', 'REL004', 'REL008'];

/** The findings the banner counts, in the order the host sent them. */
export function bannerIssues(issues: readonly DisplayRelationshipIssue[] | undefined): DisplayRelationshipIssue[] {
  return (issues ?? []).filter((issue) => BANNER_ISSUE_CODES.includes(issue.code));
}

/** "1 relationship needs attention" / "N relationships need attention". */
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
  if (dismissedFor === signature) { return null; }

  return (
    <div className="relationship-issues-banner" role="status">
      <span className="relationship-issues-banner__icon" aria-hidden="true">&#9888;</span>
      <span
        className="relationship-issues-banner__text"
        title={issues.map((i) => `${i.code}: ${i.message}`).join('\n')}
      >
        {bannerHeadline(issues.length)}
      </span>
      <button
        type="button"
        className="relationship-issues-banner__action"
        onClick={() => send({ type: 'repairRelationships' })}
      >
        Repair Relationships…
      </button>
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
