/**
 * Runtime validators for the feedback messages.
 *
 * These sit at the message boundary, so they see whatever a compromised or
 * simply buggy webview sends. The provider choice matters most: it decides
 * where the user's text is posted, so an unrecognised value is refused outright
 * rather than coerced into the default — a coerced value would silently restore
 * the precedence the user was trying to escape.
 */

import { describe, expect, it } from 'vitest';

import {
  isValidDuplicateMode,
  isValidFeedbackKind,
  validateAnalyzeFeedbackPayload,
  validateCopyFeedbackReportPayload,
  validateOpenFeedbackLinkPayload,
  validateRequestFeedbackContextPayload,
  validateSetFeedbackProviderPayload,
  validateSubmitFeedbackPayload,
} from '../../src/providers/payloadValidation';

const submitPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: 'bug',
  title: 'Edge vanished',
  description: 'It disappeared after a rename.',
  includeDiagnostics: true,
  ...overrides,
});

const domainSummary = {
  stage: 'logical',
  modelCount: 4,
  relationshipCount: 3,
  schemaVersion: 5,
};

describe('isValidFeedbackKind', () => {
  it.each(['bug', 'feature'])('accepts %j', (kind) => {
    expect(isValidFeedbackKind(kind)).toBe(true);
  });

  it.each([['Bug'], ['question'], [''], [null], [undefined], [1], [{}], [['bug']]])(
    'rejects %j',
    (value) => {
      expect(isValidFeedbackKind(value)).toBe(false);
    },
  );
});

describe('isValidDuplicateMode', () => {
  it.each(['open', 'fixed', 'declined'])('accepts %j', (mode) => {
    expect(isValidDuplicateMode(mode)).toBe(true);
  });

  it.each([['closed'], ['Open'], [null]])('rejects %j', (value) => {
    expect(isValidDuplicateMode(value)).toBe(false);
  });
});

describe('validateRequestFeedbackContextPayload', () => {
  it('accepts an absent or empty payload — every field is optional', () => {
    expect(validateRequestFeedbackContextPayload(undefined)).toBeNull();
    expect(validateRequestFeedbackContextPayload({})).toBeNull();
  });

  it('accepts webview errors and a domain summary', () => {
    expect(
      validateRequestFeedbackContextPayload({ webviewErrors: ['boom'], domain: domainSummary }),
    ).toBeNull();
  });

  it.each([
    ['a non-object payload', 'nope', /must be an object/],
    ['non-string errors', { webviewErrors: [1] }, /list of strings/],
    ['a non-list errors field', { webviewErrors: 'boom' }, /list of strings/],
    ['a domain summary missing a stage', { domain: { ...domainSummary, stage: 5 } }, /stage must be a string/],
    [
      'a non-numeric model count',
      { domain: { ...domainSummary, modelCount: 'four' } },
      /modelCount must be a finite number/,
    ],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateRequestFeedbackContextPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateAnalyzeFeedbackPayload', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    requestId: 1,
    kind: 'bug',
    description: 'Renamed a model and the edge vanished.',
    ...overrides,
  });

  it('accepts a well-formed request, with and without context', () => {
    expect(validateAnalyzeFeedbackPayload(payload())).toBeNull();
    expect(validateAnalyzeFeedbackPayload(payload({ context: '1. Rename it' }))).toBeNull();
  });

  it('accepts the kind-chosen flag either way, and none at all', () => {
    expect(validateAnalyzeFeedbackPayload(payload({ kindChosenByUser: true }))).toBeNull();
    expect(validateAnalyzeFeedbackPayload(payload({ kindChosenByUser: false }))).toBeNull();
    expect(validateAnalyzeFeedbackPayload(payload({ kindChosenByUser: undefined }))).toBeNull();
  });

  it('accepts either trigger, and none at all', () => {
    expect(validateAnalyzeFeedbackPayload(payload({ trigger: 'debounce' }))).toBeNull();
    expect(validateAnalyzeFeedbackPayload(payload({ trigger: 'user' }))).toBeNull();
    expect(validateAnalyzeFeedbackPayload(payload({ trigger: undefined }))).toBeNull();
  });

  it.each([
    ['a non-object', null, /must be an object/],
    ['a fractional request id', payload({ requestId: 1.5 }), /finite integer/],
    ['a missing request id', payload({ requestId: undefined }), /finite integer/],
    ['a bad kind', payload({ kind: 'question' }), /must be "bug" or "feature"/],
    ['a non-string description', payload({ description: 42 }), /Description must be a string/],
    ['a blank description', payload({ description: '   ' }), /cannot be empty/],
    ['a non-string context', payload({ context: 42 }), /Context must be a string/],
    // `trigger` decides whether an unprimed language-model request may run, so
    // anything unrecognised is refused rather than read as a user action.
    ['an unknown trigger', payload({ trigger: 'click' }), /trigger must be/],
    ['a non-string trigger', payload({ trigger: true }), /trigger must be/],
    // Decides whether the kind is stated to the model as the user's decision,
    // so anything but a boolean is refused rather than read as "yes".
    [
      'a non-boolean kind-chosen flag',
      payload({ kindChosenByUser: 'yes' }),
      /Kind-chosen flag must be a boolean/,
    ],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateAnalyzeFeedbackPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateSubmitFeedbackPayload', () => {
  it('accepts the minimum a report needs', () => {
    expect(validateSubmitFeedbackPayload(submitPayload())).toBeNull();
  });

  it('accepts every optional field together', () => {
    expect(
      validateSubmitFeedbackPayload(
        submitPayload({
          kind: 'feature',
          steps: 'Two windows today.',
          webviewErrors: ['boom'],
          regressionOf: 42,
          commentOnIssue: 43,
          domain: domainSummary,
        }),
      ),
    ).toBeNull();
  });

  it('accepts an empty title — the host substitutes the per-kind default', () => {
    expect(validateSubmitFeedbackPayload(submitPayload({ title: '' }))).toBeNull();
  });

  it.each([
    ['a non-object', 'nope', /must be an object/],
    ['an array', [], /must be an object/],
    ['a missing kind', submitPayload({ kind: undefined }), /must be "bug" or "feature"/],
    ['a non-string title', submitPayload({ title: 5 }), /Title must be a string/],
    ['a non-string description', submitPayload({ description: null }), /Description must be a string/],
    ['non-string steps', submitPayload({ steps: 5 }), /Steps must be a string/],
    [
      'a missing diagnostics flag',
      submitPayload({ includeDiagnostics: undefined }),
      /Diagnostics flag must be a boolean/,
    ],
    ['a zero issue number', submitPayload({ regressionOf: 0 }), /must be a positive integer/],
    ['a fractional issue number', submitPayload({ commentOnIssue: 1.5 }), /must be a positive integer/],
    ['non-string webview errors', submitPayload({ webviewErrors: [1] }), /list of strings/],
    ['a bad domain summary', submitPayload({ domain: { name: 'x' } }), /must be a string/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateSubmitFeedbackPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateCopyFeedbackReportPayload', () => {
  it('accepts the same fields minus the issue numbers', () => {
    expect(validateCopyFeedbackReportPayload(submitPayload())).toBeNull();
    expect(
      validateCopyFeedbackReportPayload(
        submitPayload({ webviewErrors: [], domain: domainSummary }),
      ),
    ).toBeNull();
  });

  it.each([
    ['a non-object', null, /must be an object/],
    ['a bad kind', submitPayload({ kind: 'x' }), /must be "bug" or "feature"/],
    ['a non-string title', submitPayload({ title: 5 }), /Title must be a string/],
    ['non-string webview errors', submitPayload({ webviewErrors: [1] }), /list of strings/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateCopyFeedbackReportPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateSetFeedbackProviderPayload', () => {
  it('accepts each of the four destinations, with or without the diagnostics context', () => {
    for (const provider of ['auto', 'vscode', 'endpoint', 'hosted']) {
      expect(validateSetFeedbackProviderPayload({ provider })).toBeNull();
    }
    expect(
      validateSetFeedbackProviderPayload({
        provider: 'hosted',
        webviewErrors: ['boom'],
        domain: domainSummary,
      }),
    ).toBeNull();
  });

  it.each([
    ['a non-object', 'hosted', /must be an object/],
    ['an array', [], /must be an object/],
    ['a missing provider', {}, /must be "auto", "vscode", "endpoint" or "hosted"/],
    // Refused rather than coerced: writing an unknown value would restore the
    // automatic precedence, which is the thing the user was pinning away from.
    ['an unknown provider', { provider: 'copilot' }, /must be "auto", "vscode", "endpoint" or "hosted"/],
    ['a mis-cased provider', { provider: 'Hosted' }, /must be "auto", "vscode", "endpoint" or "hosted"/],
    ['non-string webview errors', { provider: 'auto', webviewErrors: [1] }, /list of strings/],
    ['a bad domain summary', { provider: 'auto', domain: { name: 'x' } }, /must be a string/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateSetFeedbackProviderPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateOpenFeedbackLinkPayload', () => {
  it('accepts both targets', () => {
    expect(validateOpenFeedbackLinkPayload({ target: 'extension' })).toBeNull();
    expect(validateOpenFeedbackLinkPayload({ target: 'issue', issue: 42 })).toBeNull();
    expect(validateOpenFeedbackLinkPayload({ target: 'issue', issue: 42, comment: true })).toBeNull();
  });

  it.each([
    ['a non-object', null, /must be an object/],
    ['an unknown target', { target: 'settings' }, /must be "issue" or "extension"/],
    ['a missing issue number', { target: 'issue' }, /positive integer/],
    ['a negative issue number', { target: 'issue', issue: -1 }, /positive integer/],
    ['a non-boolean comment flag', { target: 'issue', issue: 1, comment: 'yes' }, /must be a boolean/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateOpenFeedbackLinkPayload(value)).toMatch(pattern as RegExp);
  });
});
