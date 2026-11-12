/**
 * FieldsSection — a table's (or a column's) context fields in the Detail panel.
 *
 * The rows come from core's resolver (`resolveTableFields` /
 * `resolveColumnFields`) over the project's field list
 * (`DisplaySubjectArea.fields`, else core's `STARTING_FIELD_LIST`), so the
 * canvas, the CLI and the assistant agree on what a table records. A field's
 * value stays where it always lived (its *home*), and each edit is posted as
 * the message that home has always used:
 *
 * - `rationale` → `updateModelRationale` with one key (`''` clears it)
 * - `meta` → `updateMeta` (set one key; a clear removes the key)
 * - `grain` → `updateModelGrain` (`''` clears it)
 * - `role` → `updateModelRole` (`null` clears it)
 *
 * A column's section lists only the fields kept in the column's `meta`; its
 * natural key, SCD type and additivity stay in `ColumnRowEditor`.
 *
 * Three presentations, gated `viewer ? … : (readOnly ? … : <editor>)`:
 * the viewer and a read-only stage (physical) show the rows that have a
 * value, labels and values only (two columns: muted label, wrapped value),
 * and post nothing; in the viewer a table's section is a fold, its heading a
 * button with the count, closed unless `open` says otherwise. The editor shows the list
 * in order (empty fields with their guidance), retired fields with a badge,
 * values the list does not name under "Not in your list", and "+ Add field".
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import {
  DBML_IMPORT_META_KEY,
  FIELD_KEY_PATTERN,
  FIELD_TYPES,
  STARTING_FIELD_LIST,
  builtInField,
  fieldRowId,
  formatMetaValue,
  reservedFieldKeyReason,
  resolveColumnFields,
  resolveTableFields,
} from '@erd-studio/core';
import type {
  DisplayColumn,
  DisplayTable,
  FieldList,
  FieldRow,
  FieldScope,
  Meta,
  MetaValue,
  Rationale,
  TableRole,
} from '@erd-studio/core';
import { useIsViewer, useSend } from '../../host/canvasEnvironment';
import { roleLabel } from '../../lib/roleOptions';
import { IconChevron, IconClose, IconPencil } from './panelIcons';
import './FieldsSection.css';

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** The table properties the resolver reads. */
export type FieldsTable = Pick<DisplayTable, 'modelRole' | 'grain' | 'meta' | 'rationale'>;

/** The column properties the resolver reads. */
export type FieldsColumn = Pick<DisplayColumn, 'name' | 'meta' | 'isNaturalKey' | 'scdType' | 'additiveType'>;

/** Home kinds this renderer knows how to edit. A home from a newer core is shown read-only. */
const KNOWN_HOME_KINDS: ReadonlySet<string> = new Set(['rationale', 'meta', 'grain', 'role', 'naturalKey', 'scdType', 'additiveType']);

/** The label of Import DBML's bookkeeping row (`meta.dbml`). */
export const DBML_IMPORT_ROW_LABEL = 'Kept from DBML import';

const homeKind = (row: FieldRow): string | undefined => {
  const kind = (row.definition.home as { kind?: unknown } | undefined)?.kind;
  return typeof kind === 'string' ? kind : undefined;
};

/** Whether this renderer understands the row's definition (a newer core's type or home is shown read-only). */
function knownDefinition(row: FieldRow): boolean {
  const kind = homeKind(row);
  return (FIELD_TYPES as readonly string[]).includes(row.definition.type) && kind !== undefined && KNOWN_HOME_KINDS.has(kind);
}

/** Whether a row holds a value a reader would see: anything except no value or blank text. */
export function rowHasValue(row: FieldRow): boolean {
  if (row.value === undefined) return false;
  return !(typeof row.value === 'string' && row.value.trim() === '');
}

/** The `meta.dbml` entry Import DBML keeps, or undefined. */
export function dbmlImportValue(owner: { meta?: Meta } | undefined): MetaValue | undefined {
  const meta = owner?.meta;
  if (!meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, DBML_IMPORT_META_KEY)) return undefined;
  return meta[DBML_IMPORT_META_KEY];
}

/** The rows a section draws: a column's section keeps only the fields held in its `meta`. */
export function fieldRows(table: FieldsTable, column: FieldsColumn | undefined, list: FieldList): FieldRow[] {
  if (column) {
    return resolveColumnFields(column as DisplayColumn, table as DisplayTable, list).filter((row) => row.id.startsWith('meta:'));
  }
  return resolveTableFields(table as DisplayTable, list);
}

/**
 * Whether a table's read-only Fields section has anything to show: a field
 * with a value, or the "Kept from DBML import" row.
 */
export function tableFieldsShown(table: FieldsTable, list: FieldList = STARTING_FIELD_LIST): boolean {
  return fieldRows(table, undefined, list).some(rowHasValue) || dbmlImportValue(table) !== undefined;
}

/** The text a row's value reads as: Yes / No, a role's label, or the value as written. */
function valueText(row: FieldRow): string {
  const def = row.definition;
  if (row.choice !== undefined) {
    if (def.type === 'yes-no') return row.choice === 'true' ? 'Yes' : 'No';
    if (homeKind(row) === 'role') return roleLabel(row.choice);
    return row.choice;
  }
  return row.value === undefined ? '' : formatMetaValue(row.value);
}

/** The value as the text an editor starts from. */
function editText(row: FieldRow): string {
  if (typeof row.value === 'string') return row.value;
  return row.value === undefined ? '' : formatMetaValue(row.value);
}

/** Why "+ Add field" refuses a key, or null when it may be added. */
function addKeyError(key: string, scope: FieldScope, meta: Meta | undefined, rows: readonly FieldRow[]): string | null {
  if (!key) return 'Key is required';
  if (meta && Object.prototype.hasOwnProperty.call(meta, key)) return `"${key}" already exists`;
  switch (reservedFieldKeyReason(key, scope)) {
    case 'dbmlSetting': return `"${key}" is a DBML setting and cannot be a field. Pick another key.`;
    case 'erdSetting': return `"${key}" is one of ERD Studio's own settings and cannot be a field. Pick another key.`;
    case 'prefix': return 'Keys starting erd_, rationale_ or meta_ are reserved. Pick another key.';
    case 'unsafe': return `"${key}" cannot be a field key. Pick another key.`;
    default: break;
  }
  // A built-in (or a field the list names) already has its own row.
  const builtIn = builtInField(key, scope) ?? builtInField(key.toLowerCase(), scope);
  const id = builtIn ? fieldRowId(builtIn) : `meta:${key}`;
  const row = rows.find((r) => r.id === id);
  if (row) return `"${key}" is the ${row.definition.label} field: fill it in above.`;
  // A retired built-in is never listed again: say where its text goes instead.
  if (builtIn?.status === 'retired') return `"${key}" is a retired field. ${builtIn.guidance ?? 'Write it in Decisions instead.'}`;
  if (builtIn) return `"${key}" is the built-in field ${builtIn.label}: add ${builtIn.key} to fields.yml to use it.`;
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FieldsSectionProps {
  modelName: string;
  /** The table (for a column's section: the column's table, whose role decides which fields suit it). */
  table: FieldsTable;
  /** Show this column's fields instead of the table's (a compact section). */
  column?: FieldsColumn;
  /** The project's field list (`DisplaySubjectArea.fields`); the starting set when absent. */
  fields?: FieldList;
  /** A read-only stage (physical): values only, as the viewer shows them. */
  readOnly?: boolean;
  /** No dbt project: no "from dbt" badge. */
  logicalOnly?: boolean;
  /**
   * Viewer only, a table's section: whether its fold is open. Without it the
   * section keeps its own state, starting closed.
   */
  open?: boolean;
  /** Viewer only: called when the reader opens or closes the fold. */
  onOpenChange?: (open: boolean) => void;
}

export function FieldsSection({ modelName, table, column, fields, readOnly = false, logicalOnly = false, open, onOpenChange }: FieldsSectionProps) {
  const viewer = useIsViewer();
  const list = fields ?? STARTING_FIELD_LIST;
  const rows = useMemo(() => fieldRows(table, column, list), [table, column, list]);
  const dbml = dbmlImportValue(column ?? table);
  const compact = column !== undefined;

  return viewer ? (
    compact ? (
      <ReadOnlyFields rows={rows} dbml={dbml} compact />
    ) : (
      <CollapsibleFields rows={rows} dbml={dbml} open={open} onOpenChange={onOpenChange} />
    )
  ) : readOnly ? (
    <ReadOnlyFields rows={rows} dbml={dbml} compact={compact} />
  ) : (
    <EditableFields
      modelName={modelName}
      column={column}
      meta={(column ?? table).meta}
      rows={rows}
      dbml={dbml}
      logicalOnly={logicalOnly}
    />
  );
}

// ---------------------------------------------------------------------------
// Read-only (viewer, physical stage)
// ---------------------------------------------------------------------------

function ReadOnlyFields({ rows, dbml, compact }: { rows: FieldRow[]; dbml: MetaValue | undefined; compact: boolean }) {
  const shown = rows.filter(rowHasValue);
  if (shown.length === 0 && dbml === undefined) return null;
  return (
    <div className={`fields-section fields-section--read-only${compact ? ' fields-section--compact' : ''}`}>
      {compact ? (
        <span className="fields-section__label">Fields</span>
      ) : (
        <h4 className="detail-panel__section-title fields-section__title">Fields</h4>
      )}
      <dl className="fields-section__list">
        <ReadOnlyRows shown={shown} dbml={dbml} />
      </dl>
    </div>
  );
}

/** The read-only rows: each field's label and value, then Import DBML's bookkeeping. */
function ReadOnlyRows({ shown, dbml }: { shown: FieldRow[]; dbml: MetaValue | undefined }) {
  return (
    <>
      {shown.map((row) => (
        <div className="fields-section__row" key={row.id} data-field={row.id}>
          <dt className="fields-section__name">{row.definition.label}</dt>
          <dd className={`fields-section__value${typeof row.value === 'string' || row.choice !== undefined ? '' : ' fields-section__value--structured'}`}>
            {valueText(row)}
          </dd>
        </div>
      ))}
      {dbml !== undefined && <DbmlImportRow value={dbml} editor={false} />}
    </>
  );
}

/** The viewer's table section: a heading button with the count, folding the rows away. */
function CollapsibleFields({
  rows,
  dbml,
  open: openProp,
  onOpenChange,
}: {
  rows: FieldRow[];
  dbml: MetaValue | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const listId = useId();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const shown = rows.filter(rowHasValue);
  const count = shown.length + (dbml === undefined ? 0 : 1);
  if (count === 0) return null;

  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={`fields-section fields-section--read-only fields-section--collapsible${open ? ' fields-section--open' : ''}`}>
      <h4 className="detail-panel__section-title fields-section__title">
        <button
          type="button"
          className="fields-section__toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
        >
          <span className="fields-section__chevron" aria-hidden="true"><IconChevron size={11} /></span>
          <span className="fields-section__toggle-label">Fields</span>{' '}
          <span className="fields-section__count">({count})</span>
        </button>
      </h4>
      <dl className="fields-section__list" id={listId} hidden={!open}>
        <ReadOnlyRows shown={shown} dbml={dbml} />
      </dl>
    </div>
  );
}

function DbmlImportRow({ value, editor }: { value: MetaValue; editor: boolean }) {
  return (
    <div className="fields-section__row fields-section__row--dbml" data-field="meta:dbml">
      <dt className="fields-section__name">{DBML_IMPORT_ROW_LABEL}</dt>
      <dd
        className="fields-section__value fields-section__value--structured"
        title={editor ? "Settings from an imported DBML file, kept as they were. Edit them in the table's file." : undefined}
      >
        {formatMetaValue(value)}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface EditableFieldsProps {
  modelName: string;
  column?: FieldsColumn;
  meta: Meta | undefined;
  rows: FieldRow[];
  dbml: MetaValue | undefined;
  logicalOnly: boolean;
}

function EditableFields({ modelName, column, meta, rows, dbml, logicalOnly }: EditableFieldsProps) {
  const send = useSend();
  const compact = column !== undefined;
  const columnName = column?.name;
  const scope: FieldScope = compact ? 'column' : 'table';

  const postMeta = useCallback(
    (patch: { set?: Record<string, string>; remove?: string[] }) => {
      send({
        type: 'updateMeta',
        payload: { modelName, ...(columnName !== undefined ? { columnName } : {}), ...patch },
      });
    },
    [send, modelName, columnName],
  );

  /** Post a field's new text (`''` clears it) as the message its home uses. */
  const commit = useCallback(
    (row: FieldRow, text: string) => {
      const home = row.definition.home;
      switch (home.kind) {
        case 'rationale':
          send({ type: 'updateModelRationale', payload: { modelName, rationale: { [home.key]: text } as Partial<Rationale> } });
          return;
        case 'grain':
          send({ type: 'updateModelGrain', payload: { modelName, grain: text } });
          return;
        case 'role':
          send({ type: 'updateModelRole', payload: { modelName, modelRole: (text || null) as TableRole | null } });
          return;
        case 'meta':
          postMeta(text === '' ? { remove: [row.definition.key] } : { set: { [row.definition.key]: text } });
          return;
        default:
          // A column's typed fields are edited in its row; a home from a newer core is read-only.
          return;
      }
    },
    [send, modelName, postMeta],
  );

  const visible = rows.filter((row) => row.value !== undefined || row.editable);
  const listed = visible.filter((row) => row.source !== 'notInList');
  const others = visible.filter((row) => row.source === 'notInList');
  const anything = visible.length > 0 || dbml !== undefined;

  const rowView = (row: FieldRow) => (
    <FieldRowView
      key={row.id}
      row={row}
      logicalOnly={logicalOnly}
      onCommit={(text) => commit(row, text)}
      onRemove={() => postMeta({ remove: [row.definition.key] })}
    />
  );

  return (
    <div className={`fields-section${compact ? ' fields-section--compact' : ''}`}>
      {compact ? (
        anything && <span className="fields-section__label">Fields</span>
      ) : (
        <div className="fields-section__head">
          <h4 className="detail-panel__section-title fields-section__title">Fields</h4>
          <button
            type="button"
            className="fields-section__customise"
            onClick={() => send({ type: 'openFieldsFile' })}
            title="Open .erd-studio/fields.yml, the list of fields this project records"
          >
            Customise fields
          </button>
        </div>
      )}

      {listed.length > 0 ? (
        <div className="fields-section__list">{listed.map(rowView)}</div>
      ) : (
        !compact && <span className="fields-section__hint">No table fields are on.</span>
      )}

      {others.length > 0 && (
        <div className="fields-section__group">
          <span className="fields-section__group-title">Not in your list</span>
          <div className="fields-section__list">{others.map(rowView)}</div>
          {!compact && (
            <span className="fields-section__hint">Kept as it is. Add it to fields.yml to give it a label and a type.</span>
          )}
        </div>
      )}

      {dbml !== undefined && (
        <dl className="fields-section__list">
          <DbmlImportRow value={dbml} editor />
        </dl>
      )}

      <AddField scope={scope} meta={meta} rows={rows} onAdd={(key, value) => postMeta({ set: { [key]: value } })} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row (editor)
// ---------------------------------------------------------------------------

interface FieldRowViewProps {
  row: FieldRow;
  logicalOnly: boolean;
  onCommit: (text: string) => void;
  onRemove: () => void;
}

function FieldRowView({ row, logicalOnly, onCommit, onRemove }: FieldRowViewProps) {
  const labelId = useId();
  const def = row.definition;
  const kind = homeKind(row);
  const known = knownDefinition(row);
  const hasValue = row.value !== undefined;
  const isChoice = def.type === 'choice' || def.type === 'yes-no';
  const label = def.label;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Enter saves and unmounts the input, and the browser then blurs it: without
  // this, that blur would post the same edit a second time (two undo steps).
  const savedRef = useRef(false);

  const startEdit = useCallback(() => {
    savedRef.current = false;
    setDraft(editText(row));
    setEditing(true);
  }, [row]);

  const save = useCallback(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    const next = draft.trim();
    if (next !== editText(row).trim()) onCommit(next);
    setEditing(false);
  }, [draft, row, onCommit]);

  const cancel = useCallback(() => {
    savedRef.current = true;
    setEditing(false);
  }, []);

  const badges = (
    <>
      {row.source === 'retired' && <span className="fields-section__badge fields-section__badge--retired">Retired</span>}
      {def.filledBy === 'dbt' && !logicalOnly && <span className="fields-section__badge fields-section__badge--dbt">from dbt</span>}
      {def.filledBy === 'people' && <span className="fields-section__badge fields-section__badge--people">people only</span>}
    </>
  );

  // A clear: meta keys are removed; the other homes are posted empty. A
  // choice clears through its "Not set" option instead, except an empty meta
  // text (''), which has no option of its own.
  const clearable = known && hasValue && (kind === 'meta' || kind === 'rationale' || kind === 'grain')
    && !(row.editable && isChoice && row.value !== '');
  const textEditable = row.editable && (def.type === 'text' || def.type === 'value');
  // A text field is a text box; a value, and a meta key no list names (it
  // has no type: the one-line box the metadata editor always had), one line.
  const multiline = def.type === 'text' && !(row.source === 'notInList' && kind === 'meta');

  const actions = !editing && (textEditable && hasValue || clearable) && (
    <span className="fields-section__actions">
      {textEditable && hasValue && (
        <button type="button" className="fields-section__icon-btn" onClick={startEdit} title={`Edit ${label}`} aria-label={`Edit ${label}`}>
          <IconPencil size={12} />
        </button>
      )}
      {clearable && (
        <button
          type="button"
          className="fields-section__icon-btn"
          onClick={kind === 'meta' ? onRemove : () => onCommit('')}
          title={kind === 'meta' ? `Remove ${label}` : `Clear ${label}`}
          aria-label={kind === 'meta' ? `Remove ${label}` : `Clear ${label}`}
        >
          <IconClose size={12} />
        </button>
      )}
    </span>
  );

  let body: React.ReactNode;
  if (row.editable && isChoice) {
    const options: Array<[string, string]> = def.type === 'yes-no'
      ? [['true', 'Yes'], ['false', 'No']]
      : (Array.isArray(def.values) ? def.values : []).map((v) => [v, kind === 'role' ? roleLabel(v) : v]);
    const outside = row.choice === undefined && hasValue ? editText(row) : undefined;
    const current = row.choice ?? outside ?? '';
    body = (
      <select
        className="fields-section__select"
        aria-labelledby={labelId}
        value={current}
        onChange={(e) => {
          if (e.target.value !== current) onCommit(e.target.value);
        }}
      >
        <option value="">Not set</option>
        {outside !== undefined && outside !== '' && (
          <option value={outside} className="fields-section__option--outside">{`${outside} (not one of the choices)`}</option>
        )}
        {options.map(([value, text]) => (
          <option key={value} value={value}>{text}</option>
        ))}
      </select>
    );
  } else if (textEditable && editing) {
    body = multiline ? (
      <div className="fields-section__edit">
        <textarea
          className="detail-panel__rationale-textarea fields-section__textarea"
          aria-labelledby={labelId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
          }}
          placeholder={def.guidance}
          rows={2}
          autoFocus
        />
        <div className="detail-panel__rationale-actions">
          <button type="button" className="detail-panel__button" onClick={cancel}>Cancel</button>
          <button type="button" className="detail-panel__button detail-panel__button--primary" onClick={save}>Save</button>
        </div>
      </div>
    ) : (
      <input
        className="fields-section__input"
        aria-labelledby={labelId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        placeholder={def.guidance}
        autoFocus
      />
    );
  } else if (textEditable && !hasValue) {
    body = (
      <button type="button" className="fields-section__placeholder" onClick={startEdit} aria-label={`Add ${label}`} title={`Add ${label}`}>
        {def.guidance || `Add ${label}`}
      </button>
    );
  } else if (textEditable) {
    body = (
      <span className="fields-section__text" onDoubleClick={startEdit}>
        {typeof row.value === 'string' && row.value === '' ? <em className="fields-section__empty-value">(empty)</em> : valueText(row)}
      </span>
    );
  } else {
    body = (
      <span
        className="fields-section__text fields-section__value--structured"
        title={hasValue ? "Edit nested values in the table's file" : undefined}
      >
        {valueText(row)}
      </span>
    );
  }

  return (
    <div
      className={`fields-section__field${row.source === 'retired' ? ' fields-section__field--retired' : ''}`}
      data-field={row.id}
    >
      <div className="fields-section__field-head">
        <span className="fields-section__name" id={labelId} title={def.key}>{label}</span>
        {badges}
        {actions}
      </div>
      {row.source === 'retired' && def.guidance && <span className="fields-section__hint">{def.guidance}</span>}
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// + Add field (editor)
// ---------------------------------------------------------------------------

function AddField({
  scope,
  meta,
  rows,
  onAdd,
}: {
  scope: FieldScope;
  meta: Meta | undefined;
  rows: readonly FieldRow[];
  onAdd: (key: string, value: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setAdding(false);
    setNewKey('');
    setNewValue('');
    setError(null);
  }, []);

  const saveNew = useCallback(() => {
    const key = newKey.trim();
    const problem = addKeyError(key, scope, meta, rows);
    if (problem) {
      setError(problem);
      return;
    }
    onAdd(key, newValue);
    reset();
  }, [newKey, newValue, scope, meta, rows, onAdd, reset]);

  if (!adding) {
    return (
      <button
        type="button"
        className="detail-panel__rationale-add-btn fields-section__add-btn"
        onClick={() => setAdding(true)}
        title="Add a field your list does not name, such as an owner or a source system"
      >
        + Add field
      </button>
    );
  }

  const key = newKey.trim();
  const storedAsJson = key !== '' && !FIELD_KEY_PATTERN.test(key);
  return (
    <div className="fields-section__new">
      <input
        className="fields-section__input fields-section__input--key"
        value={newKey}
        onChange={(e) => { setNewKey(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); reset(); } }}
        placeholder="key (e.g. owner)"
        aria-label="Field key"
        autoFocus
      />
      <input
        className="fields-section__input"
        value={newValue}
        onChange={(e) => setNewValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); saveNew(); }
          if (e.key === 'Escape') { e.preventDefault(); reset(); }
        }}
        placeholder="value"
        aria-label="Field value"
      />
      <div className="fields-section__new-actions">
        <button type="button" className="detail-panel__button" onClick={reset}>Cancel</button>
        <button type="button" className="detail-panel__button detail-panel__button--primary" onClick={saveNew}>Add</button>
      </div>
      {storedAsJson && !error && (
        <span className="fields-section__warning">
          Not lower case letters, digits and underscores, so a DBML table keeps it inside meta_json.
        </span>
      )}
      {error && <span className="fields-section__error">{error}</span>}
    </div>
  );
}
