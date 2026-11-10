/**
 * `JSON.parse` that also says where things are: the 1-based line each object
 * and array starts on, and the line of each of an object's keys. A TMSL
 * `model.bim` and the files of a Tabular Editor Save to Folder model are
 * JSON, and the import's loss ledger names a table, a column or a role with
 * its file and line, as it does for TMDL.
 *
 * Values are what `JSON.parse` gives (the same objects, keys in the same
 * order, the last of a repeated key winning, `__proto__` an own key). A
 * value nested deeper than {@link MAX_JSON_DEPTH} is read by `JSON.parse`
 * with no lines inside it; the rest of the file keeps its lines. Where this
 * reader cannot follow (invalid JSON), `JSON.parse` decides: its error is
 * thrown as it is, with the line it is on. Pure: no Node built-ins.
 */

/** Deeper than this, lines are not tracked (a hostile file must not overflow the stack): `JSON.parse` reads that value. */
export const MAX_JSON_DEPTH = 256;

export interface JsonLines {
  /** The line the object or array starts on (its `{` or `[`); undefined when unknown. */
  lineOf(value: unknown): number | undefined;
  /** The line an object's key is written on; undefined when unknown. */
  keyLine(value: unknown, key: string): number | undefined;
}

export interface JsonWithLines {
  value: unknown;
  lines: JsonLines;
}

const NO_LINES: JsonLines = { lineOf: () => undefined, keyLine: () => undefined };

class Stop extends Error {}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Parse `text` as JSON (a leading BOM is not dropped: JSON.parse would reject it, and so does this). Throws what `JSON.parse` throws. */
export function parseJsonWithLines(text: string): JsonWithLines {
  const starts = new WeakMap<object, number>();
  const keys = new WeakMap<object, Map<string, number>>();
  let i = 0;
  let line = 1;
  const n = text.length;

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09) i++;
      else if (c === 0x0a) { line++; i++; }
      else if (c === 0x0d) { line++; i++; if (text.charCodeAt(i) === 0x0a) i++; }
      else break;
    }
  };
  const string = (): string => {
    const start = i;
    let escaped = false;
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x5c) { escaped = true; i += 2; continue; }
      if (c === 0x22) break;
      if (c < 0x20) throw new Stop();
      i++;
    }
    if (i >= n) throw new Stop();
    i++;
    return escaped ? (JSON.parse(text.slice(start, i)) as string) : text.slice(start + 1, i - 1);
  };
  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) throw new Stop();
    i += word.length;
    return value;
  };
  /**
   * A container deeper than {@link MAX_JSON_DEPTH}: found by counting brackets
   * (no recursion) and read by `JSON.parse`, with no lines inside it, so the
   * rest of the file keeps its lines and an error after it is reported on its
   * own line. An error inside it is reported on the line it starts on.
   */
  const deep = (): unknown => {
    const start = i;
    const startLine = line;
    let open = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        string();
        continue;
      }
      if (c === 0x0a) line++;
      else if (c === 0x0d) {
        line++;
        if (text.charCodeAt(i + 1) === 0x0a) i++;
      } else if (c === 0x7b || c === 0x5b) open++;
      else if (c === 0x7d || c === 0x5d) {
        open--;
        if (open === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    if (open !== 0) throw new Stop();
    try {
      return JSON.parse(text.slice(start, i)) as unknown;
    } catch {
      line = startLine;
      throw new Stop();
    }
  };
  const value = (depth: number): unknown => {
    ws();
    const c = text[i];
    if (depth > MAX_JSON_DEPTH && (c === '{' || c === '[')) return deep();
    if (c === '{') {
      const obj: Record<string, unknown> = {};
      starts.set(obj, line);
      const keyLines = new Map<string, number>();
      keys.set(obj, keyLines);
      i++;
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Stop();
        const keyAt = line;
        const key = string();
        ws();
        if (text[i] !== ':') throw new Stop();
        i++;
        const v = value(depth + 1);
        if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[key] = v;
        keyLines.set(key, keyAt);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        throw new Stop();
      }
    }
    if (c === '[') {
      const arr: unknown[] = [];
      starts.set(arr, line);
      i++;
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        throw new Stop();
      }
    }
    if (c === '"') return string();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || m[0] === '' || m[0] === '-') throw new Stop();
    i += m[0].length;
    return Number(m[0]);
  };

  try {
    const result = value(0);
    ws();
    if (i !== n) throw new Stop();
    return {
      value: result,
      lines: {
        lineOf: (v) => (typeof v === 'object' && v !== null ? starts.get(v) : undefined),
        keyLine: (v, key) => (typeof v === 'object' && v !== null ? keys.get(v)?.get(key) : undefined),
      },
    };
  } catch (e) {
    if (!(e instanceof Stop) && !(e instanceof SyntaxError)) throw e;
    const stoppedAt = line;
    // Not something this reader follows: JSON.parse says what is wrong (or reads it, with no lines).
    try {
      return { value: JSON.parse(text) as unknown, lines: NO_LINES };
    } catch (error) {
      // V8 does not always say where (`Unexpected end of JSON input`): the line this reader stopped on does.
      if (error instanceof Error) Object.assign(error, { jsonLine: stoppedAt });
      throw error;
    }
  }
}

/** The 1-based line a {@link parseJsonWithLines} error stopped on; undefined for any other error. */
export function jsonErrorLineOf(error: unknown): number | undefined {
  const line = (error as { jsonLine?: unknown } | null)?.jsonLine;
  return typeof line === 'number' ? line : undefined;
}
