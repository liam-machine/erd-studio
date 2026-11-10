#!/usr/bin/env node
/**
 * Fetches the import corpus (manifest.json) into a gitignored cache and
 * verifies every file against its pinned SHA-256.
 *
 *   node scripts/corpus/fetch.mjs                       # into .cache/import-corpus
 *   node scripts/corpus/fetch.mjs --cache /some/dir --only pg-discourse,mysql-magento
 *
 * Each schema's files land in <cache>/files/<name>/<path under its root>. A
 * file already there with the right hash is not downloaded again. A download
 * whose hash does not match is deleted and the run fails.
 *
 * The files are untrusted data: this script only downloads and hashes them.
 * It never runs, imports, extracts or evaluates anything it fetches, writes
 * them without the executable bit, and refuses a path that would leave the
 * schema's own folder.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
export const DEFAULT_CACHE = join(repoRoot, '.cache', 'import-corpus');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cache = resolve(arg('--cache') ?? process.env.IMPORT_CORPUS_DIR ?? DEFAULT_CACHE);
const only = new Set((arg('--only') ?? process.env.IMPORT_CORPUS_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const schemas = manifest.schemas.filter((s) => only.size === 0 || only.has(s.name));
if (only.size && schemas.length !== only.size) {
  const known = new Set(manifest.schemas.map((s) => s.name));
  console.error(`Unknown schema(s): ${[...only].filter((n) => !known.has(n)).join(', ')}`);
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The file's place in the cache, or an error when its path would leave the schema's folder. */
function target(schema, path) {
  const base = join(cache, 'files', schema.name);
  const full = resolve(base, path);
  const rel = relative(base, full);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(schema.name) || !rel || rel.startsWith('..') || isAbsolute(rel) || path.includes('\0')) {
    throw new Error(`${schema.name}: refusing the path ${JSON.stringify(path)}`);
  }
  return full;
}

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'erd-studio-import-corpus' }, redirect: 'follow' });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (attempt >= 4 || res.status === 404) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 4) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

const jobs = schemas.flatMap((s) => s.files.map((f) => ({ s, f })));
let fetched = 0; let kept = 0; const failures = [];
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < jobs.length) {
    const { s, f } = jobs[next++];
    try {
      const file = target(s, f.path);
      if (existsSync(file) && sha256(readFileSync(file)) === f.sha256) { kept++; continue; }
      const buf = await download(f.url);
      const got = sha256(buf);
      if (got !== f.sha256 || buf.length !== f.bytes) throw new Error(`checksum mismatch: expected ${f.sha256} (${f.bytes} bytes), got ${got} (${buf.length} bytes)`);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.part`;
      writeFileSync(tmp, buf, { mode: 0o644 });
      renameSync(tmp, file);
      fetched++;
    } catch (err) {
      failures.push(`${s.name}/${f.path}: ${err.message}`);
      try { rmSync(target(s, f.path), { force: true }); } catch { /* the path was refused */ }
    }
  }
}));

// Anything in a schema's folder the manifest does not list (an older pin) is removed, so the import reads the pinned set.
let removed = 0;
for (const s of schemas) {
  const base = join(cache, 'files', s.name);
  if (!existsSync(base)) continue;
  const want = new Set(s.files.map((f) => resolve(base, f.path)));
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (!want.has(full)) { rmSync(full); removed++; }
    }
  };
  walk(base);
}

mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, 'fetched.json'), JSON.stringify({ manifestPinned: manifest.pinned, schemas: schemas.map((s) => s.name), failures }, null, 1) + '\n');
console.log(`Import corpus in ${relative(process.cwd(), cache) || '.'}${sep}files: ${schemas.length} schemas, ${fetched} downloaded, ${kept} already verified${removed ? `, ${removed} stale removed` : ''}.`);
if (failures.length) {
  console.error(`${failures.length} file(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
