/**
 * webview/lib/feedbackAttachments — the limits, enforced at attach time.
 *
 * Three routes put images on a report (picker, paste, drop) and all three fold
 * through `acceptFiles`, so the user learns why a file was refused next to its
 * name rather than losing the whole report to the host validator at submit
 * time. The classification half is deliberately structural (`{ name, type,
 * size }`), which is why it is testable in node with no DOM.
 */

import { describe, expect, it } from 'vitest';

import {
  CANVAS_ATTACHMENT_NAME,
  acceptFiles,
  attachmentIdFor,
  classifyFile,
  dataUrlToAttachment,
} from '../../webview/lib/feedbackAttachments';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type FeedbackAttachment,
} from '../../src/types/feedback';

const file = (name: string, type: string, size = 1024) => ({ name, type, size });

function existing(count: number, bytes = 1024): FeedbackAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    name: `existing-${i}.png`,
    mime: 'image/png' as const,
    bytes,
    dataUrl: 'data:image/png;base64,AAAA',
    source: 'picker' as const,
  }));
}

describe('classifyFile', () => {
  it.each([
    ['image/png', 'shot.png'],
    ['image/jpeg', 'shot.jpg'],
    ['image/gif', 'shot.gif'],
    ['image/webp', 'shot.webp'],
  ])('accepts %s', (type, name) => {
    expect(classifyFile(file(name, type))).toEqual({ ok: true, mime: type });
  });

  it('normalises a charset parameter and odd casing on the mime', () => {
    expect(classifyFile(file('shot.png', 'IMAGE/PNG; charset=binary'))).toEqual({
      ok: true,
      mime: 'image/png',
    });
  });

  it('rejects a type GitHub and the host validator would not take', () => {
    expect(classifyFile(file('doc.pdf', 'application/pdf'))).toEqual({
      ok: false,
      error: 'Only PNG, JPEG, GIF and WebP images can be attached.',
    });
    expect(classifyFile(file('drawing.svg', 'image/svg+xml')).ok).toBe(false);
    expect(classifyFile(file('mystery', '')).ok).toBe(false);
  });

  it('accepts exactly the limit and rejects one byte more', () => {
    expect(classifyFile(file('big.png', 'image/png', MAX_ATTACHMENT_BYTES)).ok).toBe(true);
    expect(classifyFile(file('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1))).toEqual({
      ok: false,
      error: 'That image is larger than the 10 MB limit.',
    });
  });

  it('rejects an empty file rather than attaching nothing', () => {
    expect(classifyFile(file('empty.png', 'image/png', 0))).toEqual({
      ok: false,
      error: 'That file is empty.',
    });
    expect(classifyFile(file('odd.png', 'image/png', Number.NaN)).ok).toBe(false);
  });
});

describe('acceptFiles', () => {
  it('accepts everything that fits', () => {
    const result = acceptFiles([], [file('a.png', 'image/png'), file('b.jpg', 'image/jpeg')]);
    expect(result.accepted).toEqual([
      { name: 'a.png', mime: 'image/png' },
      { name: 'b.jpg', mime: 'image/jpeg' },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('caps the report at MAX_ATTACHMENTS, counting what is already attached', () => {
    const result = acceptFiles(existing(MAX_ATTACHMENTS - 1), [
      file('fits.png', 'image/png'),
      file('one-too-many.png', 'image/png'),
    ]);
    expect(result.accepted.map((a) => a.name)).toEqual(['fits.png']);
    expect(result.rejected).toEqual([
      { name: 'one-too-many.png', error: `At most ${MAX_ATTACHMENTS} images can be attached.` },
    ]);
  });

  it('keeps the good half of a mixed batch and says why the rest went', () => {
    const result = acceptFiles([], [
      file('good.png', 'image/png'),
      file('doc.pdf', 'application/pdf'),
      file('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
    ]);
    expect(result.accepted.map((a) => a.name)).toEqual(['good.png']);
    expect(result.rejected.map((r) => r.name)).toEqual(['doc.pdf', 'huge.png']);
  });

  it('refuses a file that would blow the whole-report ceiling', () => {
    // The per-image check bites first for an oversize file.
    const oversize = acceptFiles(existing(1), [
      file('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
    ]);
    expect(oversize.accepted).toEqual([]);
    expect(oversize.rejected[0].error).toBe('That image is larger than the 10 MB limit.');

    // The aggregate is the last line of defence: with the report already
    // holding more than the per-image limit each (which only a stale or
    // tampered list could produce), a legal file still gets a reason the user
    // can act on rather than silently vanishing at submit time.
    const total = acceptFiles(existing(2, 15 * 1024 * 1024), [
      file('fits.png', 'image/png', MAX_ATTACHMENT_BYTES),
      file('over.png', 'image/png', 1),
    ]);
    expect(total.accepted.map((a) => a.name)).toEqual(['fits.png']);
    expect(total.rejected).toEqual([
      { name: 'over.png', error: 'That would exceed the total size limit for one report.' },
    ]);
  });

  it('accepts nothing from an empty batch', () => {
    expect(acceptFiles(existing(1), [])).toEqual({ accepted: [], rejected: [] });
  });
});

describe('attachmentIdFor', () => {
  it('slugs the file name and keeps the counter, so the same file twice is two ids', () => {
    expect(attachmentIdFor('Screen Shot 2026.png', 0)).toBe('0-screen-shot-2026-png');
    expect(attachmentIdFor('Screen Shot 2026.png', 1)).toBe('1-screen-shot-2026-png');
  });

  it('falls back to a readable id for a name with nothing sluggable in it', () => {
    expect(attachmentIdFor('...', 3)).toBe('3-image');
  });
});

describe('dataUrlToAttachment', () => {
  it('builds an attachment with the decoded byte length, not the base64 length', () => {
    // 8 base64 chars with no padding decode to 6 bytes.
    const attachment = dataUrlToAttachment(
      'data:image/png;base64,AAAAAAAA',
      CANVAS_ATTACHMENT_NAME,
      'canvas',
      0,
    );
    expect(attachment).toMatchObject({
      id: '0-canvas-png',
      name: 'canvas.png',
      mime: 'image/png',
      source: 'canvas',
    });
    expect(attachment?.bytes).toBe(6);
    expect(attachment?.dataUrl).toBe('data:image/png;base64,AAAAAAAA');
  });

  it('discounts base64 padding when measuring the payload', () => {
    expect(dataUrlToAttachment('data:image/png;base64,AAAA', 'a.png', 'paste', 0)?.bytes).toBe(3);
    expect(dataUrlToAttachment('data:image/png;base64,AAA=', 'a.png', 'paste', 0)?.bytes).toBe(2);
    expect(dataUrlToAttachment('data:image/png;base64,AA==', 'a.png', 'paste', 0)?.bytes).toBe(1);
  });

  it('returns null for a malformed URL, an unaccepted type or an empty payload', () => {
    expect(dataUrlToAttachment('not a data url', 'a.png', 'drop', 0)).toBeNull();
    expect(dataUrlToAttachment('data:application/pdf;base64,AAAA', 'a.pdf', 'drop', 0)).toBeNull();
    expect(dataUrlToAttachment('data:image/png;base64,', 'a.png', 'drop', 0)).toBeNull();
  });

  it('returns null for a capture bigger than the per-image ceiling', () => {
    // 4/3 base64 chars per byte, one past the limit.
    const payload = 'A'.repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 64) * 4) / 3));
    expect(dataUrlToAttachment(`data:image/png;base64,${payload}`, 'huge.png', 'canvas', 0)).toBeNull();
  });

  it('names the captured canvas consistently with the host\'s expectations', () => {
    expect(CANVAS_ATTACHMENT_NAME).toBe('canvas.png');
  });
});
