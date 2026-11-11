/**
 * AliasEditor — the "Warehouse name" row of the detail panel's metadata.
 *
 * A model's name is its identity; its alias is the table dbt builds it as.
 * Setting one is how two layers can each have a `date` table: the models are
 * `silver_date` and `gold_date`, both with the alias `date`.
 *
 * Read mode shows the table name (the model name, dimmed, when there is no
 * alias). Edit mode is a single input: Enter saves, Escape cancels, and an
 * empty value clears the alias.
 *
 * Without a dbt project (`dbtWording` false) the tooltip and hint say the
 * same thing without naming dbt. The viewer always passes false: a page
 * outside VS Code cannot know whether the project uses dbt.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TABLE_ALIAS_MAX_LENGTH, TABLE_ALIAS_RULE, isValidTableAlias } from '@erd-studio/core';
import { useCanvasHost } from '../../host/canvasEnvironment';

interface AliasEditorProps {
  /** What the diagram calls the table: the name the edit is posted for. */
  modelName: string;
  /**
   * The table's own name when `modelName` is not it (one of two same-named
   * tables from different schema folders, `DisplayTable.tableName`): what
   * the row shows and an alias is compared with. Absent: `modelName`.
   */
  tableName?: string;
  alias?: string;
  /** Physical stage and the viewer: show the value, offer no edit. */
  readOnly: boolean;
  /**
   * Name dbt in the tooltip and hint (default). False in a folder with no
   * dbt project, where the alias is just the table's name in the warehouse,
   * and always in the viewer.
   */
  dbtWording?: boolean;
}

/** The edit-mode hint under the input. */
export function aliasHint(dbtWording: boolean): string {
  return dbtWording
    ? "The table dbt builds (its alias). Leave blank to use the table's name."
    : "The table's name in the warehouse (its alias). Leave blank to use the table's name.";
}

/** The read-mode tooltip on the value. */
export function aliasTitle(modelName: string, alias: string | undefined, dbtWording: boolean): string {
  if (!alias) return "Same as the table's name";
  return dbtWording
    ? `Built as ${alias} (dbt alias); the table's name is ${modelName}`
    : `Named ${alias} in the warehouse; the table's name is ${modelName}`;
}

export function AliasEditor({ modelName, tableName, alias, readOnly, dbtWording = true }: AliasEditorProps) {
  const host = useCanvasHost();
  const ownName = tableName ?? modelName;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(alias ?? '');
  // Enter saves and closes the input, and the input's blur can follow it:
  // one edit must post once, or it costs the user a second undo step.
  const settled = useRef(false);

  // Sync from props when not editing (e.g. a domain refresh from the host).
  useEffect(() => {
    if (!editing) {
      setValue(alias ?? '');
    }
  }, [alias, editing]);

  const trimmed = value.trim();
  const error = trimmed && !isValidTableAlias(trimmed) ? TABLE_ALIAS_RULE : null;

  const handleSave = useCallback(() => {
    if (error || settled.current) return;
    settled.current = true;
    // An alias equal to the table's own name is no alias.
    const next = trimmed === ownName ? '' : trimmed;
    // Skip no-op saves to avoid spurious undo entries.
    if (next !== (alias ?? '')) {
      host.postMessage({ type: 'updateModelAlias', payload: { modelName, alias: next } });
    }
    setEditing(false);
  }, [host, modelName, ownName, alias, trimmed, error]);

  const handleCancel = useCallback(() => {
    settled.current = true;
    setValue(alias ?? '');
    setEditing(false);
  }, [alias]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel],
  );

  const startEditing = useCallback(() => {
    settled.current = false;
    setEditing(true);
  }, []);

  if (editing) {
    return (
      <div className="detail-panel__metadata-row detail-panel__metadata-row--alias">
        <span className="detail-panel__label detail-panel__label--wide">Warehouse name</span>
        <span className="detail-panel__alias-edit">
          <input
            className={`detail-panel__alias-input${error ? ' detail-panel__alias-input--error' : ''}`}
            value={value}
            placeholder={ownName}
            maxLength={TABLE_ALIAS_MAX_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => (error ? handleCancel() : handleSave())}
            aria-label="Warehouse name (alias)"
            aria-invalid={error ? true : undefined}
            autoFocus
          />
          <span className={`detail-panel__alias-hint${error ? ' detail-panel__alias-hint--error' : ''}`}>
            {error ?? aliasHint(dbtWording)}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="detail-panel__metadata-row detail-panel__metadata-row--alias">
      <span className="detail-panel__label detail-panel__label--wide">Warehouse name</span>
      <span
        className={`detail-panel__value${alias ? '' : ' detail-panel__value--muted'}`}
        title={aliasTitle(ownName, alias, dbtWording)}
        onDoubleClick={readOnly ? undefined : startEditing}
      >
        {alias || ownName}
      </span>
      {!readOnly && (
        <button
          className="detail-panel__rationale-edit-btn detail-panel__alias-edit-btn"
          onClick={startEditing}
          title="Set the warehouse name (alias)"
          aria-label="Edit warehouse name"
        >
          ✎
        </button>
      )}
    </div>
  );
}
