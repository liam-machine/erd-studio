// REPRO (reporter-feedback-3, stage 1): a real Table Library drag (started in the workbench, intercepted)
// replayed on the canvas webview's OWN CDP target, which skips VS Code's Shift gating. Shows what
// the canvas and host do once a drop does arrive: 'already on this diagram' (VS Code notification),
// or the table added. Usage: node reporter3-canvas-direct.mjs <cdp port> <table[,table]> <screenshot.jpg>
// (port from: node test/stories/repro/reporter3-dragdrop.mjs --only X --keep). Run on a FRESH window:
// a drop sent to the webview target leaves the workbench's intercepted drag open, so a second drag will not start.
const L='../lib/';
const { Workbench, Webview, sleep } = await import(L+'act.mjs');
const { attach } = await import(L+'cdp.mjs');
const port = Number(process.argv[2]); const tables = (process.argv[3] ?? 'dim_date').split(','); const table = tables[tables.length-1];
const wb = new Workbench({ port, pace: { glide: 0, settle: 100 } });
const canvas = await Webview.find(wb);
const outer = await attach(canvas.target);
await outer.evaluate(`(() => { const w=document.querySelector('iframe#active-frame').contentWindow; w.__i=[]; for (const ty of ['dragenter','dragover','dragleave','drop']) w.addEventListener(ty, e => w.__i.push(ty+(e.shiftKey?'+s':'')+' prevented='+e.defaultPrevented+' types='+[...e.dataTransfer.types].join(',')), false); return 1})()`);
const row = `[...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(table)})`;
const rowOf = (t) => `[...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(t)})`;
for (const [i, t] of tables.entries()) { const q = await wb.center(rowOf(t)); for (const type of ['mousePressed','mouseReleased']) await wb.send('Input.dispatchMouseEvent', { type, x: q.x, y: q.y, button: 'left', buttons: type==='mousePressed'?1:0, clickCount: 1, modifiers: i ? 4 : 0 }); await sleep(150); }
const from = await wb.center(row);
console.log('from', from);
const dummy={items:[{mimeType:'text/plain',data:'x'}],dragOperationsMask:1};
for (const t of ['dragCancel']) { try { await wb.send('Input.dispatchDragEvent',{type:t,x:5,y:5,data:dummy}); console.log('cancelled'); } catch(e){ console.log('cancel err', e.message);} }
await wb.send('Input.setInterceptDrags', { enabled: true });
const c = await wb.client();
const got = new Promise(res => { const off = c.on('Input.dragIntercepted', p => { off(); res(p.data); }); });
await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i=1;i<=8;i++){ await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x+i*4, y: from.y+i, button:'left', buttons:1}); await sleep(30);}
const data = await Promise.race([got, sleep(4000).then(()=>null)]);
await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1 });
await wb.send('Input.setInterceptDrags', { enabled: false });
console.log('drag', !!data, data && data.items.find(i=>i.mimeType.includes('modellibrary'))?.data);
console.log('selected', await wb.ev(`[...document.querySelectorAll('.part.sidebar .monaco-list-row.selected')].map(r=>r.textContent.trim().slice(0,30))`));
// Point in the webview page's own coordinates (outer index.html): the inner frame fills it.
const p = await outer.evaluate(`(() => { const f=document.querySelector('iframe#active-frame'); const r=f.contentDocument.querySelector('.react-flow__pane').getBoundingClientRect(); const o=f.getBoundingClientRect(); return {x: o.left + r.left + r.width*0.55, y: o.top + r.top + r.height*0.75}; })()`);
const d = (type) => outer.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data, modifiers: 8 });
try { await d('dragEnter'); for (let i=0;i<4;i++){ await d('dragOver'); await sleep(60);} await d('drop'); } catch (e) { console.log('dispatch error', e.message); }
await sleep(4000);
console.log(JSON.stringify(await outer.evaluate(`document.querySelector('iframe#active-frame').contentWindow.__i`), null, 0));
console.log('notifications', JSON.stringify(await wb.ev(`[...document.querySelectorAll('.notification-toast-container .notification-list-item-message')].map(n => n.textContent.trim())`)));
console.log('canvas toasts', JSON.stringify(await canvas.ev(`[...doc.querySelectorAll('[role=alert], [role=status], .toast')].map(n => n.textContent.trim()).filter(Boolean)`)));
await wb.screenshot(process.argv[4] ?? '/tmp/g3-p3.jpg');
const diag = await outer.evaluate(`[...document.querySelector('iframe#active-frame').contentDocument.querySelectorAll('.react-flow__node')].map(n => n.dataset.id)`);
console.log('nodes now', JSON.stringify(diag));
process.exit(0);
