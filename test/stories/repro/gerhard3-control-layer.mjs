// REPRO (gerhard-feedback-3, stage 1) CONTROL: a tree-to-tree drop through the same CDP mechanism as
// experiment A of gerhard3-dragdrop.mjs (Gold layer row dropped on Silver): VS Code delivers it and
// layers.json is reordered, so A's silent no-op is the extension's, not the harness's.
// Usage: node gerhard3-control-layer.mjs <cdp port> <project>/.erd-studio/layers.json
import fs from 'node:fs';
const L='../lib/';
const { Workbench, sleep } = await import(L+'act.mjs');
const port = Number(process.argv[2]); const layersFile = process.argv[3];
const wb = new Workbench({ port, pace: { glide: 0, settle: 100 } });
const row = (t) => `[...document.querySelectorAll('.part.sidebar .monaco-list-row')].find(r => (r.querySelector('.label-name')?.textContent ?? '').trim() === ${JSON.stringify(t)})`;
const before = JSON.parse(fs.readFileSync(layersFile,'utf8')).layers.map(l=>l.id);
const from = await wb.center(row('Gold')); const to = await wb.center(row('Silver'));
await wb.send('Input.setInterceptDrags', { enabled: true });
const c = await wb.client();
const got = new Promise(res => { const off = c.on('Input.dragIntercepted', p => { off(); res(p.data); }); });
await wb.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i=1;i<=8;i++){ await wb.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x+i*4, y: from.y-i*3, button:'left', buttons:1}); await sleep(30);}
const data = await Promise.race([got, sleep(4000).then(()=>null)]);
console.log('drag types', data?.items.map(i=>i.mimeType+'='+i.data.slice(0,80)));
const d = (type, p) => wb.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
await d('dragEnter', to); for (let i=0;i<4;i++){ await d('dragOver', {x:to.x+i, y:to.y}); await sleep(60);} await d('drop', to);
await wb.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
await wb.send('Input.setInterceptDrags', { enabled: false });
await sleep(2500);
console.log('layers before', before, 'after', JSON.parse(fs.readFileSync(layersFile,'utf8')).layers.map(l=>l.id));
process.exit(0);
