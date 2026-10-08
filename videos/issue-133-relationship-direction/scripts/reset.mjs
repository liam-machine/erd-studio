// Bring the window to a clean state with the orders diagram open in the canvas.
import { session, sleep } from '<issue-to-pr-skill>/scripts/cdp/act.mjs';
const a = await session({ marks: '/dev/null' });
const k = (key, code, kc, mod = 0) => a.key(key, code, kc, mod);
await k('Escape', 'Escape', 27); await sleep(300); await k('Escape', 'Escape', 27);
// close all editors: Cmd+K Cmd+W
await k('k', 'KeyK', 75, 4); await k('w', 'KeyW', 87, 4); await sleep(600);
// Quick Open orders.json
await k('p', 'KeyP', 80, 4); await sleep(600); await a.type('orders.json', 20); await sleep(800);
await k('Enter', 'Enter', 13); await sleep(4000);
// dismiss notifications
await a.ev("document.querySelectorAll('.notification-toast .codicon-notifications-clear, .notification-toast .action-label.codicon-close').forEach(b=>b.click())");
a.close();
