import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError, parseArgs, USAGE } from '../../src/cli/args';
import type { ChangesResult } from '../../src/cli/changes';
import { main } from '../../src/cli/index';

/**
 * `erd-studio changes` end to end, over temporary git repositories made
 * here: commit a base model, change the working tree, run the CLI.
 */

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-changes-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
}

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
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

const DIM_CUSTOMER = `Table gold.dim_customer [role: 'conformed-dim', grain: 'One row per customer'] {
  customer_key BIGINT [pk]
  customer_id STRING
}
`;
const FCT_ORDER = `Table gold.fct_order [role: 'transaction-fact', grain: 'One row per order'] {
  order_id STRING [pk]
  customer_key BIGINT [foreign_key: 'true']
  amount "DECIMAL(10,2)"
}
`;
const REFS = `use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use { table gold.fct_order } from '../tables/gold/fct_order.dbml'

Ref: gold.fct_order.customer_key > gold.dim_customer.customer_key
`;
const DIAGRAM = `use { table gold.fct_order } from '../tables/gold/fct_order.dbml'
use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../relationships/gold.dbml'

Project sales {
  erd_schema_version: '7'
}
`;

/** A logical-only project in a fresh repo, with the base model committed. Returns the project folder. */
function repoWithBase(sub = ''): string {
  git(tmp, 'init', '-q');
  const project = sub ? path.join(tmp, sub) : tmp;
  write(project, '.erd-studio/layers.json', '{"layers":[{"id":"gold","label":"Gold"}]}\n');
  write(project, '.erd-studio/gold/tables/gold/dim_customer.dbml', DIM_CUSTOMER);
  write(project, '.erd-studio/gold/tables/gold/fct_order.dbml', FCT_ORDER);
  write(project, '.erd-studio/gold/relationships/gold.dbml', REFS);
  write(project, '.erd-studio/gold/diagrams/sales.dbml', DIAGRAM);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'base');
  return project;
}

/** The working-tree edits every case below compares. */
function changeModel(project: string): void {
  write(project, '.erd-studio/gold/tables/gold/fct_order.dbml', FCT_ORDER
    .replace("grain: 'One row per order'", "grain: 'One row per order line'")
    .replace('"DECIMAL(10,2)"', '"DECIMAL(12,2)"')
    .replace('}\n', '  quantity INT\n}\n'));
  write(project, '.erd-studio/gold/tables/gold/dim_date.dbml', 'Table gold.dim_date {\n  date_key INT [pk]\n}\n');
  write(project, '.erd-studio/gold/relationships/gold.dbml', REFS.replace(
    "use { table gold.fct_order }",
    "use { table gold.dim_date } from '../tables/gold/dim_date.dbml'\nuse { table gold.fct_order }",
  ) + 'Ref: gold.fct_order.order_id > gold.dim_date.date_key\n');
  write(project, '.erd-studio/gold/diagrams/sales.dbml', DIAGRAM.replace(
    "use * from",
    "use { table gold.dim_date } from '../tables/gold/dim_date.dbml'\nuse * from",
  ));
  write(project, '.erd-studio/gold/diagrams/dates.dbml', "use { table gold.dim_date } from '../tables/gold/dim_date.dbml'\n");
}

describe('erd-studio changes --json', () => {
  it('reports no changes against the commit the working tree matches', async () => {
    const project = repoWithBase();
    const { code, out } = await run(['changes', '--base', 'HEAD', '--json'], project);
    expect(code).toBe(0);
    const result = JSON.parse(out) as ChangesResult;
    expect(result.changed).toBe(false);
    expect(result.base.ref).toBe('HEAD');
    expect(result.base.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.head).toBe('working-tree');
    expect(result.dbtProject).toBe(false);
    expect(Object.values(result.summary).every((n) => n === 0)).toBe(true);
  });

  it('has the documented shape, with project-relative paths', async () => {
    const project = repoWithBase();
    changeModel(project);
    const { code, out } = await run(['changes', '--base', 'HEAD', '--json'], project);
    expect(code).toBe(0);
    const result = JSON.parse(out) as ChangesResult;
    expect(Object.keys(result)).toEqual([
      'cliVersion', 'projectRoot', 'semanticDir', 'dbtProject', 'base', 'head', 'changed', 'summary',
      'tables', 'relationships', 'diagrams', 'relationshipsFiles', 'problems',
    ]);
    expect(result.projectRoot).toBe(project);
    expect(result.changed).toBe(true);
    expect(result.summary).toEqual({
      tablesAdded: 1, tablesRemoved: 0, tablesRenamed: 0, tablesMoved: 0, tablesChanged: 1,
      relationshipsAdded: 1, relationshipsRemoved: 0, relationshipsChanged: 0,
      diagramsAdded: 1, diagramsRemoved: 0, diagramsChanged: 1, relationshipsFilesChanged: 1,
    });
    expect(result.tables.added).toEqual([{ name: 'dim_date', file: '.erd-studio/gold/tables/gold/dim_date.dbml', layer: 'gold', schema: 'gold' }]);
    expect(result.tables.changed).toEqual([{
      name: 'fct_order',
      file: '.erd-studio/gold/tables/gold/fct_order.dbml',
      columnsAdded: [{ name: 'quantity', dataType: 'INT' }],
      columnsRemoved: [],
      typesChanged: [{ column: 'amount', from: 'DECIMAL(10,2)', to: 'DECIMAL(12,2)' }],
      keysChanged: [],
      grain: { from: 'One row per order', to: 'One row per order line' },
    }]);
    expect(result.relationships.added).toEqual([{
      fromTable: 'fct_order', fromColumn: 'order_id', toTable: 'dim_date', toColumn: 'date_key',
      cardinality: 'many-to-one', file: '.erd-studio/gold/relationships/gold.dbml',
    }]);
    expect(result.diagrams.added).toEqual([{ name: 'dates', layer: 'gold', file: '.erd-studio/gold/diagrams/dates.dbml', tables: ['dim_date'] }]);
    expect(result.diagrams.changed).toEqual([{
      name: 'sales', layer: 'gold', file: '.erd-studio/gold/diagrams/sales.dbml', tablesAdded: ['dim_date'], tablesRemoved: [],
    }]);
    expect(result.relationshipsFiles).toEqual([
      { file: '.erd-studio/gold/relationships/gold.dbml', status: 'changed', refsAdded: 1, refsRemoved: 0, refsChanged: 0 },
    ]);
    expect(result.problems).toEqual([]);
  });

  it('works on a project in a subfolder of the repository, with --project', async () => {
    const project = repoWithBase('design/model');
    fs.rmSync(path.join(project, '.erd-studio/gold/diagrams/sales.dbml'));
    const { code, out } = await run(['changes', '--project', 'design/model', '--base', 'HEAD', '--json'], tmp);
    expect(code).toBe(0);
    const result = JSON.parse(out) as ChangesResult;
    expect(result.diagrams.removed.map((d) => d.file)).toEqual(['.erd-studio/gold/diagrams/sales.dbml']);
  });

  it('reads the base from git and writes nothing: the working tree and index are left as they were', async () => {
    const project = repoWithBase();
    changeModel(project);
    const before = git(tmp, 'status', '--porcelain');
    await run(['changes', '--base', 'HEAD', '--json'], project);
    expect(git(tmp, 'status', '--porcelain')).toBe(before);
  });

  it('treats a model that is new since the ref as all added', async () => {
    git(tmp, 'init', '-q');
    write(tmp, 'README.md', 'hello\n');
    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-q', '-m', 'empty');
    write(tmp, '.erd-studio/gold/tables/gold/dim_customer.dbml', DIM_CUSTOMER);
    const { code, out } = await run(['changes', '--base', 'HEAD', '--json'], tmp);
    expect(code).toBe(0);
    expect((JSON.parse(out) as ChangesResult).tables.added.map((t) => t.name)).toEqual(['dim_customer']);
  });

  it('is exit 3 with unknown-ref for a ref git does not know', async () => {
    const project = repoWithBase();
    const { code, out } = await run(['changes', '--base', 'no-such-branch', '--json'], project);
    expect(code).toBe(3);
    expect(JSON.parse(out).error.code).toBe('unknown-ref');
  });

  it('is exit 3 with not-a-git-repo outside git', async () => {
    write(tmp, '.erd-studio/gold/tables/gold/dim_customer.dbml', DIM_CUSTOMER);
    const { code, out } = await run(['changes', '--base', 'HEAD', '--json'], tmp);
    expect(code).toBe(3);
    const code_ = JSON.parse(out).error.code;
    // A temp folder can sit inside a repository on some machines; then the ref is what git cannot find.
    expect(['not-a-git-repo', 'unknown-ref']).toContain(code_);
  });
});

describe('erd-studio changes, human output', () => {
  it('prints Markdown for a pull-request comment', async () => {
    const project = repoWithBase();
    changeModel(project);
    const { code, out } = await run(['changes', '--base', 'HEAD', '--format', 'markdown'], project);
    expect(code).toBe(0);
    const short = git(tmp, 'rev-parse', '--short=7', 'HEAD').trim();
    expect(out).toBe([
      '### ERD Studio model changes',
      '',
      `Compared with \`HEAD\` (${short}). tables: 1 added, 1 changed · relationships: 1 added · diagrams: 1 added, 1 changed`,
      '',
      '**Tables added**',
      '',
      '- `dim_date` (layer gold, schema gold) in `.erd-studio/gold/tables/gold/dim_date.dbml`',
      '',
      '**Tables changed**',
      '',
      '- `fct_order`',
      '  - columns added: `quantity` (INT)',
      '  - types changed: `amount` DECIMAL(10,2) → DECIMAL(12,2)',
      '  - grain: "One row per order" → "One row per order line"',
      '',
      '**Relationships added**',
      '',
      '- `fct_order.order_id` → `dim_date.date_key` (many-to-one) in `.erd-studio/gold/relationships/gold.dbml`',
      '',
      '**Diagrams added**',
      '',
      '- `gold/dates` with 1 table',
      '',
      '**Diagrams changed**',
      '',
      '- `gold/sales`: added `dim_date`',
      '',
      '**Relationships files**',
      '',
      '- `.erd-studio/gold/relationships/gold.dbml`: 1 Ref added, 0 removed',
      '',
    ].join('\n'));
  });

  it('says so in Markdown when nothing changed', async () => {
    const project = repoWithBase();
    const { out } = await run(['changes', '--base', 'HEAD', '--format', 'markdown'], project);
    expect(out).toContain('No changes to tables, relationships or diagrams.');
    expect(out.startsWith('### ERD Studio model changes\n')).toBe(true);
  });

  it('prints plain text by default', async () => {
    const project = repoWithBase();
    changeModel(project);
    const { code, out } = await run(['changes', '--base', 'HEAD'], project);
    expect(code).toBe(0);
    expect(out).toMatch(/^ERD Studio model changes since HEAD \([0-9a-f]{7}\)\n/);
    expect(out).toContain('\nTables changed:\n  fct_order\n    columns added: quantity (INT)\n');
    expect(out).not.toContain('`');
  });

  it('--format json is --json', async () => {
    const project = repoWithBase();
    changeModel(project);
    const a = await run(['changes', '--base', 'HEAD', '--format', 'json'], project);
    const b = await run(['changes', '--base', 'HEAD', '--json'], project);
    expect(JSON.parse(a.out)).toEqual(JSON.parse(b.out));
  });
});

describe('changes arguments', () => {
  it('needs --base', () => {
    expect(() => parseArgs(['changes'])).toThrow(CliUsageError);
    expect(() => parseArgs(['changes'])).toThrow(/--base/);
  });

  it('refuses a --base that git would read as an option', () => {
    expect(() => parseArgs(['changes', '--base=-p'])).toThrow(/git branch, tag or commit/);
    expect(() => parseArgs(['changes', '--base', 'a b'])).toThrow(/git branch, tag or commit/);
  });

  it('takes text, markdown or json, and not with a different --json', () => {
    expect(parseArgs(['changes', '--base', 'main']).changesFormat).toBe('text');
    expect(parseArgs(['changes', '--base', 'main', '--format', 'Markdown']).changesFormat).toBe('markdown');
    expect(parseArgs(['changes', '--base', 'main', '--format', 'json']).json).toBe(true);
    expect(parseArgs(['changes', '--base', 'main', '--json']).changesFormat).toBe('json');
    expect(() => parseArgs(['changes', '--base', 'main', '--format', 'dbml'])).toThrow(/text\|markdown\|json/);
    expect(() => parseArgs(['changes', '--base', 'main', '--format', 'markdown', '--json'])).toThrow(/not both/);
  });

  it('keeps --base to changes and export formats to export', () => {
    expect(() => parseArgs(['diff', '--all', '--base', 'main'])).toThrow(/not an option of "diff"/);
    expect(() => parseArgs(['export', '--all', '--format', 'markdown'])).toThrow(/Unknown --format/);
  });

  it('has no --out and is in the usage text', () => {
    expect(() => parseArgs(['changes', '--base', 'main', '--out', 'x.md'])).toThrow(/Unknown option --out/);
    expect(USAGE).toContain('erd-studio changes   [--json] --base <git-ref> [--format text|markdown|json]');
  });
});
