import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

import { slugFromName, validateTypedDiagramName } from '../../src/commands/diagramName';

const SLUG_RULE = (slug: string) => (/^[a-z][a-z0-9_-]*$/.test(slug) ? undefined : 'Use lowercase letters, numbers, - and _, starting with a letter (e.g. customer-360)');

describe('a diagram name as people type it', () => {
  it('turns what was typed into the file name', () => {
    expect(slugFromName('Sales')).toBe('sales');
    expect(slugFromName('Customer 360')).toBe('customer-360');
  });

  it('accepts "Sales" with a quiet "Saved as sales", and a file name as it is', () => {
    expect(validateTypedDiagramName('Sales', SLUG_RULE)).toEqual({ message: 'Saved as sales', severity: vscode.InputBoxValidationSeverity.Info });
    expect(validateTypedDiagramName('sales', SLUG_RULE)).toBeUndefined();
  });

  it('refuses an empty name, and passes on what the rule says about the file name', () => {
    expect(validateTypedDiagramName('   ', SLUG_RULE)).toBe('Give the diagram a name');
    expect(validateTypedDiagramName('2024 plan', SLUG_RULE)).toMatch(/^Use lowercase/);
    expect(validateTypedDiagramName('Taken', (slug) => (slug === 'taken' ? 'There is already a diagram named "taken"' : undefined)))
      .toBe('There is already a diagram named "taken"');
  });

  it('is the one rule every start uses: New Diagram, Import DBML (and the SQL and Power BI imports through it), Draw from dbt', () => {
    // Onboarding story 04 found New Diagram accepting "Orders" and the imports refusing "Sales".
    const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    for (const file of ['extension.ts', 'commands/importDbml.ts', 'commands/drawFromDbt.ts']) {
      expect(src(file), file).toContain('validateTypedDiagramName(value');
    }
    for (const file of ['commands/importDbml.ts', 'commands/drawFromDbt.ts']) {
      expect(src(file), file).toContain('const slug = slugFromName(name);');
    }
  });
});
