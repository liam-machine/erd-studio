/**
 * AttachmentGrid — image thumbnails plus the drop zone that feeds them.
 *
 * Two of the three input routes live here (the picker and a drop on the zone);
 * the third, a paste, is caught by the dialog because a paste lands wherever
 * the caret is. All three call the same `onFiles`, so the limits in
 * `webview/lib/feedbackAttachments.ts` are enforced in exactly one place.
 *
 * The zone disappears once the report holds `max` images rather than staying
 * as a control that can only refuse.
 */

import { useCallback, useRef, useState } from 'react';

import type { FeedbackAttachment, FeedbackAttachmentSource } from '../../../src/types/feedback';
import { MAX_ATTACHMENTS } from '../../../src/types/feedback';

export interface AttachmentGridProps {
  attachments: FeedbackAttachment[];
  /** Maximum images on one report; the drop zone hides at this count. */
  max: number;
  onRemove: (id: string) => void;
  onFiles: (files: readonly File[], source: FeedbackAttachmentSource) => void;
  /** Set by the readiness meter's "Attach one" action to draw the eye here. */
  dropHighlighted: boolean;
}

/** Accept attribute mirroring the mime types the attachment helpers allow. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export function AttachmentGrid({
  attachments,
  max,
  onRemove,
  onFiles,
  dropHighlighted,
}: AttachmentGridProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) onFiles(Array.from(files), 'drop');
    },
    [onFiles],
  );

  const handlePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length) onFiles(Array.from(files), 'picker');
      // Reset so picking the same file twice still fires a change event.
      e.target.value = '';
    },
    [onFiles],
  );

  const zoneClass = [
    'feedback__dropzone',
    dragOver ? 'feedback__dropzone--over' : '',
    dropHighlighted ? 'feedback__dropzone--urged' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {attachments.length > 0 && (
        <div className="feedback__thumbs">
          {attachments.map((attachment) => (
            <div className="feedback__thumb" key={attachment.id}>
              <img className="feedback__thumb-img" src={attachment.dataUrl} alt="" />
              {attachment.source === 'canvas' && (
                <span className="feedback__thumb-badge">canvas</span>
              )}
              <div className="feedback__thumb-name" title={attachment.name}>
                {attachment.name}
              </div>
              <button
                type="button"
                className="feedback__thumb-remove"
                onClick={() => onRemove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {attachments.length < max && (
        <div
          className={zoneClass}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          Drop images here, paste from the clipboard, or{' '}
          <button
            type="button"
            className="feedback__link"
            onClick={() => inputRef.current?.click()}
          >
            choose files
          </button>
          <div className="feedback__dropzone-hint">
            PNG, JPEG, GIF or WebP · up to {MAX_ATTACHMENTS} · 10 MB each
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={handlePicked}
          />
        </div>
      )}
    </>
  );
}
