/**
 * The settle's refuse-not-skip rule (§2.6 step 3) when a caller renders with
 * its own resolver: Give Duplicate Its Own Name renames the copy outside the
 * library plan (its plan is the current state), so the tables whose path
 * changes come from the resolver. A diagram it cannot settle while one of
 * its members' paths changes refuses the whole edit instead of being left
 * with a `use` line to a file that is gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dbmlResolverOf, settleDbmlDiagramWrites } from '../../src/services/dbmlDiagramSettle';
import { TableLibraryService } from '../../src/services/logicalModelService';

const NATIVE = path.resolve(__dirname, '../fixtures/dbml-native');
const SEMANTIC_DIR = '.erd-studio';

let root: string;
const at = (rel: string): string => path.join(root, SEMANTIC_DIR, rel);
const readText = (filePath: string): string | null => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-settle-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A current-state plan, and a resolver whose own `pathChanged` names `changed` (as Give Duplicate's does). */
function settleWith(changed: string[], mutate: () => boolean): ReturnType<typeof settleDbmlDiagramWrites> {
  const library = new TableLibraryService(root, SEMANTIC_DIR);
  const { plan } = library.planDbmlLibraryOps({}, readText);
  const semanticRoot = path.join(root, SEMANTIC_DIR);
  const base = dbmlResolverOf(plan, semanticRoot);
  return settleDbmlDiagramWrites({
    semanticRoot,
    diagrams: [at('silver/diagrams/staging.dbml')],
    plan,
    readText,
    resolver: { ...base, ...(changed.length > 0 ? { pathChanged: new Set(changed) } : {}) },
    mutatedOnly: true,
    mutate: mutate,
  });
}

describe('settleDbmlDiagramWrites with a caller\'s resolver (Give Duplicate Its Own Name)', () => {
  it('refuses a diagram it cannot render when the resolver changes the path of one of its members', () => {
    expect(() => settleWith(['dim_date'], () => {
      throw new Error('the writer turned it down');
    })).toThrow('silver/diagrams/staging.dbml does not read (the writer turned it down); fix it first, or it would keep a use line to silver/tables/calendar/dim_date.dbml.');
  });

  it('leaves it as it is when no member\'s path changes', () => {
    expect(settleWith(['dim_region'], () => {
      throw new Error('the writer turned it down');
    })).toEqual([]);
  });
});
