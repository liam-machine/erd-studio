/**
 * Structural sharing for a rebuilt graph: every rebuilt node or edge that is
 * structurally equal to the one already in the store is replaced by that
 * same object.
 *
 * The canvas rebuilds every node and edge whenever the domain changes —
 * including the optimistic update after a drag, where only the moved
 * tables' positions (and the sides of their edges) differ. React Flow reuses
 * its internal node for a user node that is the same object as last time,
 * and memoised node and edge components skip rendering when their props keep
 * their identity, so handing back the old objects for everything that did
 * not change turns a 500-table re-render into a handful.
 *
 * Correct by construction: the result is equal, field for field, to what the
 * rebuild produced; only identities change. Transient React Flow fields that
 * the rebuild never sets (`dragging`, `resizing`) are ignored, and an absent
 * `selected` equals `false`.
 */

/** Fields React Flow sets on its own while the user interacts, which a rebuild never sets. */
const TRANSIENT_KEYS = new Set(['dragging', 'resizing']);

/** Structural equality of plain data: functions, Maps, Sets and class instances compare by identity. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.prototype && protoA !== null) return false;
  if (Object.getPrototypeOf(b) !== protoA) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const keysB = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) if (!(k in bo) || !sameData(ao[k], bo[k])) return false;
  return true;
}

/** Whether a rebuilt graph element equals the one in the store (ignoring transient interaction fields). */
function sameElement(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (TRANSIENT_KEYS.has(key)) continue;
    if (key === 'selected') {
      if (!!prev.selected !== !!next.selected) return false;
      continue;
    }
    if (!sameData(prev[key], next[key])) return false;
  }
  return true;
}

/**
 * `next` with each element replaced by the element of `prev` with the same
 * id when the two are structurally equal. Returns `prev` itself when every
 * element was reused in the same order (nothing to set at all).
 */
export function reuseUnchanged<T extends { id: string }>(prev: readonly T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const byId = new Map<string, T>();
  for (const el of prev) byId.set(el.id, el);
  let allSame = prev.length === next.length;
  const out = next.map((el, i) => {
    const old = byId.get(el.id);
    if (old !== undefined && sameElement(old as unknown as Record<string, unknown>, el as unknown as Record<string, unknown>)) {
      if (prev[i] !== old) allSame = false;
      return old;
    }
    allSame = false;
    return el;
  });
  return allSame ? (prev as T[]) : out;
}
