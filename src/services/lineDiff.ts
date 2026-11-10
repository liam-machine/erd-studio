/**
 * A line diff over two texts (Myers), shared by Format Document's minimal
 * edits (`src/providers/dbmlFormattingProvider.ts`) and the DBML writers,
 * which use it to tell the lines an edit touched from the ones it left
 * alone (`src/services/dbmlWriters.ts`, #275). No `vscode`: the writers are
 * bundled into the CLI.
 */

/** One edit of the minimal diff: replace `[start, end)` of the old text with `text`. */
export interface LineEdit {
  start: number;
  end: number;
  text: string;
}

/** `text` cut into lines, each keeping its own line break (the last may have none). */
export function linesOf(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * The smallest set of whole-line edits (Myers' O((N+M)·D) diff over lines)
 * that turns `before` into `after`, as offsets into `before`. Unchanged lines
 * are never touched; a run of changed lines is one edit. Linear when the two
 * texts share most of their lines; when the diff would be large (more than
 * `maxEdits` differing lines, which bounds the memory at about 16 MB) the
 * changed middle is one edit, still leaving the common first and last lines
 * alone.
 */
export function minimalLineEdits(before: string, after: string, maxEdits = 2000): LineEdit[] {
  if (before === after) return [];
  const a = linesOf(before);
  const b = linesOf(after);
  // Common first and last lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const offsets: number[] = [0];
  for (const line of a) offsets.push(offsets[offsets.length - 1] + line.length);
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const whole = (): LineEdit[] => [{ start: offsets[head], end: offsets[head + A.length], text: B.join('') }];
  if (A.length === 0 || B.length === 0) return whole();

  // Myers: the furthest-reaching path for each diagonal, per number of differences. Each round keeps
  // only the diagonals it can reach (2d + 3 entries), so memory grows with D², not with D·(N + M).
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  /** The furthest x on diagonal k before round d (as recorded). */
  const at = (d: number, k: number): number => trace[d][d + 1 + k];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return whole();

  // Walk back: matched lines split the changed runs.
  const keep: Array<[number, number]> = []; // matched (x, y) pairs, last first
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const k = x - y;
    const prevK = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; keep.push([x, y]); }
    if (d === 0) break;
    x = prevX;
    y = prevY;
  }
  keep.reverse();
  const edits: LineEdit[] = [];
  let ax = 0;
  let by = 0;
  const flush = (toX: number, toY: number): void => {
    if (toX > ax || toY > by) {
      edits.push({ start: offsets[head + ax], end: offsets[head + toX], text: B.slice(by, toY).join('') });
    }
  };
  for (const [kx, ky] of keep) {
    flush(kx, ky);
    ax = kx + 1;
    by = ky + 1;
  }
  flush(n, m);
  return edits;
}
