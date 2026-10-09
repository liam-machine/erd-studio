/**
 * Keeps the database files in step with each other and with the Worker.
 *
 * deploy.yml applies `migrations/` and then deploys `src/index.js`, with no
 * human in between. A column the Worker binds but no migration creates would
 * fail every insert with a 503 the moment it deploys, so that is a test here
 * rather than a step in a checklist. `schema.sql` is the readable current
 * shape and is never applied; it must equal what the migrations add up to.
 *
 * Text-level on purpose: Node has no SQLite before 22.5 and this directory
 * installs nothing. CI also applies the migrations to a fresh local D1.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

/** Column names of `CREATE TABLE … heartbeats (…)`, in order. */
function createdColumns(sql) {
  const body = /CREATE TABLE IF NOT EXISTS heartbeats \(([\s\S]*?)\n\);/.exec(stripComments(sql))?.[1];
  assert.ok(body, 'no CREATE TABLE heartbeats');
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !/^PRIMARY KEY/i.test(part) && !/^\w+\)$/.test(part))
    .map((part) => part.split(/\s+/)[0]);
}

const addedColumns = (sql) =>
  [...stripComments(sql).matchAll(/ALTER TABLE heartbeats ADD COLUMN (\w+)/g)].map((m) => m[1]);
const indexes = (sql) =>
  [...stripComments(sql).matchAll(/CREATE INDEX IF NOT EXISTS (\w+) ON heartbeats\((\w+)\)/g)].map((m) => `${m[1]}(${m[2]})`);

const migrationFiles = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

/** What applying every migration in wrangler's order produces. */
function migratedShape() {
  const columns = [];
  const idx = [];
  for (const file of migrationFiles) {
    const sql = read(`migrations/${file}`);
    if (/CREATE TABLE/.test(stripComments(sql))) columns.push(...createdColumns(sql));
    columns.push(...addedColumns(sql));
    idx.push(...indexes(sql));
  }
  return { columns, indexes: idx };
}

describe('database files', () => {
  it('migrations are numbered NNNN_name.sql, once each, from 0001', () => {
    assert.ok(migrationFiles.length > 0);
    const numbers = migrationFiles.map((f) => {
      assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/);
      return Number(f.slice(0, 4));
    });
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  });

  it('wrangler.toml points the DB binding at migrations/', () => {
    assert.match(read('wrangler.toml'), /^migrations_dir = "migrations"$/m);
  });

  it('schema.sql is exactly what the migrations add up to', () => {
    const schema = read('schema.sql');
    const migrated = migratedShape();
    assert.deepEqual(createdColumns(schema), migrated.columns);
    assert.deepEqual(indexes(schema).sort(), migrated.indexes.sort());
  });

  it('every column the Worker writes is created by a migration', () => {
    const insert = /INSERT INTO heartbeats \(([\s\S]*?)\) VALUES/.exec(read('src/index.js'))?.[1];
    assert.ok(insert, 'no INSERT INTO heartbeats in src/index.js');
    const bound = insert.split(',').map((c) => c.trim()).filter(Boolean);
    const { columns } = migratedShape();
    assert.deepEqual(bound.filter((c) => !columns.includes(c)), []);
    assert.equal(new Set(columns).size, columns.length, 'a column is added twice');
  });
});
