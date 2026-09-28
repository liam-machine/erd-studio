/**
 * EmptyCanvas — the prompt over a logical canvas whose domain has no models.
 *
 * A blank canvas used to be where most first sessions ended: nothing on it
 * said what to do next. This card offers the two ways to start: pull models in
 * from the dbt project (`addModelsFromDbt` — the host asks which ones with a
 * QuickPick and lays the result out), or draw one by hand with the same
 * New Design Model dialog the toolbar's "+ Add" menu opens. The AI route
 * points at the Welcome panel rather than naming a command: the setup skill
 * may not be installed yet, and each assistant invokes it differently — the
 * panel knows both.
 *
 * Only the card takes pointer events; the overlay around it lets drags and
 * wheel zooms through to the canvas. It disappears as soon as the domain has a
 * model, on the physical stage and for a read-only domain.
 */

import React from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import './EmptyCanvas.css';

export const EmptyCanvas: React.FC = () => {
  const domain = useEditorStore((s) => s.domain);
  const newModelDialogOpen = useEditorStore((s) => s.newModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const send = useSend();

  if (!domain || domain.stage !== 'logical' || domain.readOnly || domain.models.length > 0) {
    return null;
  }
  // The dialog it opens sits in the same spot; one thing at a time.
  if (newModelDialogOpen) { return null; }

  return (
    <div className="empty-canvas">
      <section className="empty-canvas__card" aria-labelledby="empty-canvas-title">
        <h2 id="empty-canvas-title" className="empty-canvas__title">This diagram is empty</h2>
        <p className="empty-canvas__body">Start from your dbt project, or add a model by hand.</p>
        <div className="empty-canvas__actions">
          <button
            type="button"
            className="empty-canvas__button empty-canvas__button--primary"
            onClick={() => send({ type: 'addModelsFromDbt' })}
          >
            Add models from dbt
          </button>
          <button
            type="button"
            className="empty-canvas__button"
            onClick={() => setNewModelDialogOpen(true)}
          >
            New model
          </button>
        </div>
        <p className="empty-canvas__hint">
          Or let your AI assistant draw it:{' '}
          <button
            type="button"
            className="empty-canvas__link"
            onClick={() => send({ type: 'openGettingStarted' })}
          >
            set it up in the Welcome panel
          </button>
        </p>
      </section>
    </div>
  );
};
