/**
 * Image attachments for the Feedback dialog.
 *
 * Three routes put images on a report — the file picker, a paste, and a drop
 * on the zone — and all three land here so the limits are enforced once. The
 * user learns about a limit at attach time (a rejection reason next to the
 * file name) rather than at submit time, where the host validator would only
 * be able to refuse the whole report.
 *
 * `classifyFile` and `acceptFiles` are deliberately structural (`{ name, type,
 * size }`) rather than typed on `File`, so the limit logic is unit-testable in
 * node with no DOM. Only `fileToAttachment` touches a real `File`.
 */

import type { FeedbackAttachment, FeedbackAttachmentSource, FeedbackImageMime } from '../../src/types/feedback';
import {
  FEEDBACK_IMAGE_MIMES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../../src/types/feedback';

/** File name given to the auto-captured canvas screenshot. */
export const CANVAS_ATTACHMENT_NAME = 'canvas.png';

/** Rejection reason when one more image would blow the whole-report ceiling. */
const TOTAL_SIZE_REASON = 'That would exceed the total size limit for one report.';

/** Rejection reason for a file type GitHub (and the host validator) will not take. */
const MIME_REASON = 'Only PNG, JPEG, GIF and WebP images can be attached.';

/** Rejection reason for a single image over the per-image ceiling. */
const SIZE_REASON = 'That image is larger than the 10 MB limit.';

/** Rejection reason for a file with no content to attach. */
const EMPTY_REASON = 'That file is empty.';

/** Rejection reason once the report already holds the maximum number of images. */
const COUNT_REASON = `At most ${MAX_ATTACHMENTS} images can be attached.`;

/** Narrow a mime string to one of the accepted image types. */
function toImageMime(value: string): FeedbackImageMime | null {
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return (FEEDBACK_IMAGE_MIMES as readonly string[]).includes(mime) ? (mime as FeedbackImageMime) : null;
}

/**
 * A stable id for one attachment. `index` is a monotonic counter owned by the
 * dialog, so attaching the same file twice still produces two distinct ids —
 * the host validator refuses a list with duplicates.
 */
export function attachmentIdFor(name: string, index: number): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  return `${index}-${slug}`;
}

/**
 * Check one candidate file against the type and per-image size limits.
 * Returns the narrowed mime type, or the sentence to show beside the file name.
 */
export function classifyFile(
  file: { name: string; type: string; size: number },
): { ok: true; mime: FeedbackImageMime } | { ok: false; error: string } {
  const mime = toImageMime(file.type);
  if (!mime) return { ok: false, error: MIME_REASON };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: EMPTY_REASON };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: SIZE_REASON };
  return { ok: true, mime };
}

/**
 * Decide which of `incoming` can join `existing`, in order.
 *
 * Enforces all three limits: the accepted type, the per-image ceiling, the
 * count ceiling, and the whole-report ceiling — the running total counts the
 * images already on the report plus everything accepted so far in this batch.
 */
export function acceptFiles(
  existing: readonly FeedbackAttachment[],
  incoming: readonly { name: string; type: string; size: number }[],
): { accepted: { name: string; mime: FeedbackImageMime }[]; rejected: { name: string; error: string }[] } {
  const accepted: { name: string; mime: FeedbackImageMime }[] = [];
  const rejected: { name: string; error: string }[] = [];

  let count = existing.length;
  let total = existing.reduce((sum, attachment) => sum + attachment.bytes, 0);

  for (const file of incoming) {
    const classified = classifyFile(file);
    if (!classified.ok) {
      rejected.push({ name: file.name, error: classified.error });
      continue;
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, error: COUNT_REASON });
      continue;
    }
    if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, error: TOTAL_SIZE_REASON });
      continue;
    }
    accepted.push({ name: file.name, mime: classified.mime });
    count += 1;
    total += file.size;
  }

  return { accepted, rejected };
}

/** Read a blob as a `data:<mime>;base64,<payload>` URL. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/**
 * Turn a picked / pasted / dropped file into an attachment.
 *
 * Callers run {@link acceptFiles} first: this throws for a file the limits
 * would have rejected, rather than producing an attachment the host validator
 * would refuse at submit time.
 */
export async function fileToAttachment(
  file: File,
  source: FeedbackAttachmentSource,
  index: number,
): Promise<FeedbackAttachment> {
  const classified = classifyFile({ name: file.name, type: file.type, size: file.size });
  if (!classified.ok) throw new Error(classified.error);
  const dataUrl = await blobToDataUrl(file);
  return {
    id: attachmentIdFor(file.name, index),
    name: file.name,
    mime: classified.mime,
    bytes: file.size,
    dataUrl,
    source,
  };
}

/** Decoded byte length of a base64 payload, without decoding it. */
function base64ByteLength(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Turn a data URL (the captured canvas, or an image already in hand) into an
 * attachment. Returns null when the URL is malformed, carries a type that is
 * not accepted, or decodes to more than the per-image ceiling.
 */
export function dataUrlToAttachment(
  dataUrl: string,
  name: string,
  source: FeedbackAttachmentSource,
  index: number,
): FeedbackAttachment | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = toImageMime(match[1]);
  if (!mime) return null;
  const bytes = base64ByteLength(match[2]);
  if (bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES) return null;
  return { id: attachmentIdFor(name, index), name, mime, bytes, dataUrl, source };
}
