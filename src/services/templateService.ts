/**
 * TemplateService — reads model template JSON files from disk.
 *
 * Templates live at {dbt_project}/models/semantic/templates/*.json
 * and define preset columns and metadata for common model patterns.
 *
 * Falls back to built-in templates if no template files are found.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ColumnDef, ModelTemplate } from '../types/semantic';

const DEFAULT_SEMANTIC_DIR = 'models/semantic';
const TEMPLATES_DIR = 'templates';

/**
 * Built-in templates used as fallback when no template files exist.
 * These match the JHG conventions and provide a starting point.
 */
const FALLBACK_TEMPLATES: ModelTemplate[] = [
  {
    id: 'dimension',
    label: 'Dimension',
    prefix: 'dim_',
    description: 'Standard dimension table with SCD Type 1 tracking',
    columns: [
      { name: '{name}_id', dataType: 'INTEGER', description: 'Surrogate key', isPrimaryKey: true },
      { name: 'name', dataType: 'VARCHAR', description: 'Display name' },
      { name: 'description', dataType: 'VARCHAR', description: 'Long description' },
      { name: 'is_active', dataType: 'BOOLEAN', description: 'Active flag' },
      { name: 'valid_from', dataType: 'TIMESTAMP_NTZ', description: 'Effective start' },
      { name: 'valid_to', dataType: 'TIMESTAMP_NTZ', description: 'Effective end' },
      { name: 'dwh_inserted_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse insert timestamp' },
      { name: 'dwh_updated_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse update timestamp' },
    ],
  },
  {
    id: 'fact',
    label: 'Fact',
    prefix: 'fct_',
    description: 'Transactional fact table with event tracking',
    columns: [
      { name: '{name}_id', dataType: 'INTEGER', description: 'Surrogate key', isPrimaryKey: true },
      { name: 'event_date', dataType: 'DATE', description: 'Business event date' },
      { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Monetary amount' },
      { name: 'dwh_inserted_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse insert timestamp' },
      { name: 'dwh_updated_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse update timestamp' },
    ],
  },
  {
    id: 'bridge',
    label: 'Bridge',
    prefix: 'brg_',
    description: 'Many-to-many bridge table linking two entities',
    requiresLeftEntity: true,
    requiresRightEntity: true,
    columns: [
      { name: '{name}_id', dataType: 'INTEGER', description: 'Surrogate key', isPrimaryKey: true },
      { name: '{left}_id', dataType: 'INTEGER', description: 'FK to {left}' },
      { name: '{right}_id', dataType: 'INTEGER', description: 'FK to {right}' },
      { name: 'dwh_inserted_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse insert timestamp' },
    ],
  },
  {
    id: 'scd2',
    label: 'SCD Type 2',
    prefix: 'dim_',
    description: 'Slowly Changing Dimension Type 2 with full history tracking',
    columns: [
      { name: '{name}_id', dataType: 'INTEGER', description: 'Surrogate key', isPrimaryKey: true },
      { name: 'name', dataType: 'VARCHAR', description: 'Display name' },
      { name: 'description', dataType: 'VARCHAR', description: 'Long description' },
      { name: 'is_active', dataType: 'BOOLEAN', description: 'Active flag' },
      { name: 'valid_from', dataType: 'TIMESTAMP_NTZ', description: 'Effective start' },
      { name: 'valid_to', dataType: 'TIMESTAMP_NTZ', description: 'Effective end' },
      { name: 'scd_valid_from', dataType: 'TIMESTAMP_NTZ', description: 'SCD effective start' },
      { name: 'scd_valid_to', dataType: 'TIMESTAMP_NTZ', description: 'SCD effective end' },
      { name: 'scd_is_current', dataType: 'BOOLEAN', description: 'Current version flag' },
      { name: 'scd_hash', dataType: 'VARCHAR', description: 'Hash of tracked columns' },
      { name: 'dwh_inserted_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse insert timestamp' },
      { name: 'dwh_updated_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse update timestamp' },
    ],
  },
  {
    id: 'blank',
    label: 'Blank',
    prefix: '',
    description: 'Empty model with no predefined columns',
    columns: [],
  },
];

export class TemplateService {
  /**
   * Load all model templates from the templates directory.
   *
   * Returns templates from {projectPath}/models/semantic/templates/*.json
   * if any exist, otherwise returns built-in fallback templates.
   *
   * Templates are sorted by: dimension, fact, bridge, scd2, blank, then
   * alphabetically by id for any custom templates.
   */
  loadTemplates(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): ModelTemplate[] {
    const templatesPath = path.join(projectPath, semanticDir, TEMPLATES_DIR);

    if (!fs.existsSync(templatesPath)) {
      return FALLBACK_TEMPLATES;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(templatesPath);
    } catch (err) {
      console.warn(
        `[TemplateService] Unable to read templates directory ${templatesPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return FALLBACK_TEMPLATES;
    }

    const jsonFiles = entries.filter((e) => e.endsWith('.json'));
    if (jsonFiles.length === 0) {
      return FALLBACK_TEMPLATES;
    }

    const templates: ModelTemplate[] = [];
    for (const file of jsonFiles) {
      const filePath = path.join(templatesPath, file);
      try {
        const template = this.loadTemplateFile(filePath);
        if (template) {
          templates.push(template);
        }
      } catch (err) {
        console.warn(
          `[TemplateService] Failed to load template ${file}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (templates.length === 0) {
      return FALLBACK_TEMPLATES;
    }

    // Sort templates: standard order first, then alphabetical
    return this.sortTemplates(templates);
  }

  /**
   * Load and validate a single template file.
   */
  private loadTemplateFile(filePath: string): ModelTemplate | null {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Template file must contain a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    // Validate required fields
    if (typeof obj.id !== 'string' || !obj.id.trim()) {
      throw new Error('Template must have a non-empty "id" field');
    }

    if (typeof obj.label !== 'string' || !obj.label.trim()) {
      throw new Error('Template must have a non-empty "label" field');
    }

    const template: ModelTemplate = {
      id: obj.id.trim(),
      label: obj.label.trim(),
      prefix: typeof obj.prefix === 'string' ? obj.prefix : '',
      description: typeof obj.description === 'string' ? obj.description : '',
      columns: this.parseColumns(obj.columns),
    };

    // Optional flags for bridge templates
    if (obj.requiresLeftEntity === true) {
      template.requiresLeftEntity = true;
    }
    if (obj.requiresRightEntity === true) {
      template.requiresRightEntity = true;
    }

    return template;
  }

  /**
   * Parse and validate the columns array.
   */
  private parseColumns(value: unknown): ColumnDef[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
      )
      .map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        dataType: typeof item.dataType === 'string' ? item.dataType : 'VARCHAR',
        description: typeof item.description === 'string' ? item.description : '',
        isPrimaryKey: item.isPrimaryKey === true ? true : undefined,
      }))
      .filter((col) => col.name.trim() !== '');
  }

  /**
   * Sort templates with standard templates first in a defined order,
   * then any custom templates alphabetically.
   */
  private sortTemplates(templates: ModelTemplate[]): ModelTemplate[] {
    const standardOrder = ['dimension', 'fact', 'bridge', 'scd2', 'blank'];

    return [...templates].sort((a, b) => {
      const aIndex = standardOrder.indexOf(a.id);
      const bIndex = standardOrder.indexOf(b.id);

      // Both are standard templates: sort by predefined order
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }

      // Only a is standard: a comes first
      if (aIndex !== -1) {
        return -1;
      }

      // Only b is standard: b comes first
      if (bIndex !== -1) {
        return 1;
      }

      // Neither is standard: sort alphabetically by id
      return a.id.localeCompare(b.id);
    });
  }
}
