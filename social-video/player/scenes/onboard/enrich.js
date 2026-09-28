// onboard/enrich · "Then ask your AI assistant to enrich it. / Keys, grain, and the reason behind
// every table, / saved as plain files next to your code."
//
// The /erd-studio-setup command only exists once the walkthrough's last step, "Enrich it with
// your AI assistant", has installed it, so the scene opens on that step: the pointer clicks its
// blue "Set Up My AI Helper" button, and the step gives way to a generic "AI assistant" chat
// panel (no vendor name or mark) where the user types /erd-studio-setup and the assistant replies.
//
// Below it the fct_orders card, big. Its PK / FK badges are already there and stay still: Draw
// from dbt marks them from the unique and relationships tests. On `keys` the assistant adds what
// tests cannot say (the real sample's fct_orders.yml): the natural key badge NK on order_id and
// the additive mark on order_total, then the grain row "One row per order" opens (its slot grows
// from 0 with the text fading in only once it is nearly open), then the WHY note lands under the
// card. Tags sit beside the rows they label. On `repo` the card shrinks aside and an explorer
// card slides in: the .erd-studio files beside models/marts/, with a green "same repo" bracket.
import { appear, card, caret, COLORS, easeInOut, easeOut, ICON, lerp, pointer, path, seg, spinner, typed } from '../../lib.js';

// chat panel / walkthrough step (same slot)
const AX = 64, AY = 300, AW = 952, AH = 224;
// fct_orders card: big and on the left of the lower stage until `repo`, then small at the far left
const NW = 460;                               // wider than a canvas node: PK + NK share the key cell
const S0 = 1.25, NX0 = 96, NY0 = 566;
const S1 = 1.06, NX1 = 64, NY1 = 600;
// explorer card
const TX = 580, TY = 560, TW = 1016 - 580, TH = 1088 - 560;
const PITCH = 41;
// node rows (unscaled, relative to the node's top)
const HEAD = 62, ROW = 46, GRAIN = 46;

const rgba = (rgb, a) => `rgba(${rgb},${a.toFixed(3)})`;
const BLUE = '96,165,250', GRN = '34,197,94', PURP = '168,85,247';
const folderIcon = (col) => `<span style="color:${col};display:flex">${ICON.folder({ size: 26 })}</span>`;
const fileIcon = (col) => `<span style="color:${col};display:flex">${ICON.file({ size: 24 })}</span>`;
// The canvas marks an additive measure with a sigma; drawn as SVG (the font subset has no Greek).
const sigma = (size, col) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 5H6l6.5 7L6 19h12"/></svg>`;

const PROMPT = '/erd-studio-setup';
const COLS = [
  { keys: ['PK'], name: 'order_id', type: 'VARCHAR', nk: true },
  { keys: ['FK'], name: 'customer_id', type: 'VARCHAR' },
  { keys: [], name: 'order_date', type: 'DATE' },
  { keys: [], name: 'order_total', type: 'DECIMAL(16,2)', additive: true },
];

/** fct_orders, drawn with the node classes but a wider key cell (PK + NK side by side). */
function fctOrders({ t, gp, nkAt, sigAt }) {
  const pop = (at) => {
    if (t < at) return null;
    const a = easeOut(seg(t, at, at + 0.3));
    const s = 1 + 0.35 * (1 - a) + 0.12 * Math.sin(Math.PI * seg(t, at, at + 0.5));
    return `opacity:${a.toFixed(3)};transform:scale(${s.toFixed(3)});`;
  };
  const rows = COLS.map((c) => {
    let keys = c.keys.map((k) => `<span class="badge badge--${k.toLowerCase()}">${k}</span>`).join('');
    const nk = c.nk && pop(nkAt);
    if (nk) keys += `<span class="badge" style="background:${rgba(PURP, 0.22)};color:#c084fc;${nk}">NK</span>`;
    const sg = c.additive && pop(sigAt);
    const sig = sg ? `<span style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:${rgba(BLUE, 0.18)};${sg}">${sigma(20, COLORS.logical)}</span>` : '';
    return `<div class="node__row"><span class="node__key" style="width:92px;gap:6px">${keys}</span><span class="node__col">${c.name}</span>${sig}<span class="node__type">${c.type}</span></div>`;
  }).join('');
  const textOp = seg(gp, 0.8, 1);
  const grain = `<div style="height:${(GRAIN * gp).toFixed(1)}px;overflow:hidden;border-bottom:${gp > 0.02 ? 1 : 0}px solid var(--row-line);background:rgba(27,42,64,${(0.9 * gp).toFixed(3)})"><div style="height:${GRAIN}px;display:flex;align-items:center;padding:0 20px;font-size:24px;color:#cfe3ff;white-space:nowrap;opacity:${textOp.toFixed(3)}">One row per order</div></div>`;
  return `<div class="node" style="left:0;top:0;width:${NW}px">
    <div class="node__head"><span class="node__name">fct_orders</span><span class="badge badge--gld">GLD</span></div>${grain}${rows}</div>`;
}

export default {
  render(t, { beats }) {
    const A = beats.ask.t, K = beats.keys.t, R = beats.repo.t;
    // the walkthrough step: the pointer clicks Set Up My AI Helper, then the chat takes the slot
    const clickSetup = A + 0.2;
    const toChat = A + 0.55;                   // step out, chat in (0.3 s)
    // o_ask: "Then ask your AI assistant to enrich it."(+0.0-1.99)
    const typeAt = toChat + 0.3;
    const typeEnd = typeAt + PROMPT.length / 26;
    const thinkAt = typeEnd + 0.05;
    const replyAt = A + 1.65;                  // "…to enrich it"
    // o_keys: "Keys,"(+0.0-0.49) "grain,"(+0.58-1.01) "and the reason behind every table"(+1.25-2.79)
    const nkAt = K + 0.05;                     // "Keys"
    const sigAt = K + 0.4;
    const grainAt = K + 0.62;                  // "grain"
    const whyAt = K + 1.3;                     // "…the reason behind every table"
    // o_repo: "saved as plain files"(+0.0-2.05) "next to your code"
    const moveAt = R - 0.05;
    const treeAt = R + 0.1;
    const nextAt = R + 0.75;

    let html = '';

    // ---------------- the walkthrough step (flash) ----------------
    const stepOp = 1 - seg(t, toChat, toChat + 0.3);
    if (stepOp > 0) {
      const press = seg(t, clickSetup, clickSetup + 0.35);
      const btnBg = press > 0 && press < 1 ? '#0b4f7d' : '#0e639c';
      let step = `<div class="abs" style="left:30px;top:16px;right:30px;height:${AH - 64 - 32}px;border-radius:12px;background:#ffffff0c;border:2px solid rgba(55,148,255,.9);box-shadow:0 0 22px rgba(55,148,255,.3)">
        <span class="abs" style="left:18px;top:20px;width:32px;height:32px;border-radius:50%;border:3px solid #6c6f76;box-sizing:border-box"></span>
        <div class="abs" style="left:66px;top:15px;font-size:27px;line-height:40px;font-weight:700;white-space:nowrap">Enrich it with your AI assistant</div>
        <div class="abs" style="left:66px;top:62px;height:50px;padding:0 24px;border-radius:6px;background:${btnBg};color:#fff;font-size:26px;font-weight:600;display:flex;align-items:center;gap:10px;white-space:nowrap">${ICON.sparkle({ size: 22 })}Set Up My AI Helper</div></div>`;
      html += card({ x: AX, y: AY, w: AW, h: AH, tabs: [{ label: 'Get started with ERD Studio', on: true }], headStyle: 'font-size:24px', body: step, style: `opacity:${stepOp.toFixed(3)}` });
      const pt = path(t, [{ t: 0, x: 620, y: 520 }, { t: clickSetup - 0.02, x: 300, y: 474 }, { t: toChat, x: 300, y: 474 }]);
      html += `<div class="abs" style="left:0;top:0;opacity:${stepOp.toFixed(3)}">${pointer(pt.x, pt.y, press)}</div>`;
    }

    // ---------------- chat panel ----------------
    if (t >= toChat) {
      let chat = '';
      const tl = typed(PROMPT, t, typeAt, 26);
      chat += `<div class="abs" style="left:30px;top:20px;right:30px;height:58px;border-radius:12px;background:var(--card-inner);border:1px solid var(--card-border);display:flex;align-items:center;gap:14px;padding:0 20px;white-space:nowrap">
        <span class="mono" style="font-size:26px;color:var(--text-3)">&gt;</span><span class="mono" style="font-size:28px;color:var(--text)">${tl}</span>${t < thinkAt ? caret(t, typeEnd, 'var(--text)') : ''}</div>`;
      if (t >= thinkAt && t < replyAt) {
        chat += `<div class="abs" style="left:34px;top:102px;display:flex;align-items:center;gap:14px;font-size:26px;color:var(--text-2)">${spinner(t, 28)}Thinking…</div>`;
      }
      if (t >= replyAt) {
        chat += `<div class="abs" style="left:30px;top:96px;right:30px;display:flex;gap:16px;align-items:flex-start;${appear(t, replyAt, { dy: 10 })}">
          <span style="flex:none;width:42px;height:42px;border-radius:50%;background:#1b2a40;color:var(--logical);display:flex;align-items:center;justify-content:center;margin-top:-2px">${ICON.sparkle({ size: 24 })}</span>
          <div style="font-size:27px;line-height:1.4;color:var(--text)">Your diagram mirrors dbt. I'll add <span style="color:var(--logical);font-weight:700">keys, grain and rationale</span>.</div></div>`;
      }
      html += card({ x: AX, y: AY, w: AW, h: AH, tabs: [{ label: 'AI assistant', on: true, icon: `<span style="color:var(--logical)">${ICON.sparkle({ size: 22 })}</span>` }], headStyle: 'font-size:24px', body: chat, style: appear(t, toChat, { dy: 0, dur: 0.3 }) });
    }

    // ---------------- fct_orders card ----------------
    const mv = easeInOut(seg(t, moveAt, moveAt + 0.6));
    const S = lerp(S0, S1, mv), nx = lerp(NX0, NX1, mv), ny = lerp(NY0, NY1, mv);
    const gp = easeInOut(seg(t, grainAt, grainAt + 0.4));
    const gh = GRAIN * gp;
    html += `<div class="abs" style="left:${nx.toFixed(1)}px;top:${ny.toFixed(1)}px;width:${NW}px;height:1px;transform:scale(${S.toFixed(4)});transform-origin:0 0">${fctOrders({ t, gp, nkAt, sigAt })}</div>`;
    const nodeH = HEAD + gh + COLS.length * ROW + 6;

    // tags beside the rows they label (gone when the card moves aside)
    const tagOp = 1 - seg(t, moveAt - 0.1, moveAt + 0.2);
    if (tagOp > 0) {
      const tx = NX0 + NW * S0 + 24;
      const rowMid = (i) => NY0 + S0 * (HEAD + gh + i * ROW + ROW / 2);
      const tag = (label, rgb, at, y) => t < at ? '' : `<span class="abs pill" style="left:${tx}px;top:${(y - 21).toFixed(1)}px;background:${rgba(rgb, 0.16)};border:2px solid ${rgba(rgb, 0.9)};color:rgb(${rgb});font-size:24px;font-weight:800;letter-spacing:.04em;padding:3px 14px;opacity:${(tagOp * easeOut(seg(t, at + 0.05, at + 0.35))).toFixed(3)};transform:translateX(${(10 * (1 - easeOut(seg(t, at + 0.05, at + 0.35)))).toFixed(1)}px)">${label}</span>`;
      html += tag('NATURAL KEY', PURP, nkAt, rowMid(0));
      html += tag('ADDITIVE', BLUE, sigAt, rowMid(3));
      html += tag('GRAIN', GRN, grainAt + 0.25, NY0 + S0 * (HEAD + gh / 2));
    }

    // rationale note, right under the card
    if (t >= whyAt) {
      const noteY = ny + S * nodeH + 18;
      html += `<div class="abs" style="left:${nx.toFixed(1)}px;top:${noteY.toFixed(1)}px;width:${(NW * S).toFixed(0)}px;box-sizing:border-box;padding:14px 22px;border-radius:14px;background:#1b2a40;border:2px solid #2d4a70;${appear(t, whyAt, { dy: 12 })}">
        <div style="font-size:24px;font-weight:800;letter-spacing:.06em;color:var(--logical)">WHY</div>
        <div style="margin-top:4px;font-size:27px;line-height:1.3;color:var(--text);white-space:nowrap">Revenue, tax and cost per order</div></div>`;
    }

    // ---------------- explorer: the files, next to the code ----------------
    if (t >= treeAt) {
      const rows = [
        { d: 0, label: '.erd-studio', folder: true, erd: true },
        { d: 1, label: 'gold', folder: true, erd: true },
        { d: 2, label: 'orders.json', erd: true },
        { d: 1, label: 'logical-models', folder: true, erd: true },
        { d: 2, label: 'dim_customers.yml', erd: true },
        { d: 2, label: 'fct_orders.yml', erd: true, hot: true },
        null,                                   // spacer: the "same repo" pill sits here
        { d: 0, label: 'models', folder: true },
        { d: 1, label: 'marts', folder: true },
        { d: 2, label: 'fct_orders.sql' },
      ];
      const T0 = 16, IND = 30, LEFT = 44;
      let body = '';
      // green band behind the .erd-studio group
      const bandOp = easeOut(seg(t, treeAt + 0.35, treeAt + 0.7));
      body += `<div class="abs" style="left:0;right:0;top:${T0 - 6}px;height:${6 * PITCH + 4}px;background:rgba(19,48,31,${(0.85 * bandOp).toFixed(3)})"></div>`;
      rows.forEach((r, i) => {
        if (!r) return;
        const col = r.erd ? '#d9fbe5' : 'var(--text)';
        const ic = r.folder ? folderIcon(r.erd ? '#22c55e' : '#8b9099') : fileIcon(r.label.endsWith('.sql') ? '#d9b35a' : '#22c55e');
        body += `<div class="abs mono" style="left:${LEFT + r.d * IND}px;top:${T0 + i * PITCH}px;height:${PITCH}px;display:flex;align-items:center;gap:10px;font-size:25px;color:${col};white-space:nowrap;${r.hot ? 'font-weight:700;' : ''}${appear(t, treeAt + 0.1 + i * 0.04, { dy: 0, dx: 14, dur: 0.3 })}">${ic}${r.label}${r.folder ? '<span style="color:var(--text-3)">/</span>' : ''}</div>`;
      });
      // bracket down the left: the design files and the dbt code, one repo
      const bp = easeOut(seg(t, nextAt, nextAt + 0.45));
      if (bp > 0) {
        const y0 = T0 + 6, y1 = T0 + 10 * PITCH - 6, ym = lerp(y0, y1, bp);
        body += `<svg class="abs" style="left:0;top:0;overflow:visible" width="1" height="1"><path d="M30 ${y0} L18 ${y0} L18 ${ym.toFixed(1)}${bp > 0.98 ? ` L30 ${y1}` : ''}" fill="none" stroke="${COLORS.green}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        body += `<span class="abs pill" style="right:22px;top:${T0 + 6 * PITCH - 1}px;font-size:24px;padding:4px 16px;background:#13301f;color:var(--green);border:2px solid var(--green);${appear(t, nextAt + 0.2, { dy: 0, dx: 12 })}">${ICON.check({ size: 20 })}same repo</span>`;
      }
      html += card({
        x: TX, y: TY, w: TW, h: TH, tabs: [{ label: 'jaffle-shop', on: true, icon: `<span style="color:var(--text-2);display:flex">${ICON.folder({ size: 22 })}</span>` }],
        headStyle: 'font-size:24px', body, style: appear(t, treeAt, { dy: 0, dx: 60, dur: 0.45 }),
      });
    }
    return html;
  },
};
