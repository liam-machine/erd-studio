/**
 * MetaEditor — the structured metadata (`meta:`) of a model or a column.
 *
 * Top-level text values are edited in place; a nested map, a list, `true` /
 * `false` or an empty value is shown as it is and edited in the model file,
 * so the canvas never rewrites a value it cannot represent. Every change is
 * posted as an `updateMeta` patch (set or remove one key), never the whole map.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta } from '@erd-studio/core';
import { useCanvasHost, useIsViewer } from '../../host/canvasEnvironment';
import { formatMetaValue } from '../../lib/metaFormat';

export { formatMetaValue };

interface MetaEditorProps {
  modelName: string;
  /** Edit this column's `meta` instead of the model's. */
  columnName?: string;
  meta?: Meta;
  readOnly?: boolean;
  /** Smaller layout for a column row. */
  compact?: boolean;
}

const hasKey = (meta: Meta | undefined, key: string): boolean =>
  !!meta && Object.prototype.hasOwnProperty.call(meta, key);

export function MetaEditor({ modelName, columnName, meta, readOnly, compact }: MetaEditorProps) {
  const host = useCanvasHost();
  const viewer = useIsViewer();
  const editable = !readOnly && !viewer;
  const entries = Object.entries(meta ?? {});

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Enter saves and unmounts the input, and the browser then blurs it: without
  // this, that blur would post the same edit a second time (two undo steps).
  const savedRef = useRef(false);

  // A refresh from the host (another tab, undo) ends any edit in progress on a key that went away.
  useEffect(() => {
    if (editingKey !== null && !hasKey(meta, editingKey)) setEditingKey(null);
  }, [meta, editingKey]);

  const post = useCallback(
    (patch: { set?: Record<string, string>; remove?: string[] }) => {
      host.postMessage({
        type: 'updateMeta',
        payload: { modelName, ...(columnName !== undefined ? { columnName } : {}), ...patch },
      });
    },
    [host, modelName, columnName],
  );

  const startEdit = useCallback((key: string, value: string) => {
    savedRef.current = false;
    setEditingKey(key);
    setEditValue(value);
  }, []);

  const saveValue = useCallback(() => {
    if (editingKey === null || savedRef.current) return;
    savedRef.current = true;
    if (editValue !== meta?.[editingKey]) post({ set: { [editingKey]: editValue } });
    setEditingKey(null);
  }, [editingKey, editValue, meta, post]);

  const cancelEdit = useCallback(() => {
    savedRef.current = true;
    setEditingKey(null);
  }, []);

  const saveNew = useCallback(() => {
    const key = newKey.trim();
    if (!key) {
      setError('Key is required');
      return;
    }
    if (hasKey(meta, key)) {
      setError(`"${key}" already exists`);
      return;
    }
    post({ set: { [key]: newValue } });
    setAdding(false);
    setNewKey('');
    setNewValue('');
    setError(null);
  }, [newKey, newValue, meta, post]);

  const cancelNew = useCallback(() => {
    setAdding(false);
    setNewKey('');
    setNewValue('');
    setError(null);
  }, []);

  if (entries.length === 0 && !editable) return null;

  const block = compact ? 'meta-editor meta-editor--compact' : 'meta-editor';

  return (
    <div className={block}>
      {!compact && (
        <h4 className="detail-panel__section-title meta-editor__title">Metadata</h4>
      )}
      {compact && entries.length > 0 && (
        <span className="meta-editor__label">Metadata</span>
      )}

      {entries.length > 0 && (
        <dl className="meta-editor__list">
          {entries.map(([key, value]) => {
            const text = typeof value === 'string';
            const editingThis = editingKey === key;
            return (
              <div className="meta-editor__row" key={key}>
                <dt className="meta-editor__key" title={key}>{key}</dt>
                <dd className="meta-editor__value">
                  {editingThis ? (
                    <input
                      className="meta-editor__input"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={saveValue}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveValue(); }
                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                      }}
                      aria-label={`Value of ${key}`}
                      autoFocus
                    />
                  ) : (
                    <span
                      className={`meta-editor__text${text ? '' : ' meta-editor__text--structured'}`}
                      title={editable && !text ? 'Edit nested values in the model file' : formatMetaValue(value)}
                      onDoubleClick={editable && text ? () => startEdit(key, value) : undefined}
                    >
                      {formatMetaValue(value)}
                    </span>
                  )}
                </dd>
                {editable && !editingThis && (
                  <span className="meta-editor__actions">
                    {text && (
                      <button
                        className="meta-editor__icon-btn"
                        onClick={() => startEdit(key, value)}
                        title={`Edit ${key}`}
                        aria-label={`Edit ${key}`}
                      >
                        ✎
                      </button>
                    )}
                    <button
                      className="meta-editor__icon-btn"
                      onClick={() => post({ remove: [key] })}
                      title={`Remove ${key}`}
                      aria-label={`Remove ${key}`}
                    >
                      ×
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </dl>
      )}

      {editable && (adding ? (
        <div className="meta-editor__new">
          <input
            className="meta-editor__input meta-editor__input--key"
            value={newKey}
            onChange={(e) => { setNewKey(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelNew(); } }}
            placeholder="key (e.g. owner)"
            aria-label="Metadata key"
            autoFocus
          />
          <input
            className="meta-editor__input"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); saveNew(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelNew(); }
            }}
            placeholder="value"
            aria-label="Metadata value"
          />
          <div className="meta-editor__new-actions">
            <button className="detail-panel__button" onClick={saveNew}>Add</button>
            <button className="detail-panel__button" onClick={cancelNew}>Cancel</button>
          </div>
          {error && <span className="meta-editor__error">{error}</span>}
        </div>
      ) : (
        <button
          className="detail-panel__rationale-add-btn meta-editor__add-btn"
          onClick={() => setAdding(true)}
          title="Add structured metadata such as owner, source system or lineage"
        >
          + Add Metadata
        </button>
      ))}
    </div>
  );
}
