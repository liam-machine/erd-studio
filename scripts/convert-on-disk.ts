/**
 * Convert Project to DBML applied to a project on disk, as the command's one
 * edit applies it, for the scripts that run Convert outside VS Code:
 * `scripts/convert-fixture.ts` (the e2e) and `scripts/regen-dbml-twins.ts`.
 * Never bundled by the extension or the CLI.
 */

import * as fs from 'fs';
import * as path from 'path';

import { planDbmlConversion } from '../src/services/dbmlConversion';
import type { DbmlConversionPlan } from '../src/services/dbmlConversion';
import { removeEmptiedLibraryFolders } from '../src/services/dbmlConversionCleanup';
import { readDbmlConversionInput } from '../src/services/dbmlConversionFiles';

const SEMANTIC_DIR = '.erd-studio';

/**
 * Plan Convert for the project at `projectRoot` and apply it as the command's
 * one edit does: creates (tables, relationships files, diagrams, README),
 * replaces, deletes, then the emptied YAML library folders go (step 10).
 * The plan, or its refusals with nothing written.
 */
export async function convertOnDisk(projectRoot: string): Promise<DbmlConversionPlan> {
  const semanticRoot = path.join(projectRoot, SEMANTIC_DIR);
  const plan = await planDbmlConversion(readDbmlConversionInput(projectRoot, SEMANTIC_DIR));
  if (plan.refusals.length > 0) return plan;
  for (const c of plan.creates) {
    const file = path.join(semanticRoot, ...c.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, c.text);
  }
  for (const r of plan.replaces) fs.writeFileSync(path.join(semanticRoot, ...r.path.split('/')), r.text);
  for (const d of plan.deletes) fs.rmSync(path.join(semanticRoot, ...d.split('/')));
  removeEmptiedLibraryFolders(semanticRoot, plan.deletes);
  return plan;
}

