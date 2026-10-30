/**
 * The in-process half of `scripts/e2e-dbml.mjs` (native DBML storage §7.6),
 * bundled by that script with esbuild (like `regen-fixtures.ts`: the harness
 * pulls in markdown as text). Three modes, each printing JSON on stdout:
 *
 *   convert <projectRoot>   Plan Convert Project to DBML (readDbmlConversionInput +
 *                           planDbmlConversion) and write it to disk as the command's
 *                           one edit would. Exits 1 on any refusal.
 *   displays <projectRoot>  Every diagram's display, built with core's
 *                           loadDisplaySubjectArea (the CLI has no display format).
 *   compile <projectRoot>   Every `.dbml` compiled as a multi-file project under
 *                           @dbml/parse 9.1.1, 10.3.1 and the pinned 11.0.0.
 *
 * Reads and writes only the project it is given (a temp copy).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

import { LAYERS_CONFIG_FILE, classifySemanticFile, loadDisplaySubjectArea, parseLayersText } from '@erd-studio/core';
import { compileDbmlProject, dbmlStorageReader } from '@erd-studio/core/dbml';
import type { DbmlParserModule } from '@erd-studio/core/dbml';

import { planDbmlConversion } from '../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../src/services/dbmlConversionFiles';

const SEMANTIC_DIR = '.erd-studio';

/** Every file under the semantic dir, posix and relative to it. */
function listFiles(root: string, dir = ''): string[] {
  const abs = path.join(root, dir);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const rel = dir === '' ? e.name : `${dir}/${e.name}`;
    return e.isDirectory() ? listFiles(root, rel) : [rel];
  });
}

async function convert(projectRoot: string): Promise<void> {
  const semanticRoot = path.join(projectRoot, SEMANTIC_DIR);
  const plan = await planDbmlConversion(readDbmlConversionInput(projectRoot, SEMANTIC_DIR));
  if (plan.refusals.length > 0) {
    process.stdout.write(JSON.stringify({ refusals: plan.refusals }, null, 2));
    process.exit(1);
  }
  for (const c of plan.creates) {
    const file = path.join(semanticRoot, c.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, c.text);
  }
  for (const r of plan.replaces) fs.writeFileSync(path.join(semanticRoot, r.path), r.text);
  for (const d of plan.deletes) fs.rmSync(path.join(semanticRoot, d));
  // The command removes library folders the deletes left empty.
  for (const dir of ['logical-models']) {
    const abs = path.join(semanticRoot, dir);
    if (fs.existsSync(abs) && listFiles(abs).length === 0) fs.rmSync(abs, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({
    created: plan.creates.map((c) => c.path),
    replaced: plan.replaces.map((r) => r.path),
    deleted: plan.deletes,
    notes: plan.notes,
    movedRelationships: plan.movedRelationships,
    summary: plan.summary,
  }, null, 2));
}

/**
 * Each diagram's display, keyed by its path relative to the semantic dir
 * without the extension. Every library folder is listed as a layer, so the
 * loader's probe finds every table wherever it is (the host's semantics,
 * §3.4), as Convert's own self-check does.
 */
async function displays(projectRoot: string): Promise<void> {
  const semanticRoot = path.join(projectRoot, SEMANTIC_DIR);
  const files = listFiles(semanticRoot);
  const read = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(semanticRoot, ...rel.split('/')), 'utf-8');
    } catch {
      return null;
    }
  };
  const layers = parseLayersText(read(LAYERS_CONFIG_FILE), () => undefined);
  const known = new Set(layers.map((l) => l.id));
  const libraryFolders = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    if ((parts[0] === 'tables' || parts[0] === 'logical-models') && parts.length === 3) libraryFolders.add(parts[1]);
  }
  const extra = [...libraryFolders].filter((f) => !known.has(f)).map((id, i) => ({
    id, label: id, abbreviation: id.slice(0, 3).toUpperCase(), color: '#888888', creatable: false, order: 1000 + i,
  }));
  const layersText = JSON.stringify({ schemaVersion: 1, layers: [...layers, ...extra] });
  const out: Record<string, unknown> = {};
  for (const rel of files.sort()) {
    const cls = classifySemanticFile(rel, { tablesDirIsLayer: false });
    if (cls.kind !== 'diagram') continue;
    try {
      const display = await loadDisplaySubjectArea({
        domainPath: rel,
        readOnly: true,
        dbml: dbmlStorageReader,
        warn: () => undefined,
        readFile: async (p) => (p === LAYERS_CONFIG_FILE ? layersText : read(p)),
      });
      out[rel.replace(/\.(json|dbml)$/i, '')] = JSON.parse(JSON.stringify(display));
    } catch (err) {
      out[rel.replace(/\.(json|dbml)$/i, '')] = { loadError: err instanceof Error ? err.message : String(err) };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

/** Every `.dbml` compiled, with its `use` targets, under each parser. */
function compile(projectRoot: string): void {
  const semanticRoot = path.join(projectRoot, SEMANTIC_DIR);
  const sources: Record<string, string> = {};
  for (const rel of listFiles(semanticRoot)) {
    if (rel.toLowerCase().endsWith('.dbml')) sources[rel] = fs.readFileSync(path.join(semanticRoot, rel), 'utf-8');
  }
  const parsers: Record<string, DbmlParserModule> = {
    '9.1.1': v9 as unknown as DbmlParserModule,
    '10.3.1': v10 as unknown as DbmlParserModule,
    '11.0.0 (pinned)': undefined as unknown as DbmlParserModule,
  };
  const out: Record<string, Record<string, unknown[]>> = {};
  for (const [version, parser] of Object.entries(parsers)) {
    const result = parser ? compileDbmlProject(sources, Object.keys(sources), parser) : compileDbmlProject(sources, Object.keys(sources));
    out[version] = Object.fromEntries(Object.entries(result).filter(([, list]) => list.length > 0));
  }
  process.stdout.write(JSON.stringify({ files: Object.keys(sources).length, errors: out }, null, 2));
}

async function main(): Promise<void> {
  const [mode, root] = process.argv.slice(2);
  if (!root) throw new Error('usage: convert-fixture <convert|displays|compile> <projectRoot>');
  if (mode === 'convert') await convert(root);
  else if (mode === 'displays') await displays(root);
  else if (mode === 'compile') compile(root);
  else throw new Error(`unknown mode ${mode}`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
