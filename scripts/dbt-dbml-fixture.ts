/**
 * The DBML copy of the dbt fixture: `test/fixtures/dbt-project-dbml` is
 * `test/fixtures/dbt-project` after Convert Project to DBML, so the whole dbt
 * loop (Physical tab, Compare, Sync, Draw from dbt, `selectors.yml`) runs on
 * native DBML storage against the same dbt project. Shared by the generator
 * (`scripts/regen-dbt-dbml-fixture.ts`) and the test that keeps the committed
 * copy in step (`test/unit/dbtProjectDbmlFixture.test.ts`). No `vscode`.
 */

import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');

/** The YAML/JSON dbt fixture the copy is made from. */
export const DBT_DBML_SOURCE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

/** The committed DBML copy. */
export const DBT_DBML_TARGET = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project-dbml');

/**
 * Paths (relative to the project, `/`-separated) left out of the copy: the
 * harness files (the same for either storage, and refreshed only for
 * `dbt-project` by `sync-fixtures.yml`) and the sample sync plan, which names
 * the YAML library paths Convert removes.
 */
export const DBT_DBML_EXCLUDE: readonly string[] = ['.claude/', '.agents/', '.erd-studio/.sync-plan.json'];

/** The command that regenerates the copy (named by the test's failure message). */
export const DBT_DBML_REGEN_COMMAND = 'npm run regen:dbt-dbml-fixture';

/** Whether `rel` (relative to the project, `/`-separated) is left out of the copy. */
export function excludedFromDbtDbmlCopy(rel: string): boolean {
  return DBT_DBML_EXCLUDE.some((x) => (x.endsWith('/') ? rel === x.slice(0, -1) || rel.startsWith(x) : rel === x));
}

/** A `fs.cpSync` filter that skips the excluded paths under `root`. */
export function dbtDbmlCopyFilter(root: string): (src: string) => boolean {
  return (src) => {
    const rel = path.relative(root, src).split(path.sep).join('/');
    return rel === '' || !excludedFromDbtDbmlCopy(rel);
  };
}
