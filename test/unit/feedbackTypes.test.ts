/**
 * src/types/feedback.ts — the pure half of the feedback contract.
 *
 * These helpers are the only logic the webview and the extension host share, so
 * they are unit-tested here rather than through either end. The readiness score
 * in particular is computed locally on purpose (attaching an image must move
 * the bar with no round trip), which makes its bands worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_MIN_CHARS,
  DESCRIPTION_CLEAR_CHARS,
  DESCRIPTION_THIN_CHARS,
  DUPLICATE_RELATED_THRESHOLD,
  DUPLICATE_TAKEOVER_THRESHOLD,
  FEEDBACK_COPY,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  READINESS_MAX,
  READINESS_WEIGHTS,
  applyRegressionPrefix,
  compareVersions,
  duplicateModeFor,
  footerRoute,
  isFeedbackKind,
  isVersionOlder,
  otherKind,
  pickTakeoverDuplicate,
  readinessScore,
  relatedDuplicates,
  stripRegressionPrefix,
  type DuplicateCandidate,
  type ReadinessInput,
} from '../../src/types/feedback';

/** A duplicate candidate with only the fields a test cares about spelled out. */
function candidate(overrides: Partial<DuplicateCandidate> & { number: number; match: number }): DuplicateCandidate {
  return {
    title: `Issue #${overrides.number}`,
    why: 'Same symptom.',
    state: 'open',
    url: `https://github.com/liam-machine/erd-studio/issues/${overrides.number}`,
    ...overrides,
  };
}

/** Readiness input with everything at its "nothing supplied" value. */
function readiness(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    kind: 'bug',
    descriptionLength: 0,
    contextLength: 0,
    attachmentCount: 0,
    includeDiagnostics: false,
    ...overrides,
  };
}

const label = (input: ReadinessInput, index: number) => readinessScore(input).checks[index].label;

describe('kind helpers', () => {
  it('recognises exactly the two kinds', () => {
    expect(isFeedbackKind('bug')).toBe(true);
    expect(isFeedbackKind('feature')).toBe(true);
    for (const value of ['Bug', 'question', '', null, undefined, 0, {}]) {
      expect(isFeedbackKind(value)).toBe(false);
    }
  });

  it('flips between the two kinds', () => {
    expect(otherKind('bug')).toBe('feature');
    expect(otherKind('feature')).toBe('bug');
  });

  it('carries the issue-form template on the copy for each kind', () => {
    expect(FEEDBACK_COPY.bug.template).toBe('bug_report.yml');
    expect(FEEDBACK_COPY.feature.template).toBe('feature_request.yml');
    expect(FEEDBACK_COPY.bug.head).toBe('Report a bug');
    expect(FEEDBACK_COPY.feature.head).toBe('Request a feature');
  });
});

describe('compareVersions / isVersionOlder', () => {
  it('orders released patch versions', () => {
    expect(compareVersions('0.6.41', '0.6.44')).toBeLessThan(0);
    expect(compareVersions('0.6.44', '0.6.41')).toBeGreaterThan(0);
    expect(compareVersions('0.6.44', '0.6.44')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });

  it('reads a non-numeric segment as zero rather than NaN-comparing', () => {
    // "0.6.44-beta" must still register as 0.6.44, not as an unordered value.
    expect(compareVersions('0.6.44-beta', '0.6.44')).toBe(0);
    expect(compareVersions('x.y.z', '0.0.0')).toBe(0);
  });

  it('answers the only question the footer asks: am I behind the fix?', () => {
    expect(isVersionOlder('0.6.41', '0.6.44')).toBe(true);
    expect(isVersionOlder('0.6.44', '0.6.44')).toBe(false);
    expect(isVersionOlder('0.7.0', '0.6.44')).toBe(false);
  });
});

describe('duplicateModeFor', () => {
  it('maps state + state_reason onto the three takeovers', () => {
    expect(duplicateModeFor(candidate({ number: 1, match: 1, state: 'open' }))).toBe('open');
    expect(
      duplicateModeFor(candidate({ number: 2, match: 1, state: 'closed', stateReason: 'completed' })),
    ).toBe('fixed');
    expect(
      duplicateModeFor(candidate({ number: 3, match: 1, state: 'closed', stateReason: 'not_planned' })),
    ).toBe('declined');
  });

  it('treats a closed issue with no reason as fixed', () => {
    expect(duplicateModeFor(candidate({ number: 4, match: 1, state: 'closed' }))).toBe('fixed');
  });
});

describe('pickTakeoverDuplicate', () => {
  it('returns null when nothing reaches the takeover threshold', () => {
    expect(pickTakeoverDuplicate([])).toBeNull();
    expect(
      pickTakeoverDuplicate([candidate({ number: 1, match: DUPLICATE_TAKEOVER_THRESHOLD - 0.01 })]),
    ).toBeNull();
  });

  it('takes the threshold itself as qualifying', () => {
    expect(
      pickTakeoverDuplicate([candidate({ number: 1, match: DUPLICATE_TAKEOVER_THRESHOLD })])?.number,
    ).toBe(1);
  });

  it('picks the strongest match, and the older thread on a tie', () => {
    expect(
      pickTakeoverDuplicate([
        candidate({ number: 10, match: 0.8 }),
        candidate({ number: 11, match: 0.95 }),
      ])?.number,
    ).toBe(11);

    expect(
      pickTakeoverDuplicate([
        candidate({ number: 42, match: 0.9 }),
        candidate({ number: 7, match: 0.9 }),
      ])?.number,
    ).toBe(7);
  });
});

describe('relatedDuplicates', () => {
  it('keeps only the [0.3, 0.7) window, strongest first', () => {
    const result = relatedDuplicates([
      candidate({ number: 1, match: 0.2 }),
      candidate({ number: 2, match: DUPLICATE_RELATED_THRESHOLD }),
      candidate({ number: 3, match: 0.55 }),
      candidate({ number: 4, match: DUPLICATE_TAKEOVER_THRESHOLD }),
    ]);
    expect(result.map((d) => d.number)).toEqual([3, 2]);
  });

  it('is empty when everything is either noise or a takeover', () => {
    expect(relatedDuplicates([candidate({ number: 1, match: 0.9 })])).toEqual([]);
    expect(relatedDuplicates([candidate({ number: 1, match: 0.05 })])).toEqual([]);
  });
});

describe('applyRegressionPrefix', () => {
  it('prefixes a trimmed title', () => {
    expect(applyRegressionPrefix('  Edge vanished  ')).toBe('Regression: Edge vanished');
  });

  it('is idempotent and case-insensitive about an existing prefix', () => {
    expect(applyRegressionPrefix('Regression: Edge vanished')).toBe('Regression: Edge vanished');
    expect(applyRegressionPrefix('regression: edge vanished')).toBe('regression: edge vanished');
  });
});

describe('stripRegressionPrefix', () => {
  it('undoes exactly one prefix, whatever its case', () => {
    expect(stripRegressionPrefix('Regression: Edge vanished')).toBe('Edge vanished');
    expect(stripRegressionPrefix('regression:   Edge vanished')).toBe('Edge vanished');
    expect(stripRegressionPrefix('Regression: Regression: Edge vanished')).toBe(
      'Regression: Edge vanished',
    );
  });

  it('leaves a title that never had one alone', () => {
    expect(stripRegressionPrefix('  Edge vanished  ')).toBe('Edge vanished');
    expect(stripRegressionPrefix('Regressions are bad')).toBe('Regressions are bad');
  });

  it('round-trips with applyRegressionPrefix', () => {
    expect(stripRegressionPrefix(applyRegressionPrefix('Edge vanished'))).toBe('Edge vanished');
  });
});

describe('footerRoute', () => {
  const base = { filingAnyway: false, attachmentCount: 0, version: '0.6.41', outdated: false };

  it('hands the footer to an open duplicate', () => {
    const route = footerRoute({ ...base, duplicate: { number: 42, mode: 'open' } });
    expect(route.primaryLabel).toBe('Add to #42');
    expect(route.lead).toBe('Nothing new gets filed.');
    expect(route.rest).toBe(' Your description is posted as a comment on #42.');
  });

  it('sends an outdated user to the update, naming both versions', () => {
    const route = footerRoute({
      ...base,
      duplicate: { number: 42, mode: 'fixed', fixedIn: '0.6.44' },
      outdated: true,
    });
    expect(route.primaryLabel).toBe('Update ERD Studio');
    expect(route.lead).toBe('Already fixed in 0.6.44.');
    expect(route.rest).toBe(" Updating is quicker than filing — you're on 0.6.41.");
  });

  it('calls it a regression when the user already has the fix', () => {
    const route = footerRoute({
      ...base,
      duplicate: { number: 42, mode: 'fixed', fixedIn: '0.6.44' },
      version: '0.6.44',
    });
    expect(route.primaryLabel).toBe('Report as a regression');
    expect(route.lead).toBe('You already have the fix,');
    expect(route.rest).toBe(' so this is a regression — worth its own issue, referencing #42.');
  });

  it('asserts neither outcome when the fix version was never recorded', () => {
    // Most closed issues carry no milestone and no `shipped-in:` label, so
    // "you already have the fix" is not something we can say — and neither is
    // "you are behind", which would talk a real report out of being filed.
    const route = footerRoute({ ...base, duplicate: { number: 42, mode: 'fixed' }, versionKnown: false });
    expect(route.primaryLabel).toBe('File it anyway');
    expect(route.lead).toBe('Closed as fixed.');
    expect(route.rest).toBe(' Update first; if it still happens, file it referencing #42.');
  });

  it('keeps the two frozen fixed rows when the version IS known', () => {
    const known = { ...base, duplicate: { number: 42, mode: 'fixed' as const, fixedIn: '0.6.44' }, versionKnown: true };
    expect(footerRoute({ ...known, outdated: true }).primaryLabel).toBe('Update ERD Studio');
    expect(footerRoute({ ...known, version: '0.6.44' }).primaryLabel).toBe('Report as a regression');
  });

  it('sends a declined duplicate to the reasoning first', () => {
    const route = footerRoute({ ...base, duplicate: { number: 9, mode: 'declined' } });
    expect(route.primaryLabel).toBe('Open #9');
    expect(route.lead).toBe('Closed as not planned.');
  });

  it('falls back to the plain routes once the user files anyway', () => {
    const route = footerRoute({
      ...base,
      duplicate: { number: 42, mode: 'open' },
      filingAnyway: true,
    });
    expect(route.primaryLabel).toBe('Open GitHub issue');
    expect(route.lead).toBe('Opens the prefilled form.');
  });

  it('explains the clipboard hand-off for one image and for several', () => {
    const one = footerRoute({ ...base, duplicate: null, attachmentCount: 1 });
    expect(one.rest).toBe(' Your image goes on the clipboard — paste it into the Screenshot box.');

    const many = footerRoute({ ...base, duplicate: null, attachmentCount: 3 });
    expect(many.rest).toBe(
      ' The first of 3 images goes on the clipboard; the rest are saved to a folder you can reveal.',
    );
  });

  it('promises nothing is sent from VS Code when there are no images', () => {
    const route = footerRoute({ ...base, duplicate: null });
    expect(route.rest).toBe(
      ' You review it and press Submit on GitHub — nothing is sent from VS Code.',
    );
  });
});

describe('readinessScore', () => {
  it('sums its weights to 100, so the score is a percentage of real points', () => {
    expect(READINESS_MAX).toBe(100);
    expect(
      READINESS_WEIGHTS.description +
        READINESS_WEIGHTS.context +
        READINESS_WEIGHTS.attachment +
        READINESS_WEIGHTS.diagnostics,
    ).toBe(100);
  });

  it('scores an empty draft 0 and a complete one 100', () => {
    expect(readinessScore(readiness()).score).toBe(0);
    expect(
      readinessScore(
        readiness({
          descriptionLength: DESCRIPTION_CLEAR_CHARS,
          contextLength: CONTEXT_MIN_CHARS + 1,
          attachmentCount: 1,
          includeDiagnostics: true,
        }),
      ).score,
    ).toBe(100);
  });

  it('has three description bands at exactly CLEAR and THIN', () => {
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_CLEAR_CHARS })).score).toBe(40);
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_THIN_CHARS })).score).toBe(22);
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_THIN_CHARS - 1 })).score).toBe(0);
  });

  it('labels the description band it landed in', () => {
    expect(label(readiness({ descriptionLength: 120 }), 0)).toBe('Clear description');
    expect(label(readiness({ descriptionLength: 50 }), 0)).toBe('Description is thin');
    expect(label(readiness({ descriptionLength: 3 }), 0)).toBe('Description is very short');
  });

  it('requires context strictly longer than CONTEXT_MIN_CHARS', () => {
    expect(readinessScore(readiness({ contextLength: CONTEXT_MIN_CHARS })).score).toBe(0);
    expect(readinessScore(readiness({ contextLength: CONTEXT_MIN_CHARS + 1 })).score).toBe(30);
  });

  it('scores an image at 20 and diagnostics at 10', () => {
    expect(readinessScore(readiness({ attachmentCount: 1 })).score).toBe(20);
    expect(readinessScore(readiness({ includeDiagnostics: true })).score).toBe(10);
  });

  it('pluralises the attached-images label', () => {
    expect(label(readiness({ attachmentCount: 1 }), 2)).toBe('1 image attached');
    expect(label(readiness({ attachmentCount: 2 }), 2)).toBe('2 images attached');
  });

  it('flips the context labels with the kind', () => {
    expect(label(readiness({ kind: 'bug', contextLength: 40 }), 1)).toBe('Steps to reproduce');
    expect(label(readiness({ kind: 'feature', contextLength: 40 }), 1)).toBe('Rationale given');
    expect(label(readiness({ kind: 'bug' }), 1)).toBe('No steps to reproduce');
    expect(label(readiness({ kind: 'feature' }), 1)).toBe('No rationale');
  });

  it('prefers the model\'s prose for an unmet check and falls back to a local sentence', () => {
    const withReason = readinessScore(
      readiness({ reasons: { desc: 'Say what you expected instead.' } }),
    );
    expect(withReason.checks[0].why).toBe('Say what you expected instead.');

    const withoutReason = readinessScore(readiness());
    expect(withoutReason.checks[0].why).toBe(
      'A sentence or two more would help — what did you expect instead?',
    );
  });

  it('offers a jump target on every unmet check and none on a met one', () => {
    const empty = readinessScore(readiness());
    expect(empty.checks.map((c) => c.target)).toEqual([
      'description',
      'context',
      'attachments',
      'diagnostics',
    ]);
    expect(empty.checks.every((c) => typeof c.act === 'string')).toBe(true);

    const met = readinessScore(readiness({ includeDiagnostics: true }));
    expect(met.checks[3]).toEqual({ ok: true, label: 'Versions and recent errors attached' });
  });
});

describe('attachment limits', () => {
  it('derives the aggregate ceiling from the per-image one, so a valid report never fails on it', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES);
  });
});
