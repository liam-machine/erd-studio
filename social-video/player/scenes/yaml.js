// 5 · How the logical model is saved. fct_order.yml reveals line by line (the real v5 model
// file); on "grain, columns, types and keys" each of those lines lights up with a tag while the
// rest dims. On "A domain file…" the YAML card folds up to its tab strip and orders.json takes
// over: the `models` list ("groups the tables") and the relationship entry ("how they join")
// light up, with a mini fct_order * -- 1 dim_customer diagram beside it.
import { appear, card, easeInOut, easeOut, ICON, jsonLine, lerp, seg, STORY, yamlLine } from '../lib.js';

const X = 64, W = 952;
const YML = STORY.fctOrderYml, JSN = STORY.ordersJson;

// YAML card
const Y_TOP = 314, Y_H = 764;
const Y_PITCH = 42, Y_FONT = 28, Y_CW = Y_FONT * 0.6;    // JetBrains Mono advance ≈ 0.6em
const CODE_L = 30, TX = 84;                              // body-relative code left, text offset (style.css .code__tx)
// JSON card
const J_TOP = 380, J_H = 708;
const J_PITCH = 38, J_FONT = 26, J_CW = J_FONT * 0.6;

const TAG_X = 700;                                        // body-relative x of the tag column (YAML)
const JTAG_X = 684;                                       // …and in orders.json

const rgba = (rgb, a) => `rgba(${rgb},${a.toFixed(3)})`;
const C = {
  blue: '96,165,250', green: '34,197,94', cyan: '120,192,244', purple: '196,144,232', orange: '236,168,108', amber: '244,180,44', fk: '96,162,249',
};

function tagPill(label, rgb, style = '', icon = '') {
  return `<span class="abs pill" style="background:${rgba(rgb, 0.16)};border:2px solid ${rgba(rgb, 0.9)};color:rgb(${rgb});font-size:24px;font-weight:800;letter-spacing:.04em;padding:3px 14px;${style}">${icon}${label}</span>`;
}

const fileIcon = (col) => `<span style="color:${col}">${ICON.file({ size: 22 })}</span>`;

export default {
  render(t, { beats }) {
    const b = beats;
    // ---- timing (scene-local seconds; words from the real narration) ----
    const revealAt = b.file.t + 0.15, perLine = 0.11;     // done by ~2.2, "…one small YAML file"
    const fields = b.fields.t;
    const dimAt = fields + 0.3;
    const HL = [                                           // "with its grain, columns, types and keys"
      { line: 2, tag: 'GRAIN', rgb: C.green, at: fields + 0.45 },
      { line: 4, tag: 'COLUMNS', rgb: C.purple, at: fields + 0.85, also: [5, 8, 11, 13] },
      { line: 6, tag: 'TYPE', rgb: C.cyan, at: fields + 1.3 },
      { line: 7, tag: 'PRIMARY KEY', rgb: C.amber, at: fields + 1.8 },
      { line: 10, tag: 'FOREIGN KEY', rgb: C.fk, at: fields + 2.0 },
    ];
    const dom = b.domain.t;
    const fold = easeInOut(seg(t, dom - 0.05, dom + 0.5));
    const jsonIn = dom + 0.2;
    const jRevealAt = dom + 0.45, jPer = 0.04;
    const tablesAt = dom + 1.3;                            // "…groups the tables"
    const joinAt = dom + 2.15;                             // "…says how they join"
    const jDimAt = tablesAt - 0.1;

    let html = '';

    // ================= fct_order.yml =================
    const yH = lerp(Y_H, 64, fold), yY = lerp(Y_TOP, 300, fold);
    let ybody = '';
    if (fold < 1) {
      const dimP = seg(t, dimAt, dimAt + 0.3);
      // highlight rows + tags
      HL.forEach((h) => {
        if (t < h.at) return;
        const q = easeOut(seg(t, h.at, h.at + 0.3));
        const rows = [h.line];
        rows.forEach((ln) => {
          ybody += `<div class="abs" style="left:12px;top:${24 + ln * Y_PITCH}px;width:${W - 26}px;height:${Y_PITCH}px;background:${rgba(h.rgb, 0.13 * q)};border-left:5px solid ${rgba(h.rgb, q)};border-radius:4px"></div>`;
        });
        (h.also ?? []).forEach((ln) => {
          ybody += `<div class="abs" style="left:12px;top:${24 + ln * Y_PITCH}px;width:5px;height:${Y_PITCH}px;background:${rgba(h.rgb, 0.7 * q)}"></div>`;
        });
        const endX = CODE_L + TX + YML[h.line].length * Y_CW + 18;
        const cy = 24 + h.line * Y_PITCH + Y_PITCH / 2;
        ybody += `<div class="abs" style="left:${endX}px;top:${cy - 1}px;width:${Math.max(0, (TAG_X - 14 - endX) * q)}px;height:0;border-top:2px dashed ${rgba(h.rgb, 0.7)}"></div>`;
        ybody += tagPill(h.tag, h.rgb, `left:${TAG_X}px;top:${cy - 22}px;${appear(t, h.at + 0.1, { dy: 0, dx: 12, dur: 0.3 })}`);
      });
      // code
      let code = '';
      YML.forEach((ln, i) => {
        const at = revealAt + i * perLine;
        if (t < at) return;
        const hl = HL.find((h) => h.line === i || (h.also ?? []).includes(i));
        const lit = hl && t >= hl.at ? easeOut(seg(t, hl.at, hl.at + 0.25)) : 0;
        const op = lerp(1, 0.38, dimP) + (1 - lerp(1, 0.38, dimP)) * lit;
        code += `<div class="code__ln" style="top:${i * Y_PITCH}px;opacity:${op.toFixed(3)}">${i + 1}</div><div class="code__tx" style="top:${i * Y_PITCH}px;opacity:${op.toFixed(3)};${appear(t, at, { dur: 0.18, dy: 0, dx: -8 })}">${yamlLine(ln)}</div>`;
      });
      ybody += `<div class="code" style="left:${CODE_L}px;top:24px;width:${W - 60}px;font-size:${Y_FONT}px;line-height:${Y_PITCH}px">${code}</div>`;
      // "one file per table" note, bottom right, while the file reveals
      const noteOp = seg(t, b.file.t + 1.2, b.file.t + 1.5) * (1 - seg(t, dimAt, dimAt + 0.3));
      if (noteOp > 0) {
        ybody += `<div class="abs" style="left:${TAG_X - 40}px;top:${24 + 12 * Y_PITCH}px;width:${W - TAG_X + 10}px;opacity:${noteOp.toFixed(3)};white-space:nowrap">
          <div style="font-size:26px;font-weight:700;color:var(--text)">One file per table</div>
          <div style="margin-top:6px;font-size:24px;color:var(--text-2)">plain YAML, in git</div></div>`;
      }
    }
    const tablesGlow = seg(t, tablesAt, tablesAt + 0.3);
    const tabStyle = () => (tablesGlow > 0 ? `color:${rgba(C.blue, 0.4 + 0.6 * tablesGlow)};font-weight:700;` : '');
    const ytabs = [
      { label: `<span style="${tabStyle()}">dim_customer.yml</span>`, icon: fileIcon('#d9b35a') },
      { label: `<span style="${tabStyle()}">fct_order.yml</span>`, on: true, icon: fileIcon('#d9b35a') },
    ];
    html += card({
      x: X, y: yY, w: W, h: yH, tabs: ytabs, crumb: '.erd-studio › logical-models',
      headStyle: 'font-size:24px', body: ybody, style: `${appear(t, 0, { dy: 20 })}${fold > 0 ? `opacity:${lerp(1, 0.85, fold).toFixed(3)};` : ''}`,
    });

    // ================= orders.json =================
    if (t >= jsonIn) {
      const jDim = seg(t, jDimAt, jDimAt + 0.3);
      let jbody = '';
      const MODELS = 5, REL0 = 6, REL1 = 12;
      const lit = (i) => {
        if (i === MODELS) return easeOut(seg(t, tablesAt, tablesAt + 0.25));
        if (i >= REL0 && i <= REL1) return easeOut(seg(t, joinAt, joinAt + 0.25));
        return 0;
      };
      // models row
      if (t >= tablesAt) {
        const q = easeOut(seg(t, tablesAt, tablesAt + 0.3));
        jbody += `<div class="abs" style="left:12px;top:${20 + MODELS * J_PITCH}px;width:${W - 26}px;height:${J_PITCH}px;background:${rgba(C.blue, 0.14 * q)};border-left:5px solid ${rgba(C.blue, q)};border-radius:4px"></div>`;
        jbody += tagPill('THE TABLES', C.blue, `left:${JTAG_X}px;top:${20 + 3 * J_PITCH - 4}px;${appear(t, tablesAt + 0.1, { dy: 0, dx: 12, dur: 0.3 })}`, ICON.chevDown({ size: 20, sw: 3 }));
      }
      // relationships block + mini diagram
      if (t >= joinAt) {
        const q = easeOut(seg(t, joinAt, joinAt + 0.3));
        jbody += `<div class="abs" style="left:12px;top:${20 + REL0 * J_PITCH}px;width:${W - 26}px;height:${(REL1 - REL0 + 1) * J_PITCH}px;background:${rgba(C.blue, 0.1 * q)};border-left:5px solid ${rgba(C.blue, q)};border-radius:4px"></div>`;
        const mx = JTAG_X, my = 20 + REL0 * J_PITCH + 6;
        jbody += tagPill('HOW THEY JOIN', C.blue, `left:${mx}px;top:${my}px;${appear(t, joinAt + 0.1, { dy: 0, dx: 12, dur: 0.3 })}`);
        const chip = (label, y, at) => `<div class="abs mono" style="left:${mx}px;top:${y}px;height:46px;padding:0 16px;display:flex;align-items:center;border-radius:10px;background:#17181c;border:2.5px solid var(--logical);font-size:24px;font-weight:500;white-space:nowrap;${appear(t, at, { dy: 8 })}">${label}</div>`;
        const c1 = my + 62, c2 = c1 + 46 + 84;
        const lp = easeOut(seg(t, joinAt + 0.3, joinAt + 0.55));
        const lx = mx + 34;
        jbody += chip('fct_order', c1, joinAt + 0.2);
        jbody += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M${lx} ${c1 + 46} V${c1 + 46 + 84 * lp}" stroke="var(--logical)" stroke-width="3" fill="none"/></svg>`;
        if (lp >= 1) {
          jbody += `<div class="abs mono" style="left:${lx + 12}px;top:${c1 + 44}px;font-size:28px;font-weight:800;color:var(--logical)">*</div>`;
          jbody += `<div class="abs mono" style="left:${lx + 12}px;top:${c2 - 32}px;font-size:24px;font-weight:800;color:var(--logical)">1</div>`;
          jbody += `<div class="abs mono" style="left:${lx + 44}px;top:${c1 + 64}px;font-size:24px;color:var(--text-2);${appear(t, joinAt + 0.6, { dy: 0 })}">customer_id</div>`;
        }
        jbody += chip('dim_customer', c2, joinAt + 0.4);
      }
      let code = '';
      JSN.forEach((ln, i) => {
        const at = jRevealAt + i * jPer;
        if (t < at) return;
        const base = lerp(1, 0.38, jDim);
        const op = base + (1 - base) * lit(i);
        code += `<div class="code__ln" style="top:${i * J_PITCH}px;opacity:${op.toFixed(3)}">${i + 1}</div><div class="code__tx" style="top:${i * J_PITCH}px;opacity:${op.toFixed(3)};${appear(t, at, { dur: 0.16, dy: 0, dx: -8 })}">${jsonLine(ln)}</div>`;
      });
      jbody += `<div class="code" style="left:${CODE_L}px;top:20px;width:${W - 60}px;font-size:${J_FONT}px;line-height:${J_PITCH}px">${code}</div>`;
      html += card({
        x: X, y: J_TOP, w: W, h: J_H,
        tabs: [{ label: 'orders.json', on: true, icon: fileIcon('var(--syn-val)') }], crumb: '.erd-studio › silver · the domain file',
        headStyle: 'font-size:24px', body: jbody, style: `z-index:2;${appear(t, jsonIn, { dy: 40, dur: 0.45 })}`,
      });
    }
    return html;
  },
};
