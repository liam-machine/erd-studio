import * as path from 'path';
import { it } from 'vitest';
import { main } from '../../src/cli/index';
async function run(argv: string[], cwd: string) {
  let out = ''; let err = '';
  const code = await main(argv, { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, cwd, env: {} });
  return { code, out, err };
}
const P = path.resolve(__dirname, '../fixtures/dbt-project');
it('fixture', async () => {
  const c = await run(['check', '--json'], P);
  console.log('CHECK', c.code, c.out.slice(0, 3000));
  const d = await run(['diff', '--all', '--json'], P);
  const j = JSON.parse(d.out);
  console.log('DIFF', d.code, j.integrityError, JSON.stringify(j.domains.map((x: any) => [x.file, x.integrity.length])));
  const s = d.out.match(/\/Users\/[^"]*/g);
  console.log('ABS', s?.slice(0,5));
  const doc = await run(['doctor', '--json', '--no-dbt'], P);
  console.log('DOCTOR', doc.code, JSON.stringify(JSON.parse(doc.out).relationships), JSON.stringify(JSON.parse(doc.out).nextSteps.map((s: any) => s.id)));
});
