// Shared helpers for scene modules. Everything here is pure: (inputs, t) -> HTML string.
// No timers, no randomness, no CSS transitions — capture.mjs relies on render(t) being
// deterministic so frames can be rendered out of order and in parallel.

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, p) => a + (b - a) * p;
/** 0..1 progress of t through [t0, t1]. */
export const seg = (t, t0, t1) => clamp((t - t0) / (t1 - t0));
export const easeOut = (p) => 1 - Math.pow(1 - p, 3);
export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** Standard entrance: fade + 14px rise over `dur` seconds from `at`. Returns a style fragment. */
export function appear(t, at, { dur = 0.35, dy = 14, dx = 0 } = {}) {
  const p = easeOut(seg(t, at, at + dur));
  if (p >= 1) return 'opacity:1;';
  return `opacity:${p.toFixed(3)};transform:translate(${(dx * (1 - p)).toFixed(1)}px,${(dy * (1 - p)).toFixed(1)}px);`;
}
/** Fade-out from `at`. */
export const fadeOut = (t, at, dur = 0.3) => 1 - seg(t, at, at + dur);
export const on = (t, at) => t >= at;

/** Typewriter: the visible prefix of `text` at `cps` characters per second from `at`. */
export const typed = (text, t, at, cps = 22) => text.slice(0, Math.floor(clamp((t - at) * cps, 0, text.length)));
export const typedEnd = (text, at, cps = 22) => at + text.length / cps;
/** Block caret: solid while typing, then blinks at 1 Hz. */
export function caret(t, typingUntil, color = 'var(--text)') {
  const visible = t < typingUntil || Math.floor(t * 2) % 2 === 0;
  return `<span style="display:inline-block;width:.55em;height:1.1em;vertical-align:-.2em;background:${visible ? color : 'transparent'}"></span>`;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** Interpolates two #rrggbb colours. */
export function mix(a, b, p) {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(lerp(v, B[i], clamp(p))).toString(16).padStart(2, '0')).join('');
}
export const ACCENT = { blue: '#5ca2f8', amber: '#f4b42c', green: '#22c55e' };
export const COLORS = { logical: '#60a5fa', physical: '#20c05a', amber: '#f4b42c', green: '#22c55e', text: '#e9ecef', text2: '#8b9099' };

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- icons (inline SVG: the latin font subsets have no check marks or arrows) ----------
const svg = (d, { size = 24, stroke = 'currentColor', sw = 2.4, fill = 'none', vb = 24, style = '' } = {}) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="${style}">${d}</svg>`;
export const ICON = {
  check: (o) => svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', { sw: 3, ...o }),
  arrow: (o) => svg('<path d="M4 12h15M13 6l6 6-6 6"/>', o),
  lock: (o) => svg('<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', o),
  warn: (o) => svg('<path d="M12 3.5L2.5 20h19z" fill="currentColor" stroke="none"/><path d="M12 10v4.5" stroke="#1a1405" stroke-width="2.6"/><circle cx="12" cy="17.3" r="1.4" fill="#1a1405" stroke="none"/>', o),
  play: (o) => svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>', { sw: 1.5, ...o }),
  playCircle: (o) => svg('<circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke-width="1.2"/>', { sw: 1.8, ...o }),
  chevDown: (o) => svg('<path d="M6 9l6 6 6-6"/>', o),
  chevRight: (o) => svg('<path d="M9 6l6 6-6 6"/>', o),
  folder: (o) => svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor" stroke="none"/>', o),
  file: (o) => svg('<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>', { sw: 1.8, ...o }),
  sparkle: (o) => svg('<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" fill="currentColor" stroke="none"/>', o),
  copy: (o) => svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', { sw: 2, ...o }),
  external: (o) => svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', { sw: 2, ...o }),
  terminal: (o) => svg('<path d="M5 8l4 4-4 4M12 17h7"/>', o),
  plus: (o) => svg('<path d="M12 5v14M5 12h14"/>', { sw: 3, ...o }),
  table: (o) => svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v10"/>', { sw: 2, ...o }),
  x: (o) => svg('<path d="M6 6l12 12M18 6L6 18"/>', { sw: 3, ...o }),
  claude: (o) => svg([0, 45, 90, 135].map((a) => `<path d="M12 3.2v17.6" transform="rotate(${a} 12 12)"/>`).join(''), { sw: 2.6, ...o }),
  globe: (o) => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>', { sw: 1.8, ...o }),
  neq: (o) => svg('<path d="M5 9h14M5 15h14M16 4L8 20"/>', { sw: 2.4, ...o }),
};
/** Deterministic spinner: a 270° arc rotated by t. */
export const spinner = (t, size = 26, color = 'var(--text-2)') =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${Math.round((t * 400) % 360)}deg)"><path d="M12 3a9 9 0 1 1-9 9" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/></svg>`;

export const tick = (kind = 'ok', t = 0) =>
  kind === 'wait'
    ? `<span class="tick tick--wait">${spinner(t, 28)}</span>`
    : `<span class="tick tick--${kind}">${kind === 'ok' ? ICON.check({ size: 22 }) : ICON.warn({ size: 22 })}</span>`;

// ---------- card (window chrome) ----------
/**
 * @param o.x,y,w,h   box in 1920x1080 frame space
 * @param o.tabs      [{ label, on?, icon? }]
 * @param o.dots      traffic-light dots (terminals)
 * @param o.crumb     breadcrumb after the tabs
 * @param o.body      inner HTML of the body (positioned relative to the body box)
 */
export function card({ x, y, w, h, tabs = [], dots = false, crumb = '', body = '', style = '', bodyCls = '', headStyle = '' }) {
  const head = `<div class="card__head" style="${headStyle}">${dots ? '<div class="card__dots"><i></i><i></i><i></i></div>' : ''}${tabs
    .map((tb) => `<div class="card__tab${tb.on ? ' card__tab--on' : ''}">${tb.icon ?? ''}${tb.label}</div>`)
    .join('')}${crumb ? `<div class="card__crumb">${crumb}</div>` : ''}</div>`;
  return `<div class="card" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}">${head}<div class="card__body ${bodyCls}">${body}</div></div>`;
}

/** ERD Studio app icon, rounded like the extension's marketplace icon. */
export const appIcon = (size, style = '') =>
  `<img src="/media/icon.png" width="${size}" height="${size}" style="display:block;border-radius:${Math.round(size * 0.22)}px;box-shadow:0 12px 34px #0009,0 0 0 1px #ffffff14;${style}">`;

// ---------- ERD node ----------
export const NODE = { head: 62, grain: 42, row: 46 };
export const nodeHeight = (cols, grain = true) => NODE.head + (grain ? NODE.grain : 0) + cols * NODE.row + 6;
/** y (relative to node top) of the centre of column row i. */
export const rowY = (i, grain = true) => NODE.head + (grain ? NODE.grain : 0) + i * NODE.row + NODE.row / 2;

/**
 * An ERD node. `stage` is logical|physical, or a 0..1 number to blend the border between them.
 * cols: [{ name, type, key?: 'PK'|'FK', row?: 'amber'|'green', types?: [[label, value, colour]...], pill?: html, strike? }]
 */
export function node({ x, y, w, name, stage = 'logical', layer = 'GLD', grain, cols, style = '', lock = false }) {
  const border = typeof stage === 'number' ? mix(COLORS.logical, COLORS.physical, stage) : stage === 'physical' ? COLORS.physical : COLORS.logical;
  const rows = cols
    .map((c) => {
      const key = c.key ? `<span class="badge badge--${c.key.toLowerCase()}">${c.key}</span>` : '';
      const type = c.types
        ? `<span class="node__types">${c.types.map(([l, v, col]) => `<span style="color:${col}">${l}: ${esc(v)}</span>`).join('')}</span>`
        : `<span class="node__type">${esc(c.type)}</span>`;
      return `<div class="node__row${c.row ? ` node__row--${c.row}` : ''}"${c.rowStyle ? ` style="${c.rowStyle}"` : ''}><span class="node__key">${key}</span><span class="node__col"${c.strike ? ' style="text-decoration:line-through;color:var(--text-3)"' : ''}>${c.name}</span>${type}${c.pill ?? ''}</div>`;
    })
    .join('');
  const lockTab = lock ? `<div class="node__lock" style="left:${x + 18}px;top:${y - 36}px;${style}">${ICON.lock({ size: 17 })}read-only</div>` : '';
  return `${lockTab}<div class="node" style="left:${x}px;top:${y}px;width:${w}px;border-color:${border};${style}">
    <div class="node__head"><span class="node__name">${name}</span><span class="badge badge--${layer === 'SLV' ? 'slv' : 'gld'}">${layer}</span></div>
    ${grain ? `<div class="node__grain">${grain}</div>` : ''}${rows}</div>`;
}

/**
 * Orthogonal relationship edge through `pts` ([[x,y],...]), drawn up to `progress` (0..1)
 * of its length, with "1" / "*" cardinality marks at the ends once fully drawn.
 */
export function edge(pts, { color = COLORS.logical, progress = 1, width = 3, one, many, dash = false, opacity = 1 } = {}) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const shown = clamp(progress) * len;
  const marks = progress >= 1
    ? [one && `<text x="${one[0]}" y="${one[1]}" fill="${color}" font-size="24" font-weight="800" font-family="JetBrains Mono">1</text>`,
       many && `<text x="${many[0]}" y="${many[1]}" fill="${color}" font-size="28" font-weight="800" font-family="JetBrains Mono">*</text>`].filter(Boolean).join('')
    : '';
  const dashAttr = dash ? `stroke-dasharray="10 8"` : `stroke-dasharray="${shown} ${len + 10}"`;
  return `<svg class="abs" style="left:0;top:0;overflow:visible;opacity:${opacity}" width="1" height="1"><path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" ${dashAttr}/>${marks}</svg>`;
}

/** Canvas toolbar: domain name + layer badge, Logical/Physical tabs, ⊕/⊘ Diff button. */
export function toolbar({ x, y, domain = 'orders', layer = 'GLD', stage = 'logical', diff = 'off', style = '' }) {
  const tab = (s, label, icon = '') => `<span class="tb__tab${stage === s ? ` tb__tab--${s}` : ''}">${icon}${label}</span>`;
  // The real button reads "⊕ Diff" while off and "⊘ Diff" while the comparison is showing
  // (webview/components/Toolbar/Toolbar.tsx); drawn as SVG so the glyphs never fall back to a system font.
  const diffIcon = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="8"/>${diff === 'off' ? '<path d="M12 8v8M8 12h8"/>' : '<path d="M6.5 17.5l11-11"/>'}</svg>`;
  return `<div class="tb" style="left:${x}px;top:${y}px;${style}"><span class="tb__domain">${domain}</span><span class="badge badge--${layer === 'SLV' ? 'slv' : 'gld'}">${layer}</span>
    <span class="tb__tabs">${tab('logical', 'Logical')}${tab('physical', 'Physical', stage === 'physical' ? ICON.lock({ size: 18 }) : '')}</span>
    <span class="tb__diff${diff !== 'off' ? ` tb__diff--${diff}` : ''}">${diffIcon}Diff</span></div>`;
}

/** Mouse pointer at (x, y); `press` 0..1 draws the click ripple. */
export function pointer(x, y, press = 0, style = '') {
  const ripple = press > 0 && press < 1
    ? `<div class="abs" style="left:${x - 30 * press - 6}px;top:${y - 30 * press - 6}px;width:${60 * press + 12}px;height:${60 * press + 12}px;border-radius:50%;border:3px solid rgba(255,255,255,${(0.7 * (1 - press)).toFixed(2)})"></div>`
    : '';
  return `${ripple}<svg class="abs" style="left:${x - 4}px;top:${y - 2}px;filter:drop-shadow(0 4px 8px #000a);${style}" width="38" height="46" viewBox="0 0 19 23"><path d="M1.5 1.5v17.2l4.4-4.1 2.9 6.6 3-1.3-2.9-6.5h6z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
}

/** Pointer path: moves between waypoints [{t, x, y}], eased; returns {x, y}. */
export function path(t, pts) {
  if (t <= pts[0].t) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const p = easeInOut(seg(t, pts[i - 1].t, pts[i].t));
      return { x: lerp(pts[i - 1].x, pts[i].x, p), y: lerp(pts[i - 1].y, pts[i].y, p) };
    }
  }
  return pts[pts.length - 1];
}

/** Coloured YAML/JSON-ish line: `key: value` with light syntax colouring. */
export function yamlLine(s) {
  const m = s.match(/^(\s*)(- )?([\w]+)(:)(.*)$/);
  if (!m) return esc(s);
  const [, ind, dash, k, colon, rest] = m;
  const val = rest.trim();
  const vcls = /^(true|false|\d+)$/.test(val) ? 'kw' : 'v';
  return `${ind}${dash ? '<span class="p">- </span>' : ''}<span class="k">${k}</span><span class="p">${colon}</span>${rest ? ` <span class="${vcls}">${esc(val)}</span>` : ''}`;
}
