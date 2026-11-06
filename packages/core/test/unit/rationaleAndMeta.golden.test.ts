/**
 * The old-shape fixture for context fields (packages/core/test/fixtures/rationale-and-meta):
 * model files as every extension before context fields wrote them — all six
 * rationale keys, an unknown rationale key, an empty one, and table and
 * column meta holding text, a yes/no and a list.
 *
 * Its golden (`display.golden.json`, in the fixture) was written before core
 * learnt the new rationale keys, and must never change for this shape: the
 * core loader draws exactly what it drew. Its export goldens are pinned by
 * exportDiagram.golden.test.ts. Regenerate with UPDATE_GOLDEN=1 only for an
 * intended rendering change.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';

const ROOT = path.resolve(__dirname, '../fixtures/rationale-and-meta');
const GOLDEN = path.join(ROOT, 'display.golden.json');
const DOMAIN = '.erd-studio/silver/ledger.json';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function fsReadFile(root: string) {
  return async (p: string): Promise<string | null> => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}

describe('rationale-and-meta: the shape model files had before context fields', () => {
  it('draws its golden DisplaySubjectArea', async () => {
    const area = await loadDisplaySubjectArea({ domainPath: DOMAIN, readFile: fsReadFile(ROOT), readOnly: false, warn: () => {} });
    const json = `${JSON.stringify(area, null, 2)}\n`;
    if (UPDATE) fs.writeFileSync(GOLDEN, json);
    expect(json).toBe(fs.readFileSync(GOLDEN, 'utf-8'));
  });

  it('draws the same with readFieldsFile on and no fields.yml: no fields, no warning', async () => {
    const warnings: string[] = [];
    const area = await loadDisplaySubjectArea({
      domainPath: DOMAIN,
      readFile: fsReadFile(ROOT),
      readOnly: false,
      warn: (m) => warnings.push(m),
      readFieldsFile: true,
    });
    expect(`${JSON.stringify(area, null, 2)}\n`).toBe(fs.readFileSync(GOLDEN, 'utf-8'));
    expect(area.fields).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('keeps meta beside the rationale: a meta purpose is its own entry, booleans stay booleans, lists stay lists', async () => {
    const area = await loadDisplaySubjectArea({ domainPath: DOMAIN, readFile: fsReadFile(ROOT), readOnly: false, warn: () => {} });
    const account = area.models.find((m) => m.name === 'dim_account')!;
    expect(account.rationale?.purpose).toBe('Shared account reference for finance reporting');
    expect(account.meta).toEqual({
      owner: 'finance-data',
      certified: true,
      tags: ['finance', 'conformed'],
      purpose: 'Kept in meta, next to the rationale purpose',
    });
    // An unknown rationale key is not read; an empty one is no value.
    expect(Object.keys(account.rationale ?? {})).toEqual(['purpose', 'design', 'grainChoice', 'roleChoice', 'scdStrategy', 'measures']);
    const balance = area.models.find((m) => m.name === 'fct_balance')!;
    expect(balance.rationale).toEqual({
      purpose: 'Month-end balances for the finance close',
      measures: 'balance is semi-additive (never sum across months); txn_count is additive',
    });
    expect(account.columns.find((c) => c.name === 'account_name')?.meta).toEqual({
      pii: true,
      business_rule: 'Trimmed, title case',
      sources: ['crm', 'billing'],
    });
  });
});
