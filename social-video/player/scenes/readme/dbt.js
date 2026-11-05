// readme · 9 · dbt — the short last beat. The same diagram (status included), now in a folder
// with a dbt project: on "Open the project" the toolbar gains Compare with dbt and the second
// row of stage tabs ("Logical · your design", "Physical · read from dbt" — dbt projects only).
// On "Physical" the canvas flips to the read-only Physical stage (green, the lock on its tab, no
// + Add): what the dbt project has — order_date a TIMESTAMP, an extra loaded_at column, and no
// relationship (no relationships test). Back on Logical, Compare with dbt marks the three
// differences the way the canvas draws them (packages/renderer ModelNode): the two types stacked,
// loaded_at as a ghost row under "only in physical" with its "physical only" badge, and the
// relationship dbt lacks as a dashed amber edge. The DiscrepancyPanel (bottom right) carries
// the counts in its own labels: "Logical (current) vs Physical (target)", matched, type diff,
// col diff, rel diff, ⊕ Sync.
import { appear, appearFade, card, COLORS, easeInOut, easeOut, edge, ICON, node, path, pointer, rowY, seg } from '../../lib.js';
import { FILE_COL, R, TB, toolbar2, viewFileBtn, wordAt } from './story.js';
import { GEO } from './canvas.js';

const { CX, CY, CW } = GEO;
const CH = 1088 - CY;                 // the whole stage: the panel sits inside the canvas
const TBX = CX + 24, TBY = CY + 64 + 16;
const NY = CY + 214;
const DX = CX + 20, DW = 350;
const FX = DX + DW + 82, FW = 490;
const MIDX = (DX + DW + FX) / 2;
const D = R.drift;
const RIGHT = 1080 - CX - CW + 24;    // `right:` of things aligned to the canvas's right edge

const svgIcon = (d, size = 22) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">${d}</svg>`;
const circlePlus = svgIcon('<circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/>', 20);

export default {
  render(t, { beats, scene }) {
    const Cm = beats.compare.t;
    const tabsAt = wordAt(scene, 'open', 'project') - 0.1;
    const physAt = wordAt(scene, 'open', 'Physical') - 0.05;
    const hasAt = wordAt(scene, 'open', 'shows');
    const backAt = beats.open.end + 0.05;
    const pressAt = Cm + 0.15;
    const diffAt = wordAt(scene, 'compare', 'marks');

    const toPhys = easeInOut(seg(t, physAt, physAt + 0.5));
    const toLog = easeInOut(seg(t, backAt, backAt + 0.4));
    const p = toPhys * (1 - toLog);          // 0 logical .. 1 physical
    const physical = p > 0.5;
    const comparing = t >= pressAt + 0.1;
    const lit = (at) => easeOut(seg(t, at, at + 0.3));
    const m1 = lit(diffAt), m2 = lit(diffAt + 0.3), m3 = lit(diffAt + 0.6);

    let html = card({
      x: CX, y: CY, w: CW, h: CH, tabs: [{ label: 'sales.dbml', on: true, icon: `<span style="color:${FILE_COL.dbml}">${ICON.file({ size: 20 })}</span>` }],
      crumb: t >= tabsAt ? 'a dbt project' : '.erd-studio › gold › diagrams', bodyCls: 'grid-bg',
    });
    const stage = t >= tabsAt ? (physical ? 'physical' : 'logical') : null;
    const compare = t < tabsAt ? null : comparing ? 'on' : t >= pressAt - 0.05 ? 'press' : 'off';
    html += toolbar2({ x: TBX, y: TBY, stage, compare, tabsStyle: appear(t, tabsAt, { dy: -8, dur: 0.3 }) });
    html += viewFileBtn(CX + CW - 24 - 196, TBY + 4);

    // Notes on the tab row's right: "dbt_project.yml found", then "read-only · read from dbt".
    const noteY = TBY + TB.tabsDy + 6;
    if (t >= tabsAt && t < physAt + 0.1) {
      html += `<div class="abs" style="right:${RIGHT}px;top:${noteY}px;${appear(t, tabsAt, { dy: 6 })}"><span class="pill" style="font-size:22px;padding:5px 16px;background:#1c1e23;border:1px solid #34363d;color:var(--text-2)"><span class="mono">dbt_project.yml</span> found</span></div>`;
    }
    if (t >= hasAt - 0.3 && t < backAt) {
      html += `<div class="abs" style="right:${RIGHT}px;top:${noteY}px;${appearFade(t, hasAt - 0.3, 1 - seg(t, backAt - 0.25, backAt), { dy: 6 })}"><span class="pill" style="font-size:22px;padding:5px 16px;background:#13301f;color:var(--green);border:1px solid #1f5a35">${ICON.lock({ size: 18 })}read-only · read from dbt</span></div>`;
    }

    // ---- edge: logical draws it; physical has none; the comparison ghosts it amber ----
    const sy = NY + rowY(0), ey = NY + rowY(1);
    const pts = [[DX + DW, sy], [MIDX, sy], [MIDX, ey], [FX, ey]];
    if (m3 > 0) html += edge(pts, { color: COLORS.amber, dash: true, width: 3.5, one: [DX + DW + 8, sy - 10], many: [FX - 22, ey - 8], opacity: m3 });
    else if (p < 1) html += edge(pts, { color: COLORS.logical, one: [DX + DW + 8, sy - 10], many: [FX - 22, ey - 8], opacity: 1 - p });

    // ---- nodes: fct_order keeps the status column the canvas and PR scenes added ----
    const hot = (a) => (a > 0 ? `background:rgba(56,48,28,${a.toFixed(3)});box-shadow:inset 5px 0 0 rgba(244,180,44,${a.toFixed(3)});` : '');
    const [orderId, customerId, , orderTotal] = R.fct_order.cols;
    const status = { name: R.newCol.name, type: R.newCol.type };
    let cols;
    if (physical) {
      cols = [orderId, customerId, { name: D.typeCol, type: D.typePhysical }, orderTotal, status, { name: D.physOnly.name, type: D.physOnly.type }];
    } else {
      cols = [
        orderId, customerId,
        m1 > 0
          ? { name: D.typeCol, types: [['logical', D.typeLogical, COLORS.logical], ['physical', D.typePhysical, COLORS.physical]], rowStyle: hot(m1) }
          : { name: D.typeCol, type: D.typeLogical },
        orderTotal, status,
      ];
      if (m2 > 0) {
        cols.push({ name: '<span style="font-size:15px;font-weight:700;letter-spacing:.06em;color:var(--text-3)">ONLY IN PHYSICAL</span>', type: '', rowStyle: `height:${(30 * m2).toFixed(1)}px;overflow:hidden;opacity:${m2.toFixed(3)};border-top:1px dashed #3a3d45` });
        cols.push({
          name: D.physOnly.name, type: D.physOnly.type, strike: true,
          pill: '<span class="pill" style="font-size:15px;padding:2px 9px;margin-left:6px;background:#2a2c33;color:var(--text-2);border:1px solid #3a3d45">physical only</span>',
          rowStyle: `height:${(46 * m2).toFixed(1)}px;overflow:hidden;opacity:${(0.85 * m2).toFixed(3)};${hot(m2 * 0.7)}`,
        });
      }
    }
    html += node({ x: DX, y: NY, w: DW, name: R.dim_customer.name, layer: R.badge, grain: R.dim_customer.grain, cols: R.dim_customer.cols, stage: p });
    html += node({ x: FX, y: NY, w: FW, name: R.fct_order.name, layer: R.badge, grain: R.fct_order.grain, cols, stage: p });

    // ---- the DiscrepancyPanel, bottom right of the canvas ----
    if (comparing) {
      const PW = 600, PH = 116, px = CX + CW - 24 - PW, py = CY + CH - 16 - PH;
      const stat = (v, label, col, a) => `<span style="display:flex;align-items:baseline;gap:8px;padding:4px 10px;border-radius:8px;${a > 0 ? `background:rgba(244,180,44,${(0.16 * a).toFixed(3)});` : ''}"><span style="font-size:30px;font-weight:800;color:${col}">${v}</span><span style="font-size:20px;color:var(--text-2)">${label}</span></span>`;
      const glow = (at) => easeOut(seg(t, at, at + 0.25)) * (1 - seg(t, at + 0.9, at + 1.4));
      html += `<div class="abs" style="left:${px}px;top:${py}px;width:${PW}px;height:${PH}px;border-radius:12px;background:#1c1e23;border:1px solid #3a3d45;box-shadow:0 18px 44px #000a;padding:10px 18px;white-space:nowrap;${appear(t, pressAt + 0.15, { dy: 14 })}">
        <div style="display:flex;align-items:center;gap:8px;font-size:22px">
          <span style="font-weight:700;color:${COLORS.logical}">Logical</span><span style="font-size:17px;color:var(--text-3)">(current)</span>
          <span style="color:var(--text-2)">vs</span>
          <span style="font-weight:700;color:${COLORS.physical}">Physical</span><span style="font-size:17px;color:var(--text-3)">(target)</span>
          <span style="flex:1"></span>
          <span style="display:flex;align-items:center;gap:6px;padding:4px 14px;border-radius:8px;border:1px solid #3a3d45;font-size:20px;font-weight:600">${circlePlus}Sync</span>
          <span style="color:var(--text-3);display:flex">${ICON.x({ size: 18 })}</span></div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
          ${stat(2, 'matched', 'var(--text)', 0)}${stat(1, 'type diff', 'var(--amber)', glow(diffAt))}${stat(1, 'col diff', 'var(--amber)', glow(diffAt + 0.3))}${stat(1, 'rel diff', 'var(--amber)', glow(diffAt + 0.6))}</div></div>`;
    }

    // Tab clicks (Physical, then Logical) and the Compare press: one pointer.
    const tabY = TBY + TB.tabsDy + TB.tabsH / 2;
    const physTab = { x: TBX + 400, y: tabY }, logTab = { x: TBX + 110, y: tabY }, cmpBtn = { x: TBX + 230, y: TBY + 32 };
    if (t >= physAt - 0.8 && t < pressAt + 0.9) {
      const pt = path(t, [
        { t: physAt - 0.8, x: 760, y: 980 }, { t: physAt - 0.05, ...physTab },
        { t: backAt - 0.3, ...physTab }, { t: backAt - 0.02, ...logTab },
        { t: pressAt - 0.35, ...logTab }, { t: pressAt - 0.02, ...cmpBtn },
        { t: pressAt + 0.9, x: cmpBtn.x + 120, y: cmpBtn.y + 260 },
      ]);
      const tap = (at) => (t >= at && t < at + 0.35 ? seg(t, at, at + 0.35) : 0);
      const press = Math.max(tap(physAt), tap(backAt), tap(pressAt));
      const op = Math.min(seg(t, physAt - 0.8, physAt - 0.5), 1 - seg(t, pressAt + 0.4, pressAt + 0.9));
      html += `<div class="abs" style="left:0;top:0;opacity:${op.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }
    return html;
  },
};
