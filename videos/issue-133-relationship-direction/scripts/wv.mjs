// Drive the ERD Studio canvas, which lives in a webview iframe target's #active-frame.
// Same conventions as act.mjs: a visible gliding cursor, ripples, mark() cues.
import fs from 'node:fs';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connectFrame(port = Number(process.env.CDP_PORT || 9333)) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(x => x.type === 'iframe' && x.url.includes('vscode-webview') && x.url.includes('index.html') && x.url.includes('erd-studio'));
  if (!t) throw new Error('no ERD Studio webview target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

const OVERLAY = `(() => { const d = doc; if (d.getElementById('__cur')) return true;
  const s = d.createElement('style');
  s.textContent = '#__cur{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;pointer-events:none;transition:transform .8s cubic-bezier(.4,.1,.2,1);transform:translate(50vw,50vh)}' +
    '#__ripple{position:fixed;z-index:2147483646;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #fbbf24;pointer-events:none;opacity:0}' +
    '#__hl{position:fixed;z-index:2147483644;border:3px solid #fbbf24;border-radius:6px;box-shadow:0 0 0 4000px rgba(0,0,0,.28);pointer-events:none;transition:all .45s;opacity:0}';
  d.head.appendChild(s);
  const cur = d.createElement('div'); cur.id = '__cur';
  cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6 1.1 3.9 7.2-2.9 1.5-3.9-7.3L4 21z" fill="#fff" stroke="#000" stroke-width="1.4"/></svg>';
  d.body.appendChild(cur);
  for (const id of ['__ripple', '__hl']) { const e = d.createElement('div'); e.id = id; d.body.appendChild(e); }
  return true; })()`;

export async function canvas({ marks = process.env.MARKS } = {}) {
  const c = await connectFrame();
  const ev = async (body) => {
    const expr = `(() => { const f=document.getElementById('active-frame'); const win=f.contentWindow; const doc=f.contentDocument; return (${body}); })()`;
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await ev(OVERLAY);
  const center = (q) => ev(`(() => { const el=${q}; if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  const a = {
    ev,
    async mark(text) { fs.appendFileSync(marks, JSON.stringify({ t: Date.now(), text }) + '\n'); },
    async waitFor(q, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(`!!(${q})`)) return; await sleep(200); } throw new Error('timeout ' + q); },
    async moveTo(q) { await ev(OVERLAY); const p = await center(q); if (!p) throw new Error('not found: ' + q); await ev(`doc.getElementById('__cur').style.transform='translate(${p.x - 4}px,${p.y - 2}px)'`); await sleep(900); return p; },
    async ripple(p) { await ev(`(() => { const rp=doc.getElementById('__ripple'); rp.style.left='${p.x}px'; rp.style.top='${p.y}px'; rp.animate([{opacity:1,transform:'scale(.4)'},{opacity:0,transform:'scale(1.6)'}],{duration:500}); return 1; })()`); },
    async click(q) { const p = await a.moveTo(q); await a.ripple(p); await ev(`(() => { const el=${q}; el.click(); return 1; })()`); await sleep(400); },
    async highlight(q, pad = 4) { await ev(OVERLAY); return ev(`(() => { const h=doc.getElementById('__hl'); const el=${q}; if(!el){h.style.opacity=0;return false;} const r=el.getBoundingClientRect(); Object.assign(h.style,{left:(r.left-${pad})+'px',top:(r.top-${pad})+'px',width:(r.width+2*${pad})+'px',height:(r.height+2*${pad})+'px',opacity:1}); return true; })()`); },
    async unhighlight() { await ev(`(doc.getElementById('__hl')||{style:{}}).style.opacity=0`); },
    async hideCursor() { await ev(`(doc.getElementById('__cur')||{style:{}}).style.opacity=0`); },
    close: () => c.close(),
  };
  return a;
}
