/**
 * webview/lib/feedbackAttachments — the canvas capture, turned into the one
 * attachment a report can carry.
 *
 * The dialog has a single image route, so this is the single place a data URL
 * becomes a `FeedbackAttachment`. It re-applies the ceilings the host validator
 * applies at the message boundary, so a capture that could never be accepted is
 * refused in the dialog, where it can be explained. Pure (a string in, a plain
 * object out), which is why it is testable in node with no DOM.
 */

import { describe, expect, it } from 'vitest';

import {
  CANVAS_ATTACHMENT_ID,
  CANVAS_ATTACHMENT_NAME,
  canvasAttachment,
} from '../../webview/lib/feedbackAttachments';
import { MAX_ATTACHMENT_BYTES } from '../../src/types/feedback';

/** A base64 data URL whose payload decodes to exactly `bytes` bytes. */
function dataUrl(bytes: number, mime = 'image/png'): string {
  const whole = Math.floor(bytes / 3);
  const remainder = bytes - whole * 3;
  const tail = remainder === 0 ? '' : remainder === 1 ? 'AA==' : 'AAA=';
  return `data:${mime};base64,${'A'.repeat(whole * 4)}${tail}`;
}

describe('canvasAttachment', () => {
  it('builds the attachment the host contract expects', () => {
    const attachment = canvasAttachment('data:image/png;base64,AAAA');
    expect(attachment).toEqual({
      id: CANVAS_ATTACHMENT_ID,
      name: CANVAS_ATTACHMENT_NAME,
      mime: 'image/png',
      bytes: 3,
      dataUrl: 'data:image/png;base64,AAAA',
      source: 'canvas',
    });
  });

  it('names the file canvas.png, which is what the report lists', () => {
    expect(CANVAS_ATTACHMENT_NAME).toBe('canvas.png');
    expect(canvasAttachment('data:image/png;base64,AAAA')?.name).toBe('canvas.png');
  });

  it('reports the decoded byte length, not the base64 length', () => {
    // "AAAA" is 4 base64 chars → 3 bytes; padding is discounted.
    expect(canvasAttachment('data:image/png;base64,AAAA')?.bytes).toBe(3);
    expect(canvasAttachment('data:image/png;base64,AAA=')?.bytes).toBe(2);
    expect(canvasAttachment('data:image/png;base64,AA==')?.bytes).toBe(1);
  });

  it('refuses anything that is not a base64 image data URL', () => {
    expect(canvasAttachment('')).toBeNull();
    expect(canvasAttachment('not a data url')).toBeNull();
    expect(canvasAttachment('https://example.com/canvas.png')).toBeNull();
    expect(canvasAttachment('data:image/png,AAAA')).toBeNull();
  });

  it('refuses a type GitHub and the host validator would not take', () => {
    expect(canvasAttachment('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(canvasAttachment('data:application/pdf;base64,AAAA')).toBeNull();
    expect(canvasAttachment('data:text/plain;base64,AAAA')).toBeNull();
  });

  it('refuses an empty payload rather than attaching a zero-byte image', () => {
    expect(canvasAttachment('data:image/png;base64,')).toBeNull();
  });

  it('refuses a capture over the per-image ceiling, which the host would reject anyway', () => {
    expect(canvasAttachment(dataUrl(MAX_ATTACHMENT_BYTES))?.bytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(canvasAttachment(dataUrl(MAX_ATTACHMENT_BYTES + 1))).toBeNull();
  });
});
