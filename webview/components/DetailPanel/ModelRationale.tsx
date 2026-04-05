/**
 * ModelRationale — collapsible section for all design rationale fields.
 *
 * Renders a clickable "Design Rationale" heading that toggles the body.
 * Each field has its own add/edit/read lifecycle and sends independent
 * field-patch messages via RationaleField.
 *
 * Conditional fields:
 * - roleChoice: shown when model has a modelRole
 * - grainChoice: shown when model has a grain
 * - scdStrategy: shown when model has a modelRole
 * - measures: shown when model has a grain
 *
 * When no rationale exists and no conditional fields are visible,
 * shows a dashed "Add Rationale" button that opens the section.
 */

import { useMemo, useState } from 'react';
import type { Rationale, ModelRole } from '../../../src/types/semantic';
import { RationaleField } from './RationaleField';

interface ModelRationaleProps {
  modelName: string;
  rationale?: Rationale;
  modelRole?: ModelRole;
  grain?: string;
}

export function ModelRationale({ modelName, rationale, modelRole, grain }: ModelRationaleProps) {
  const [open, setOpen] = useState(false);
  // Track whether user has clicked "Add Rationale" to force-show and auto-edit
  const [forceShow, setForceShow] = useState(false);

  const filledCount = useMemo(() => {
    if (!rationale) return 0;
    return [
      rationale.purpose,
      rationale.design,
      rationale.roleChoice,
      rationale.grainChoice,
      rationale.scdStrategy,
      rationale.measures,
    ].filter(Boolean).length;
  }, [rationale]);

  const hasAnyContent = filledCount > 0;

  // Show section if there's content, conditional fields apply, or user forced it open
  const showSection = hasAnyContent || forceShow || !!modelRole || !!grain;

  if (!showSection) {
    return (
      <div className="detail-panel__rationale-section">
        <button
          className="detail-panel__rationale-add-btn"
          onClick={() => {
            setForceShow(true);
            setOpen(true);
          }}
          title="Add design rationale"
        >
          + Add Rationale
        </button>
      </div>
    );
  }

  return (
    <div className="detail-panel__rationale-section">
      <button
        className="detail-panel__rationale-toggle"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open}
      >
        <span className={`detail-panel__rationale-chevron${open ? ' detail-panel__rationale-chevron--open' : ''}`}>
          ▸
        </span>
        Design Rationale
        {filledCount > 0 && (
          <span className="detail-panel__rationale-count">
            ({filledCount})
          </span>
        )}
      </button>

      {open && (
        <div className="detail-panel__rationale-body">
          <RationaleField
            modelName={modelName}
            rationale={rationale}
            fieldKey="purpose"
            label="Purpose"
            placeholder="What requirements does this model meet?"
            autoEdit={forceShow && !rationale?.purpose}
          />

          <RationaleField
            modelName={modelName}
            rationale={rationale}
            fieldKey="design"
            label="Design"
            placeholder="Why was this model designed this way?"
          />

          {modelRole && (
            <RationaleField
              modelName={modelName}
              rationale={rationale}
              fieldKey="roleChoice"
              label="Role Choice"
              placeholder="Why was this model role selected?"
            />
          )}

          {grain && (
            <RationaleField
              modelName={modelName}
              rationale={rationale}
              fieldKey="grainChoice"
              label="Grain Choice"
              placeholder="Why was this grain chosen over alternatives?"
            />
          )}

          {modelRole && (
            <RationaleField
              modelName={modelName}
              rationale={rationale}
              fieldKey="scdStrategy"
              label="SCD Strategy"
              placeholder="Overall SCD strategy across dimension attributes"
            />
          )}

          {grain && (
            <RationaleField
              modelName={modelName}
              rationale={rationale}
              fieldKey="measures"
              label="Measures"
              placeholder="Why measures are structured this way"
            />
          )}
        </div>
      )}
    </div>
  );
}
