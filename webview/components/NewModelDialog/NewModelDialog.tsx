/**
 * NewModelDialog — dialog for creating new design models.
 *
 * Displays centered when newModelDialogOpen is true. Contains minimal
 * structure for F201 to implement form fields, templates, and validation.
 *
 * Phase 1 (F200): Basic shell with close button.
 * Phase 2 (F201): Form fields, JHG templates, validation, and model creation logic.
 */

import { useCallback } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import './NewModelDialog.css';

export function NewModelDialog() {
  const isOpen = useEditorStore((s) => s.newModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);

  const handleClose = useCallback(() => {
    setNewModelDialogOpen(false);
  }, [setNewModelDialogOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <Panel position="top-center" className="new-model-dialog">
      {/* Header */}
      <div className="new-model-dialog__header">
        <h3 className="new-model-dialog__title">New Model</h3>
        <button
          className="new-model-dialog__close"
          onClick={handleClose}
          title="Close dialog"
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>

      {/* Content placeholder — F201 will add form fields here */}
      <div className="new-model-dialog__content">
        <p className="new-model-dialog__placeholder">
          Form fields will be implemented in F201
        </p>
      </div>

      {/* Footer placeholder — F201 will add action buttons here */}
      <div className="new-model-dialog__footer">
        <button
          className="new-model-dialog__button"
          onClick={handleClose}
        >
          Close
        </button>
      </div>
    </Panel>
  );
}
