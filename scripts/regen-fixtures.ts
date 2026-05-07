/**
 * Regenerates test fixture harness files from the source generators.
 *
 * Usage:  npx tsx scripts/regen-fixtures.ts
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
