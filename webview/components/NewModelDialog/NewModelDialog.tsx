/**
 * NewTableDialog — dialog for creating new design models with configurable templates.
 *
 * Form fields, in order:
 * - Table name (text input, validated for template prefix)
 * - Schema (DBML projects only, from the host's `newTableSchemas`): the
 *   schema folder, with the layer's existing ones offered and the file it
 *   creates previewed
 * - Starter columns (optional): the template picker, Blank first (loaded
 *   from .erd-studio/templates/*.json files, else the built-in ones)
 * - Description (textarea)
 * - Left/Right entity (text inputs, shown only for bridge-type templates)
 *
 * Templates are loaded from the extension host and pre-populate columns.
 * Placeholder syntax: {name} = model name minus prefix, {left}/{right} = bridge entity names.
 */

import { useCallback, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import { KeyBadgeGroup } from '@erd-studio/renderer/editor';
import type { ColumnDef, DesignTable, TableRole, TableTemplate } from '../../../src/types/semantic';
import { COLUMN_NAME_PATTERN, COLUMN_NAME_RULE, TABLE_NAME_PATTERN, findDuplicateNames, sameName } from '../../../src/types/naming';
import { SCHEMA_FOLDER_RULE, isSchemaFolderName, newTablePathPreview } from '../../../src/types/schemaFolder';
import type { DisplaySubjectArea } from '../../../src/types/display';
import './NewModelDialog.css';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract the base name from a model name by removing the template prefix.
 * e.g., "dim_customer" with prefix "dim_" returns "customer".
 */
function extractBaseName(modelName: string, prefix: string): string {
  if (!prefix) return modelName;
  if (modelName.startsWith(prefix)) {
    return modelName.slice(prefix.length);
  }
  return modelName;
}

/**
 * Resolve placeholders {name}, {left}, {right} in template columns.
 */
function resolvePlaceholders(
  columns: ColumnDef[],
  placeholders: Record<string, string>,
): ColumnDef[] {
  return columns.map((col) => ({
    ...col,
    name: Object.entries(placeholders).reduce(
      (name, [key, value]) => name.replace(new RegExp(`\\{${key}\\}`, 'g'), value),
      col.name,
    ),
    description: Object.entries(placeholders).reduce(
      (desc, [key, value]) => desc.replace(new RegExp(`\\{${key}\\}`, 'g'), value),
      col.description,
    ),
  }));
}

/**
 * Validate the new model form fields.
 * Returns a record of field name → error message.
 */
function validateForm(
  modelName: string,
  template: TableTemplate,
  leftEntity: string,
  rightEntity: string,
  existingModelNames: string[],
  libraryModelNames: string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};

  // Model name validation — same rule as the host's validateModelName / rename,
  // so a name accepted here can always be renamed later.
  if (!modelName.trim()) {
    errors.modelName = 'Table name is required';
  } else if (!TABLE_NAME_PATTERN.test(modelName)) {
    errors.modelName = 'Start with a letter; use only letters, numbers, and underscores';
  } else if (template.prefix && !modelName.startsWith(template.prefix)) {
    errors.modelName = `Must start with "${template.prefix}" for ${template.label} template`;
  } else if (template.prefix && modelName.length <= template.prefix.length) {
    errors.modelName = `Add content after "${template.prefix}" (e.g., ${template.prefix}example)`;
  } else if (existingModelNames.some((n) => sameName(n, modelName))) {
    // Compared without case, like the host: `DimDate` and `dimdate` are one
    // file on macOS/Windows and one table in dbt.
    const existing = existingModelNames.find((n) => sameName(n, modelName));
    errors.modelName = `Table "${existing}" already exists in this diagram`;
  } else if (libraryModelNames.some((n) => sameName(n, modelName))) {
    // The model library (logical-models/) is shared across domains — a new
    // model must not overwrite one another domain already uses.
    const existing = libraryModelNames.find((n) => sameName(n, modelName));
    errors.modelName = `Table "${existing}" already exists in the Table Library — use "Add Existing Tables" instead`;
  }

  // Bridge entity validation (check for requiresLeftEntity/requiresRightEntity flags)
  if (template.requiresLeftEntity || template.requiresRightEntity) {
    if (!leftEntity.trim()) {
      errors.leftEntity = 'Left entity is required';
    } else if (!COLUMN_NAME_PATTERN.test(leftEntity)) {
      errors.leftEntity = COLUMN_NAME_RULE;
    }
    if (!rightEntity.trim()) {
      errors.rightEntity = 'Right entity is required';
    } else if (!COLUMN_NAME_PATTERN.test(rightEntity)) {
      errors.rightEntity = COLUMN_NAME_RULE;
    }
  }

  return errors;
}

/** The template picker's label: a template only fills in columns to start from. */
export const STARTER_COLUMNS_LABEL = 'Starter columns (optional)';

/** One line on what each built-in template is for; a project's own templates use their description. */
const STARTER_HINTS: Record<string, string> = {
  blank: 'no columns yet',
  dimension: 'something you describe (customer, product)',
  fact: 'something that happens (an order, a payment)',
  bridge: 'links two tables many-to-many',
  scd2: 'a dimension that keeps its history',
};

/** "Dimension — something you describe (customer, product)". */
export function starterOptionText(t: Pick<TableTemplate, 'id' | 'label' | 'description'>): string {
  const hint = STARTER_HINTS[t.id] ?? t.description?.trim();
  return hint ? `${t.label} — ${hint}` : t.label;
}

/** Blank first, then the templates in the host's order. */
export function starterOrder<T extends { id: string }>(templates: readonly T[]): T[] {
  return [...templates.filter((t) => t.id === 'blank'), ...templates.filter((t) => t.id !== 'blank')];
}

/**
 * The Schema field of a DBML diagram's New Table (`newTableSchemas` from the
 * host): the schema the table goes in (what the user typed, trimmed; blank
 * is the default, the schema most of this diagram's tables in the layer
 * use, else the layer id), whether the schema folder rule refuses it, and
 * the file it creates. Undefined when the host sends no choice (a YAML
 * project): the dialog shows no field and sends no schema.
 */
export function schemaFieldState(
  choice: DisplaySubjectArea['newTableSchemas'],
  typed: string | null,
  tableName: string,
): { schema: string; error?: string; preview: string } | undefined {
  if (!choice) return undefined;
  const schema = typed === null || typed.trim() === '' ? choice.defaultSchema : typed.trim();
  const preview = `Creates ${newTablePathPreview(choice.dir, choice.layer, choice.schemas, schema, tableName.trim() || 'table_name')}`;
  return isSchemaFolderName(schema) ? { schema, preview } : { schema, error: SCHEMA_FOLDER_RULE, preview };
}

/** Auto-suggested model role based on template ID. */
const TEMPLATE_ROLE_MAP: Record<string, TableRole> = {
  dimension: 'domain-dim',
  fact: 'transaction-fact',
  bridge: 'factless-fact',
  scd2: 'domain-dim',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewTableDialog() {
  const isOpen = useEditorStore((s) => s.newModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const domain = useEditorStore((s) => s.domain);
  const templates = useEditorStore((s) => s.templates);
  const existingModels = useEditorStore((s) => s.existingModels);
  const send = useSend();

  // Form state
  const [modelName, setModelName] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState<string>('blank');
  const [leftEntity, setLeftEntity] = useState('');
  const [rightEntity, setRightEntity] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [customColumns, setCustomColumns] = useState<ColumnDef[]>([]);
  // The Schema field as typed; null until the user types (the host's default shows).
  const [schemaTyped, setSchemaTyped] = useState<string | null>(null);
  const schemaChoice = domain?.newTableSchemas;
  const schemaField = useMemo(() => schemaFieldState(schemaChoice, schemaTyped, modelName), [schemaChoice, schemaTyped, modelName]);

  // Derived state — find the selected template from the store.
  // Fallback to a minimal empty template when no templates are loaded (e.g., physical stage).
  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? templates[0] ?? { id: 'blank', label: 'Blank', prefix: '', description: '', columns: [] as import('../../../src/types/semantic').ColumnDef[] },
    [templateId, templates],
  );

  // Check if this template requires left/right entity inputs (bridge tables)
  const requiresEntityInputs = template?.requiresLeftEntity || template?.requiresRightEntity;

  // Each table's own name: two tables of one name are named `<schema>.<name>` on the diagram.
  // A DBML table (it has a layer) in another schema folder than the new table's is another
  // table: the new one joins it as the second of a pair. A YAML table refuses its name anywhere.
  const newTableSchema = schemaField?.schema;
  const existingModelNames = useMemo(
    () => (domain?.models ?? [])
      .filter((m) => newTableSchema === undefined || m.layer === undefined || !m.schema || sameName(m.schema, newTableSchema))
      .map((m) => m.tableName || m.name),
    [domain, newTableSchema],
  );

  // Models that already have a logical-models/*.yml but are not in this domain.
  // Creating a "new" model with one of these names would overwrite a shared file.
  // A DBML table in another schema folder than the new table's is another table:
  // only the chosen schema folder's tables (and YAML tables, unique by name) refuse it.
  const libraryModelNames = useMemo(
    () => existingModels
      .filter((m) => m.source === 'logical'
        && (m.schemaFolder === undefined || newTableSchema === undefined || sameName(m.schemaFolder, newTableSchema)))
      .map((m) => m.name),
    [existingModels, newTableSchema],
  );

  // Validation (guard: template may be undefined when no templates are loaded)
  const errors = useMemo(
    () => template ? validateForm(modelName, template, leftEntity, rightEntity, existingModelNames, libraryModelNames) : {},
    [modelName, template, leftEntity, rightEntity, existingModelNames, libraryModelNames],
  );

  // Resolved columns with placeholders replaced, plus custom columns
  const resolvedColumns = useMemo(() => {
    const baseName = extractBaseName(modelName || '{name}', template.prefix);
    const templateCols = resolvePlaceholders(template.columns, {
      name: baseName || '{name}',
      left: leftEntity || '{left}',
      right: rightEntity || '{right}',
    });
    return [...templateCols, ...customColumns];
  }, [modelName, template, leftEntity, rightEntity, customColumns]);

  // Column names that appear more than once across template + custom columns.
  // Duplicates break every name-keyed path (React keys, edit/remove by name),
  // so the host rejects them — flag them here before submit.
  const duplicateColumnNames = useMemo(
    () => new Set(findDuplicateNames(resolvedColumns.map((col) => col.name))),
    [resolvedColumns],
  );

  // Only flag columns that have been touched (non-empty name) but are invalid.
  // Empty columns are allowed while editing — they are filtered out on submit.
  const hasInvalidColumns = useMemo(
    () =>
      customColumns.some(
        (col) =>
          col.name.trim() !== '' &&
          (!COLUMN_NAME_PATTERN.test(col.name) || duplicateColumnNames.has(col.name.trim())),
      ),
    [customColumns, duplicateColumnNames]
  );

  const isValid = Object.keys(errors).length === 0 && modelName.trim() !== '' && !hasInvalidColumns && !schemaField?.error;

  // The name was refused because the Table Library already has the table
  // (and this diagram does not): offer to add that one instead.
  const libraryMatch = useMemo(
    () => (existingModelNames.some((n) => sameName(n, modelName))
      ? undefined
      : libraryModelNames.find((n) => sameName(n, modelName))),
    [existingModelNames, libraryModelNames, modelName],
  );
  const libraryRefused = !!libraryMatch && !!errors.modelName && errors.modelName.includes('Table Library');

  // Handlers
  const resetForm = useCallback(() => {
    setModelName('');
    setDescription('');
    // Reset to blank template
    setTemplateId('blank');
    setLeftEntity('');
    setRightEntity('');
    setTouched({});
    setCustomColumns([]);
    setSchemaTyped(null);
  }, []);

  const handleClose = useCallback(() => {
    setNewModelDialogOpen(false);
    resetForm();
  }, [setNewModelDialogOpen, resetForm]);

  // Swap to Add Existing Tables, its search already narrowed to the table.
  const handleAddExistingInstead = useCallback(() => {
    if (!libraryMatch) return;
    handleClose();
    setAddExistingModelDialogOpen(true, libraryMatch);
  }, [libraryMatch, handleClose, setAddExistingModelDialogOpen]);

  const handleSubmit = useCallback(() => {
    if (!isValid) return;

    const baseName = extractBaseName(modelName, template.prefix);
    const templateCols = resolvePlaceholders(template.columns, {
      name: baseName,
      left: leftEntity,
      right: rightEntity,
    });
    // Filter out empty custom columns on submit
    const validCustomColumns = customColumns.filter((col) => col.name.trim() !== '');
    const finalColumns = [...templateCols, ...validCustomColumns];

    const suggestedRole = TEMPLATE_ROLE_MAP[templateId];
    const newModel: DesignTable = {
      name: modelName.trim(),
      description: description.trim(),
      columns: finalColumns,
      ...(suggestedRole ? { modelRole: suggestedRole } : {}),
    };

    send({
      type: 'addModel',
      payload: schemaField ? { ...newModel, schemaFolder: schemaField.schema } : newModel,
    });

    handleClose();
  }, [isValid, modelName, description, template, leftEntity, rightEntity, customColumns, schemaField, send, handleClose]);

  const handleBlur = useCallback((field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }, []);

  // Initialize schema from domain layer when dialog opens
  const handleTemplateChange = useCallback((newTemplateId: string) => {
    setTemplateId(newTemplateId);
    // Reset bridge fields when switching to a template that doesn't need them
    const newTemplate = templates.find((t) => t.id === newTemplateId);
    if (newTemplate && !newTemplate.requiresLeftEntity && !newTemplate.requiresRightEntity) {
      setLeftEntity('');
      setRightEntity('');
    }
  }, [templates]);

  // Column management handlers
  const handleAddColumn = useCallback(() => {
    setCustomColumns((prev) => [
      ...prev,
      { name: '', dataType: 'VARCHAR', description: '' },
    ]);
  }, []);

  const handleRemoveColumn = useCallback((index: number) => {
    setCustomColumns((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleColumnChange = useCallback(
    (index: number, field: keyof ColumnDef, value: string | boolean) => {
      setCustomColumns((prev) =>
        prev.map((col, i) =>
          i === index ? { ...col, [field]: value } : col
        )
      );
    },
    []
  );

  if (!isOpen) {
    return null;
  }

  // Guard: If no templates loaded yet, show loading state
  if (templates.length === 0 || !template) {
    return (
      <Panel position="top-center" className="new-model-dialog">
        <div className="new-model-dialog__header">
          <h3 className="new-model-dialog__title">New Table</h3>
          <button
            className="new-model-dialog__close"
            onClick={handleClose}
            title="Close dialog"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        <div className="new-model-dialog__content">
          <p>Loading templates...</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel position="top-center" className="new-model-dialog">
      {/* Header */}
      <div className="new-model-dialog__header">
        <h3 className="new-model-dialog__title">New Table</h3>
        <button
          className="new-model-dialog__close"
          onClick={handleClose}
          title="Close dialog"
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="new-model-dialog__content">
        {/* Model Name */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="modelName">
            Table Name
          </label>
          <input
            id="modelName"
            type="text"
            className={`new-model-dialog__input ${touched.modelName && errors.modelName ? 'new-model-dialog__input--error' : ''}`}
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onBlur={() => handleBlur('modelName')}
            placeholder={template.prefix ? `${template.prefix}example` : 'table_name'}
          />
          {touched.modelName && errors.modelName && (
            <span className="new-model-dialog__error">{errors.modelName}</span>
          )}
          {libraryRefused && (
            <button
              type="button"
              className="new-model-dialog__add-existing"
              onClick={handleAddExistingInstead}
            >
              Add &quot;{libraryMatch}&quot; from the Table Library
            </button>
          )}
        </div>

        {/* Schema folder (DBML only): where the table's file goes. */}
        {schemaChoice && schemaField && (
          <div className="new-model-dialog__field">
            <label className="new-model-dialog__label" htmlFor="tableSchema">
              Schema
            </label>
            <input
              id="tableSchema"
              type="text"
              list="tableSchemaChoices"
              className={`new-model-dialog__input ${schemaField.error ? 'new-model-dialog__input--error' : ''}`}
              value={schemaTyped ?? schemaChoice.defaultSchema}
              onChange={(e) => setSchemaTyped(e.target.value)}
              placeholder={schemaChoice.defaultSchema}
              spellCheck={false}
            />
            <datalist id="tableSchemaChoices">
              {schemaChoice.schemas.map((s) => <option key={s} value={s} />)}
            </datalist>
            {schemaField.error && (
              <span className="new-model-dialog__error">{schemaField.error}</span>
            )}
            <span className="new-model-dialog__hint new-model-dialog__path">{schemaField.preview}</span>
          </div>
        )}

        {/* Starter columns (a template). Each field is its own block, so another can sit between them. */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="template">
            {STARTER_COLUMNS_LABEL}
          </label>
          <select
            id="template"
            className="new-model-dialog__select"
            value={templateId}
            onChange={(e) => handleTemplateChange(e.target.value)}
          >
            {starterOrder(templates).map((t) => (
              <option key={t.id} value={t.id} title={t.description || undefined}>
                {starterOptionText(t)}
              </option>
            ))}
          </select>
          {template.prefix && (
            <span className="new-model-dialog__hint">Table names start with {template.prefix}</span>
          )}
        </div>

        {/* Description */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="description">
            Description
          </label>
          <textarea
            id="description"
            className="new-model-dialog__textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description..."
            rows={2}
          />
        </div>

        {/* Bridge Entity Fields (for templates that require left/right entities) */}
        {requiresEntityInputs && (
          <div className="new-model-dialog__bridge-fields">
            <div className="new-model-dialog__field">
              <label className="new-model-dialog__label" htmlFor="leftEntity">
                Left Entity
              </label>
              <input
                id="leftEntity"
                type="text"
                className={`new-model-dialog__input ${touched.leftEntity && errors.leftEntity ? 'new-model-dialog__input--error' : ''}`}
                value={leftEntity}
                onChange={(e) => setLeftEntity(e.target.value)}
                onBlur={() => handleBlur('leftEntity')}
                placeholder="customer"
              />
              {touched.leftEntity && errors.leftEntity && (
                <span className="new-model-dialog__error">{errors.leftEntity}</span>
              )}
            </div>
            <div className="new-model-dialog__field">
              <label className="new-model-dialog__label" htmlFor="rightEntity">
                Right Entity
              </label>
              <input
                id="rightEntity"
                type="text"
                className={`new-model-dialog__input ${touched.rightEntity && errors.rightEntity ? 'new-model-dialog__input--error' : ''}`}
                value={rightEntity}
                onChange={(e) => setRightEntity(e.target.value)}
                onBlur={() => handleBlur('rightEntity')}
                placeholder="product"
              />
              {touched.rightEntity && errors.rightEntity && (
                <span className="new-model-dialog__error">{errors.rightEntity}</span>
              )}
            </div>
          </div>
        )}

        {/* Column Editor */}
        <div className="new-model-dialog__column-editor">
          <div className="new-model-dialog__column-header">
            <h4 className="new-model-dialog__preview-title">
              Columns ({resolvedColumns.length})
            </h4>
            <button
              type="button"
              className="new-model-dialog__add-column-btn"
              onClick={handleAddColumn}
              title="Add column"
            >
              + Add Column
            </button>
          </div>

          {/* Template columns (read-only preview) */}
          {template.columns.length > 0 && (
            <div className="new-model-dialog__template-columns">
              <span className="new-model-dialog__section-label">From template</span>
              <div className="new-model-dialog__columns">
                {resolvePlaceholders(template.columns, {
                  name: extractBaseName(modelName || '{name}', template.prefix) || '{name}',
                  left: leftEntity || '{left}',
                  right: rightEntity || '{right}',
                }).map((col) => (
                  <div key={col.name} className="new-model-dialog__column new-model-dialog__column--template">
                    <KeyBadgeGroup
                      isPrimaryKey={col.isPrimaryKey ?? false}
                      isForeignKey={col.isForeignKey ?? false}
                      isNaturalKey={col.isNaturalKey ?? false}
                      mode="readonly"
                      status="planned"
                    />
                    <span className="new-model-dialog__col-name">{col.name}</span>
                    <span className="new-model-dialog__col-type">{col.dataType}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Custom columns (editable) */}
          {customColumns.length > 0 && (
            <div className="new-model-dialog__custom-columns">
              <span className="new-model-dialog__section-label">Custom columns</span>
              <div className="new-model-dialog__column-list">
                {customColumns.map((col, idx) => (
                  <div key={idx} className="new-model-dialog__column-row">
                    <KeyBadgeGroup
                      isPrimaryKey={col.isPrimaryKey ?? false}
                      isForeignKey={col.isForeignKey ?? false}
                      isNaturalKey={col.isNaturalKey ?? false}
                      mode="editable"
                      status="planned"
                      onTogglePK={() => handleColumnChange(idx, 'isPrimaryKey', !col.isPrimaryKey)}
                      onToggleFK={() => handleColumnChange(idx, 'isForeignKey', !col.isForeignKey)}
                      onToggleNK={() => handleColumnChange(idx, 'isNaturalKey', !col.isNaturalKey)}
                    />
                    <input
                      type="text"
                      className={`new-model-dialog__col-input new-model-dialog__col-input--name ${
                        col.name && (!COLUMN_NAME_PATTERN.test(col.name) || duplicateColumnNames.has(col.name.trim()))
                          ? 'new-model-dialog__col-input--error'
                          : ''
                      }`}
                      title={
                        col.name && duplicateColumnNames.has(col.name.trim())
                          ? `Duplicate column name "${col.name.trim()}"`
                          : undefined
                      }
                      value={col.name}
                      onChange={(e) => handleColumnChange(idx, 'name', e.target.value)}
                      placeholder="column_name"
                    />
                    <select
                      className="new-model-dialog__col-select"
                      value={col.dataType}
                      onChange={(e) => handleColumnChange(idx, 'dataType', e.target.value)}
                    >
                      <option value="VARCHAR">VARCHAR</option>
                      <option value="INTEGER">INTEGER</option>
                      <option value="BOOLEAN">BOOLEAN</option>
                      <option value="DATE">DATE</option>
                      <option value="TIMESTAMP_NTZ">TIMESTAMP_NTZ</option>
                      <option value="DECIMAL(18,2)">DECIMAL(18,2)</option>
                      <option value="FLOAT">FLOAT</option>
                    </select>
                    <input
                      type="text"
                      className="new-model-dialog__col-input new-model-dialog__col-input--desc"
                      value={col.description}
                      onChange={(e) => handleColumnChange(idx, 'description', e.target.value)}
                      placeholder="Description"
                    />
                    <button
                      type="button"
                      className="new-model-dialog__col-remove"
                      onClick={() => handleRemoveColumn(idx)}
                      title="Remove column"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {/* Inline add row at the bottom of the list */}
                <div
                  className="new-model-dialog__column-row new-model-dialog__column-row--add"
                  onClick={handleAddColumn}
                  title="Add another column"
                >
                  <span className="new-model-dialog__add-row-text">+ add column</span>
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {resolvedColumns.length === 0 && (
            <div className="new-model-dialog__empty-columns">
              <span>No columns yet. Click "Add Column" to add columns to this table.</span>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="new-model-dialog__footer">
        <button
          className="new-model-dialog__button new-model-dialog__button--secondary"
          onClick={handleClose}
        >
          Cancel
        </button>
        <button
          className="new-model-dialog__button new-model-dialog__button--primary"
          onClick={handleSubmit}
          disabled={!isValid}
        >
          Create Table
        </button>
      </div>
    </Panel>
  );
}
