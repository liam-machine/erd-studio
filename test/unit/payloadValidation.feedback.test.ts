/**
 * Runtime validators for the six feedback messages.
 *
 * These sit at the message boundary, so they see whatever a compromised or
 * simply buggy webview sends. Attachments matter most: they are decoded and
 * written to disk, so the mime, the declared size and the data URL's own
 * prefix all have to agree before anything touches the filesystem.
 */

import { describe, expect, it } from 'vitest';

import {
  isValidDuplicateMode,
  isValidFeedbackImageMime,
  isValidFeedbackKind,
  validateAnalyzeFeedbackPayload,
  validateCopyFeedbackReportPayload,
  validateFeedbackAttachment,
  validateFeedbackAttachments,
  validateOpenFeedbackLinkPayload,
  validateRequestFeedbackContextPayload,
  validateSubmitFeedbackPayload,
} from '../../src/providers/payloadValidation';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type FeedbackAttachment,
} from '../../src/types/feedback';

function attachment(overrides: Partial<FeedbackAttachment> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    name: 'canvas.png',
    mime: 'image/png',
    bytes: 1024,
    dataUrl: 'data:image/png;base64,AAAA',
    source: 'canvas',
    ...overrides,
  };
}

const submitPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: 'bug',
  title: 'Edge vanished',
  description: 'It disappeared after a rename.',
  includeDiagnostics: true,
  ...overrides,
});

const domainSummary = {
  name: 'orders',
  layer: 'silver',
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

describe('isValidFeedbackImageMime', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('accepts %j', (mime) => {
    expect(isValidFeedbackImageMime(mime)).toBe(true);
  });

  it.each([['image/svg+xml'], ['application/pdf'], ['image/PNG'], [null], [42]])(
    'rejects %j',
    (value) => {
      expect(isValidFeedbackImageMime(value)).toBe(false);
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

describe('validateFeedbackAttachment', () => {
  it('accepts a well-formed attachment', () => {
    expect(validateFeedbackAttachment(attachment())).toBeNull();
    expect(validateFeedbackAttachment(attachment({ onClipboard: true }))).toBeNull();
  });

  it.each([
    ['not an object', null, /must be an object/],
    ['not an object', 'canvas.png', /must be an object/],
    ['an array', [], /must be an object/],
    ['a blank id', attachment({ id: '   ' }), /id must be a non-empty string/],
    ['a missing name', attachment({ name: undefined }), /name must be a non-empty string/],
    ['an unaccepted mime', attachment({ mime: 'application/pdf' }), /not an accepted image type/],
    ['zero bytes', attachment({ bytes: 0 }), /positive number of bytes/],
    ['non-finite bytes', attachment({ bytes: Number.NaN }), /positive number of bytes/],
    [
      'an oversize image',
      attachment({ bytes: MAX_ATTACHMENT_BYTES + 1 }),
      /larger than the 10 MB limit/,
    ],
    [
      'a data URL whose mime disagrees with the declared one',
      attachment({ mime: 'image/png', dataUrl: 'data:image/jpeg;base64,AAAA' }),
      /base64 image data URL matching its mime type/,
    ],
    [
      'a plain URL instead of a data URL',
      attachment({ dataUrl: 'https://example.com/a.png' }),
      /base64 image data URL/,
    ],
    ['an unknown source', attachment({ source: 'telepathy' }), /source is not recognised/],
    [
      'a non-boolean clipboard flag',
      attachment({ onClipboard: 'yes' }),
      /onClipboard must be a boolean/,
    ],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateFeedbackAttachment(value)).toMatch(pattern as RegExp);
  });

  it('names the offending file in the size message, so the user knows which one', () => {
    expect(
      validateFeedbackAttachment(attachment({ name: 'huge.png', bytes: MAX_ATTACHMENT_BYTES + 1 })),
    ).toBe('Attachment "huge.png" is larger than the 10 MB limit.');
  });
});

describe('validateFeedbackAttachments', () => {
  it('accepts undefined — a report with no images is normal', () => {
    expect(validateFeedbackAttachments(undefined)).toBeNull();
  });

  it('accepts an empty list and a full one', () => {
    expect(validateFeedbackAttachments([])).toBeNull();
    expect(
      validateFeedbackAttachments(
        Array.from({ length: MAX_ATTACHMENTS }, (_, i) => attachment({ id: `a${i}` })),
      ),
    ).toBeNull();
  });

  it('rejects one image too many', () => {
    expect(
      validateFeedbackAttachments(
        Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => attachment({ id: `a${i}` })),
      ),
    ).toBe(`At most ${MAX_ATTACHMENTS} images can be attached.`);
  });

  it('rejects duplicate ids', () => {
    expect(validateFeedbackAttachments([attachment(), attachment()])).toBe(
      'Attachment ids must be unique.',
    );
  });

  it('rejects a list that is not a list', () => {
    expect(validateFeedbackAttachments('canvas.png')).toBe('Attachments must be a list.');
    expect(validateFeedbackAttachments({ 0: attachment() })).toBe('Attachments must be a list.');
  });

  it('surfaces the first bad entry\'s own message', () => {
    expect(
      validateFeedbackAttachments([attachment(), attachment({ id: 'a2', mime: 'text/plain' })]),
    ).toBe('Attachment mime type is not an accepted image type.');
  });

  it('cannot fail on the aggregate once every image and the count are legal', () => {
    // The aggregate ceiling is MAX_ATTACHMENTS × MAX_ATTACHMENT_BYTES, so a
    // list that passes both other checks passes this one by construction —
    // a user is never told at submit time about a limit they could not have
    // seen at attach time.
    const maxed = Array.from({ length: MAX_ATTACHMENTS }, (_, i) =>
      attachment({ id: `a${i}`, bytes: MAX_ATTACHMENT_BYTES }),
    );
    expect(validateFeedbackAttachments(maxed)).toBeNull();

    // One more image is refused on the count, which is the friendlier message.
    expect(
      validateFeedbackAttachments([...maxed, attachment({ id: 'extra', bytes: 1 })]),
    ).toBe(`At most ${MAX_ATTACHMENTS} images can be attached.`);
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
    ['a domain summary missing a name', { domain: { ...domainSummary, name: 5 } }, /name must be a string/],
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

  it.each([
    ['a non-object', null, /must be an object/],
    ['a fractional request id', payload({ requestId: 1.5 }), /finite integer/],
    ['a missing request id', payload({ requestId: undefined }), /finite integer/],
    ['a bad kind', payload({ kind: 'question' }), /must be "bug" or "feature"/],
    ['a non-string description', payload({ description: 42 }), /Description must be a string/],
    ['a blank description', payload({ description: '   ' }), /cannot be empty/],
    ['a non-string context', payload({ context: 42 }), /Context must be a string/],
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
          attachments: [attachment()],
          screenshotError: 'timed out',
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
    [
      'a non-string screenshot error',
      submitPayload({ screenshotError: 5 }),
      /Screenshot error must be a string/,
    ],
    ['a bad attachment', submitPayload({ attachments: [attachment({ mime: 'x' })] }), /accepted image type/],
    ['a zero issue number', submitPayload({ regressionOf: 0 }), /must be a positive integer/],
    ['a fractional issue number', submitPayload({ commentOnIssue: 1.5 }), /must be a positive integer/],
    ['non-string webview errors', submitPayload({ webviewErrors: [1] }), /list of strings/],
    ['a bad domain summary', submitPayload({ domain: { name: 'x' } }), /must be a string/],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateSubmitFeedbackPayload(value)).toMatch(pattern as RegExp);
  });
});

describe('validateCopyFeedbackReportPayload', () => {
  it('accepts the same fields minus attachments and issue numbers', () => {
    expect(validateCopyFeedbackReportPayload(submitPayload())).toBeNull();
    expect(
      validateCopyFeedbackReportPayload(
        submitPayload({ attachmentNames: ['canvas.png'], webviewErrors: [], domain: domainSummary }),
      ),
    ).toBeNull();
  });

  it.each([
    ['a non-object', null, /must be an object/],
    ['a bad kind', submitPayload({ kind: 'x' }), /must be "bug" or "feature"/],
    ['a non-string title', submitPayload({ title: 5 }), /Title must be a string/],
    [
      'non-string attachment names',
      submitPayload({ attachmentNames: [1] }),
      /Attachment names must be a list of strings/,
    ],
  ])('rejects %s', (_label, value, pattern) => {
    expect(validateCopyFeedbackReportPayload(value)).toMatch(pattern as RegExp);
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
