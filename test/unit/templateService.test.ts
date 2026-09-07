import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TemplateService } from '../../src/services/templateService';

describe('TemplateService', () => {
  let projectPath: string;
  let templatesDir: string;
  let service: TemplateService;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-templates-'));
    templatesDir = path.join(projectPath, '.erd-studio', 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    service = new TemplateService();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeTemplate(file: string, body: Record<string, unknown>): void {
    fs.writeFileSync(path.join(templatesDir, file), JSON.stringify(body, null, 2));
  }

  it('falls back to built-in templates when the directory has no json files', () => {
    const templates = service.loadTemplates(projectPath);
    expect(templates.map((t) => t.id)).toEqual(['dimension', 'fact', 'bridge', 'scd2', 'blank']);
  });

  describe('parseColumns', () => {
    it('preserves isForeignKey / isNaturalKey / scdType / additiveType flags', () => {
      writeTemplate('custom_scd.json', {
        id: 'custom_scd',
        label: 'Custom SCD',
        prefix: 'dim_',
        columns: [
          { name: '{name}_id', dataType: 'INTEGER', description: 'SK', isPrimaryKey: true, scdType: 0 },
          { name: 'customer_code', dataType: 'VARCHAR', description: '', isNaturalKey: true, scdType: 2 },
          { name: 'region_id', dataType: 'INTEGER', description: 'FK', isForeignKey: true },
          { name: 'amount', dataType: 'DECIMAL(18,2)', description: '', additiveType: 'non-additive' },
        ],
      });

      const [template] = service.loadTemplates(projectPath);
      expect(template.id).toBe('custom_scd');
      expect(template.columns).toEqual([
        { name: '{name}_id', dataType: 'INTEGER', description: 'SK', isPrimaryKey: true, scdType: 0 },
        { name: 'customer_code', dataType: 'VARCHAR', description: '', isNaturalKey: true, scdType: 2 },
        { name: 'region_id', dataType: 'INTEGER', description: 'FK', isForeignKey: true },
        { name: 'amount', dataType: 'DECIMAL(18,2)', description: '', additiveType: 'non-additive' },
      ]);
    });

    it('drops invalid flag values instead of passing them through', () => {
      writeTemplate('bad_flags.json', {
        id: 'bad_flags',
        label: 'Bad',
        columns: [
          {
            name: 'c',
            dataType: 'VARCHAR',
            description: '',
            isPrimaryKey: 'yes',
            isForeignKey: 1,
            isNaturalKey: 'true',
            scdType: 3,
            additiveType: 'sometimes',
          },
        ],
      });

      const [template] = service.loadTemplates(projectPath);
      expect(template.columns).toEqual([{ name: 'c', dataType: 'VARCHAR', description: '' }]);
    });
  });

  describe('duplicate ids', () => {
    it('warns and skips a second template file that reuses an id', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeTemplate('a_dimension.json', {
        id: 'dimension',
        label: 'First',
        columns: [{ name: 'first_col', dataType: 'VARCHAR', description: '' }],
      });
      writeTemplate('b_dimension.json', {
        id: 'dimension',
        label: 'Second',
        columns: [{ name: 'second_col', dataType: 'VARCHAR', description: '' }],
      });
      writeTemplate('fact.json', { id: 'fact', label: 'Fact', columns: [] });

      const templates = service.loadTemplates(projectPath);
      expect(templates.map((t) => t.id)).toEqual(['dimension', 'fact']);
      expect(templates[0].label).toBe('First');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('id "dimension" is already defined by a_dimension.json'));
    });
  });
});
