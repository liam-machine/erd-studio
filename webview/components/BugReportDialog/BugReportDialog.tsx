/**
 * BugReportDialog — "Report a Bug" form.
 *
 * Collects a title, description and optional repro steps, optionally captures
 * a screenshot of the canvas (copied to the clipboard), and posts a
 * `reportBug` message. The extension host opens a prefilled GitHub issue form
 * in the browser; nothing is submitted from inside VS Code, so the user always
 * reviews the report before it goes anywhere.
 *
 * Rendered as a fixed overlay (not a React Flow `Panel`) so it also works on
 * the error screen where the canvas is unmounted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { captureScreenshot } from '../../lib/screenshot';
import type { ReportBugMessage } from '../../../src/types/messages';
import './BugReportDialog.css';

/** Selector for everything the screenshot should leave out (this dialog). */
const EXCLUDE_FROM_SCREENSHOT = '.bug-report, .bug-report__backdrop';

export function BugReportDialog() {
  const vscode = useVsCodeApi();
  const open = useEditorStore((s) => s.bugReportDialogOpen);
  const prefill = useEditorStore((s) => s.bugReportPrefill);
  const setOpen = useEditorStore((s) => s.setBugReportDialogOpen);
  const domain = useEditorStore((s) => s.domain);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Reset the form each time the dialog opens, applying any prefill.
  useEffect(() => {
    if (!open) return;
    setTitle(prefill?.title ?? '');
    setDescription(prefill?.description ?? '');
    setSteps('');
    setBusy(false);
    setStatus(null);
    const id = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, prefill]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  // Escape closes the dialog. Handled here (capture phase) rather than relying
  // on the canvas keyboard handler so it also works on the error screen.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, busy, close]);

  const handleSubmit = useCallback(async () => {
    if (busy) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setStatus('Please give the report a short title.');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);

    let screenshotDataUrl: string | undefined;
    let screenshotOnClipboard = false;
    if (includeScreenshot) {
      setStatus('Capturing screenshot…');
      const root = document.getElementById('root');
      if (root) {
        const shot = await captureScreenshot(root, EXCLUDE_FROM_SCREENSHOT);
        if (shot.dataUrl) {
          screenshotDataUrl = shot.dataUrl;
          screenshotOnClipboard = shot.onClipboard;
        } else {
          useEditorStore.getState().recordError('screenshot', shot.error ?? 'capture failed');
        }
      }
    }

    const state = useEditorStore.getState();
    const message: ReportBugMessage = {
      type: 'reportBug',
      payload: {
        title: trimmedTitle,
        description: description.trim(),
        steps: steps.trim() || undefined,
        includeDiagnostics,
        screenshotDataUrl,
        screenshotOnClipboard,
        webviewErrors: state.recentErrors,
        domain: domain
          ? {
              name: domain.domain,
              layer: domain.layer,
              stage: domain.stage,
              modelCount: domain.models.length,
              relationshipCount: domain.relationships.length,
              schemaVersion: domain.schemaVersion,
            }
          : undefined,
      },
    };
    vscode.postMessage(message);
    close();
  }, [busy, title, description, steps, includeDiagnostics, includeScreenshot, domain, vscode, close]);

  if (!open) return null;

  return (
    <>
      <div className="bug-report__backdrop" onClick={busy ? undefined : close} />
      <div className="bug-report" role="dialog" aria-modal="true" aria-labelledby="bug-report-title">
        <div className="bug-report__header">
          <h3 id="bug-report-title" className="bug-report__title">Report a Bug</h3>
          <button
            type="button"
            className="bug-report__close"
            onClick={close}
            aria-label="Close"
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div className="bug-report__content">
          <p className="bug-report__hint">
            This opens a prefilled GitHub issue in your browser. You can review and edit
            everything before submitting.
          </p>

          <div className="bug-report__field">
            <label className="bug-report__label" htmlFor="bug-report-title-input">Title</label>
            <input
              id="bug-report-title-input"
              ref={titleRef}
              className="bug-report__input"
              type="text"
              value={title}
              maxLength={120}
              placeholder="Short summary, e.g. Relationship arrow disappears after column rename"
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="bug-report__field">
            <label className="bug-report__label" htmlFor="bug-report-description">What happened?</label>
            <textarea
              id="bug-report-description"
              className="bug-report__textarea"
              rows={4}
              value={description}
              placeholder="What did you expect, and what happened instead?"
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="bug-report__field">
            <label className="bug-report__label" htmlFor="bug-report-steps">
              Steps to reproduce <span className="bug-report__optional">(optional)</span>
            </label>
            <textarea
              id="bug-report-steps"
              className="bug-report__textarea"
              rows={3}
              value={steps}
              placeholder={'1. Open the domain\n2. Click …'}
              onChange={(e) => setSteps(e.target.value)}
              disabled={busy}
            />
          </div>

          <label className="bug-report__check">
            <input
              type="checkbox"
              checked={includeScreenshot}
              onChange={(e) => setIncludeScreenshot(e.target.checked)}
              disabled={busy}
            />
            <span>
              Include a screenshot of this canvas
              <span className="bug-report__check-hint">Copied to your clipboard — paste it into the issue.</span>
            </span>
          </label>

          <label className="bug-report__check">
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(e) => setIncludeDiagnostics(e.target.checked)}
              disabled={busy}
            />
            <span>
              Include diagnostics
              <span className="bug-report__check-hint">
                Extension &amp; VS Code versions, OS, domain summary (names and counts only), recent errors.
              </span>
            </span>
          </label>

          {status && <div className="bug-report__status" role="status">{status}</div>}
        </div>

        <div className="bug-report__footer">
          <button type="button" className="bug-report__button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="bug-report__button bug-report__button--primary"
            onClick={() => void handleSubmit()}
            disabled={busy}
          >
            {busy ? 'Preparing…' : 'Open on GitHub'}
          </button>
        </div>
      </div>
    </>
  );
}
