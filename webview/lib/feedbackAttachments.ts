/**
 * The one image route the Feedback dialog owns: the canvas capture.
 *
 * `webview/lib/screenshot.ts` rasterises the canvas to a PNG data URL; this
 * turns that URL into the {@link FeedbackAttachment} the host contract is
 * shaped around, applying the same ceilings the host validator will re-apply
 * at the message boundary — so a capture that could never be accepted is
 * refused here, where the dialog can say why, rather than at submit time.
 *
 * Deliberately pure (a string in, a plain object out) so it is unit-testable
 * in node with no DOM.
 */

import type { FeedbackAttachment, FeedbackImageMime } from '../../src/types/feedback';
import { FEEDBACK_IMAGE_MIMES, MAX_ATTACHMENT_BYTES } from '../../src/types/feedback';

/** File name given to the auto-captured canvas screenshot. */
export const CANVAS_ATTACHMENT_NAME = 'canvas.png';

/**
 * Attachment id for the canvas capture. Constant because a report carries at
 * most one image, so there is nothing for it to collide with — and the host
 * validator's uniqueness rule is satisfied by construction.
 */
export const CANVAS_ATTACHMENT_ID = 'canvas';

/** Narrow a mime string to one of the accepted image types. */
function toImageMime(value: string): FeedbackImageMime | null {
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (FEEDBACK_IMAGE_MIMES as readonly string[]).includes(mime) ? (mime as FeedbackImageMime) : null;
}

/** Decoded byte length of a base64 payload, without decoding it. */
function base64ByteLength(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Turn the captured canvas data URL into an attachment. Returns null when the
 * URL is malformed, carries a type that is not accepted, or decodes to more
 * than the per-image ceiling.
 */
export function canvasAttachment(dataUrl: string): FeedbackAttachment | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = toImageMime(match[1]);
  if (!mime) return null;
  const bytes = base64ByteLength(match[2]);
  if (bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES) return null;
  return {
    id: CANVAS_ATTACHMENT_ID,
    name: CANVAS_ATTACHMENT_NAME,
    mime,
    bytes,
    dataUrl,
    source: 'canvas',
  };
}
