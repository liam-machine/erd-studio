/**
 * `erd-studio diff` gives the same answer on both storages of the dbt
 * fixture: `test/fixtures/dbt-project` (YAML/JSON) and its native-DBML
 * Convert `test/fixtures/dbt-project-dbml`. Run in-process through the CLI's
 * own `main()` (the same code `dist/cli.js` bundles), so no build is needed.
 *
 * - `diff --all --json`: every diagram's verdict, counts, phantoms and fixes
 *   are equal once each path is mapped to the file that holds the same thing
 *   on the other storage (e2e-dbml's normalisation, without Convert's plan:
 *   the twin is committed). The human output is equal after the same mapping.
 * - every DBML fix and plan path names a `.dbml` file in the right layer: a
 *   table's own file, the relationships file that holds (or will hold) a Ref,
 *   or the diagram that should import it.
 * - `--domain` accepts a `.dbml` diagram however it is spelled.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { main } from '../../src/cli/index';
import type { DiffResult, Fix, SubjectAreaDiff } from '../../src/cli/diff';
import { dbtFixtureRoot, tableFilePath } from './helpers/dbtFixtures';

const YAML = dbtFixtureRoot('dbt-project');
const DBML = dbtFixtureRoot('dbt-project-dbml');

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    cwd,
    env: {},
  });
  return { code, out, err };
}

const rel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** A diagram's key on either storage: `silver/showcase` for `silver/showcase.json` and `silver/diagrams/showcase.dbml`. */
const diagramKey = (file: string): string =>
  file.replace(/^\.erd-studio\//, '').replace(/^([^/]+)\/diagrams\/([^/]+)$/, '$1/$2').replace(/\.(json|dbml)$/i, '');

const isTableFile = (p: string): boolean => /^\.erd-studio\/(logical-models\/(.+\/)?[^/]+\.yml|[^/]+\/tables\/[^/]+\/[^/]+\.dbml)$/.test(p);
const isRelationshipsFile = (p: string): boolean => /^\.erd-studio\/[^/]+\/relationships\/[^/]+\.dbml$/.test(p);
const isDiagramFile = (p: string): boolean => /^\.erd-studio\/[^/]+\/([^/]+\.json|diagrams\/[^/]+\.dbml)$/.test(p);
const tableOfPath = (p: string): string => path.posix.basename(p).replace(/\.(yml|dbml)$/, '').toLowerCase();

/**
 * One path, as the same thing on either storage: a table's file → `table:<name>`,
 * a diagram → `diagram:<layer>/<name>`, and where a relationship is stored (a
 * table yml or domain JSON on YAML, a relationships file on DBML) →
 * `relationship-store`. A dbt path (`models/…`) is the same on both.
 */
function pathKey(p: string | undefined, fix?: Fix): string | undefined {
  if (typeof p !== 'string') return p;
  const isRelationship = fix?.relationship !== undefined;
  if (isRelationship && (isRelationshipsFile(p) || isTableFile(p) || (isDiagramFile(p) && fix!.kind !== 'import-relationships-file'))) return 'relationship-store';
  if (isTableFile(p)) return `table:${tableOfPath(p)}`;
  if (isDiagramFile(p)) return `diagram:${diagramKey(p)}`;
  return p;
}

/** A fix with its paths keyed; `explain` names the files too, so it is dropped. */
const fixKey = (f: Fix): unknown => ({ ...f, file: pathKey(f.file, f), movesFrom: undefined, storedIn: undefined, useLine: undefined, explain: undefined });

/** A relationship's identity, for putting lists in one order. */
const relKey = (r: { fromModel?: string; fromColumn?: string; toModel?: string; toColumn?: string }): string =>
  [r.fromModel, r.fromColumn, r.toModel, r.toColumn].map((v) => String(v ?? '').toLowerCase()).join('\u0000');

/**
 * `value` with every `relationships` list in one order: a DBML diagram reads
 * its relationships in the relationships file's order, a JSON one in the table
 * files' order. Order is all that differs (as in dbtLoop.storage.test.ts).
 */
const relationshipsSorted = <T>(value: T): T => JSON.parse(JSON.stringify(value), (key, v) => (
  key === 'relationships' && Array.isArray(v) ? [...v].sort((a, b) => relKey(a).localeCompare(relKey(b))) : v
));

function normalise(d: SubjectAreaDiff): unknown {
  return relationshipsSorted({
    domain: d.domain, layer: d.layer, clean: d.clean, error: d.error?.code, counts: d.counts, phantoms: d.phantoms,
    missingModelFiles: d.missingModelFiles, modelsWithoutColumns: d.modelsWithoutColumns,
    unreadable: d.unreadableModelFiles.map((u) => u.name),
    fixes: d.fixes.map(fixKey),
    report: d.report,
    plan: d.plan && {
      ...d.plan,
      generatedAt: '',
      modelContext: Object.fromEntries(Object.entries(d.plan.modelContext).map(([k, c]) => [k, { ...c, logicalModelPath: pathKey(c.logicalModelPath), relationshipsPath: undefined }])),
      relationships: d.plan.relationships.map((r) => ({ ...r, storedIn: undefined })),
    },
  });
}


async function diffAll(root: string): Promise<{ code: number; byKey: Map<string, SubjectAreaDiff>; result: DiffResult }> {
  const r = await cli(['diff', '--all', '--json'], root);
  const result = JSON.parse(r.out) as DiffResult;
  return { code: r.code, result, byKey: new Map(result.domains.map((d) => [diagramKey(d.file), d])) };
}

describe('erd-studio diff on the YAML and DBML twins of the dbt fixture', () => {
  it('diff --all --json: the same verdicts, counts, reports, plans and fixes on both, after mapping paths', async () => {
    const yaml = await diffAll(YAML);
    const dbml = await diffAll(DBML);
    expect(dbml.code).toBe(yaml.code);
    expect(dbml.result.clean).toBe(yaml.result.clean);
    expect(dbml.result.inputs).toEqual(yaml.result.inputs);
    expect([...dbml.byKey.keys()].sort()).toEqual([...yaml.byKey.keys()].sort());
    const compared: string[] = [];
    for (const [key, a] of yaml.byKey) {
      const b = dbml.byKey.get(key)!;
      expect(b.file, key).toMatch(/^\.erd-studio\/[^/]+\/diagrams\/[^/]+\.dbml$/);
      expect(a.file, key).toMatch(/^\.erd-studio\/[^/]+\/[^/]+\.json$/);
      expect(b.needsMigration, key).toBeUndefined();
      if (a.needsMigration) {
        // An empty v4 file on YAML (finance, bob, …): Convert made it an empty diagram, which compares clean.
        expect(a.fixes, key).toEqual([]);
        expect(b, key).toMatchObject({ clean: true, fixes: [] });
        continue;
      }
      expect(normalise(b), key).toEqual(normalise(a));
      compared.push(key);
    }
    // The diagrams with tables are compared in full.
    expect(compared).toEqual(expect.arrayContaining(['silver/showcase', 'silver/scroll-test']));
  });

  it('every fix on DBML names a .dbml file in the right layer', async () => {
    const { result } = await diffAll(DBML);
    const fixes = result.domains.flatMap((d) => d.fixes.map((f) => ({ d, f })));
    expect(fixes.length).toBeGreaterThan(0);
    const kinds = new Set<string>();
    for (const { d, f } of fixes) {
      kinds.add(f.kind);
      if (f.kind === 'resolve-phantom') continue;
      expect(f.file, `${f.kind} ${f.model}`).toMatch(/\.dbml$/);
      expect(fs.existsSync(path.join(DBML, f.file)), f.file).toBe(true);
      const tableFile = tableFilePath(DBML, 'dbml', f.model);
      const tableLayer = tableFile ? rel(DBML, tableFile).split('/')[1] : undefined;
      if (f.kind === 'import-relationships-file') {
        // The diagram itself, to import the file that already holds the Ref.
        expect(f.file).toBe(d.file);
        expect(f.storedIn).toMatch(/^\.erd-studio\/[^/]+\/relationships\/[^/]+\.dbml$/);
      } else if (f.relationship) {
        // The relationships file in the foreign-key table's layer (where a new Ref goes, or the one holding it).
        expect(f.file, `${f.kind} ${f.model}`).toMatch(new RegExp(`^\\.erd-studio/${tableLayer}/relationships/[^/]+\\.dbml$`));
      } else {
        // The table's own file: <layer>/tables/<schema>/<table>.dbml.
        expect(f.file, `${f.kind} ${f.model}.${f.column ?? ''}`).toBe(rel(DBML, tableFile!));
        expect(f.file).toMatch(/^\.erd-studio\/[^/]+\/tables\/[^/]+\/[^/]+\.dbml$/);
      }
    }
    // The fixture exercises table and relationship fixes alike.
    expect([...kinds]).toEqual(expect.arrayContaining(['set-type', 'remove-relationship']));
  });

  it('the plan names each table\'s .dbml file and its layer\'s relationships file', async () => {
    const { byKey } = await diffAll(DBML);
    const plan = byKey.get('silver/showcase')!.plan!;
    expect(Object.keys(plan.modelContext).length).toBeGreaterThan(0);
    for (const [name, ctx] of Object.entries(plan.modelContext)) {
      expect(ctx.logicalModelPath, name).toBe(rel(DBML, tableFilePath(DBML, 'dbml', name)!));
      expect(ctx.relationshipsPath, name).toBe('.erd-studio/silver/relationships/silver.dbml');
    }
    for (const r of plan.relationships) {
      if (r.storedIn) expect(fs.existsSync(path.join(DBML, r.storedIn)), r.storedIn).toBe(true);
    }
  });

  it('the human output is the same on both, after mapping paths', async () => {
    const human = async (root: string, map: (s: string) => string): Promise<string> => map((await cli(['diff', '--all'], root)).out);
    const yamlOut = await human(YAML, (s) => s);
    const v4 = (await diffAll(YAML)).result.domains.filter((d) => d.needsMigration).map((d) => d.domain);
    // Each DBML file named in the output, back to its YAML counterpart (table files by name).
    const tableYml = (name: string): string => rel(YAML, tableFilePath(YAML, 'yaml', name)!);
    const dbmlOut = await human(DBML, (s) => s
      .replace(/\.erd-studio\/([^/\s]+)\/diagrams\/([^/\s]+)\.dbml/g, '.erd-studio/$1/$2.json')
      .replace(/\.erd-studio\/[^/\s]+\/tables\/[^/\s]+\/([^/\s]+)\.dbml/g, (_m, name: string) => tableYml(name)));
    const lines = (s: string): string[] => s.split('\n')
      // Where a relationship is stored differs by design (a table yml or the domain JSON vs a relationships file).
      .filter((l) => !/relationships\/[^/\s]+\.dbml/.test(l))
      // An empty v4 file: to migrate on YAML, an empty (clean) diagram on DBML.
      .filter((l) => !v4.some((name) => l.startsWith(`${name} (`) || l.includes(`/${name}.json`)));
    expect(lines(dbmlOut).filter((l) => /\S/.test(l))).toEqual(lines(yamlOut).filter((l) => /\S/.test(l)));
    expect(dbmlOut).toMatch(/^showcase \(silver\) — \d+ differences to fix, \d+ advisory/m);
  });

  it('--domain takes a .dbml diagram from the project root, from a subfolder, or as an absolute path', async () => {
    const want = '.erd-studio/silver/diagrams/showcase.dbml';
    const yaml = JSON.parse((await cli(['diff', '--json', '--domain', '.erd-studio/silver/showcase.json'], YAML)).out) as DiffResult;
    for (const [arg, cwd] of [
      [want, DBML],
      ['showcase.dbml', path.join(DBML, '.erd-studio', 'silver', 'diagrams')],
      [path.join(DBML, ...want.split('/')), path.join(DBML, 'models')],
    ] as Array<[string, string]>) {
      const r = await cli(['diff', '--json', '--domain', arg], cwd);
      expect(r.code, arg).toBe(1);
      const result = JSON.parse(r.out) as DiffResult;
      expect(result.domains.map((d) => d.file), arg).toEqual([want]);
      expect(normalise(result.domains[0]), arg).toEqual(normalise(yaml.domains[0]));
    }
  });

  it('every plan names a dbt SQL file only when it is on disk, on both storages', async () => {
    for (const root of [YAML, DBML]) {
      const { byKey } = await diffAll(root);
      const showcase = byKey.get('silver/showcase')!.plan!.modelContext;
      // A yml-only model (the dev-host dim_customer) has no SQL file to edit: null, not a guessed name.
      expect(showcase.dim_customer, root).toMatchObject({ dbtSqlPath: null, dbtSchemaPath: 'models/silver/dim_customer.yml' });
      expect(showcase.dim_project?.dbtSqlPath, root).toBe('models/silver/dim_project.sql');
      let named = 0;
      for (const d of byKey.values()) {
        for (const [name, c] of Object.entries(d.plan?.modelContext ?? {})) {
          if (c.dbtSqlPath === null) continue;
          named++;
          expect(fs.existsSync(path.join(root, c.dbtSqlPath)), `${d.file} ${name}: ${c.dbtSqlPath}`).toBe(true);
        }
      }
      expect(named, root).toBeGreaterThan(0);
    }
  });

  it('--domain on a .dbml table file or relationships file is refused, not compared', async () => {
    for (const arg of ['.erd-studio/silver/tables/silver/dim_customer.dbml', '.erd-studio/silver/relationships/silver.dbml']) {
      const r = await cli(['diff', '--json', '--domain', arg], DBML);
      expect(r.code, arg).toBe(3);
      expect(JSON.parse(r.out).error.code, arg).toBe('not-a-diagram');
    }
  });
});
