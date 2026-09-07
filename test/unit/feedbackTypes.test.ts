/**
 * src/types/feedback.ts — the pure half of the feedback contract.
 *
 * These helpers are the only logic the webview and the extension host share, so
 * they are unit-tested here rather than through either end. The readiness score
 * in particular is computed locally on purpose (ticking the diagnostics box
 * must move the bar with no round trip), which makes its bands worth pinning
 * down.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTEXT_MIN_CHARS,
  DESCRIPTION_CLEAR_CHARS,
  DESCRIPTION_THIN_CHARS,
  DUPLICATE_RELATED_THRESHOLD,
  DUPLICATE_TAKEOVER_THRESHOLD,
  FEEDBACK_AI_PROVIDER_CHOICES,
  FEEDBACK_COPY,
  KIND_CONFIDENCE_CLOSE,
  READINESS_MAX,
  READINESS_WEIGHTS,
  applyRegressionPrefix,
  compareVersions,
  duplicateModeFor,
  footerRoute,
  isFeedbackAiProviderChoice,
  isFeedbackKind,
  kindSplit,
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
  const base = { filingAnyway: false, version: '0.6.41', outdated: false };

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

  it('promises nothing is sent from VS Code — there is only ever the one route', () => {
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
      READINESS_WEIGHTS.description + READINESS_WEIGHTS.context + READINESS_WEIGHTS.diagnostics,
    ).toBe(100);
  });

  it('scores an empty draft 0 and a complete one 100', () => {
    expect(readinessScore(readiness()).score).toBe(0);
    expect(
      readinessScore(
        readiness({
          descriptionLength: DESCRIPTION_CLEAR_CHARS,
          contextLength: CONTEXT_MIN_CHARS + 1,
          includeDiagnostics: true,
        }),
      ).score,
    ).toBe(100);
  });

  it('has three description bands at exactly CLEAR and THIN', () => {
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_CLEAR_CHARS })).score).toBe(45);
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_THIN_CHARS })).score).toBe(25);
    expect(readinessScore(readiness({ descriptionLength: DESCRIPTION_THIN_CHARS - 1 })).score).toBe(0);
  });

  it('labels the description band it landed in', () => {
    expect(label(readiness({ descriptionLength: 120 }), 0)).toBe('Clear description');
    expect(label(readiness({ descriptionLength: 50 }), 0)).toBe('Description is thin');
    expect(label(readiness({ descriptionLength: 3 }), 0)).toBe('Description is very short');
  });

  it('requires context strictly longer than CONTEXT_MIN_CHARS', () => {
    expect(readinessScore(readiness({ contextLength: CONTEXT_MIN_CHARS })).score).toBe(0);
    expect(readinessScore(readiness({ contextLength: CONTEXT_MIN_CHARS + 1 })).score).toBe(35);
  });

  it('scores the diagnostics at 20', () => {
    expect(readinessScore(readiness({ includeDiagnostics: true })).score).toBe(20);
  });

  it('asks for no image at all — there is no route the dialog could offer', () => {
    // Every check applies to every report now, so the meter has a fixed
    // denominator and nothing that could sit there permanently unmeetable.
    for (const kind of ['bug', 'feature'] as const) {
      const checks = readinessScore(readiness({ kind })).checks;
      expect(checks).toHaveLength(3);
      expect(checks.some((c) => /image|screenshot/i.test(c.label))).toBe(false);
    }
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
    expect(empty.checks.map((c) => c.target)).toEqual(['description', 'context', 'diagnostics']);
    expect(empty.checks.every((c) => typeof c.act === 'string')).toBe(true);

    const met = readinessScore(readiness({ includeDiagnostics: true }));
    expect(met.checks[2]).toEqual({ ok: true, label: 'Versions and recent errors attached' });
  });

  it('reaches 100 on a complete report of either kind', () => {
    // The denominator no longer depends on the kind, so a feature request is
    // not capped by a check it could never meet.
    for (const kind of ['bug', 'feature'] as const) {
      expect(
        readinessScore(
          readiness({
            kind,
            descriptionLength: DESCRIPTION_CLEAR_CHARS,
            contextLength: CONTEXT_MIN_CHARS + 1,
            includeDiagnostics: true,
          }),
        ).score,
      ).toBe(100);
    }
  });
});

describe('kindSplit', () => {
  /**
   * The choice is binary, so one confidence describes both sides. The model is
   * deliberately not asked for two numbers: two numbers can disagree about what
   * they sum to, and reconciling that would mean inventing an answer.
   */
  it('gives the remainder to the other kind', () => {
    expect(kindSplit('feature', 0.86)).toEqual({
      kind: 'feature',
      percent: 86,
      other: 'bug',
      otherPercent: 14,
      closeCall: false,
    });
  });

  it('always sums to 100, at every rounding', () => {
    for (const c of [0.5, 0.501, 0.555, 0.666, 0.775, 0.999, 1]) {
      const split = kindSplit('bug', c);
      expect(split.percent + split.otherPercent).toBe(100);
    }
  });

  it('calls it close below the threshold and settled at or above it', () => {
    expect(kindSplit('bug', KIND_CONFIDENCE_CLOSE - 0.01).closeCall).toBe(true);
    expect(kindSplit('bug', KIND_CONFIDENCE_CLOSE).closeCall).toBe(false);
    // A 51/49 guess and a near-certainty used to look identical in the panel.
    expect(kindSplit('bug', 0.51).closeCall).toBe(true);
    expect(kindSplit('bug', 0.95).closeCall).toBe(false);
  });

  it('never shows the picked kind losing its own split', () => {
    // A model that returns kind:"bug" with confidence 0.3 has contradicted
    // itself. "Bug 30% / Feature 70%" under a verdict chip reading *Bug* is a
    // worse answer than admitting it is a coin toss.
    const split = kindSplit('bug', 0.3);
    expect(split.percent).toBe(50);
    expect(split.otherPercent).toBe(50);
    expect(split.closeCall).toBe(true);
  });

  it('treats a missing or nonsense confidence as an even split', () => {
    for (const value of [NaN, Infinity, -1, undefined as unknown as number]) {
      const split = kindSplit('feature', value);
      expect(split.percent).toBe(50);
      expect(split.closeCall).toBe(true);
    }
    expect(kindSplit('feature', 2).percent).toBe(100);
  });
});

describe('analysis provider choices', () => {
  it('recognises exactly the four destinations', () => {
    expect([...FEEDBACK_AI_PROVIDER_CHOICES]).toEqual(['auto', 'vscode', 'endpoint', 'hosted']);
    for (const choice of FEEDBACK_AI_PROVIDER_CHOICES) {
      expect(isFeedbackAiProviderChoice(choice)).toBe(true);
    }
  });

  it('rejects anything else, so an unknown value can never be written as a pin', () => {
    for (const value of ['copilot', 'Auto', '', null, undefined, 3, {}]) {
      expect(isFeedbackAiProviderChoice(value)).toBe(false);
    }
  });
});
