/**
 * TemplateService — reads model template JSON files from disk.
 *
 * Templates live at {dbt_project}/.erd-studio/templates/*.json
 * and define preset columns and metadata for common model patterns.
 *
 * Falls back to built-in templates if no template files are found.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ColumnDef, ModelTemplate } from '../types/semantic';

const DEFAULT_SEMANTIC_DIR = '.erd-studio';
const TEMPLATES_DIR = 'templates';

/**
 * Built-in templates used as fallback when no template files exist.
 * Provide a starting point for common dimensional modeling patterns.
 *
 * Every dimension here separates two different keys, because conflating them
 * is the mistake these templates used to teach:
 *
 *   `{name}_key` — the SURROGATE key. Warehouse-generated, meaningless, unique
 *                  per ROW, and the column facts point at.
 *   `{name}_id`  — the BUSINESS (natural) key, as the source system spells it.
 *                  Unique per ENTITY, which is not the same thing: under SCD2
 *                  one entity owns several rows, so the business key repeats
 *                  and cannot be the primary key.
 *
 * That is also why `isNaturalKey` belongs on an identifier and never on a
 * label. A person's name is not unique, so a name marked as the natural key
 * is a claim the data cannot honour.
 */
const FALLBACK_TEMPLATES: ModelTemplate[] = [
  {
    id: 'dimension',
    label: 'Dimension',
    prefix: 'dim_',
    description: 'Standard dimension table with SCD Type 1 tracking',
    columns: [
      { name: '{name}_key', dataType: 'INTEGER', description: 'Surrogate key — warehouse-generated, one per row', isPrimaryKey: true, scdType: 0 },
      { name: '{name}_id', dataType: 'VARCHAR', description: 'Business key from the source system', isNaturalKey: true, scdType: 0 },
      { name: 'name', dataType: 'VARCHAR', description: 'Display name', scdType: 1 },
      { name: 'description', dataType: 'VARCHAR', description: 'Long description', scdType: 1 },
      { name: 'is_active', dataType: 'BOOLEAN', description: 'Active flag', scdType: 1 },
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
      // A transaction fact's own identifier is the source system's transaction
      // id — a degenerate dimension. It is both the primary key and the
      // business key, so it carries both flags rather than being shadowed by a
      // surrogate that would buy nothing.
      { name: '{name}_id', dataType: 'INTEGER', description: 'Transaction id from the source system (degenerate dimension)', isPrimaryKey: true, isNaturalKey: true },
      { name: 'date_key', dataType: 'INTEGER', description: 'FK to dim_date', isForeignKey: true },
      { name: 'event_date', dataType: 'DATE', description: 'Business event date' },
      { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Monetary amount', additiveType: 'additive' },
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
      { name: '{name}_key', dataType: 'INTEGER', description: 'Surrogate key — one per link row', isPrimaryKey: true },
      { name: '{left}_key', dataType: 'INTEGER', description: 'FK to {left}', isForeignKey: true },
      { name: '{right}_key', dataType: 'INTEGER', description: 'FK to {right}', isForeignKey: true },
      { name: 'dwh_inserted_at', dataType: 'TIMESTAMP_NTZ', description: 'Warehouse insert timestamp' },
    ],
  },
  {
    id: 'scd2',
    label: 'SCD Type 2',
    prefix: 'dim_',
    description: 'Slowly Changing Dimension Type 2 with full history tracking',
    columns: [
      // The surrogate key is what makes SCD2 work: one row per version, so the
      // business key below deliberately repeats and must NOT be the PK.
      { name: '{name}_key', dataType: 'INTEGER', description: 'Surrogate key — one per row, so one per version of the entity', isPrimaryKey: true, scdType: 0 },
      { name: '{name}_id', dataType: 'VARCHAR', description: 'Business key — repeats across the versions of one entity', isNaturalKey: true, scdType: 0 },
      { name: 'name', dataType: 'VARCHAR', description: 'Display name', scdType: 2 },
      { name: 'description', dataType: 'VARCHAR', description: 'Long description', scdType: 2 },
      { name: 'is_active', dataType: 'BOOLEAN', description: 'Active flag', scdType: 2 },
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
   * Returns templates from {projectPath}/.erd-studio/templates/*.json
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
    const seenIds = new Map<string, string>();
    for (const file of jsonFiles.sort()) {
      const filePath = path.join(templatesPath, file);
      try {
        const template = this.loadTemplateFile(filePath);
        if (template) {
          // Template ids must be unique — the picker looks templates up by id
          // and uses it as a React key. First file (alphabetically) wins.
          const firstFile = seenIds.get(template.id);
          if (firstFile) {
            console.warn(
              `[TemplateService] Skipping template ${file}: id "${template.id}" ` +
              `is already defined by ${firstFile}`
            );
            continue;
          }
          seenIds.set(template.id, file);
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
   *
   * Copies every ColumnDef design flag (PK/FK/NK, scdType, additiveType) so a
   * custom template can pre-flag columns; invalid values are dropped rather
   * than passed through.
   */
  private parseColumns(value: unknown): ColumnDef[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
      )
      .map((item): ColumnDef => {
        const col: ColumnDef = {
          name: typeof item.name === 'string' ? item.name : '',
          dataType: typeof item.dataType === 'string' ? item.dataType : 'VARCHAR',
          description: typeof item.description === 'string' ? item.description : '',
        };
        if (item.isPrimaryKey === true) col.isPrimaryKey = true;
        if (item.isForeignKey === true) col.isForeignKey = true;
        if (item.isNaturalKey === true) col.isNaturalKey = true;
        if (item.scdType === 0 || item.scdType === 1 || item.scdType === 2) {
          col.scdType = item.scdType;
        }
        if (
          item.additiveType === 'additive' ||
          item.additiveType === 'semi-additive' ||
          item.additiveType === 'non-additive'
        ) {
          col.additiveType = item.additiveType;
        }
        return col;
      })
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
