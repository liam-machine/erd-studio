// 9 · Claude checks its own work: the same comparison as the canvas Diff button flags one type
// difference (drawn the way the canvas draws a type mismatch: the row highlighted, both stages'
// types stacked), Claude fixes the model file, re-runs the diff and gets 0 differences.
import { appear, card, COLORS, edge, ICON, mix, node, rowY, seg, spinner, tick, toolbar } from '../lib.js';

const Y = 322, H = 600;
const LX = 96, LW = 1110, RX = LX + LW + 36, RW = 1824 - RX;

export default {
  render(t, { beats }) {
    const cmp = beats.compare.t, fix = beats.fix.t;
    const diffOn = cmp + 2.6;           // "…just like the Diff button"
    const found = cmp + 3.2;
    const fixed = fix + 1.8;            // "…gets fixed"
    const again = fix + 2.4;            // "…checks again"
    const clean = fix + 3.9;            // "…no differences" (script.yaml accentAfter.offset matches)

    const diffState = t < diffOn ? 'off' : t < clean ? 'amber' : 'green';
    let html = card({ x: LX, y: Y, w: LW, h: H, tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold › orders.json', bodyCls: 'grid-bg', style: appear(t, 0) });
    html += toolbar({ x: LX + 250, y: Y + 64 + 22, stage: 'logical', diff: diffState, style: appear(t, 0.2) });

    // Diff count pill beside the toolbar
    if (t >= found) {
      const isClean = t >= clean;
      html += `<span class="abs pill" style="left:${LX + 800}px;top:${Y + 64 + 32}px;background:${isClean ? '#13301f' : 'var(--amber-row)'};color:${isClean ? 'var(--green)' : 'var(--amber)'};${appear(t, isClean ? clean : found, { dy: 6 })}">${isClean ? `${ICON.check({ size: 20 })}0 differences` : '1 difference'}</span>`;
    }

    const dc = { x: LX + 40, y: Y + 64 + 130 }, fo = { x: LX + 470, y: Y + 64 + 150 };
    const W1 = 340, W2 = 590;
    const cy = fo.y + rowY(1);
    const sy = dc.y + rowY(0), mx = (dc.x + W1 + fo.x) / 2;
    html += edge([[dc.x + W1, sy], [mx, sy], [mx, cy], [fo.x, cy]], { one: [dc.x + W1 + 10, sy - 10], many: [fo.x - 24, cy - 8], opacity: 1 });
    html += node({ x: dc.x, y: dc.y, w: W1, name: 'dim_customer', grain: 'One row per customer',
      cols: [{ key: 'PK', name: 'customer_key', type: 'INT' }, { name: 'email', type: 'VARCHAR' }], style: appear(t, 0.3) });

    // The order_total row: plain -> amber mismatch -> green fixed -> plain.
    const flagged = t >= found && t < fixed;
    const isFixed = t >= fixed;
    const hot = flagged ? seg(t, found, found + 0.3) : isFixed ? 1 - seg(t, clean + 1.2, clean + 2) : 0;
    const orderTotal = flagged
      ? { name: 'order_total', row: 'amber', rowStyle: `opacity:${(0.4 + 0.6 * hot).toFixed(2)}`, types: [['logical', 'FLOAT', COLORS.logical], ['physical', 'DECIMAL(18,2)', COLORS.physical]] }
      : isFixed
        ? { name: 'order_total', type: 'DECIMAL(18,2)', row: hot > 0.02 ? 'green' : undefined, rowStyle: hot > 0.02 ? `background:rgba(19,48,31,${hot.toFixed(2)})` : '' }
        : { name: 'order_total', type: 'FLOAT' };
    html += node({ x: fo.x, y: fo.y, w: W2, name: 'fct_order', grain: 'One row per order',
      cols: [{ key: 'PK', name: 'order_id', type: 'INT' }, { key: 'FK', name: 'customer_key', type: 'INT' }, { name: 'order_date', type: 'DATE' }, orderTotal],
      style: appear(t, 0.45) });

    // Callout under the node (the reference video's amber note, green once fixed)
    if (t >= found + 0.3) {
      const g = seg(t, fixed, fixed + 0.3);
      const border = mix('#f4b42c', '#22c55e', g), bg = mix('#2a2414', '#132a1c', g);
      const title = isFixed ? 'Fixed in fct_order.yml' : 'Type differs from dbt';
      const body = isFixed ? 'logical now says DECIMAL(18,2)' : 'logical FLOAT, physical DECIMAL(18,2)';
      const ry = fo.y + rowY(3);
      html += edge([[dc.x + 400, ry], [fo.x, ry]], { color: border, dash: true, width: 2.5, opacity: seg(t, found + 0.3, found + 0.6) });
      html += `<div class="abs" style="left:${dc.x}px;top:${ry - 44}px;width:400px;padding:16px 22px;border-radius:14px;border:2px solid ${border};background:${bg};${appear(t, found + 0.3, { dy: 8 })}">
        <div style="font-size:23px;font-weight:700;color:${border}">${title}</div><div style="margin-top:4px;font-size:19px;color:#d6d9de;white-space:nowrap">${body}</div></div>`;
    }

    // Right: Claude's log of the same loop.
    html += card({ x: RX, y: Y, w: RW, h: H, tabs: [{ label: 'Claude Code', on: true, icon: `<span style="color:var(--claude)">${ICON.claude({ size: 20 })}</span>` }], style: appear(t, 0.1) });
    const log = [
      { at: cmp + 0.3, dot: true, text: 'Comparing logical with physical' },
      { at: cmp + 0.7, tool: 'Bash(erd-studio diff --json)' },
      { at: found, res: 'amber', text: '1 difference: fct_order.order_total' },
      { at: fix + 1.0, dot: true, text: 'Fixing it to match dbt' },
      { at: fix + 1.4, tool: 'Update(fct_order.yml)' },
      { at: again, dot: true, text: 'Checking again' },
      { at: again + 0.3, tool: 'Bash(erd-studio diff --json)' },
      { at: clean, res: 'green', text: '0 differences' },
    ];
    log.forEach((l, i) => {
      if (t < l.at) return;
      const y = Y + 64 + 30 + i * 60;
      const x = RX + 34 + (l.dot ? 0 : 32);
      let inner;
      if (l.dot) inner = `<span class="dot"></span><span style="font-size:24px;font-weight:600">${l.text}</span>`;
      else if (l.tool) {
        const pending = (l.tool.startsWith('Bash') && ((i === 1 && t < found) || (i === 6 && t < clean)));
        inner = `${pending ? spinner(t, 20) : `<span style="color:var(--text-3)">${ICON.chevRight({ size: 20 })}</span>`}<span class="tool">${l.tool}</span>`;
      } else inner = `${tick(l.res === 'green' ? 'ok' : 'warn')}<span style="font-size:22px;font-weight:600;color:${l.res === 'green' ? 'var(--green)' : 'var(--amber)'}">${l.text}</span>`;
      html += `<div class="abs" style="left:${x}px;top:${y}px;display:flex;align-items:center;gap:14px;white-space:nowrap;${appear(t, l.at, { dy: 0, dx: -10 })}">${inner}</div>`;
    });
    return html;
  },
};
