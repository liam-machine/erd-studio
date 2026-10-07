/**
 * Human-readable renderers for the `erd-studio` subcommands (everything the
 * CLI prints without `--json`). Colour only on a TTY and never with NO_COLOR.
 */

import type { RelationshipFinding } from '@erd-studio/core';
import type { CheckResult } from './check';
import { describeUnreadable, type DiffResult, type DomainDiff, type Fix } from './diff';
import type { DoctorResult } from './doctor';
import type { InventoryResult } from './inventory';

export interface Paint {
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  dim(s: string): string;
}

export function makePaint(enabled: boolean): Paint {
  const wrap = (code: number) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { red: wrap(31), yellow: wrap(33), green: wrap(32), dim: wrap(2) };
}

/** Colour is on only for an interactive stdout with NO_COLOR unset. */
export function colourEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && !('NO_COLOR' in env);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fixLine(f: Fix, p: Paint): string {
  const mark = f.severity === 'blocking' ? p.red('✗') : p.yellow('!');
  const where = f.column ? `${f.model}.${f.column}` : f.model;
  switch (f.kind) {
    case 'set-type':
      return f.severity === 'advisory'
        ? `  ${mark} ${where}  dbt has no type for this column yet`
        : `  ${mark} ${where}  type: ${f.from || '(none)'} (logical) vs ${f.to} (dbt)`;
    case 'add-column':
      return `  ${mark} ${where}  missing in logical${f.to ? ` (${f.to})` : ''}`;
    case 'remove-column':
      return `  ${mark} ${where}  not in dbt`;
    case 'add-relationship':
      return `  ${mark} ${f.relationship!.fromModel} → ${f.relationship!.toModel} on ${f.relationship!.fromColumn}  missing in logical`;
    case 'remove-relationship':
      return `  ${mark} ${f.relationship!.fromModel} → ${f.relationship!.toModel} on ${f.relationship!.fromColumn}  not tested in dbt`;
    case 'set-cardinality':
      return `  ${mark} ${f.relationship!.fromModel} → ${f.relationship!.toModel} on ${f.relationship!.fromColumn}  cardinality: ${f.from} (logical) vs ${f.to} (dbt)`
        + (f.movesFrom ? `, store it in ${f.file}` : '');
    case 'resolve-phantom':
      return `  ${mark} ${f.model}  not a dbt model`;
    default:
      return `  ${mark} ${where}  ${f.explain}`;
  }
}

function domainBlock(d: DomainDiff, p: Paint): string[] {
  const head = `${d.domain} (${d.layer})`;
  if (d.error) { return [`${head} — ${p.red('could not be compared')}: ${d.error.message}`]; }
  if (d.needsMigration) { return [`${head} — ${p.yellow('older (v4) format')}: run "ERD Studio: Migrate to v5" first`]; }
  const { blocking, advisory } = d.counts;
  const summary = blocking === 0 && advisory === 0
    ? p.green('matches dbt')
    : [
      blocking > 0 ? `${plural(blocking, 'difference')} to fix` : 'nothing to fix',
      advisory > 0 ? `${advisory} advisory` : '',
    ].filter(Boolean).join(', ');
  const unreadable = new Map(d.unreadableModelFiles.map((u) => [u.name, u]));
  const lines = [`${head} — ${summary}`, ...d.fixes.map((f) => {
    const u = f.kind === 'fix-model-yaml' ? unreadable.get(f.model) : undefined;
    return u ? `  ${p.red('✗')} ${describeUnreadable(u)}` : fixLine(f, p);
  })];
  if (d.modelsWithoutColumns.length > 0) {
    lines.push(p.dim(`  ${plural(d.modelsWithoutColumns.length, 'model')} with no column information in dbt yet: ${d.modelsWithoutColumns.join(', ')}`));
  }
  const notable = d.integrity.filter((f) => f.severity !== 'info');
  if (notable.length > 0) {
    lines.push(p.dim(`  relationship checks (not part of the comparison — see erd-studio check):`));
    for (const f of notable) { lines.push(findingLine(f, p)); }
  }
  return lines;
}

function findingLine(f: RelationshipFinding, p: Paint): string {
  const mark = f.severity === 'error' ? p.red('✗') : f.severity === 'warning' ? p.yellow('!') : p.dim('·');
  return `  ${mark} ${f.code} ${f.message}${f.line !== undefined && !f.message.includes(`line ${f.line}`) ? ` (line ${f.line})` : ''}`;
}

export function formatCheck(r: CheckResult, p: Paint): string {
  const { errors, warnings, info } = r.counts;
  const where = r.mode === 'library' ? 'kept in the model files' : 'kept in each diagram';
  const scope = `${plural(r.checked.relationships, 'relationship')} ${where}, ${plural(r.checked.modelFiles, 'model file')}, ${plural(r.checked.domains, 'diagram')}`;
  const lines: string[] = [];
  if (r.findings.length === 0) {
    lines.push(`${p.green('✓')} No relationship problems (${scope}).`);
    return lines.join('\n') + '\n';
  }
  const parts = [
    errors > 0 ? p.red(plural(errors, 'error')) : '',
    warnings > 0 ? p.yellow(plural(warnings, 'warning')) : '',
    info > 0 ? plural(info, 'note') : '',
  ].filter(Boolean);
  lines.push(`${parts.join(', ')} (${scope})`);
  for (const f of r.findings) { lines.push(findingLine(f, p)); }
  if (errors + warnings > 0) {
    lines.push('', 'In VS Code, "ERD Studio: Repair Relationships…" fixes most of these, showing every change first.');
  }
  return lines.join('\n') + '\n';
}

export function formatDiff(r: DiffResult, p: Paint): string {
  if (r.domains.length === 0) { return 'No domains to compare.\n'; }
  return r.domains.map((d) => domainBlock(d, p).join('\n')).join('\n\n') + '\n';
}

export function formatDoctor(r: DoctorResult, p: Paint): string {
  const ok = (b: boolean) => (b ? p.green('✓') : p.yellow('–'));
  const lines: string[] = [];
  if (!r.project.found) {
    lines.push(`${ok(false)} No dbt project found (looked for dbt_project.yml near ${r.projectRoot})`);
    return lines.join('\n') + '\n';
  }
  lines.push(`${ok(true)} dbt project ${r.project.name ?? '(unnamed)'} at ${r.projectRoot}`);
  lines.push(r.dbt.found
    ? `${ok(true)} dbt ${r.dbt.version ?? ''} (${r.dbt.flavour}) — ${r.dbt.source}`
    : r.dbt.untrustedVenvDbt
      ? `${ok(false)} dbt at ${r.dbt.untrustedVenvDbt} not run yet (confirm it, then pass --trust-venv)`
      : `${ok(false)} dbt ${r.dbt.checked ? 'not found' : 'not checked (--no-dbt)'}`);
  if (r.profiles.required) {
    lines.push(`${ok(r.profiles.found)} profiles.yml ${r.profiles.path ?? 'not found'}`);
  }
  lines.push(`${ok(r.artifacts.manifest.status === 'ok')} manifest ${r.artifacts.manifest.status}`
    + (r.artifacts.manifest.models !== null ? ` (${plural(r.artifacts.manifest.models, 'model')})` : ''));
  lines.push(`${ok(r.artifacts.catalog.status === 'ok')} catalog ${r.artifacts.catalog.status}`);
  lines.push(`${ok(r.erd.semanticDirExists)} ERD Studio: ${plural(r.erd.domains, 'domain')}, ${plural(r.erd.logicalModels, 'logical model')}`);
  for (const u of r.erd.unreadableModelFiles) {
    lines.push(`${p.red('✗')} ${describeUnreadable(u)}`);
  }
  if (r.relationships.checked) {
    const rel = r.relationships;
    const problems = rel.errors + rel.warnings;
    lines.push(`${ok(problems === 0)} relationships: ${plural(rel.stored, 'stored entry', 'stored entries')}`
      + (problems === 0 ? ', no problems' : `, ${[rel.errors ? plural(rel.errors, 'error') : '', rel.warnings ? plural(rel.warnings, 'warning') : ''].filter(Boolean).join(', ')}`));
  }
  lines.push(`${ok(r.harness.schemaSkill === 'current')} Claude skills: schema ${r.harness.schemaSkill}, setup ${r.harness.setupSkill}`);
  lines.push('', 'Next steps:');
  r.nextSteps.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.title}${s.command ? ` — ${s.command}` : ''}`);
  });
  return lines.join('\n') + '\n';
}

export function formatInventory(r: InventoryResult, p: Paint): string {
  const lines = [`${plural(r.models.length, 'model')}, ${plural(r.relationships.length, 'relationship')} (manifest ${r.inputs.manifest}, catalog ${r.inputs.catalog})`];
  let folder: string | null = null;
  for (const m of r.models) {
    const f = m.folder.join('/') || '.';
    if (f !== folder) { lines.push(`  ${f}/`); folder = f; }
    const tag = r.alreadyModelled.includes(m.name) ? p.dim(' (modelled)') : '';
    lines.push(`    ${m.name}  ${plural(m.columnCount, 'column')}${m.existsInProject ? '' : p.yellow(' — not in dbt')}${tag}`);
  }
  if (r.skipped.length > 0) {
    lines.push(p.dim(`  skipped: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`));
  }
  const { layering, shape, history, meta } = r.conventions;
  lines.push('', 'Conventions:');
  lines.push(`  layering: ${layering.style}${layering.layers.length ? ` (${layering.layers.join(' → ')})` : ''}`);
  lines.push(`  shape: ${shape.style}${shape.style === 'none' ? '' : ` (${shape.confidence}; from ${shape.sources.join(', ')})`}`);
  for (const e of [...layering.evidence, ...shape.evidence]) { lines.push(p.dim(`    ${e}`)); }
  if (history.snapshots.length > 0) { lines.push(`  snapshots: ${history.snapshots.join(', ')}`); }
  if (meta.modelsWithMeta > 0) {
    lines.push(`  meta: on ${meta.modelsWithMeta} of ${plural(meta.totalModels, 'model')}`);
    if (meta.models.length > 0) { lines.push(p.dim(`    models: ${meta.models.map((k) => `${k.key} (${k.count})`).join(', ')}`)); }
    if (meta.columns.length > 0) { lines.push(p.dim(`    columns: ${meta.columns.map((k) => `${k.key} (${k.count})`).join(', ')}`)); }
  }
  return lines.join('\n') + '\n';
}
