/**
 * Regenerates `test/fixtures/dbt-project-dbml`: the whole dbt fixture
 * (`dbt_project.yml`, `models/`, `target/`, `selectors.yml`, `.erd-studio/`)
 * after the real Convert Project to DBML, minus the harness files and the
 * sample sync plan (`DBT_DBML_EXCLUDE`). Rerun it after any intended change to
 * Convert's output or to `test/fixtures/dbt-project`; the test
 * `test/unit/dbtProjectDbmlFixture.test.ts` fails until you do. Review the
 * diff: anything but Convert's own output is a Convert bug. Never run in CI.
 *
 * Usage (from the repo root): `npm run regen:dbt-dbml-fixture`. It bundles this
 * script with esbuild into `scripts/.regen-dbt-dbml-fixture.cjs` (gitignored)
 * first, since the planner pulls in markdown as text, which only esbuild's
 * `.md` loader handles.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { convertOnDisk } from './convert-on-disk';
import { DBT_DBML_SOURCE, DBT_DBML_TARGET, dbtDbmlCopyFilter } from './dbt-dbml-fixture';

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-dbml-'));
  const work = path.join(tmp, 'project');
  try {
    fs.cpSync(DBT_DBML_SOURCE, work, { recursive: true, preserveTimestamps: true, filter: dbtDbmlCopyFilter(DBT_DBML_SOURCE) });
    const plan = await convertOnDisk(work);
    if (plan.refusals.length > 0) throw new Error(`Convert refused:\n${plan.refusals.join('\n')}`);
    if (plan.leftAsIs.length > 0) {
      throw new Error(`Convert left files as they are:\n${plan.leftAsIs.map((l) => `${l.path}: ${l.problem}`).join('\n')}`);
    }
    fs.rmSync(DBT_DBML_TARGET, { recursive: true, force: true });
    fs.cpSync(work, DBT_DBML_TARGET, { recursive: true, preserveTimestamps: true });
    // The manifest is newer than every model file, so the copy reads as fresh
    // (manifest staleness compares mtimes; git checkouts reset them anyway).
    const now = new Date();
    for (const f of ['manifest.json', 'catalog.json']) {
      const p = path.join(DBT_DBML_TARGET, 'target', f);
      if (fs.existsSync(p)) fs.utimesSync(p, now, now);
    }
    process.stdout.write(
      `dbt-project-dbml: ${plan.creates.length} created, ${plan.deletes.length} YAML/JSON files converted\n`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
