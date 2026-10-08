// Real-extension functional check of every relationship journey on the canvas (#133, final build).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { session, sleep } from '<issue-to-pr-skill>/scripts/cdp/act.mjs';
import { canvas } from '<work>/wv.mjs';
const require = createRequire('<repo>/package.json');
const { parse } = require('yaml');
const ROOT = process.env.DEMO;
const LIB = `${ROOT}/.erd-studio/logical-models`;
const rels = (m) => parse(fs.readFileSync(`${LIB}/${m}.yml`, 'utf-8')).relationships ?? null;
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const w = await session({ marks: '/dev/null' });
await w.ev("(document.getElementById('__cur')||{style:{}}).style.opacity=0");
const k = (key, code, kc, mod = 0) => w.key(key, code, kc, mod);
let c = await canvas({ marks: '/dev/null' });
const drop = async (fm, fc, tm, tc) => {
  await c.ev(`(() => { win.dispatchEvent(new win.CustomEvent('column-relationship-drop', { detail: { fromModel: '${fm}', fromColumn: '${fc}', toModel: '${tm}', toColumn: '${tc}' } })); return 1; })()`);
  await c.waitFor(`doc.querySelector('.new-fk-dialog')`); await sleep(400);
};
const val = (id) => c.ev(`(doc.getElementById('${id}')||{}).value`);
const text = (sel) => c.ev(`(doc.querySelector('${sel}')||{}).textContent || ''`);
const setRole = (t) => c.ev(`(() => { const el=doc.getElementById('relationship-role'); const set=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set; set.call(el, '${t}'); el.dispatchEvent(new win.Event('input',{bubbles:true})); return 1; })()`);
const primary = () => c.ev(`(() => { const b=doc.querySelector('.new-fk-dialog__button--primary'); return { label: b.textContent.trim(), disabled: b.disabled }; })()`);
const clickPrimary = () => c.ev(`(doc.querySelector('.new-fk-dialog__button--primary').click(), 1)`);
const cancel = () => c.ev(`(doc.querySelector('.new-fk-dialog__button--secondary').click(), 1)`);
const edgeMenu = async () => {
  await c.waitFor(`doc.querySelector('.react-flow__edge path')`);
  await c.ev(`(() => { const p=doc.querySelector('.react-flow__edge path'); const r=p.getBoundingClientRect(); p.dispatchEvent(new win.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return 1; })()`);
  await c.waitFor(`doc.querySelector('.context-menu')`); await sleep(200);
};
const swap = async () => {
  await c.waitFor(`doc.querySelector('.fk-edge__swap-zone')`);
  await c.ev(`(doc.querySelector('.fk-edge__swap-zone').dispatchEvent(new win.MouseEvent('mouseover',{bubbles:true})), 1)`);
  await c.waitFor(`doc.querySelector('.fk-edge__swap-btn')`);
  await c.ev(`(doc.querySelector('.fk-edge__swap-btn').click(), 1)`);
};
const settle = () => sleep(2500);
const FCT = { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
const DIM = { fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' };

// 1. Certain direction: a drag from the dimension's key is turned round, with a sentence and a read-back.
await drop('dim_customer', 'customer_key', 'fct_order', 'customer_key');
check('1a drag from a key opens the dialog from the fact', (await val('fromModel')) === 'fct_order' && (await val('toModel')) === 'dim_customer', await val('fromModel'));
const sentence = await text('.new-fk-dialog__sentence'); const readback = await text('.new-fk-dialog__readback');
check('1b sentence and read-back say where it is saved', /fct_order/.test(sentence) && /fct_order/.test(readback), JSON.stringify([sentence, readback]));
check('1c turned-round note offers Swap back', /Swap back/.test(await text('.new-fk-dialog__note')), await text('.new-fk-dialog__note'));
const p1 = await primary(); check('1d Create enabled, no extra click', !p1.disabled && /Create Relationship/.test(p1.label), JSON.stringify(p1));
await setRole('buyer'); await sleep(200); await clickPrimary(); await settle();
check('1e stored on the fact with its role', eq(rels('fct_order'), [{ ...FCT, role: 'buyer' }]), JSON.stringify(rels('fct_order')));
check('1f dimension file untouched', rels('dim_customer') === null, JSON.stringify(rels('dim_customer')));
await c.waitFor(`doc.querySelector('.fk-edge__role')`).catch(() => {});
check('1g role drawn on the line', (await text('.fk-edge__role')) === 'buyer');

// 2. Undo / redo cover the model file.
await c.ev(`([...doc.querySelectorAll('button')].find(b=>b.textContent.trim()==='↶').click(), 1)`); await settle();
check('2a undo removes it', rels('fct_order') === null, JSON.stringify(rels('fct_order')));
await c.ev(`([...doc.querySelectorAll('button')].find(b=>b.textContent.trim()==='↷').click(), 1)`); await settle();
check('2b redo puts it back', eq(rels('fct_order'), [{ ...FCT, role: 'buyer' }]), JSON.stringify(rels('fct_order')));

// 3. ⇄ moves it to the new many side and back, role kept.
await swap(); await settle();
check('3a swap moves it to the dimension, role kept', eq(rels('dim_customer'), [{ ...DIM, role: 'buyer' }]) && rels('fct_order') === null, JSON.stringify([rels('dim_customer'), rels('fct_order')]));
await swap(); await settle();
check('3b swap back: home on the fact', eq(rels('fct_order'), [{ ...FCT, role: 'buyer' }]) && rels('dim_customer') === null, JSON.stringify([rels('dim_customer'), rels('fct_order')]));

// 4. Edit from the context menu: role shown, changed.
await edgeMenu();
await c.ev(`(doc.querySelector('.context-menu__edit-link').click(), 1)`); await c.waitFor(`doc.querySelector('.new-fk-dialog')`); await sleep(400);
check('4a edit opens with the stored role', (await val('relationship-role')) === 'buyer', await val('relationship-role'));
await setRole('account owner'); await sleep(200); await clickPrimary(); await settle();
check('4b new role saved', eq(rels('fct_order'), [{ ...FCT, role: 'account owner' }]), JSON.stringify(rels('fct_order')));

// 5. Cardinality from the context menu keeps the role.
await edgeMenu();
const opts = await c.ev(`(() => { const b=doc.querySelector('.context-menu__cardinality-button'); if(b) b.click(); return [...doc.querySelectorAll('.context-menu__cardinality-option')].map(o=>o.textContent.trim()); })()`); await sleep(300);
check('5a no One → Many option', !(opts || []).some((o) => /One\s*→\s*Many/.test(o)), JSON.stringify(opts));
await c.ev(`([...doc.querySelectorAll('.context-menu__cardinality-option')].find(o=>o.textContent.trim()==='One → One').click(), 1)`); await settle();
check('5b one-to-one saved, role kept', eq(rels('fct_order'), [{ ...FCT, cardinality: 'one-to-one', role: 'account owner' }]), JSON.stringify(rels('fct_order')));

// 6. The same two columns the other way round is refused.
await drop('fct_order', 'customer_key', 'dim_customer', 'customer_key');
const dup = await c.ev(`({ err: (doc.querySelector('.new-fk-dialog__error--global')||{}).textContent, disabled: doc.querySelector('.new-fk-dialog__button--primary').disabled })`);
check('6 reverse duplicate refused', dup.disabled === true && /already exists/.test(dup.err ?? ''), JSON.stringify(dup));
await cancel(); await sleep(400);

// 7. Ambiguous: two non-key columns → the dialog asks, Create disabled until answered.
await drop('fct_order', 'amount', 'dim_date', 'calendar_date');
const amb = await c.ev(`({ choices: [...doc.querySelectorAll('.new-fk-dialog__choice-button')].map(b=>b.textContent.trim()), disabled: doc.querySelector('.new-fk-dialog__button--primary').disabled })`);
check('7a ambiguous: asks with buttons named after the models, Create disabled', amb.choices.length === 2 && amb.disabled === true && amb.choices.some((t) => /fct_order/.test(t)) && amb.choices.some((t) => /dim_date/.test(t)), JSON.stringify(amb));
await c.ev(`(doc.querySelector('.new-fk-dialog__choice-button').click(), 1)`); await sleep(300);
check('7b answering enables Create', !(await primary()).disabled, JSON.stringify(await primary()));
await cancel(); await sleep(400);
check('7c cancel writes nothing', eq(rels('fct_order'), [{ ...FCT, cardinality: 'one-to-one', role: 'account owner' }]), JSON.stringify(rels('fct_order')));

// 8. Contradiction: a key-certain drag (dim key → declared FK) turned back against the keys warns; button says Create anyway.
await drop('dim_date', 'date_key', 'fct_order', 'order_date_key');
check('8a certain drag is turned round onto the declared FK', (await val('fromModel')) === 'fct_order', await val('fromModel'));
await c.ev(`([...doc.querySelectorAll('.new-fk-dialog__link-button')].find(b=>/Swap back/.test(b.textContent)).click(), 1)`); await sleep(400);
const con = await c.ev(`({ warn: [...doc.querySelectorAll('.new-fk-dialog__warning[role=alert]')].map(e=>e.textContent).join(' '), label: doc.querySelector('.new-fk-dialog__button--primary').textContent.trim() })`);
check('8b contradiction warns and offers Create anyway', /primary key/.test(con.warn) && /Create anyway/.test(con.label), JSON.stringify(con));
await cancel(); await sleep(400);
// 8c. Likely only (unflagged column): turned back gives a soft note with Swap sides, no warning.
await drop('dim_date', 'date_key', 'fct_order', 'ship_date_key');
await c.ev(`(([...doc.querySelectorAll('.new-fk-dialog__link-button')].find(b=>/Swap back/.test(b.textContent))||{click(){}}).click(), 1)`); await sleep(400);
const soft = await c.ev(`({ note: [...doc.querySelectorAll('.new-fk-dialog__note')].map(e=>e.textContent).join(' '), alert: doc.querySelectorAll('.new-fk-dialog__warning[role=alert]').length, label: doc.querySelector('.new-fk-dialog__button--primary').textContent.trim() })`);
check('8c likely-only: soft note, no warning, normal Create', soft.alert === 0 && /Create Relationship/.test(soft.label) && soft.note.length > 0, JSON.stringify(soft));
await cancel(); await sleep(400);

// 9. The other diagram draws the shared relationship once, with its role.
c.close();
await k('k', 'KeyK', 75, 4); await k('w', 'KeyW', 87, 4); await sleep(800);
await w.realClick(`document.querySelector('.part.sidebar .composite.title') || document.querySelector('.part.sidebar')`);
await k('p', 'KeyP', 80, 4); await sleep(500); await w.type('reporting.json', 15); await sleep(700); await k('Enter', 'Enter', 13); await sleep(4500);
c = await canvas({ marks: '/dev/null' });
const other = await c.ev(`({ edges: doc.querySelectorAll('.react-flow__edge').length, role: (doc.querySelector('.fk-edge__role')||{}).textContent })`);
check('9 second diagram draws it once, with its role', other.edges === 1 && other.role === 'account owner', JSON.stringify(other));

// 10. Delete from the context menu in the second diagram.
await edgeMenu();
await c.ev(`(doc.querySelector('.context-menu__delete-link').click(), 1)`); await sleep(300);
await c.ev(`(doc.querySelector('.context-menu__delete-link').click(), 1)`); await settle();
check('10a delete: gone from every file', rels('fct_order') === null && rels('dim_customer') === null, JSON.stringify([rels('fct_order'), rels('dim_customer')]));
check('10b delete: no line left', (await c.ev(`doc.querySelectorAll('.react-flow__edge').length`)) === 0);

c.close(); w.close();
console.log(failed === 0 ? 'ALL PASSED' : `${failed} FAILED`);
process.exit(failed ? 1 : 0);
