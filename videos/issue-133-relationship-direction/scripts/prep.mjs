// One-off per launch: canvas open, welcome card and dbt banner dismissed, fitted.
import { canvas, sleep } from '<work>/wv.mjs';
const c = await canvas({ marks: '/dev/null' });
await c.ev(`(() => { const b=[...doc.querySelectorAll('button')].find(x=>x.textContent.trim()==='Get Started'); b&&b.click(); return !!b; })()`);
await sleep(500);
await c.ev(`(() => { const b=doc.querySelector('.manifest-hint__dismiss'); b&&b.click(); return !!b; })()`);
await sleep(500);
await c.ev(`(() => { const b=[...doc.querySelectorAll('button')].find(x=>x.textContent.trim()==='Fit'); b&&b.click(); return !!b; })()`);
await sleep(800);
await c.hideCursor();
c.close();
