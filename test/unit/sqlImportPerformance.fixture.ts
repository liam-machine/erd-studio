/**
 * A generated CREATE TABLE script for the SQL import's performance and
 * worker tests (never committed as a file): `tables` Postgres tables of a
 * few typed columns each, every table after the first with a foreign key to
 * the one before, and an index and a comment every tenth table.
 */

/** The script, and the line each CREATE TABLE starts on. */
export function generatedSqlWithLines(tables: number): { text: string; lines: number[] } {
  const parts: string[] = [];
  const lines: number[] = [];
  let line = 1;
  for (let i = 0; i < tables; i++) {
    lines.push(line);
    let block = `CREATE TABLE t${i} (\n  id INTEGER PRIMARY KEY,\n  code VARCHAR(20) NOT NULL UNIQUE,\n  name VARCHAR(100) NOT NULL,\n  amount NUMERIC(12,2) DEFAULT 0,\n  created_at TIMESTAMP${i > 0 ? `,\n  prev_id INTEGER REFERENCES t${i - 1}(id)` : ''}\n);\n`;
    if (i % 10 === 9) block += `CREATE INDEX ix_t${i}_name ON t${i} (name);\nCOMMENT ON TABLE t${i} IS 'Table ${i}';\n`;
    parts.push(block);
    line += block.split('\n').length - 1;
  }
  return { text: parts.join(''), lines };
}

export function generatedSql(tables: number): string {
  return generatedSqlWithLines(tables).text;
}
