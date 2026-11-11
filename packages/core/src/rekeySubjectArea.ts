/**
 * Re-keying a diagram's tables in its v5 subject-area object.
 *
 * A diagram names each member by its reference (`assignTableRefs`): its bare
 * name, or `<schema>.<name>` while another member of the diagram has the
 * same name. A member's reference changes when a table of its name joins or
 * leaves the diagram, and when it is renamed or moved to another schema
 * folder. Every place the object stores the reference must follow in the
 * same edit: the member list, the relationship ends, the positions keys,
 * the `stubColumns` entries and the sticky notes' links. A place that is
 * missed shows up as a lost position or a detached sticky note.
 *
 * Pure and parser-free.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Set an own property, so a name such as `__proto__` is an entry like any other. */
function setEntry(record: Json, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * `obj` (a v5 subject-area object, as a diagram reader returns it) with
 * each table reference `renames` names written as its new reference:
 * `logical.models`, `logical.relationships` ends, `viewConfig.positions`
 * keys, `viewConfig.annotations` links and `stubColumns`. References are
 * compared without case, as they are wherever text is resolved to a table.
 *
 * A renamed position takes the place of an entry already under its new
 * name that is not itself renamed (a stray line an older version left, such
 * as a bare `addresse` beside `bqs.addresse`): the member's own position
 * wins. Everything else is kept as it is, and `obj` is never changed: the
 * parts that change are copied. With nothing to rename, `obj` is returned.
 *
 * Renaming back with the inverse map gives `obj` again, whenever no stray
 * had to give way.
 */
export function rekeySubjectArea<T extends Json>(obj: T, renames: ReadonlyMap<string, string>): T {
  const map = new Map<string, string>();
  for (const [from, to] of renames) if (from !== to) map.set(from.toLowerCase(), to);
  if (map.size === 0) return obj;
  const renamed = (name: unknown): unknown => (typeof name === 'string' ? map.get(name.toLowerCase()) ?? name : name);
  const out: Json = { ...obj };

  if (isObject(obj.logical)) {
    const logical: Json = { ...obj.logical };
    if (Array.isArray(logical.models)) logical.models = logical.models.map(renamed);
    if (Array.isArray(logical.relationships)) {
      logical.relationships = logical.relationships.map((rel) => (isObject(rel)
        ? { ...rel, fromModel: renamed(rel.fromModel), toModel: renamed(rel.toModel) }
        : rel));
    }
    out.logical = logical;
  }

  if (Array.isArray(obj.stubColumns)) out.stubColumns = obj.stubColumns.map(renamed);

  if (isObject(obj.viewConfig)) {
    const view: Json = { ...obj.viewConfig };
    if (isObject(view.positions)) {
      const before = view.positions;
      const keys = Object.keys(before);
      // The new names of the renamed entries: an entry that is not renamed but already
      // has one of them gives way to the member it names.
      const targets = new Set(keys.filter((k) => map.has(k.toLowerCase())).map((k) => map.get(k.toLowerCase())!.toLowerCase()));
      const positions: Json = {};
      const placed = new Set<string>();
      for (const key of keys) {
        const to = map.get(key.toLowerCase());
        if (to === undefined) {
          if (targets.has(key.toLowerCase())) continue;
          setEntry(positions, key, before[key]);
          continue;
        }
        // Two entries renamed to one name: the first keeps it.
        if (placed.has(to.toLowerCase())) continue;
        placed.add(to.toLowerCase());
        setEntry(positions, to, before[key]);
      }
      view.positions = positions;
    }
    if (Array.isArray(view.annotations)) {
      view.annotations = view.annotations.map((a) => (isObject(a) && typeof a.linkedModel === 'string' && map.has(a.linkedModel.toLowerCase())
        ? { ...a, linkedModel: map.get(a.linkedModel.toLowerCase()) }
        : a));
    }
    out.viewConfig = view;
  }
  return out as T;
}
