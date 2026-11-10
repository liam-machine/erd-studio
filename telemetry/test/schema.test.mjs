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

/** `{ table: [column, …] }` of every `CREATE TABLE IF NOT EXISTS … (…)` in `sql`, columns in order. */
function createdTables(sql) {
  const tables = {};
  for (const [, table, body] of stripComments(sql).matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    tables[table] = body
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line && !/^PRIMARY KEY/i.test(line))
      .map((line) => line.split(/\s+/)[0]);
  }
  return tables;
}

/** The `PRIMARY KEY (…)` columns of `table` in `sql`. */
function primaryKey(sql, table) {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(stripComments(sql))?.[1] ?? '';
  return (/PRIMARY KEY \(([^)]*)\)/i.exec(body)?.[1] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
}

const addedColumns = (sql) =>
  [...stripComments(sql).matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map((m) => ({ table: m[1], column: m[2] }));
const indexes = (sql) =>
  [...stripComments(sql).matchAll(/CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\((\w+)\)/g)].map((m) => `${m[1]}:${m[2]}(${m[3]})`);

const migrationFiles = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

/** What applying every migration in wrangler's order produces: columns per table, and the indexes. */
function migratedShape() {
  const tables = {};
  const idx = [];
  for (const file of migrationFiles) {
    const sql = read(`migrations/${file}`);
    for (const [table, columns] of Object.entries(createdTables(sql))) {
      assert.ok(!tables[table], `${file} creates ${table} a second time`);
      tables[table] = [...columns];
    }
    for (const { table, column } of addedColumns(sql)) {
      assert.ok(tables[table], `${file} alters ${table} before any migration creates it`);
      tables[table].push(column);
    }
    idx.push(...indexes(sql));
  }
  return { tables, indexes: idx };
}

/** The columns of `INSERT INTO <table> (…)` in the Worker source. */
function insertedColumns(table) {
  const insert = new RegExp(`INSERT INTO ${table} \\(([\\s\\S]*?)\\) VALUES`).exec(read('src/index.js'))?.[1];
  assert.ok(insert, `no INSERT INTO ${table} in src/index.js`);
  return insert.split(',').map((c) => c.trim()).filter(Boolean);
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
    assert.deepEqual(createdTables(schema), migrated.tables);
    assert.deepEqual(indexes(schema).sort(), migrated.indexes.sort());
    assert.deepEqual(Object.keys(migrated.tables).sort(), ['heartbeats', 'worker_daily']);
  });

  it('every column the Worker writes is created by a migration', () => {
    const { tables } = migratedShape();
    for (const table of ['heartbeats', 'worker_daily']) {
      const columns = tables[table];
      assert.deepEqual(insertedColumns(table).filter((c) => !columns.includes(c)), [], table);
      assert.equal(new Set(columns).size, columns.length, `a column of ${table} is added twice`);
    }
  });

  it('the ledger upsert conflicts on exactly the worker_daily primary key', () => {
    const conflict = /INSERT INTO worker_daily[\s\S]*?ON CONFLICT\(([^)]*)\)/.exec(read('src/index.js'))?.[1];
    assert.ok(conflict, 'no ON CONFLICT on the worker_daily insert');
    const key = conflict.split(',').map((c) => c.trim());
    for (const file of migrationFiles) {
      const pk = primaryKey(read(`migrations/${file}`), 'worker_daily');
      if (pk.length) assert.deepEqual(key, pk);
    }
    assert.deepEqual(primaryKey(read('schema.sql'), 'worker_daily'), key);
  });
});
