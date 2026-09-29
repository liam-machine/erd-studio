/**
 * ManifestHint — the logical stage's "Run dbt parse" strip (#113).
 *
 * #110 put **Run dbt parse** on the physical stage's notice, but most canvases
 * never leave the logical stage, so a project with no `manifest.json` never
 * learned why its Physical view would be empty. The host flags a logical
 * payload with `manifestMissing` only when dbt has not written a manifest and
 * this workspace has not dismissed the hint; every payload re-states it, so
 * once `dbt parse` runs the manifest watcher's refresh arrives without the flag
 * and the strip goes away by itself.
 *
 * Never on the physical stage (PhysicalSourceNotice speaks there) and never on
 * an empty diagram, where the EmptyCanvas card is the one thing to read. The ×
 * is "don't show again for this project": hidden here at once, persisted by
 * the host in workspaceState.
 */

import React from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import './ManifestHint.css';

export const ManifestHint: React.FC = () => {
  const domain = useEditorStore((s) => s.domain);
  const manifestMissing = useEditorStore((s) => s.manifestMissing);
  const dismissed = useEditorStore((s) => s.manifestHintDismissed);
  const dismiss = useEditorStore((s) => s.dismissManifestHint);
  const send = useSend();

  if (!manifestMissing || dismissed) { return null; }
  if (domain?.stage !== 'logical' || domain.models.length === 0) { return null; }

  const onDismiss = () => {
    dismiss();
    send({ type: 'dismissManifestHint' });
  };

  return (
    <div className="manifest-hint" role="status">
      <span className="manifest-hint__icon" aria-hidden="true">&#9432;</span>
      <span className="manifest-hint__text">
        <span className="manifest-hint__lead">
          dbt hasn&apos;t parsed this project yet. Your diagram is fine, but the Physical view can&apos;t
          show columns and tests without it.
        </span>{' '}
        <span className="manifest-hint__hint">Needs a working dbt profile.</span>
      </span>
      <button
        type="button"
        className="manifest-hint__action"
        onClick={() => send({ type: 'runDbtParse' })}
      >
        Run dbt parse
      </button>
      <button
        type="button"
        className="manifest-hint__dismiss"
        onClick={onDismiss}
        aria-label="Don't show again for this project"
        title="Don't show again for this project"
      >
        &times;
      </button>
    </div>
  );
};
