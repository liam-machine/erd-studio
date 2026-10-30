/**
 * `doctor` compiles a DBML project file by file (`compileDbmlFilesSeparately`)
 * instead of in one multi-file compile, which grew with the square of the
 * library (9 s of a 1,100-table doctor). Its report must not change: on a
 * project broken in ways that cross files (the same Ref in two relationships
 * files a diagram reads, a bad `use` path, a syntax error in a table, an
 * unquoted value, a TableGroup), `dbmlProblems` is identical to what the
 * whole-project compile gives.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorResult } from '../../src/cli/doctor';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'dbml-native');
const cleanEnv: NodeJS.ProcessEnv = { PATH: '' };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-doctor-compile-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('../../src/services/dbmlFileCompile');
  vi.resetModules();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function brokenProject(): string {
  const root = path.join(tmp, 'project');
  fs.cpSync(FIXTURE, root, { recursive: true });
  const at = (rel: string): string => path.join(root, '.erd-studio', rel);
  const edit = (rel: string, fn: (t: string) => string): void => {
    const before = fs.readFileSync(at(rel), 'utf-8');
    const after = fn(before);
    expect(after, rel).not.toBe(before);
    fs.writeFileSync(at(rel), after);
  };
  // The same Ref in two relationships files the diagram reads with `use *`.
  edit('gold/relationships/customers.dbml', (t) => `${t.trimEnd()}\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\nRef: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n`);
  // An unquoted value, and a syntax error in another table.
  edit('silver/tables/calendar/dim_date.dbml', (t) => t.replace("role: 'conformed-dim'", 'role: conformed'));
  edit('gold/tables/gold/dim_region.dbml', (t) => t.replace('{', '{\n  broken column [pk,'));
  // A diagram use path that names no file, and a TableGroup (crosses files the old way).
  edit('gold/diagrams/sales.dbml', (t) => t
    .replace("use { table gold.bridge_empty } from '../tables/gold/bridge_empty.dbml'", "use { table gold.bridge_empty } from '../tables/gold/bridge_missing.dbml'")
    .concat('\nTableGroup orders {\n  gold.fct_order\n  gold.dim_customer\n}\n'));
  return root;
}

async function doctorWith(root: string, wholeProject: boolean): Promise<DoctorResult> {
  vi.resetModules();
  if (wholeProject) {
    vi.doMock('../../src/services/dbmlFileCompile', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/services/dbmlFileCompile')>();
      const { compileDbmlProject } = await import('@erd-studio/core/dbml');
      return { ...real, compileDbmlFilesSeparately: (files: Record<string, string>, entries: readonly string[]) => compileDbmlProject(files, entries) };
    });
  }
  const { runDoctor } = await import('../../src/cli/doctor');
  return runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: cleanEnv, homeDir: path.join(tmp, 'home') });
}

describe('doctor compiles DBML file by file and reports what the whole-project compile reports', () => {
  it('the same dbmlProblems and next steps on a project broken across files', async () => {
    const root = brokenProject();
    const separately = await doctorWith(root, false);
    const whole = await doctorWith(root, true);
    // The parser's own diagnostics (numeric codes) are there to compare.
    expect(separately.erd.dbmlProblems.filter((p) => typeof p.code === 'number').length).toBeGreaterThanOrEqual(3);
    expect(separately.erd.dbmlProblems).toEqual(whole.erd.dbmlProblems);
    expect(separately.nextSteps).toEqual(whole.nextSteps);
  });

  it('a clean project is clean either way', async () => {
    const root = path.join(tmp, 'clean');
    fs.cpSync(FIXTURE, root, { recursive: true });
    expect((await doctorWith(root, false)).erd.dbmlProblems).toEqual([]);
    expect((await doctorWith(root, true)).erd.dbmlProblems).toEqual([]);
  });
});
