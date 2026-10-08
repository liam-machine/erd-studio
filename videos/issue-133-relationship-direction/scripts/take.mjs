// usage: MARKS=... node take.mjs before|after
import { session, sleep } from '<issue-to-pr-skill>/scripts/cdp/act.mjs';
import { canvas } from '<work>/wv.mjs';
const side = process.argv[2];
const after = side === 'after';
const w = await session();
await w.ev("(document.getElementById('__cur')||{style:{}}).style.opacity=0");
let c = await canvas();
const row = (model, col) => `doc.querySelector('[data-model-name="${model}"] [data-column-name="${col}"]')`;
const k = (key, code, kc, mod = 0) => w.key(key, code, kc, mod);
const drag = async (fm, fc, tm, tc) => {
  await c.moveTo(row(fm, fc)); await c.highlight(row(fm, fc)); await sleep(700);
  await c.moveTo(row(tm, tc)); await c.highlight(row(tm, tc)); await sleep(500);
  await c.unhighlight();
  await c.ev(`(() => { win.dispatchEvent(new win.CustomEvent('column-relationship-drop', { detail: { fromModel: '${fm}', fromColumn: '${fc}', toModel: '${tm}', toColumn: '${tc}' } })); return 1; })()`);
  await c.waitFor(`doc.querySelector('.new-fk-dialog')`);
};
const openFile = async (name) => {
  // Keys go to whatever has focus; after a click in the canvas that is the webview.
  await w.realClick(`document.querySelector('.part.sidebar .composite.title') || document.querySelector('.part.sidebar')`);
  await w.ev("(document.getElementById('__cur')||{style:{}}).style.opacity=0");
  await k('p', 'KeyP', 80, 4); await sleep(500); await w.type(name, 35); await sleep(700);
  await k('Enter', 'Enter', 13); await sleep(1500);
};

await sleep(800);
await w.mark('Three models on the canvas, and no relationships yet.');
await sleep(3200);
await w.mark('Drag from the customer key to the order\'s customer column.');
await drag('dim_customer', 'customer_key', 'fct_order', 'customer_key');
await c.highlight(`doc.querySelector('.new-fk-dialog__direction') || doc.querySelector('.new-fk-dialog')`);
await w.mark(after
  ? 'The dialog turns it round, and says it will be saved in the fact\'s file.'
  : 'The dialog reads it from the dimension: customer is the many side.');
await sleep(4200);
await c.unhighlight();
await w.mark('Create the relationship.');
await c.click(`[...doc.querySelectorAll('.new-fk-dialog__button--primary')].find(b=>/Create/.test(b.textContent))`);
await sleep(2200);
await c.hideCursor();
c.close();

await w.mark('Now open the dimension\'s file.');
await openFile('dim_customer.yml');
await sleep(800);
await w.mark(after ? 'The dimension file is untouched.' : 'The relationship was written into the dimension\'s file.');
await sleep(3800);
await w.mark('And the fact\'s file.');
await openFile('fct_order.yml');
await sleep(800);
await w.mark(after ? 'It lives with the fact, as many to one.' : 'The fact file has nothing.');
await sleep(4000);

if (after) {
  await w.mark('New: a relationship can carry a role, like ship date.');
  await openFile('orders.json');
  await sleep(2500);
  c = await canvas();
  await c.ev(`(() => { const b=[...doc.querySelectorAll('button')].find(x=>x.textContent.trim()==='Fit'); b&&b.click(); return 1; })()`);
  await sleep(900);
  await drag('dim_date', 'date_key', 'fct_order', 'ship_date_key');
  const input = `doc.getElementById('relationship-role')`;
  await c.click(input);
  for (const ch of 'ship date') {
    await c.ev(`(() => { const el=${input}; const set=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set; set.call(el, el.value + '${ch}'); el.dispatchEvent(new win.Event('input',{bubbles:true})); return 1; })()`);
    await sleep(90);
  }
  await sleep(600);
  await c.click(`[...doc.querySelectorAll('.new-fk-dialog__button--primary')].find(b=>/Create/.test(b.textContent))`);
  await sleep(1200);
  await c.highlight(`doc.querySelector('.fk-edge__role')`, 6);
  await w.mark('The role is drawn on the line.');
  await sleep(3500);
  await c.unhighlight(); await c.hideCursor();
  c.close();
}
await sleep(800);
w.close();
