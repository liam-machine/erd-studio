#!/usr/bin/env node
/**
 * Pins the import corpus: reads sources.json, resolves each entry's `ref` to
 * a commit, lists its files (the `files` named, or every file under `root`
 * whose path matches `include`), downloads each once to hash it, and writes
 * manifest.json: one raw.githubusercontent.com URL at that commit and one
 * SHA-256 per file. fetch.mjs reads only the manifest.
 *
 *   node scripts/corpus/pin.mjs                 # every entry
 *   node scripts/corpus/pin.mjs --only a,b      # re-pin these, keep the rest
 *
 * Needs a GitHub token for the API (GITHUB_TOKEN, or `gh auth token`). It only
 * downloads and hashes: nothing it downloads is written to disk or run.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(here, 'sources.json');
const MANIFEST = join(here, 'manifest.json');

const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';
const only = new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean));

const token = process.env.GITHUB_TOKEN || (() => {
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; }
})();

async function api(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'User-Agent': 'erd-studio-import-corpus' },
  });
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status}`);
  return res.json();
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${enc(path)}`;

/** Every blob under `root` at `commit`, walking down to root first so a big repo's truncated recursive tree never matters. */
async function listUnder(repo, commit, root) {
  const c = await api(`repos/${repo}/git/commits/${commit}`);
  let sha = c.tree.sha;
  for (const seg of root.split('/').filter(Boolean)) {
    const t = await api(`repos/${repo}/git/trees/${sha}`);
    const next = t.tree.find((e) => e.path === seg && e.type === 'tree');
    if (!next) throw new Error(`${repo}@${commit}: no folder ${root}`);
    sha = next.sha;
  }
  const t = await api(`repos/${repo}/git/trees/${sha}?recursive=1`);
  if (t.truncated) throw new Error(`${repo}@${commit}:${root}: the tree is truncated; pick a narrower root`);
  return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
}

async function hashOf(url) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': 'erd-studio-import-corpus' } });
    if (res.ok || attempt === 4 || res.status === 404) break;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));
const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { schemas: [] };
const prevByName = new Map(previous.schemas.map((s) => [s.name, s]));
const commits = new Map();

const schemas = [];
for (const src of sources.schemas) {
  if (only.size && !only.has(src.name) && prevByName.has(src.name)) { schemas.push(prevByName.get(src.name)); continue; }
  const key = `${src.repo}@${src.ref}`;
  if (!commits.has(key)) commits.set(key, (await api(`repos/${src.repo}/commits/${encodeURIComponent(src.ref)}`)).sha);
  const commit = commits.get(key);
  const root = src.root ?? '';
  let paths;
  if (src.files) paths = src.files;
  else {
    const re = new RegExp(src.include ?? '.');
    paths = (await listUnder(src.repo, commit, root)).filter((p) => re.test(p)).sort();
  }
  if (paths.length === 0) throw new Error(`${src.name}: no files`);
  const files = await pool(paths, 8, async (p) => {
    const full = root ? `${root}/${p}` : p;
    const url = rawUrl(src.repo, commit, full);
    return { path: p, url, ...(await hashOf(url)) };
  });
  const { files: _f, include: _i, ...rest } = src;
  schemas.push({ ...rest, commit, ...(src.include ? { include: src.include } : {}), files });
  console.log(`${src.name}: ${files.length} file(s), ${files.reduce((n, f) => n + f.bytes, 0)} bytes @ ${commit.slice(0, 10)}`);
}

writeFileSync(MANIFEST, JSON.stringify({
  $comment: 'Generated by scripts/corpus/pin.mjs from sources.json. Each file: a URL pinned to a commit and its SHA-256; fetch.mjs downloads and verifies, and never runs, what it fetches.',
  pinned: new Date().toISOString().slice(0, 10),
  schemas,
}, null, 1) + '\n');
console.log(`manifest.json: ${schemas.length} schemas, ${schemas.reduce((n, s) => n + s.files.length, 0)} files`);
