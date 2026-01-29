/**
 * NewModelDialog — dialog for creating new design models with configurable templates.
 *
 * Form fields:
 * - Model name (text input, validated for template prefix)
 * - Schema (text input, pre-filled from domain layer)
 * - Description (textarea)
 * - Template picker (loaded from semantic/templates/*.json files)
 * - Left/Right entity (text inputs, shown only for bridge-type templates)
 *
 * Templates are loaded from the extension host and pre-populate columns.
 * Placeholder syntax: {name} = model name minus prefix, {left}/{right} = bridge entity names.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { ColumnDef, DesignModel, ModelTemplate } from '../../../src/types/semantic';
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
  schema: string,
  template: ModelTemplate,
  leftEntity: string,
  rightEntity: string,
  existingModelNames: string[],
): Record<string, string> {
  const errors: Record<string, string> = {};

  // Model name validation
  if (!modelName.trim()) {
    errors.modelName = 'Model name is required';
  } else if (!/^[a-z0-9_]+$/.test(modelName)) {
    errors.modelName = 'Use lowercase letters, numbers, and underscores only';
  } else if (template.prefix && !modelName.startsWith(template.prefix)) {
    errors.modelName = `Must start with "${template.prefix}" for ${template.label} template`;
  } else if (template.prefix && modelName.length <= template.prefix.length) {
    errors.modelName = `Add content after "${template.prefix}" (e.g., ${template.prefix}example)`;
  } else if (existingModelNames.includes(modelName)) {
    errors.modelName = `Model "${modelName}" already exists in this domain`;
  }

  // Schema validation
  if (!schema.trim()) {
    errors.schema = 'Schema is required';
  } else if (!/^[a-z0-9_]+$/.test(schema)) {
    errors.schema = 'Use lowercase letters, numbers, and underscores only';
  }

  // Bridge entity validation (check for requiresLeftEntity/requiresRightEntity flags)
  if (template.requiresLeftEntity || template.requiresRightEntity) {
    if (!leftEntity.trim()) {
      errors.leftEntity = 'Left entity is required';
    } else if (!/^[a-z0-9_]+$/.test(leftEntity)) {
      errors.leftEntity = 'Use lowercase letters, numbers, and underscores only';
    }
    if (!rightEntity.trim()) {
      errors.rightEntity = 'Right entity is required';
    } else if (!/^[a-z0-9_]+$/.test(rightEntity)) {
      errors.rightEntity = 'Use lowercase letters, numbers, and underscores only';
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewModelDialog() {
  const isOpen = useEditorStore((s) => s.newModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const domain = useEditorStore((s) => s.domain);
  const templates = useEditorStore((s) => s.templates);
  const { send } = useMessageBus(() => {});

  // Form state
  const [modelName, setModelName] = useState('');
  const [schema, setSchema] = useState('');
  const [description, setDescription] = useState('');
  const [templateId, setTemplateId] = useState<string>('dimension');
  const [leftEntity, setLeftEntity] = useState('');
  const [rightEntity, setRightEntity] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Derived state — find the selected template from the store
  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? templates[0],
    [templateId, templates],
  );

  // Check if this template requires left/right entity inputs (bridge tables)
  const requiresEntityInputs = template?.requiresLeftEntity || template?.requiresRightEntity;

  const existingModelNames = useMemo(
    () => (domain?.models ?? []).map((m) => m.name),
    [domain],
  );

  // Validation
  const errors = useMemo(
    () => validateForm(modelName, schema, template, leftEntity, rightEntity, existingModelNames),
    [modelName, schema, template, leftEntity, rightEntity, existingModelNames],
  );

  const isValid = Object.keys(errors).length === 0 && modelName.trim() !== '';

  // Resolved columns with placeholders replaced
  const resolvedColumns = useMemo(() => {
    const baseName = extractBaseName(modelName || '{name}', template.prefix);
    return resolvePlaceholders(template.columns, {
      name: baseName || '{name}',
      left: leftEntity || '{left}',
      right: rightEntity || '{right}',
    });
  }, [modelName, template, leftEntity, rightEntity]);

  // Handlers
  const resetForm = useCallback(() => {
    setModelName('');
    setSchema('');
    setDescription('');
    // Reset to first available template, fallback to 'dimension' if none loaded yet
    setTemplateId(templates[0]?.id ?? 'dimension');
    setLeftEntity('');
    setRightEntity('');
    setTouched({});
  }, [templates]);

  const handleClose = useCallback(() => {
    setNewModelDialogOpen(false);
    resetForm();
  }, [setNewModelDialogOpen, resetForm]);

  const handleSubmit = useCallback(() => {
    if (!isValid) return;

    const baseName = extractBaseName(modelName, template.prefix);
    const finalColumns = resolvePlaceholders(template.columns, {
      name: baseName,
      left: leftEntity,
      right: rightEntity,
    });

    const newModel: DesignModel = {
      name: modelName.trim(),
      schema: schema.trim(),
      description: description.trim(),
      columns: finalColumns,
    };

    send({
      type: 'addModel',
      payload: newModel,
    });

    handleClose();
  }, [isValid, modelName, schema, description, template, leftEntity, rightEntity, send, handleClose]);

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

  // Set default schema when dialog opens
  useEffect(() => {
    if (isOpen && !schema && domain?.layer) {
      setSchema(domain.layer);
    }
  }, [isOpen, schema, domain?.layer]);

  if (!isOpen) {
    return null;
  }

  // Guard: If no templates loaded yet, show loading state
  if (templates.length === 0 || !template) {
    return (
      <Panel position="top-center" className="new-model-dialog">
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

      {/* Content */}
      <div className="new-model-dialog__content">
        {/* Template Selector */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="template">
            Template
          </label>
          <select
            id="template"
            className="new-model-dialog__select"
            value={templateId}
            onChange={(e) => handleTemplateChange(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} {t.prefix && `(${t.prefix}*)`}
              </option>
            ))}
          </select>
        </div>

        {/* Model Name */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="modelName">
            Model Name
          </label>
          <input
            id="modelName"
            type="text"
            className={`new-model-dialog__input ${touched.modelName && errors.modelName ? 'new-model-dialog__input--error' : ''}`}
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onBlur={() => handleBlur('modelName')}
            placeholder={template.prefix ? `${template.prefix}example` : 'model_name'}
          />
          {touched.modelName && errors.modelName && (
            <span className="new-model-dialog__error">{errors.modelName}</span>
          )}
        </div>

        {/* Schema */}
        <div className="new-model-dialog__field">
          <label className="new-model-dialog__label" htmlFor="schema">
            Schema
          </label>
          <input
            id="schema"
            type="text"
            className={`new-model-dialog__input ${touched.schema && errors.schema ? 'new-model-dialog__input--error' : ''}`}
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            onBlur={() => handleBlur('schema')}
            placeholder="silver"
          />
          {touched.schema && errors.schema && (
            <span className="new-model-dialog__error">{errors.schema}</span>
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

        {/* Column Preview */}
        {resolvedColumns.length > 0 && (
          <div className="new-model-dialog__preview">
            <h4 className="new-model-dialog__preview-title">
              Columns ({resolvedColumns.length})
            </h4>
            <div className="new-model-dialog__columns">
              {resolvedColumns.map((col) => (
                <div key={col.name} className="new-model-dialog__column">
                  <span className="new-model-dialog__col-indicators">
                    {col.isPrimaryKey && (
                      <span className="new-model-dialog__pk" title="Primary Key">PK</span>
                    )}
                  </span>
                  <span className="new-model-dialog__col-name">{col.name}</span>
                  <span className="new-model-dialog__col-type">{col.dataType}</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
          Create Model
        </button>
      </div>
    </Panel>
  );
}
