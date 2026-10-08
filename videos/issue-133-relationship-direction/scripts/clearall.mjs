import { session, sleep } from '<issue-to-pr-skill>/scripts/cdp/act.mjs';
const a = await session({ marks: '/dev/null' });
await a.ev("(document.getElementById('__cur')||{style:{}}).style.opacity=0");
for (let i = 0; i < 3; i++) { await a.key('Escape', 'Escape', 27); await sleep(300); }
await a.key('k', 'KeyK', 75, 4); await a.key('w', 'KeyW', 87, 4); await sleep(500);
const n = await a.ev("(() => { const t=[...document.querySelectorAll('.notification-toast')].map(e=>e.innerText.slice(0,90)); document.querySelectorAll('.notification-toast .codicon-notifications-clear, .notification-toast .codicon-close').forEach(b=>b.click()); return t; })()");
console.log(JSON.stringify(n));
a.close();
