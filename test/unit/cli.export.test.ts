import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIAGRAM_EXPORT_FILE_EXTENSIONS, DIAGRAM_EXPORT_FORMATS, type DiagramExportFormat } from '@erd-studio/core';

import { CliUsageError, parseArgs, USAGE } from '../../src/cli/args';
import { buildCliContext } from '../../src/cli/context';
import { runExport, type ExportResult } from '../../src/cli/export';
import { main } from '../../src/cli/index';
import { exportDomainFile } from '../../src/services/diagramExport';
import { dbtKeyIndexOf } from '../../src/services/stageDisplay';

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
};

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
  });

  it.each([
    [['export', '--format', 'dbml'], /export needs --domain <path> and --format mermaid\|dbml/],
    [['export', '--domain', 'a.json'], /export needs --format mermaid\|dbml/],
    [['export', '--domain', 'a.json', '--format', 'svg'], /Unknown --format "svg"\. Expected one of: mermaid\|dbml/],
    [['export', '--domain', 'a.json', '--format'], /--format needs a value/],
    [['export', '--domain', 'a.json', '--domain', 'b.json', '--format', 'dbml'], /export takes one --domain/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--format', 'mermaid'], /Use --format once/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--all'], /--all is not an option of "export"/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--strict'], /--strict is not an option of "export"/],
    [['export', '--domain', 'a.json', '--format', 'dbml', '--out', 'x.dbml'], /Unknown option --out/],
    [['diff', '--domain', 'a.json', '--format', 'dbml'], /--format is not an option of "diff"/],
    [['inventory', '--format', 'dbml'], /--format is not an option of "inventory"/],
  ])('%j is a usage error', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(CliUsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('the usage text lists the subcommand and its formats', () => {
    expect(USAGE).toContain('erd-studio export    [--json] --domain <path> --format mermaid|dbml');
    expect(() => parseArgs(['exprt'])).toThrow(/doctor, inventory, diff, export, version/);
  });
});

describe('export', () => {
  it.each(DIAGRAM_EXPORT_FORMATS)('prints exactly the %s text exportDomainFile builds, and nothing else', async (format) => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const expected = await exportDomainFile(ctx.domainService, path.join(PROJECT, SHOWCASE), format, {
      dbtKeyIndex: dbtKeyIndexOf(ctx.ymlData, ctx.manifest),
    });

    const { code, out, err } = await run(['export', '--project', PROJECT, '--domain', SHOWCASE, '--format', format]);
    expect(code).toBe(0);
    expect(out).toBe(expected.content);
    expect(err).toBe('');
    expect(out.startsWith(format === 'dbml' ? '// erd-studio dbml-export v1\n' : 'erDiagram\n%% erd-studio mermaid-export v1\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
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
    for (const format of DIAGRAM_EXPORT_FORMATS) {
      expect((await run(['export', '--project', root, '--domain', SHOWCASE, '--format', format])).code).toBe(0);
      expect((await run(['export', '--project', root, '--domain', SHOWCASE, '--format', format, '--json'])).code).toBe(0);
    }
    expect(snapshotTree(root)).toEqual(before);
  });

  describe.each(Object.entries(CORE_CASES))('core fixture %s', (name, domainPath) => {
    it.each(DIAGRAM_EXPORT_FORMATS)('prints the core %s golden byte for byte', async (format: DiagramExportFormat) => {
      const root = projectFromCoreFixture(name);
      const { code, out, err } = await run(['export', '--domain', domainPath, '--format', format], root);
      expect(err).toBe('');
      expect(code).toBe(0);
      const golden = path.join(CORE_FIXTURES, 'golden', `${name}.${DIAGRAM_EXPORT_FILE_EXTENSIONS[format]}`);
      expect(out).toBe(fs.readFileSync(golden, 'utf-8'));
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
    expect(exportJson.json.error).toEqual({ code: 'domain-missing', message: 'Domain file not found: nope.json' });
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
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'usage', message: 'Unknown --format "svg". Expected one of: mermaid|dbml.' } });
    expect(err).toContain('erd-studio export');

    const human = await run(['export', '--project', PROJECT, '--domain', SHOWCASE]);
    expect(human.code).toBe(2);
    expect(human.out).toBe('');
    expect(human.err).toContain('export needs --format mermaid|dbml');
  });

  it('runExport throws a CliEnvError (never a raw error) for a bad file', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    await expect(runExport(ctx, { domain: '.erd-studio/templates/blank.json', format: 'dbml' })).rejects.toMatchObject({
      name: 'CliEnvError',
      code: 'unsupported-format',
    });
  });
});
