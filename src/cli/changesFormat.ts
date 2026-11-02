/**
 * The human outputs of `erd-studio changes`: plain text for a terminal and
 * Markdown for a pull-request comment (`--format markdown`). Both list the
 * same things in the same order as the `--json` result.
 */

import type { ChangesResult } from './changes';
import type { ColumnKeyFlag, RelationshipAt, TableAt, TableChange } from './modelChanges';

const KEY_WORDS: Record<ColumnKeyFlag, string> = { pk: 'primary key', fk: 'foreign key', nk: 'natural key' };

type Style = 'text' | 'markdown';

/** A name or path as code: backticks in Markdown (never nested), plain in text. */
function code(s: string, style: Style): string {
  if (style === 'text') return s;
  const clean = s.replace(/`/g, "'").replace(/\s+/g, ' ');
  return `\`${clean}\``;
}

/** Free text (a grain) on one line, quoted. */
function quoted(s: string | null): string {
  return s === null ? 'none' : `"${s.replace(/\s+/g, ' ').trim()}"`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function where(t: Pick<TableAt, 'layer' | 'schema'>): string {
  const parts = [t.layer ? `layer ${t.layer}` : '', t.schema ? `schema ${t.schema}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no layer';
}

function relationship(r: RelationshipAt, style: Style): string {
  return `${code(`${r.fromTable}.${r.fromColumn}`, style)} → ${code(`${r.toTable}.${r.toColumn}`, style)}`;
}

function tableDetails(c: TableChange, style: Style): string[] {
  const lines: string[] = [];
  const cols = (list: Array<{ name: string; dataType: string }>): string =>
    list.map((col) => (col.dataType ? `${code(col.name, style)} (${col.dataType})` : code(col.name, style))).join(', ');
  if (c.columnsAdded.length > 0) lines.push(`columns added: ${cols(c.columnsAdded)}`);
  if (c.columnsRemoved.length > 0) lines.push(`columns removed: ${cols(c.columnsRemoved)}`);
  if (c.typesChanged.length > 0) {
    lines.push(`types changed: ${c.typesChanged.map((t) => `${code(t.column, style)} ${t.from || 'no type'} → ${t.to || 'no type'}`).join(', ')}`);
  }
  if (c.keysChanged.length > 0) {
    lines.push(`keys: ${c.keysChanged.map((k) => `${code(k.column, style)} ${k.to ? 'is now' : 'is no longer'} a ${KEY_WORDS[k.key]}`).join(', ')}`);
  }
  if (c.alias) lines.push(`alias: ${c.alias.from ?? 'none'} → ${c.alias.to ?? 'none'}`);
  if (c.role) lines.push(`role: ${c.role.from ?? 'none'} → ${c.role.to ?? 'none'}`);
  if (c.grain) lines.push(`grain: ${quoted(c.grain.from)} → ${quoted(c.grain.to)}`);
  return lines;
}

/** The one-line summary of what changed. */
function summaryLine(r: ChangesResult): string {
  const s = r.summary;
  const parts: string[] = [];
  const tables = [
    s.tablesAdded ? `${s.tablesAdded} added` : '',
    s.tablesRemoved ? `${s.tablesRemoved} removed` : '',
    s.tablesRenamed ? `${s.tablesRenamed} renamed` : '',
    s.tablesMoved ? `${s.tablesMoved} moved` : '',
    s.tablesChanged ? `${s.tablesChanged} changed` : '',
  ].filter(Boolean);
  if (tables.length > 0) parts.push(`tables: ${tables.join(', ')}`);
  const rels = [
    s.relationshipsAdded ? `${s.relationshipsAdded} added` : '',
    s.relationshipsRemoved ? `${s.relationshipsRemoved} removed` : '',
    s.relationshipsChanged ? `${s.relationshipsChanged} changed` : '',
  ].filter(Boolean);
  if (rels.length > 0) parts.push(`relationships: ${rels.join(', ')}`);
  const diagrams = [
    s.diagramsAdded ? `${s.diagramsAdded} added` : '',
    s.diagramsRemoved ? `${s.diagramsRemoved} removed` : '',
    s.diagramsChanged ? `${s.diagramsChanged} changed` : '',
  ].filter(Boolean);
  if (diagrams.length > 0) parts.push(`diagrams: ${diagrams.join(', ')}`);
  return parts.join(' · ');
}

/** Sections as `[heading, lines]`, each line one bullet; a nested line starts with two spaces. */
function sections(r: ChangesResult, style: Style): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  const add = (heading: string, lines: string[]): void => {
    if (lines.length > 0) out.push([heading, lines]);
  };
  add('Tables added', r.tables.added.map((t) => `${code(t.name, style)} (${where(t)}) in ${code(t.file, style)}`));
  add('Tables removed', r.tables.removed.map((t) => `${code(t.name, style)} (${where(t)}) from ${code(t.file, style)}`));
  add('Tables renamed', r.tables.renamed.map((t) => `${code(t.from, style)} → ${code(t.to, style)}`));
  add('Tables moved', r.tables.moved.map((m) => `${code(m.name, style)}: ${where(m.from)} → ${where(m.to)}`));
  add('Tables changed', r.tables.changed.flatMap((c) => [
    c.renamedFrom ? `${code(c.name, style)} (was ${code(c.renamedFrom, style)})` : code(c.name, style),
    ...tableDetails(c, style).map((l) => `  ${l}`),
  ]));
  add('Relationships added', r.relationships.added.map((x) => `${relationship(x, style)} (${x.cardinality})${x.file ? ` in ${code(x.file, style)}` : ''}`));
  add('Relationships removed', r.relationships.removed.map((x) => `${relationship(x, style)} (${x.cardinality})${x.file ? ` from ${code(x.file, style)}` : ''}`));
  add('Cardinality changed', r.relationships.changed.map((x) => `${relationship(x, style)}: ${x.fromCardinality} → ${x.cardinality}`));
  add('Diagrams added', r.diagrams.added.map((d) => `${code(`${d.layer}/${d.name}`, style)} with ${plural(d.tables.length, 'table')}`));
  add('Diagrams removed', r.diagrams.removed.map((d) => `${code(`${d.layer}/${d.name}`, style)}`));
  add('Diagrams changed', r.diagrams.changed.map((d) => {
    const parts = [
      d.tablesAdded.length > 0 ? `added ${d.tablesAdded.map((t) => code(t, style)).join(', ')}` : '',
      d.tablesRemoved.length > 0 ? `removed ${d.tablesRemoved.map((t) => code(t, style)).join(', ')}` : '',
      d.movedFrom ? `now in ${code(d.file, style)}` : '',
    ].filter(Boolean);
    return `${code(`${d.layer}/${d.name}`, style)}: ${parts.join('; ')}`;
  }));
  add('Relationships files', r.relationshipsFiles.map((f) => {
    const counts = `${f.refsAdded} Ref${f.refsAdded === 1 ? '' : 's'} added, ${f.refsRemoved} removed`
      + (f.refsChanged > 0 ? `, ${f.refsChanged} changed` : '');
    return `${code(f.file, style)}${f.status === 'changed' ? '' : ` (${f.status === 'added' ? 'new file' : 'deleted'})`}: ${counts}`;
  }));
  add('Not compared', r.problems.map((p) => `${code(p.file, style)} (${p.side === 'base' ? r.base.ref : 'working tree'}): ${p.message}`));
  return out;
}

/** The ref and, unless the ref already is one, its short commit: `origin/main (1a2b3c4)`. */
function baseName(r: ChangesResult, style: Style): string {
  const short = r.base.commit.slice(0, 7);
  const ref = code(r.base.ref, style);
  return r.base.commit.startsWith(r.base.ref) ? ref : `${ref} (${short})`;
}

/** Plain text for a terminal. */
export function formatChangesText(r: ChangesResult): string {
  const head = `ERD Studio model changes since ${baseName(r, 'text')}`;
  if (!r.changed && r.problems.length === 0) return `${head}: none.\n`;
  const lines = [head, r.changed ? summaryLine(r) : 'No changes to tables, relationships or diagrams.'];
  for (const [heading, items] of sections(r, 'text')) {
    lines.push('', `${heading}:`);
    for (const item of items) lines.push(item.startsWith('  ') ? `    ${item.trimStart()}` : `  ${item}`);
  }
  return lines.join('\n') + '\n';
}

/** Markdown for a pull-request comment. */
export function formatChangesMarkdown(r: ChangesResult): string {
  const lines = ['### ERD Studio model changes', ''];
  const since = `Compared with ${baseName(r, 'markdown')}.`;
  if (!r.changed && r.problems.length === 0) {
    lines.push(`${since} No changes to tables, relationships or diagrams.`);
    return lines.join('\n') + '\n';
  }
  lines.push(r.changed ? `${since} ${summaryLine(r)}` : `${since} No changes to tables, relationships or diagrams.`);
  for (const [heading, items] of sections(r, 'markdown')) {
    lines.push('', `**${heading}**`, '');
    for (const item of items) lines.push(item.startsWith('  ') ? `  - ${item.trimStart()}` : `- ${item}`);
  }
  return lines.join('\n') + '\n';
}
