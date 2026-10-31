/**
 * Regenerates the core DBML twins (`packages/core/test/fixtures/dbml/<twin>/`)
 * by running Convert Project to DBML on each twin's YAML/JSON source, as
 * `test/unit/dbmlConversion.golden.test.ts` does, so a formatting change
 * Convert makes on purpose lands in every twin at once. Review the diff:
 * anything but the intended change is a Convert bug. Never run in CI.
 *
 * `missing-model` is not generated: it is a reader-tolerance case written by
 * hand (use lines for tables with no file). Its Convert output is the
 * `missing-model-converted` twin.
 *
 * Usage (from the repo root; bundled like regen-fixtures.ts, since the
 * planner pulls in markdown as text):
 *   npx esbuild scripts/regen-dbml-twins.ts --bundle --platform=node --format=cjs \
 *     --loader:.md=text --outfile=scripts/.regen-dbml-twins.cjs && node scripts/.regen-dbml-twins.cjs
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { convertOnDisk } from './convert-on-disk';

const ROOT = path.resolve(__dirname, '..');
const CORE_FIXTURES = path.join(ROOT, 'packages', 'core', 'test', 'fixtures');
const VARIANTS = path.join(ROOT, 'test', 'fixtures', 'dbml-convert');

/** Each twin and the project it is the conversion of (the golden test's list). */
const TWINS: Array<[twin: string, source: string]> = [
  ['composite-and-self', path.join(CORE_FIXTURES, 'composite-and-self')],
  ['showcase', path.join(CORE_FIXTURES, 'showcase')],
  ['missing-positions', path.join(CORE_FIXTURES, 'missing-positions')],
  ['library-relationships', path.join(VARIANTS, 'library-relationships-variant')],
  ['missing-model-converted', path.join(CORE_FIXTURES, 'missing-model')],
];

async function main(): Promise<void> {
  const only = new Set(process.argv.slice(2));
  for (const [twin, source] of TWINS) {
    if (only.size > 0 && !only.has(twin)) continue;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `erd-twin-${twin}-`));
    try {
      fs.cpSync(path.join(source, '.erd-studio'), path.join(tmp, '.erd-studio'), { recursive: true });
      const plan = await convertOnDisk(tmp);
      if (plan.refusals.length > 0) throw new Error(`${twin}: Convert refused:\n${plan.refusals.join('\n')}`);
      const target = path.join(CORE_FIXTURES, 'dbml', twin, '.erd-studio');
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(tmp, '.erd-studio'), target, { recursive: true });
      process.stdout.write(`${twin}: ${plan.creates.length} created, ${plan.leftAsIs.length} left as they are\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
