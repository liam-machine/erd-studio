// After the scene: verify what is on disk.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('<repo>/package.json');
const { parse } = require('yaml');
const LIB = `${process.env.DEMO}/.erd-studio/logical-models`;
const y = (m) => parse(fs.readFileSync(`${LIB}/${m}.yml`, 'utf-8'));
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + d}`); if (!ok) failed++; };
const fct = y('fct_order').relationships ?? [];
check('fact holds the customer link as many-to-one', fct.some((r) => r.fromColumn === 'customer_key' && r.toModel === 'dim_customer' && r.cardinality === 'many-to-one'), JSON.stringify(fct));
check('fact holds the date link as many-to-one', fct.some((r) => r.fromColumn === 'order_date_key' && r.toModel === 'dim_date' && r.cardinality === 'many-to-one'), JSON.stringify(fct));
check('dimension files hold no relationships', !y('dim_customer').relationships?.length && !y('dim_date').relationships?.length);
check('stray FK flag cleared on dim_customer.customer_key', !y('dim_customer').columns.find((c) => c.name === 'customer_key').isForeignKey);
process.exit(failed ? 1 : 0);
