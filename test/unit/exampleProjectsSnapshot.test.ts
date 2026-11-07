/**
 * What ERD Studio draws for every example project in docs/examples — one per
 * modelling pattern (medallion, dbt layers, Kimball bus matrix, Data Vault,
 * a database per stage, BigQuery datasets, data mesh). Together they are the
 * shapes customers' repos take, so a change to how files are read, or to
 * what a diagram shows, appears here as a reviewable diff across all of them.
 *
 * Each example's snapshot (test/golden/examples/<example>.json) is built by
 * core's `loadDisplaySubjectArea` — what the canvas and the Confluence app
 * draw — and lists its layers, every table on any diagram (layer, schema,
 * warehouse name, role, grain, columns with keys and types, and the
 * relationships file its next new relationship would be saved in) and each
 * diagram's tables and relationships. Layout positions are left out: moving
 * a table is not a change to the model.
 *
 * A diff here is a decision, not a failure to silence: read it as "this is
 * what changes for a team modelled this way". When the change is intended,
 * regenerate with:
 *
 *   UPDATE_GOLDEN=1 npx vitest run test/unit/exampleProjectsSnapshot.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import type { DisplayColumn, DisplayRelationship, DisplayTable } from '@erd-studio/core';

import { buildCliContext } from '../../src/cli/context';

const REPO = path.resolve(__dirname, '../..');
const EXAMPLES = path.join(REPO, 'docs', 'examples');
const GOLDEN = path.join(REPO, 'test', 'golden', 'examples');
const SEMANTIC_DIR = '.erd-studio';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

const examples = fs.readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(EXAMPLES, e.name, SEMANTIC_DIR)))
  .map((e) => e.name)
  .sort();

/** Every diagram of a project, semantic-relative (`gold/diagrams/sales.dbml`), sorted. */
function diagramsOf(project: string): string[] {
  const semantic = path.join(project, SEMANTIC_DIR);
  return fs.readdirSync(semantic, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(semantic, d.name, 'diagrams')))
    .flatMap((d) => fs.readdirSync(path.join(semantic, d.name, 'diagrams')).filter((f) => f.endsWith('.dbml')).map((f) => `${d.name}/diagrams/${f}`))
    .sort();
}

/** A column in one line: `customer_key BIGINT pk fk nk scd2 additive`. */
function columnLine(c: DisplayColumn): string {
  return [
    c.name,
    c.dataType,
    c.isPrimaryKey ? 'pk' : '',
    c.isForeignKey ? 'fk' : '',
    c.isNaturalKey ? 'nk' : '',
    c.scdType !== undefined ? `scd${c.scdType}` : '',
    c.additiveType ?? '',
  ].filter(Boolean).join(' ');
}

/** A relationship in one line: `fct_order.customer_key -> dim_customer.customer_key many-to-one`. */
function relationshipLine(r: DisplayRelationship): string {
  return [
    `${r.fromModel}.${r.fromColumn} -> ${r.toModel}.${r.toColumn}`,
    r.cardinality,
    r.role ? `role:${r.role}` : '',
    r.compositeKey ? 'composite' : '',
  ].filter(Boolean).join(' ');
}

/** A table as the snapshot keeps it: everything but its position. */
function tableOf(t: DisplayTable, newRelationshipsFile: string | undefined): Record<string, unknown> {
  return {
    layer: t.layer ?? null,
    schema: t.schema,
    ...(t.alias ? { alias: t.alias } : {}),
    ...(t.modelRole ? { role: t.modelRole } : {}),
    ...(t.grain ? { grain: t.grain } : {}),
    columns: t.columns.map(columnLine),
    // Where a new relationship with this table holding the foreign key is saved (`placeNewRef`).
    newRelationshipsFile: newRelationshipsFile ?? null,
  };
}

async function snapshotOf(example: string): Promise<Record<string, unknown>> {
  const root = path.join(EXAMPLES, example);
  const layers = (JSON.parse(fs.readFileSync(path.join(root, SEMANTIC_DIR, 'layers.json'), 'utf-8')) as {
    layers: Array<{ id: string; label: string; abbreviation?: string }>;
  }).layers.map((l) => ({ id: l.id, label: l.label, ...(l.abbreviation ? { abbreviation: l.abbreviation } : {}) }));
  const ctx = await buildCliContext({ project: root, semanticDir: SEMANTIC_DIR });
  const semanticRoot = path.join(root, SEMANTIC_DIR);
  const placement = ctx.tableLibraryService.relationshipsFilesForNewRefs(ctx.tableLibraryService.listTableFiles().map((e) => e.name));
  const placedFor = (name: string): string | undefined => {
    const file = placement.get(name.toLowerCase());
    return file === undefined ? undefined : path.relative(semanticRoot, file).split(path.sep).join('/');
  };
  const tables = new Map<string, Record<string, unknown>>();
  const diagrams: Array<Record<string, unknown>> = [];
  for (const diagram of diagramsOf(root)) {
    const display = await loadDisplaySubjectArea({
      domainPath: `${SEMANTIC_DIR}/${diagram}`,
      readFile: async (p) => {
        try {
          return fs.readFileSync(path.join(root, p), 'utf-8');
        } catch {
          return null;
        }
      },
      readOnly: true,
      warn: () => {},
      dbml: dbmlStorageReader,
    });
    for (const t of display.models) tables.set(`${t.schema}.${t.name}`, tableOf(t, placedFor(t.name)));
    diagrams.push({
      file: diagram,
      name: display.domain,
      layer: display.layer,
      tables: display.models.map((t) => `${t.schema}.${t.name}`).sort(),
      relationships: display.relationships.map(relationshipLine).sort(),
    });
  }
  return {
    example,
    layers,
    tables: Object.fromEntries([...tables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    diagrams,
  };
}

describe('what ERD Studio draws for each example project', () => {
  it('has a snapshot for every example, and none for an example that is gone', () => {
    if (UPDATE) fs.mkdirSync(GOLDEN, { recursive: true });
    const snapshots = fs.existsSync(GOLDEN) ? fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
    if (UPDATE) {
      for (const stale of snapshots.filter((s) => !examples.includes(s))) fs.rmSync(path.join(GOLDEN, `${stale}.json`));
      return;
    }
    expect(snapshots.sort()).toEqual(examples);
  });

  it.each(examples)('%s', async (example) => {
    const actual = `${JSON.stringify(await snapshotOf(example), null, 2)}\n`;
    const file = path.join(GOLDEN, `${example}.json`);
    if (UPDATE) {
      fs.writeFileSync(file, actual);
      return;
    }
    if (!fs.existsSync(file)) throw new Error(`Missing snapshot ${file}. Run with UPDATE_GOLDEN=1 to create it.`);
    expect(actual).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
