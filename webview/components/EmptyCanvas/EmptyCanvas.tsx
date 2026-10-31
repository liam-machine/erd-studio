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
 * Without a dbt project (`logicalOnly`) there is nothing to pull in: the card
 * drops "Add tables from dbt" and makes "New table" the primary action.
 *
 * "Add existing tables" opens the Add Existing Table dialog, as the toolbar's
 * "+ Add" menu does. It shows only when there is something to add (the host's
 * `existingModels` already leaves out this diagram's tables), and becomes the
 * primary action when the Table Library holds tables this diagram doesn't:
 * reusing a table beats drawing it again.
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
  const logicalOnly = useEditorStore((s) => s.logicalOnly);
  const existingModels = useEditorStore((s) => s.existingModels);
  const manifestModels = useEditorStore((s) => s.manifestModels);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const addExistingOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const send = useSend();

  if (!domain || domain.stage !== 'logical' || domain.readOnly || domain.models.length > 0) {
    return null;
  }
  // The dialogs it opens sit in the same spot; one thing at a time.
  if (newModelDialogOpen || addExistingOpen) { return null; }

  const existing = existingModels ?? [];
  const libraryHasTables = existing.some((m) => m.source === 'logical');
  const canAddExisting = existing.length > 0 || (manifestModels ?? []).length > 0;
  const primary: 'existing' | 'dbt' | 'new' = libraryHasTables ? 'existing' : !logicalOnly ? 'dbt' : 'new';
  const buttonClass = (which: typeof primary): string =>
    `empty-canvas__button${primary === which ? ' empty-canvas__button--primary' : ''}`;

  return (
    <div className="empty-canvas">
      <section className="empty-canvas__card" aria-labelledby="empty-canvas-title">
        <h2 id="empty-canvas-title" className="empty-canvas__title">This diagram is empty</h2>
        <p className="empty-canvas__body">
          {libraryHasTables
            ? (logicalOnly
              ? 'Reuse tables from your Table Library, or add a new one.'
              : 'Reuse tables from your Table Library, start from your dbt project, or add a table by hand.')
            : logicalOnly
              ? 'Add your first table. Each one is a file you can commit.'
              : 'Start from your dbt project, or add a table by hand.'}
        </p>
        <div className="empty-canvas__actions">
          {libraryHasTables && (
            <button
              type="button"
              className={buttonClass('existing')}
              onClick={() => setAddExistingModelDialogOpen(true)}
            >
              Add existing tables
            </button>
          )}
          {!logicalOnly && (
            <button
              type="button"
              className={buttonClass('dbt')}
              onClick={() => send({ type: 'addModelsFromDbt' })}
            >
              Add tables from dbt
            </button>
          )}
          <button
            type="button"
            className={buttonClass('new')}
            onClick={() => setNewModelDialogOpen(true)}
          >
            New table
          </button>
          {!libraryHasTables && canAddExisting && (
            <button
              type="button"
              className={buttonClass('existing')}
              onClick={() => setAddExistingModelDialogOpen(true)}
            >
              Add existing tables
            </button>
          )}
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
