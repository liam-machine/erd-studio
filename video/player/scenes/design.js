// 5 · "That's your Logical design. / Click a table to see its columns and keys. / It's saved as
// plain files in your repo, next to your SQL." The laid-out canvas from the canvas scene. The
// Logical tab pulses on "Logical"; the pointer clicks fct_orders and the detail panel slides in
// (its real section titles: "Columns (4)", "Relationships (2)", arrows and cardinality as the
// panel prints them), the key badges light on "…and keys". On `files` the panel closes and the
// Explorer slides in over the canvas: the domain file and one YAML per model under .erd-studio,
// beside models/marts; fct_orders.yml and fct_orders.sql light together on "next to your SQL".
import { appear, easeOut, edge, ICON, path, pointer, seg, toolbar } from '../lib.js';
import { BODY, CANVAS, MODELS, editorWindow, nodeH, orderEdges, orderNode } from '../editor.js';

// Detail panel copy (packages/renderer/src/components/DetailPanel): section titles and the
// relationship rows as the panel prints them for fct_orders.
export const PANEL = {
  columns: 'Columns (4)',
  relationships: 'Relationships (2)',
  rels: [
    { dir: 'out', left: 'customer_id', right: 'dim_customers.customer_id', card: 'many-to-one' },
    { dir: 'in', left: 'fct_order_items.order_id', right: 'order_id', card: 'many-to-one' },
  ],
};

const PW = 560;                                   // panel width
const PX = BODY.x + BODY.w - PW;
const FO = MODELS[1];

export default {
  render(t, { beats, dur }) {
    const D = beats.design.t, K = beats.click.t, F = beats.files.t;
    // g_design: "That's your Logical design."(+0.0–1.56) — "Logical" at ~+0.55
    const tabPulse = D + 0.5;
    // g_click: "Click a table"(+0.0–0.8) "to see its columns and keys."(+0.9–2.28)
    const clickAt = K + 0.6;
    const panelAt = clickAt + 0.15;
    const keysAt = K + 1.75;                     // "…and keys"
    // g_files: "It's saved as plain files"(+0.0–1.5) "in your repo,"(+1.5–2.2) "next to your SQL."(+2.3–3.4)
    const panelOut = F - 0.05;
    const treeAt = F + 0.15;
    const sqlAt = F + 2.3;

    let html = editorWindow({ tabs: [{ label: 'orders.json', on: true }], crumb: '.erd-studio › gold › orders.json', bodyCls: 'grid-bg' });
    html += toolbar({ x: CANVAS.toolbarX, y: CANVAS.toolbarY, stage: 'logical' });
    // the Logical tab pulses (a ring over the toolbar's tab, measured from the rendered toolbar)
    const pulse = seg(t, tabPulse, tabPulse + 0.25) * (1 - seg(t, tabPulse + 1.1, tabPulse + 1.5));
    if (pulse > 0) {
      html += `<div class="abs" style="left:${CANVAS.toolbarX + 166}px;top:${CANVAS.toolbarY + 8}px;width:114px;height:49px;border-radius:12px;box-shadow:0 0 0 ${(4 + 2 * Math.sin(t * 7)).toFixed(1)}px rgba(147,197,253,${pulse.toFixed(3)}),0 0 36px rgba(96,165,250,${(0.8 * pulse).toFixed(3)})"></div>`;
    }

    for (const [pts, many, one] of orderEdges()) html += edge(pts, { many, one });
    const keyGlow = seg(t, keysAt, keysAt + 0.3) * (1 - seg(t, keysAt + 1.2, keysAt + 1.6));
    MODELS.forEach((m) => {
      let h = orderNode(m);
      if (keyGlow > 0) h = h.replaceAll('class="badge badge--pk"', `class="badge badge--pk" style="box-shadow:0 0 0 ${(3 * keyGlow).toFixed(1)}px #f4b42c88"`).replaceAll('class="badge badge--fk"', `class="badge badge--fk" style="box-shadow:0 0 0 ${(3 * keyGlow).toFixed(1)}px #60a2f988"`);
      html += h;
    });
    // selection ring on fct_orders
    const sel = seg(t, clickAt, clickAt + 0.15) * (1 - seg(t, panelOut, panelOut + 0.3));
    if (sel > 0) html += `<div class="abs" style="left:${FO.x - 5}px;top:${FO.y - 5}px;width:${FO.w + 10}px;height:${nodeH(FO) + 10}px;border-radius:20px;border:3px solid rgba(255,255,255,${(0.85 * sel).toFixed(3)});box-shadow:0 0 30px rgba(96,165,250,${(0.5 * sel).toFixed(3)})"></div>`;

    // ---- detail panel ----
    const pin = easeOut(seg(t, panelAt, panelAt + 0.35)) * (1 - easeOut(seg(t, panelOut, panelOut + 0.3)));
    if (pin > 0) {
      const colRows = FO.cols.map((c, i) => `<div class="abs" style="left:24px;right:24px;top:${118 + i * 44}px;height:40px;display:flex;align-items:center;gap:12px;font-size:21px;white-space:nowrap">
          <span style="width:42px;display:flex">${c.key ? `<span class="badge badge--${c.key.toLowerCase()}"${keyGlow > 0 ? ` style="box-shadow:0 0 0 ${(3 * keyGlow).toFixed(1)}px ${c.key === 'PK' ? '#f4b42c88' : '#60a2f988'}"` : ''}>${c.key}</span>` : ''}</span>
          <span style="flex:1">${c.name}</span><span class="mono" style="font-size:19px;color:var(--type)">${c.type}</span></div>`).join('');
      const arrow = ICON.arrow({ size: 18, style: 'color:var(--text-3)' });
      const relRows = PANEL.rels.map((r, i) => `<div class="abs" style="left:24px;right:24px;top:${378 + i * 48}px;height:42px;display:flex;align-items:center;gap:10px;padding:0 12px;border-radius:6px;background:#ffffff08;font-size:19px;white-space:nowrap">
          <span style="display:flex;${r.dir === 'in' ? 'transform:scaleX(-1);' : ''}">${arrow}</span>
          <span class="mono" style="font-size:18px;color:${r.dir === 'out' ? 'var(--text)' : 'var(--logical)'}">${r.left}</span>${arrow}<span class="mono" style="font-size:18px;color:${r.dir === 'out' ? 'var(--logical)' : 'var(--text)'}">${r.right}</span>
          <span style="flex:1"></span><span style="color:var(--text-2);font-size:17px">${r.card}</span></div>`).join('');
      html += `<div class="abs" style="left:${PX}px;top:${BODY.y}px;width:${PW}px;height:${BODY.h}px;background:#1d1e22;border-left:1px solid var(--card-border);box-shadow:-20px 0 50px #0008;border-radius:0 0 20px 0;opacity:${pin.toFixed(3)};transform:translateX(${(60 * (1 - pin)).toFixed(1)}px)">
        <div class="abs" style="left:24px;top:22px;display:flex;align-items:center;gap:12px;font-size:28px;font-weight:700;white-space:nowrap">${FO.name}<span class="badge badge--gld">GLD</span></div>
        <div class="abs" style="right:22px;top:26px;color:var(--text-2)">${ICON.x({ size: 22, sw: 2.4 })}</div>
        <div class="abs" style="left:24px;top:80px;font-size:17px;font-weight:700;letter-spacing:.06em;color:var(--text-2)">${PANEL.columns.toUpperCase()}</div>
        ${colRows}
        <div class="abs" style="left:24px;top:${118 + 4 * 44 + 22}px;right:24px;height:1px;background:var(--card-border)"></div>
        <div class="abs" style="left:24px;top:338px;font-size:17px;font-weight:700;letter-spacing:.06em;color:var(--text-2)">${PANEL.relationships.toUpperCase()}</div>
        ${relRows}
      </div>`;
    }

    // ---- the Explorer: the design is plain files in the repo ----
    if (t >= treeAt) {
      const X = BODY.x, Y = BODY.y, W = 600;
      const sqlGlow = easeOut(seg(t, sqlAt, sqlAt + 0.35));
      const rows = [
        [0, 'folder', '.erd-studio'], [1, 'folder', 'gold'], [2, 'json', 'orders.json'],
        [1, 'folder', 'logical-models'], [2, 'folder', 'gold'],
        [3, 'yml', 'dim_customers.yml'], [3, 'yml', 'fct_orders.yml', true], [3, 'yml', 'fct_order_items.yml'], [3, 'yml', 'dim_products.yml'],
        [0, 'folder', 'models'], [1, 'folder', 'marts'], [2, 'sql', 'fct_orders.sql', true],
      ];
      const colour = { folder: '#d9b35a', json: '#e8c46a', yml: '#c490e8', sql: '#5ca2f8' };
      let r = '';
      rows.forEach(([d, kind, label, pair], i) => {
        const y = 58 + i * 38;
        const at = treeAt + 0.1 + i * 0.05;
        const hot = pair ? sqlGlow : 0;
        r += `<div class="abs" style="left:0;top:${y}px;width:${W}px;height:38px;background:rgba(34,197,94,${(0.16 * hot).toFixed(3)});${hot > 0 ? `box-shadow:inset 4px 0 0 rgba(34,197,94,${hot.toFixed(3)});` : ''}${appear(t, at, { dy: 0, dx: -10 })}"></div>
          <div class="abs" style="left:${20 + d * 26}px;top:${y + 5}px;display:flex;align-items:center;gap:10px;font-size:22px;white-space:nowrap;color:${kind === 'folder' ? 'var(--text)' : '#c9ced6'};${appear(t, at, { dy: 0, dx: -10 })}">
            <span style="color:var(--text-3);width:18px;display:flex">${kind === 'folder' ? ICON.chevDown({ size: 18, sw: 2.6 }) : ''}</span>
            <span style="color:${colour[kind]};display:flex">${kind === 'folder' ? ICON.folder({ size: 22 }) : ICON.file({ size: 22 })}</span>${label}</div>`;
      });
      const p = easeOut(seg(t, treeAt, treeAt + 0.4));
      html += `<div class="abs" style="left:${X}px;top:${Y}px;width:${W}px;height:${BODY.h}px;background:#16181b;border-right:1px solid var(--card-border);box-shadow:20px 0 50px #0009;border-radius:0 0 0 20px;overflow:hidden;opacity:${p.toFixed(3)};transform:translateX(${(-50 * (1 - p)).toFixed(1)}px)">
        <div class="abs" style="left:22px;top:16px;font-size:19px;font-weight:700;letter-spacing:.08em;color:var(--text-2)">EXPLORER</div>${r}</div>`;
    }

    // pointer: onto fct_orders' header, click, then drift off
    const target = { x: FO.x + 120, y: FO.y + 30 };
    if (t < F + 0.3) {
      const pt = path(t, [{ t: K - 0.2, x: 1300, y: 860 }, { t: clickAt - 0.1, ...target }, { t: F - 0.3, ...target }, { t: F + 0.3, x: target.x + 120, y: target.y + 300 }]);
      const op = Math.min(seg(t, K - 0.3, K), 1 - seg(t, F - 0.1, F + 0.3));
      if (op > 0) html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, seg(t, clickAt, clickAt + 0.4))}</div>`;
    }
    return html;
  },
};
