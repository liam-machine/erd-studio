import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIAGRAM_EXPORT_FORMATS, readDbdiagramLayout } from '@erd-studio/core';

import { CLI_EXPORT_FORMATS, CliUsageError, parseArgs, USAGE, type CliExportFormat } from '../../src/cli/args';
import { buildCliContext } from '../../src/cli/context';
import { runExport, runExportAll, type ExportAllResult, type ExportResult } from '../../src/cli/export';
import { main } from '../../src/cli/index';
import { exportSubjectAreaFile, exportSubjectAreaFiles } from '../../src/services/diagramExport';
import { dbtKeyIndexOf } from '../../src/services/stageDisplay';
import { goldenFileName } from '../../packages/core/test/exportParsers';

const ROOT = path.resolve(__dirname, '../..');
const PROJECT = path.join(ROOT, 'test/fixtures/dbt-project');
const SHOWCASE = '.erd-studio/silver/showcase.json';
const CORE_FIXTURES = path.join(ROOT, 'packages/core/test/fixtures');

/** The core golden cases (packages/core/test/unit/exportDiagram.golden.test.ts). */
const CORE_CASES: Record<string, string> = {
  showcase: '.erd-studio/silver/showcase.json',
  'v4-inline': '.erd-studio/bronze/orders.json',
  'missing-model': '.erd-studio/silver/partial.json',
  'no-layers': '.erd-studio/gold/accounts.json',
  'missing-positions': '.erd-studio/silver/showcase.json',
  'library-relationships': '.erd-studio/gold/sales.json',
  'v4-nameless-column': '.erd-studio/silver/orders.json',
  'composite-and-self': '.erd-studio/gold/vault.json',
  'data-type-alias': '.erd-studio/silver/orders.json',
  'domain-one-to-many': '.erd-studio/gold/sales.json',
  'duplicate-key': '.erd-studio/silver/orders.json',
};

/** The core golden a CLI format prints. */
const goldenOf = (fixture: string, format: CliExportFormat): string =>
  format === 'dbml-layout' ? `${fixture}.dbdiagram` : goldenFileName(fixture, format);

/** The first line each format prints. */
const FIRST_LINE: Record<CliExportFormat, string> = {
  mermaid: 'erDiagram\n%% erd-studio mermaid-export v1\n',
  dbml: '// erd-studio dbml-export v1\n',
  'dbml-rich': '// erd-studio dbml-export v2 (DBML 9.1+)\n',
  'dbml-layout': '{\n  "version": "3.0.0",\n',
};

const FORMATS = 'mermaid\\|dbml\\|dbml-rich\\|dbml-layout';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-export-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function run(argv: string[], cwd: string = PROJECT): Promise<{ code: number; out: string; err: string }> {
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

/** A dbt project (no manifest) holding a copy of a core fixture's `.erd-studio/`. */
function projectFromCoreFixture(name: string): string {
  const root = path.join(tmp, name);
  fs.cpSync(path.join(CORE_FIXTURES, name), root, { recursive: true });
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: fixture\nversion: "1.0.0"\n');
  return root;
}

/** Every file under `dir`, with its bytes — to prove the CLI wrote nothing. */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); } else { files.set(path.relative(dir, p), fs.readFileSync(p, 'utf-8')); }
    }
  };
  walk(dir);
  return files;
}

describe('parseArgs — export', () => {
  it('parses --domain and --format in either value form and either order', () => {
    expect(parseArgs(['export', '--domain', 'a.json', '--format', 'dbml'])).toMatchObject({ command: 'export', domains: ['a.json'], format: 'dbml' });
    expect(parseArgs(['--format=mermaid', 'export', '--domain=a.json', '--json'])).toMatchObject({ command: 'export', domains: ['a.json'], format: 'mermaid', json: true });
  });

  it('accepts the format in any case', () => {
    expect(parseArgs(['export', '--domain', 'a.json', '--format', 'DBML']).format).toBe('dbml');
    expect(parseArgs(['export', '--domain', 'a.json', '--format', 'DBML-Rich']).format).toBe('dbml-rich');
  });

  it('takes every diagram format plus dbml-layout', () => {
    expect(CLI_EXPORT_FORMATS).toEqual([...DIAGRAM_EXPORT_FORMATS, 'dbml-layout']);
    for (const format of CLI_EXPORT_FORMATS) {
      expect(parseArgs(['export', '--domain', 'a.json', '--format', format]).format).toBe(format);
    }
  });

  it('takes --all in place of --domain', () => {
    expect(parseArgs(['export', '--all', '--format', 'dbml-rich'])).toMatchObject({ command: 'export', all: true, domains: [], format: 'dbml-rich' });
    expect(parseArgs(['--all', 'export', '--format=mermaid', '--json'])).toMatchObject({ all: true, format: 'mermaid', json: true });
  });

  it.each([
    [['export', '--format', 'dbml'], new RegExp(`export needs --domain <path> \\(or --all\\) and --format ${FORMATS}`)],
    [['export', '--domain', 'a.json'], new RegExp(`export needs --format ${FORMATS}`)],
    [['export', '--all'], new RegExp(`export needs --format ${FORMATS}`)],
    [['export', '--domain', 'a.json', '--format', 'svg'], new RegExp(`Unknown --format "svg"\\. Expected one of: ${FORMATS}\\.`)],
    [['export', '--domain', 'a.json', '--format'], /--format needs a value/],
    [['export', '--domain', 'a.json', '--domain', 'b.json', '--format', 'dbml'], /export takes one --domain/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--format', 'mermaid'], /Use --format once/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--all'], /Use either --domain or --all, not both/],
    [['export', '--all', '--format', 'dbml', '--domain', 'a.json', '--domain', 'b.json'], /Use either --domain or --all, not both/],
    [['export', '--all=yes', '--format', 'dbml'], /--all does not take a value/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--strict'], /--strict is not an option of "export"/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--out', 'x.dbml'], /Unknown option --out/],
    [['diff', '--domain', 'a.json', '--format', 'dbml'], /--format is not an option of "diff"/],
    [['inventory', '--format', 'dbml'], /--format is not an option of "inventory"/],
  ])('%j is a usage error', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(CliUsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('the usage text lists the subcommand, its formats and --all', () => {
    expect(USAGE).toContain('erd-studio export    [--json] (--domain <path> | --all) --format mermaid|dbml|dbml-rich|dbml-layout');
    expect(USAGE).toMatch(/dbml-rich +DBML for dbdiagram\.io/);
    expect(USAGE).toMatch(/dbml-layout +the table positions for dbml-rich, as dbdiagram's \.dbdiagram file/);
    expect(USAGE).toMatch(/--all +every subject area, as a JSON list of \{ fileName, content \}/);
    expect(USAGE).not.toContain('--out');
    expect(() => parseArgs(['exprt'])).toThrow(/doctor, inventory, diff, export, version/);
  });
});

describe('export', () => {
  it.each(CLI_EXPORT_FORMATS)('prints exactly the %s text exportSubjectAreaFile builds, and nothing else', async (format) => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const expected = await exportSubjectAreaFile(ctx.subjectAreaService, path.join(PROJECT, SHOWCASE), format === 'dbml-layout' ? 'dbml-rich' : format, {
      dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest),
      layers: ctx.layerService,
    });

    const { code, out, err } = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', format]);
    expect(code).toBe(0);
    expect(out).toBe(format === 'dbml-layout' ? expected.layout!.content : expected.content);
    expect(err).toBe('');
    expect(out.startsWith(FIRST_LINE[format])).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('dbml-rich names the layout file dbml-layout prints, by the same base', async () => {
    const rich = JSON.parse((await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml-rich', '--json'])).out) as ExportResult;
    const layout = JSON.parse((await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml-layout', '--json'])).out) as ExportResult;
    expect(rich).toMatchObject({ format: 'dbml-rich', fileName: 'showcase.dbml' });
    expect(layout).toMatchObject({ format: 'dbml-layout', fileName: 'showcase.dbdiagram', domain: SHOWCASE });
    expect(rich.content).toContain('// Table positions: showcase.dbdiagram, next to this file');
    const read = readDbdiagramLayout(layout.content);
    expect(read.problems).toEqual([]);
    expect(read.tables.length).toBeGreaterThan(0);
  });

  it('--json prints { cliVersion, domain, format, fileName, content }', async () => {
    const human = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'mermaid']);
    const { code, out } = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'mermaid', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(out) as ExportResult;
    expect(Object.keys(json)).toEqual(['cliVersion', 'domain', 'format', 'fileName', 'content']);
    expect(json).toMatchObject({ domain: SHOWCASE, format: 'mermaid', fileName: 'showcase.mmd' });
    expect(typeof json.cliVersion).toBe('string');
    expect(json.content).toBe(human.out);
    expect(out).not.toContain(PROJECT);
  });

  it('resolves --domain from the cwd as well as the project root, and reports it project-relative', async () => {
    const fromSilver = path.join(PROJECT, '.erd-studio/silver');
    const { code, out } = await run(['export', '--project', PROJECT, '--domain', 'showcase.json', '--format', 'dbml', '--json'], fromSilver);
    expect(code).toBe(0);
    expect((JSON.parse(out) as ExportResult).domain).toBe(SHOWCASE);

    const abs = await run(['export', '--project', PROJECT, '--domain', path.join(PROJECT, SHOWCASE), '--format', 'dbml', '--json']);
    expect((JSON.parse(abs.out) as ExportResult).domain).toBe(SHOWCASE);
  });

  it('--quiet prints nothing and still exits 0', async () => {
    const { code, out, err } = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml', '--quiet']);
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(err).toBe('');
  });

  it('is deterministic', async () => {
    const a = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml']);
    const b = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml']);
    expect(a.out).toBe(b.out);
  });

  it('writes nothing to the project', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    const before = snapshotTree(root);
    for (const format of CLI_EXPORT_FORMATS) {
      expect((await run(['export', '--project', root, '--domain', SHOWCASE, '--format', format])).code).toBe(0);
      expect((await run(['export', '--project', root, '--domain', SHOWCASE, '--format', format, '--json'])).code).toBe(0);
      expect((await run(['export', '--project', root, '--all', '--format', format])).code).toBe(0);
      expect((await run(['export', '--project', root, '--all', '--format', format, '--json'])).code).toBe(0);
    }
    expect(snapshotTree(root)).toEqual(before);
  });

  describe.each(Object.entries(CORE_CASES))('core fixture %s', (name, domainPath) => {
    it.each(CLI_EXPORT_FORMATS)('prints the core %s golden byte for byte', async (format: CliExportFormat) => {
      const root = projectFromCoreFixture(name);
      const { code, out, err } = await run(['export', '--domain', domainPath, '--format', format], root);
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(out).toBe(fs.readFileSync(path.join(CORE_FIXTURES, 'golden', goldenOf(name, format)), 'utf-8'));
    });
  });
});

describe('export — errors (the same codes as diff --domain)', () => {
  async function both(argv: string[], cwd?: string): Promise<{ exportJson: { code: number; json: { error: { code: string; message: string } } }; diffJson: { error: { code: string; message: string } } }> {
    const e = await run(['export', ...argv, '--format', 'dbml', '--json'], cwd);
    const d = await run(['diff', ...argv, '--json'], cwd);
    expect(d.code).toBe(3);
    return { exportJson: { code: e.code, json: JSON.parse(e.out) }, diffJson: JSON.parse(d.out) };
  }

  it('a missing domain file is exit 3 domain-missing', async () => {
    const { exportJson, diffJson } = await both(['--project', PROJECT, '--domain', 'nope.json']);
    expect(exportJson.code).toBe(3);
    expect(exportJson.json.error).toEqual({ code: 'domain-missing', message: 'Subject area file not found: nope.json' });
    expect(exportJson.json.error).toEqual(diffJson.error);
    expect(Object.keys(exportJson.json)).toEqual(['cliVersion', 'error']);
  });

  it('a template (no schemaVersion) is exit 3 unsupported-format', async () => {
    const { exportJson, diffJson } = await both(['--project', PROJECT, '--domain', '.erd-studio/templates/blank.json']);
    expect(exportJson.code).toBe(3);
    expect(exportJson.json.error.code).toBe('unsupported-format');
    expect(exportJson.json.error).toEqual(diffJson.error);
  });

  it('malformed JSON is exit 3 domain-invalid, with a project-relative path', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio/silver/broken.json'), '{ not json');
    const { exportJson, diffJson } = await both(['--project', root, '--domain', '.erd-studio/silver/broken.json']);
    expect(exportJson.code).toBe(3);
    expect(exportJson.json.error.code).toBe('domain-invalid');
    expect(exportJson.json.error).toEqual(diffJson.error);
    expect(exportJson.json.error.message).not.toContain(root);
  });

  it('an unknown layer is exit 3 unknown-layer', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    const domain = JSON.parse(fs.readFileSync(path.join(root, SHOWCASE), 'utf-8')) as Record<string, unknown>;
    fs.mkdirSync(path.join(root, '.erd-studio/platinum'));
    fs.writeFileSync(path.join(root, '.erd-studio/platinum/showcase.json'), JSON.stringify({ ...domain, layer: 'platinum' }));
    const { exportJson, diffJson } = await both(['--project', root, '--domain', '.erd-studio/platinum/showcase.json']);
    expect(exportJson.code).toBe(3);
    expect(exportJson.json.error.code).toBe(diffJson.error.code);
    expect(exportJson.json.error).toEqual(diffJson.error);
  });

  it('no dbt project is exit 3 no-project', async () => {
    const { code, out } = await run(['export', '--domain', 'x.json', '--format', 'dbml', '--json'], tmp);
    expect(code).toBe(3);
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('no-project');
  });

  it('a usage error is exit 2 with the usage JSON and nothing else on stdout', async () => {
    const { code, out, err } = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'svg', '--json']);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'usage', message: 'Unknown --format "svg". Expected one of: mermaid|dbml|dbml-rich|dbml-layout.' },
    });
    expect(err).toContain('erd-studio export');

    const human = await run(['export', '--project', PROJECT, '--domain', SHOWCASE]);
    expect(human.code).toBe(2);
    expect(human.out).toBe('');
    expect(human.err).toContain('export needs --format mermaid|dbml|dbml-rich|dbml-layout');
  });

  it('runExport throws a CliEnvError (never a raw error) for a bad file', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    await expect(runExport(ctx, { domain: '.erd-studio/templates/blank.json', format: 'dbml' })).rejects.toMatchObject({
      name: 'CliEnvError',
      code: 'unsupported-format',
    });
  });
});

describe('export --all', () => {
  /** A copy of the dbt fixture with a second `showcase` in gold. */
  function projectWithClash(): string {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    const domain = JSON.parse(fs.readFileSync(path.join(root, SHOWCASE), 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(root, '.erd-studio/gold/showcase.json'), JSON.stringify({ ...domain, layer: 'gold' }));
    return root;
  }

  it('prints a JSON list of { fileName, content }, one per subject area, the same files exportSubjectAreaFiles gives', async () => {
    const { code, out, err } = await run(['export', '--project', PROJECT, '--all', '--format', 'dbml']);
    expect(code).toBe(0);
    expect(err).toBe('');
    const list = JSON.parse(out) as Array<{ fileName: string; content: string }>;
    expect(list.every((f) => Object.keys(f).join() === 'fileName,content')).toBe(true);

    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const summaries = ctx.subjectAreaService.listSubjectAreas(ctx.root, ctx.semanticDir);
    const expected = await exportSubjectAreaFiles(ctx.subjectAreaService, summaries.map((s) => s.filePath), 'dbml', {
      dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest),
      layers: ctx.layerService,
    });
    expect(list).toEqual(expected.files.map(({ fileName, content }) => ({ fileName, content })));
    expect(list).toHaveLength(summaries.length);
    expect(list.map((f) => f.fileName)).toContain('showcase.dbml');
    expect(list.find((f) => f.fileName === 'showcase.dbml')!.content)
      .toBe((await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml'])).out);
  });

  it('with dbml-rich, each .dbml is followed by its .dbdiagram', async () => {
    const { code, out } = await run(['export', '--project', PROJECT, '--all', '--format', 'dbml-rich']);
    expect(code).toBe(0);
    const list = JSON.parse(out) as Array<{ fileName: string; content: string }>;
    expect(list.length % 2).toBe(0);
    for (let i = 0; i < list.length; i += 2) {
      const base = list[i].fileName.replace(/\.dbml$/, '');
      expect(list[i].fileName).toMatch(/\.dbml$/);
      expect(list[i + 1].fileName).toBe(`${base}.dbdiagram`);
      expect(list[i].content).toContain(`// Table positions: ${base}.dbdiagram,`);
      expect(readDbdiagramLayout(list[i + 1].content).problems).toEqual([]);
    }
    const single = (await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml-rich'])).out;
    expect(list.find((f) => f.fileName === 'showcase.dbml')!.content).toBe(single);
  });

  it('with dbml-layout, lists only the .dbdiagram files', async () => {
    const { code, out } = await run(['export', '--project', PROJECT, '--all', '--format', 'dbml-layout']);
    expect(code).toBe(0);
    const list = JSON.parse(out) as Array<{ fileName: string; content: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((f) => f.fileName.endsWith('.dbdiagram'))).toBe(true);
    expect(list.find((f) => f.fileName === 'showcase.dbdiagram')!.content)
      .toBe((await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', 'dbml-layout'])).out);
  });

  it('two subject areas of the same name in two layers become <layer>-<name>', async () => {
    const root = projectWithClash();
    const list = JSON.parse((await run(['export', '--project', root, '--all', '--format', 'dbml-rich'])).out) as Array<{ fileName: string }>;
    const names = list.map((f) => f.fileName);
    expect(names).toContain('gold-showcase.dbml');
    expect(names).toContain('gold-showcase.dbdiagram');
    expect(names).toContain('silver-showcase.dbml');
    expect(names).toContain('silver-showcase.dbdiagram');
    expect(names).not.toContain('showcase.dbml');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('--json prints { cliVersion, format, files: [{ domain, fileName, content }], skipped }, project-relative', async () => {
    const human = JSON.parse((await run(['export', '--project', PROJECT, '--all', '--format', 'mermaid'])).out) as Array<{ fileName: string; content: string }>;
    const { code, out } = await run(['export', '--project', PROJECT, '--all', '--format', 'mermaid', '--json']);
    expect(code).toBe(0);
    const json = JSON.parse(out) as ExportAllResult;
    expect(Object.keys(json)).toEqual(['cliVersion', 'format', 'files', 'skipped']);
    expect(json.format).toBe('mermaid');
    expect(json.skipped).toEqual([]);
    expect(json.files.map(({ fileName, content }) => ({ fileName, content }))).toEqual(human);
    expect(json.files.find((f) => f.fileName === 'showcase.mmd')!.domain).toBe(SHOWCASE);
    expect(out).not.toContain(PROJECT);
  });

  it('a subject area that cannot be read is skipped and reported, not fatal, and exits 1', async () => {
    const root = path.join(tmp, 'dbt-project');
    fs.cpSync(PROJECT, root, { recursive: true });
    fs.writeFileSync(path.join(root, '.erd-studio/silver/broken.json'), '{ not json');

    const human = await run(['export', '--project', root, '--all', '--format', 'dbml']);
    expect(human.code).toBe(1);
    const list = JSON.parse(human.out) as Array<{ fileName: string }>;
    expect(list.map((f) => f.fileName)).toContain('showcase.dbml');
    expect(list.map((f) => f.fileName)).not.toContain('broken.dbml');
    expect(human.err).toMatch(/^erd-studio: skipped \.erd-studio\/silver\/broken\.json: /);
    expect(human.err).not.toContain(root);

    const json = await run(['export', '--project', root, '--all', '--format', 'dbml', '--json']);
    expect(json.code).toBe(1);
    expect(json.err).toBe('');
    const result = JSON.parse(json.out) as ExportAllResult;
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].domain).toBe('.erd-studio/silver/broken.json');
    expect(result.skipped[0].error.code).toBe('domain-invalid');

    const quiet = await run(['export', '--project', root, '--all', '--format', 'dbml', '--quiet']);
    expect(quiet).toEqual({ code: 1, out: '', err: '' });
  });

  it('no semantic dir or no subject areas is exit 3, as diff --all', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, 'dbt_project.yml'), 'name: x\nversion: "1.0.0"\n');
    const none = await run(['export', '--project', empty, '--all', '--format', 'dbml', '--json']);
    expect(none.code).toBe(3);
    expect((JSON.parse(none.out) as { error: { code: string } }).error.code).toBe('no-semantic-dir');

    fs.mkdirSync(path.join(empty, '.erd-studio'));
    const zero = await run(['export', '--project', empty, '--all', '--format', 'dbml', '--json']);
    expect(zero.code).toBe(3);
    expect((JSON.parse(zero.out) as { error: { code: string } }).error.code).toBe('no-domains');
  });

  it('runExportAll is deterministic', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    expect(await runExportAll(ctx, { format: 'dbml-rich' })).toEqual(await runExportAll(ctx, { format: 'dbml-rich' }));
  });
});

describe('export on native DBML storage (§7.1, S4)', () => {
  const NATIVE = path.join(ROOT, 'test/fixtures/dbml-native');

  it.each(CLI_EXPORT_FORMATS)('--domain a .dbml diagram exports it as %s', async (format) => {
    const r = await run(['export', '--project', NATIVE, '--domain', '.erd-studio/gold/sales.dbml', '--format', format], NATIVE);
    expect(r.code).toBe(0);
    expect(r.out.startsWith(FIRST_LINE[format])).toBe(true);
    if (format !== 'dbml-layout') expect(r.out).toContain('fct_order');
  });

  it('--all exports every DBML diagram, skipping none', async () => {
    const r = await run(['export', '--project', NATIVE, '--all', '--format', 'dbml', '--json'], NATIVE);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as ExportAllResult;
    expect(result.files.map((f) => [f.domain, f.fileName])).toEqual([
      ['.erd-studio/gold/sales.dbml', 'sales.dbml'],
      ['.erd-studio/silver/staging.dbml', 'staging.dbml'],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('--domain a table file is not-a-diagram (exit 3)', async () => {
    const r = await run(['export', '--project', NATIVE, '--domain', '.erd-studio/tables/gold/fct_order.dbml', '--format', 'dbml', '--json'], NATIVE);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe('not-a-diagram');
  });
});
