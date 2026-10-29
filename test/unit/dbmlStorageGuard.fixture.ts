/**
 * A project as ERD Studio 2.0's Convert Project to DBML leaves it, built from
 * the main dbt fixture: the YAML library and JSON diagrams are gone, tables
 * and relationships are `.dbml` files under `tables/`, and diagrams are
 * `<layer>/<name>.dbml` with a `.dbdiagram` layout. File contents are what
 * 2.0 writes (shortened). Shared by the stable DBML guard's tests.
 */
import * as fs from 'fs';
import * as path from 'path';

export const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'dbt-project');

export const TABLE_DBML = `Table dim_customer [
  schema: 'silver',
  role: 'dim',
  grain: 'One row per customer'
] {
  customer_key INT [pk, note: 'Surrogate key']
  customer_name VARCHAR [note: 'Customer name']
  Note: 'Customer dimension'
}
`;

export const RELATIONSHIPS_DBML = `// ERD Studio relationships. Each Ref belongs to its foreign-key table, which lives in this folder; every table a Ref names has a use line here.
use { table dim_customer } from './dim_customer.dbml'
use { table fct_order } from './fct_order.dbml'

Ref: fct_order.customer_key >? dim_customer.customer_key
`;

export const DIAGRAM_DBML = `Project showcase {
  Note: 'Project task management'
  erd_schema_version: '7'
  erd_model_folder: 'models/silver'
}

use { table dim_customer } from '../tables/gold/dim_customer.dbml'
use * from '../tables/gold/_relationships.dbml'
`;

export const EXPORT_DBML = `// erd-studio dbml-export v1
// Left out: positions

Table dim_customer {
  customer_key INT [pk]
}
`;

/** Copy the dbt fixture to `root` and convert its ERD Studio folder to DBML storage. Returns the ERD Studio folder. */
export function makeDbmlProject(root: string): string {
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  const semantic = path.join(root, '.erd-studio');
  fs.rmSync(path.join(semantic, 'logical-models'), { recursive: true, force: true });
  for (const layer of ['silver', 'gold']) {
    for (const f of fs.readdirSync(path.join(semantic, layer))) {
      if (f.endsWith('.json')) fs.rmSync(path.join(semantic, layer, f));
    }
  }
  fs.mkdirSync(path.join(semantic, 'tables', 'gold'), { recursive: true });
  fs.writeFileSync(path.join(semantic, 'tables', 'gold', 'dim_customer.dbml'), TABLE_DBML);
  fs.writeFileSync(path.join(semantic, 'tables', 'gold', 'fct_order.dbml'), TABLE_DBML.replace(/dim_customer/g, 'fct_order'));
  fs.writeFileSync(path.join(semantic, 'tables', 'gold', '_relationships.dbml'), RELATIONSHIPS_DBML);
  fs.writeFileSync(path.join(semantic, 'silver', 'showcase.dbml'), DIAGRAM_DBML);
  fs.writeFileSync(path.join(semantic, 'silver', 'showcase.dbdiagram'), '{"tables":{}}\n');
  return semantic;
}

/** Every file under `dir` with its bytes, for "nothing was written" checks. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), fs.readFileSync(p, 'utf-8'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
