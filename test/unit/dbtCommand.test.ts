/**
 * The toolbar's dbt command (#378): the pure builder (`buildDbtCommand`), the
 * resolver it shares with selectors.yml (`dbtModelNameOf`) and the payload
 * check (`validateCopyDbtCommandPayload`). The host side is
 * `dbtCommandHost.test.ts`, the button `Toolbar.test.tsx`.
 */
import { describe, it, expect, vi } from 'vitest';

import { DBT_COMMAND_MAX_LENGTH, buildDbtCommand, isShellSafeDbtName, type DbtCommandTable } from '../../src/services/dbtCommand';
import { dbtModelNameOf } from '../../src/services/dbtModelName';
import { validateCopyDbtCommandPayload } from '../../src/providers/payloadValidation';
import { DBT_COMMAND_TABLES_LIMIT } from '../../src/types/dbtCommand';
import type { SemanticTable } from '../../src/types/semantic';

const inDbt = (name: string, dbtModel = name): DbtCommandTable => ({ name, dbtModel });
const design = (name: string): DbtCommandTable => ({ name, dbtModel: null });

const DIAGRAM = [inDbt('dim_customer'), inDbt('dim_date'), inDbt('fct_order'), design('fct_forecast')];

describe('buildDbtCommand', () => {
  it('copies each verb for every table in dbt, leaving out and counting the design-only ones', () => {
    for (const verb of ['build', 'run', 'test'] as const) {
      const result = buildDbtCommand({ verb, tables: DIAGRAM });
      expect(result).toMatchObject({ kind: 'copy', form: 'select', tooLong: false, text: `dbt ${verb} --select dim_customer dim_date fct_order` });
      expect(result.message).toBe(`Copied: dbt ${verb} for 3 of the 4 tables on this diagram. 1 left out: not in dbt yet.`);
    }
  });

  it('says "the N tables on this diagram" when every table is in dbt', () => {
    const result = buildDbtCommand({ verb: 'build', tables: DIAGRAM.slice(0, 3) });
    expect(result.message).toBe('Copied: dbt build for the 3 tables on this diagram.');
    expect(buildDbtCommand({ verb: 'build', tables: [inDbt('dim_date')] }).message).toBe('Copied: dbt build for the table on this diagram.');
  });

  it('copies only the selected tables, matched ignoring case, in selection order, each once', () => {
    const result = buildDbtCommand({ verb: 'test', tables: DIAGRAM, selected: ['FCT_ORDER', 'dim_customer', 'fct_order'] });
    expect(result).toMatchObject({ kind: 'copy', text: 'dbt test --select fct_order dim_customer' });
    expect(result.message).toBe('Copied: dbt test for 2 selected tables.');
    expect(buildDbtCommand({ verb: 'test', tables: DIAGRAM, selected: ['dim_date'] }).message).toBe('Copied: dbt test for 1 selected table.');
  });

  it('an empty selection is the whole diagram', () => {
    expect(buildDbtCommand({ verb: 'run', tables: DIAGRAM, selected: [] })).toMatchObject({ text: 'dbt run --select dim_customer dim_date fct_order' });
  });

  it('counts a selected design-only table as left out', () => {
    const result = buildDbtCommand({ verb: 'build', tables: DIAGRAM, selected: ['fct_order', 'fct_forecast'] });
    expect(result).toMatchObject({ kind: 'copy', text: 'dbt build --select fct_order' });
    expect(result.message).toBe('Copied: dbt build for 1 of 2 selected tables. 1 left out: not in dbt yet.');
  });

  it('copies nothing when none of the tables is in dbt, and says so', () => {
    expect(buildDbtCommand({ verb: 'build', tables: [design('a'), design('b')] }))
      .toEqual({ kind: 'nothing', message: 'Nothing copied: none of the 2 tables on this diagram is in dbt yet.' });
    expect(buildDbtCommand({ verb: 'build', tables: DIAGRAM, selected: ['fct_forecast'] }))
      .toEqual({ kind: 'nothing', message: 'Nothing copied: the selected table is not in dbt yet.' });
    expect(buildDbtCommand({ verb: 'build', tables: [] }))
      .toEqual({ kind: 'nothing', message: 'Nothing copied: this diagram has no tables yet.' });
  });

  it('refuses a selected name the diagram does not have', () => {
    expect(buildDbtCommand({ verb: 'build', tables: DIAGRAM, selected: ['dim_customer', 'gone'] }))
      .toEqual({ kind: 'nothing', message: 'Nothing copied: "gone" is not on this diagram.' });
  });

  it('writes the dbt model the table is, and one model two tables share once', () => {
    const tables = [inDbt('sales.dim_customer', 'dim_customer'), inDbt('crm.dim_customer', 'crm_dim_customer'), inDbt('DIM_CUSTOMER', 'dim_customer')];
    expect(buildDbtCommand({ verb: 'build', tables })).toMatchObject({ text: 'dbt build --select dim_customer crm_dim_customer' });
  });

  it('never pastes a name a shell or dbt would misread: it is left out and counted', () => {
    for (const bad of ['a b', 'x;rm -rf ~', '$(whoami)', '`id`', 'a|b', 'a>b', "it's", 'a"b', 'tag:nightly', 'a+', '+a', '*', 'a,b', '@a', '-rf', 'a&b', '%PATH%', 'a\nb']) {
      expect(isShellSafeDbtName(bad), bad).toBe(false);
      const result = buildDbtCommand({ verb: 'run', tables: [inDbt('ok_model'), inDbt('weird', bad)] });
      expect(result, bad).toMatchObject({ kind: 'copy', text: 'dbt run --select ok_model' });
      expect(result.message).toBe('Copied: dbt run for 1 of the 2 tables on this diagram. 1 left out: its dbt name has characters a terminal would misread.');
    }
    for (const good of ['dim_customer', 'DimCustomer', '2024_orders', '_stg', 'my-model', 'orders.v2']) {
      expect(isShellSafeDbtName(good), good).toBe(true);
    }
    expect(buildDbtCommand({ verb: 'run', tables: [inDbt('weird', 'a b')] }))
      .toEqual({ kind: 'nothing', message: 'Nothing copied: the dbt name of the table on this diagram has characters a terminal would misread.' });
  });

  describe(`past ${DBT_COMMAND_MAX_LENGTH} characters`, () => {
    // 400 names of 25 characters: about 10,400 characters.
    const many = Array.from({ length: 400 }, (_, i) => inDbt(`fct_a_rather_long_name_${String(i).padStart(3, '0')}`));

    it('stays under the limit as a list', () => {
      const short = many.slice(0, 100);
      const selector = vi.fn(() => 'domain_gold_sales');
      const result = buildDbtCommand({ verb: 'build', tables: short, currentSelector: selector });
      expect(result).toMatchObject({ form: 'select', tooLong: false });
      expect(result.kind === 'copy' && result.text.length).toBeLessThanOrEqual(DBT_COMMAND_MAX_LENGTH);
      expect(selector).not.toHaveBeenCalled();
    });

    it('copies the diagram\'s selector when selectors.yml is current and nothing is selected', () => {
      const result = buildDbtCommand({ verb: 'test', tables: many, currentSelector: () => 'domain_gold_sales' });
      expect(result).toEqual({
        kind: 'copy',
        form: 'selector',
        tooLong: false,
        text: 'dbt test --selector domain_gold_sales',
        message: "Copied: dbt test --selector domain_gold_sales, this diagram's selector in selectors.yml. "
          + 'Listing the 400 tables on this diagram would be too long for the Windows command prompt.',
      });
    });

    it('copies the long command with a warning when there is no current selector', () => {
      const result = buildDbtCommand({ verb: 'build', tables: many, currentSelector: () => undefined });
      expect(result.kind).toBe('copy');
      if (result.kind !== 'copy') return;
      expect(result).toMatchObject({ form: 'select', tooLong: true });
      expect(result.text.length).toBeGreaterThan(DBT_COMMAND_MAX_LENGTH);
      expect(result.text.startsWith('dbt build --select fct_a_rather_long_name_000 ')).toBe(true);
      expect(result.message).toBe(`Copied: dbt build for the 400 tables on this diagram. It is ${result.text.length.toLocaleString('en-US')} characters, which may be too long for the Windows command prompt.`);
    });

    it('never swaps a selection for the selector', () => {
      const selector = vi.fn(() => 'domain_gold_sales');
      const result = buildDbtCommand({ verb: 'run', tables: many, selected: many.map((t) => t.name), currentSelector: selector });
      expect(result).toMatchObject({ form: 'select', tooLong: true });
      expect(result.message).toMatch(/^Copied: dbt run for 400 selected tables\. It is [\d,]+ characters, which may be too long for the Windows command prompt\.$/);
      expect(selector).not.toHaveBeenCalled();
    });
  });
});

describe('dbtModelNameOf (shared with selectors.yml)', () => {
  const table = (name: string, tableName?: string): SemanticTable =>
    ({ name, columns: [], ...(tableName ? { tableName } : {}) }) as unknown as SemanticTable;

  it('is the table\'s name, or what the comparison found a shared name as', () => {
    expect(dbtModelNameOf(table('dim_customer'))).toBe('dim_customer');
    const found = new Map<string, string | null>([['sales.dim_customer', 'dim_customer'], ['crm.dim_customer', null]]);
    expect(dbtModelNameOf(table('sales.dim_customer', 'dim_customer'), found)).toBe('dim_customer');
    expect(dbtModelNameOf(table('crm.dim_customer', 'dim_customer'), found)).toBeNull();
    // A `<schema>.<name>` reference the map does not list is never written as a reference.
    expect(dbtModelNameOf(table('hr.dim_customer', 'dim_customer'))).toBeNull();
  });
});

describe('validateCopyDbtCommandPayload', () => {
  it('accepts a verb, with or without table names', () => {
    expect(validateCopyDbtCommandPayload({ verb: 'build' })).toBeNull();
    expect(validateCopyDbtCommandPayload({ verb: 'test', tables: ['dim_customer', 'sales.fct_order'] })).toBeNull();
    expect(validateCopyDbtCommandPayload({ verb: 'run', tables: [] })).toBeNull();
  });

  it('refuses a bad verb, a non-list, a non-string or unsafe table name, and too many names', () => {
    expect(validateCopyDbtCommandPayload(undefined)).toBe('Copying a dbt command needs build, run or test.');
    expect(validateCopyDbtCommandPayload({ verb: 'seed' })).toBe('Copying a dbt command needs build, run or test.');
    expect(validateCopyDbtCommandPayload({ verb: 'build; rm -rf ~' })).toBe('Copying a dbt command needs build, run or test.');
    expect(validateCopyDbtCommandPayload({ verb: 'build', tables: 'dim_customer' })).toBe('The selected tables must be a list of table names.');
    expect(validateCopyDbtCommandPayload({ verb: 'build', tables: ['ok', 42] })).toBe('Table name is required.');
    expect(validateCopyDbtCommandPayload({ verb: 'build', tables: ['../x'] })).toBe('Table name cannot contain path separators.');
    expect(validateCopyDbtCommandPayload({ verb: 'build', tables: Array.from({ length: DBT_COMMAND_TABLES_LIMIT + 1 }, () => 'a') }))
      .toBe(`At most ${DBT_COMMAND_TABLES_LIMIT} tables can be in one dbt command.`);
  });
});
