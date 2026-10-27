/**
 * `@erd-studio/core` builds its two entries — `.` and the `./dbml` subpath —
 * in one esbuild call with code splitting (D13 of the native DBML storage
 * spec), so the modules both use land in one shared chunk. An error the DBML
 * readers throw must therefore be an instance of the class the main entry
 * exports: two bundled copies of domain.ts would break `instanceof` on the
 * public error classes for every consumer that checks them.
 *
 * Builds with packages/core/build.mjs into a scratch folder under
 * node_modules/.cache (so the externals `yaml` and `@dbml/parse` resolve from
 * the repo's install) and loads the built files, not the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'node_modules/.cache', `erd-core-dist-${process.pid}`, 'dist');

describe('the built @erd-studio/core entries', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['build.mjs'], {
      cwd: path.join(ROOT, 'packages/core'),
      env: { ...process.env, ERD_CORE_OUTDIR: OUT },
      stdio: 'pipe',
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(path.dirname(OUT), { recursive: true, force: true });
  });

  it('emit dist/index.js and dist/dbml/index.js, and only the subpath loads the parser', () => {
    expect(fs.existsSync(path.join(OUT, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(OUT, 'dbml/index.js'))).toBe(true);
    const mainAndChunks = [path.join(OUT, 'index.js'), ...fs.readdirSync(path.join(OUT, 'chunks')).filter((f) => f.endsWith('.js')).map((f) => path.join(OUT, 'chunks', f))];
    for (const file of mainAndChunks) expect(fs.readFileSync(file, 'utf8'), file).not.toContain('@dbml/parse');
    expect(fs.readFileSync(path.join(OUT, 'dbml/index.js'), 'utf8')).toContain('@dbml/parse');
  });

  it('share one module graph: an error thrown through the subpath is an instance of the main entry\'s class', async () => {
    const main = await import(pathToFileURL(path.join(OUT, 'index.js')).href);
    const dbml = await import(pathToFileURL(path.join(OUT, 'dbml/index.js')).href);
    let empty: unknown;
    try {
      dbml.dbmlStorageReader.parseSubjectArea('', 'gold/sales.dbml', null);
    } catch (err) {
      empty = err;
    }
    expect(empty).toBeInstanceOf(main.SubjectAreaFileError);
    expect((empty as { reason: string }).reason).toBe('empty');

    let future: unknown;
    try {
      dbml.dbmlStorageReader.parseSubjectArea("Project p {\n  erd_schema_version: '99'\n}\n", 'gold/p.dbml', null);
    } catch (err) {
      future = err;
    }
    expect(future).toBeInstanceOf(main.SubjectAreaValidationError);
  });
});
