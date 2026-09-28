/**
 * Regenerates test fixture harness files from the source generators.
 *
 * Usage (from the repo root; the bundle must sit in scripts/ so __dirname resolves):
 *   npx esbuild scripts/regen-fixtures.ts --bundle --platform=node --format=cjs \
 *     --loader:.md=text --outfile=scripts/.regen-fixtures.cjs && node scripts/.regen-fixtures.cjs
 * (not tsx: the harness imports the setup skill's markdown as text, which only esbuild's
 * `.md` loader handles.)
 *
 * Calls HarnessService.install() which writes both SKILL.md and SYNC.md
 * to the fixture dbt-project. No VS Code dependency required.
 */

import * as path from 'path';
import { HarnessService } from '../src/services/harnessService';

const FIXTURE_ROOT = path.resolve(__dirname, '../test/fixtures/dbt-project');

const service = new HarnessService();
const result = service.install(
  FIXTURE_ROOT,
  {
    label: 'Claude Code',
    id: 'claude',
    description: '.claude/skills/erd-studio/SKILL.md',
    relativePath: '.claude/skills/erd-studio/SKILL.md',
  },
  true, // overwrite
);

if (!result.success) {
  console.error('Failed to regenerate fixtures:', result.error);
  process.exit(1);
}

console.log('Regenerated fixture harness files');
