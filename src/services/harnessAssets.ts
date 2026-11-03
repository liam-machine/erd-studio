/**
 * Harness assets — the `/erd-studio-setup` skill, authored once as real
 * markdown under `src/harness/claude/erd-studio-setup/` and inlined as strings
 * by esbuild's `'.md': 'text'` loader (vitest's `md-text` plugin in tests).
 * The source directory keeps its historical `claude/` name; the content is
 * tool-neutral and installs into both skill folders:
 *
 * - `.claude/skills/erd-studio-setup/` — Claude Code. SKILL.md keeps the
 *   source frontmatter as written: Claude Code's `allowed-tools` list and
 *   `argument-hint`.
 * - `.agents/skills/erd-studio-setup/` — the Agent Skills folder read by
 *   GitHub Copilot, Codex, Gemini CLI and Cursor. SKILL.md's frontmatter is cut
 *   down to the open standard's portable fields (`agentSkillFrontmatter()`):
 *   Claude's `Bash(prefix:*)` rules mean nothing verified to those tools.
 *
 * Logical first, dbt as an add-on: what installs into a folder without
 * `dbt_project.yml` carries no dbt instruction. A whole dbt-only file is
 * flagged `dbtOnly` and not installed there; text inside a shared file is
 * scoped with `<!-- dbt-only -->…<!-- /dbt-only -->` (kept only in a dbt
 * project) and `<!-- no-dbt -->…<!-- /no-dbt -->` (kept only without one) —
 * see `applyDbtScope()`, the one place either is read. In a dbt project the
 * installed text is the source with the markers taken out.
 *
 * vscode-free: bundled into both `dist/extension.js` and `dist/cli.js`.
 */

import { parseDocument } from 'yaml';
import type { SkillHarnessTarget } from '../types/aiAssistants';
import setupSkill from '../harness/claude/erd-studio-setup/SKILL.md';
import dbtExplained from '../harness/claude/erd-studio-setup/references/dbt-explained.md';
import dbtSetup from '../harness/claude/erd-studio-setup/references/dbt-setup.md';
import buildingTheModel from '../harness/claude/erd-studio-setup/references/building-the-model.md';
import modellingApproaches from '../harness/claude/erd-studio-setup/references/modelling-approaches.md';
import metadata from '../harness/claude/erd-studio-setup/references/metadata.md';
import verifyAndFix from '../harness/claude/erd-studio-setup/references/verify-and-fix.md';
import troubleshooting from '../harness/claude/erd-studio-setup/references/troubleshooting.md';
import withoutDbt from '../harness/claude/erd-studio-setup/references/without-dbt.md';

export interface HarnessAsset {
  /** Path relative to the skill directory, POSIX separators. */
  relativePath: string;
  /** The file as a dbt project installs it: `source` with the scope markers taken out. */
  content: string;
  /** The authored markdown, scope markers (`applyDbtScope()`) included. */
  source: string;
  /** Append the harness version marker when installing (SKILL.md only). */
  versioned: boolean;
  /** Installed only in a dbt project (a folder holding `dbt_project.yml`): the file is dbt instructions throughout. */
  dbtOnly?: boolean;
  /**
   * Where the file installs in a root without `dbt_project.yml`, when its
   * dbt-project name says dbt (`references/without-dbt.md` is the whole
   * walkthrough there). Same skill-relative form as `relativePath`.
   */
  logicalPath?: string;
}

/** Workspace-relative directory the setup skill installs into for Claude Code. */
export const CLAUDE_SETUP_SKILL_DIR = '.claude/skills/erd-studio-setup';

/** Workspace-relative directory the setup skill installs into for the Agent Skills tools. */
export const AGENTS_SETUP_SKILL_DIR = '.agents/skills/erd-studio-setup';

export const SETUP_SKILL_DIRS: Readonly<Record<SkillHarnessTarget, string>> = {
  claude: CLAUDE_SETUP_SKILL_DIR,
  agents: AGENTS_SETUP_SKILL_DIR,
};

/** The two scoped-span kinds: `dbt-only` text is kept in a dbt project, `no-dbt` text in a folder without one. */
export type DbtScopeKind = 'dbt-only' | 'no-dbt';

/**
 * A scoped span, `<!-- dbt-only -->…<!-- /dbt-only -->` or
 * `<!-- no-dbt -->…<!-- /no-dbt -->`, with the line break straight after it.
 * Spans may cover part of a line or several lines; they never nest.
 */
const DBT_SCOPE_SPAN = /<!-- (dbt-only|no-dbt) -->([\s\S]*?)<!-- \/\1 -->(\r?\n)?/g;

/** Any scope marker, opening or closing — none may survive `applyDbtScope()`. */
export const DBT_SCOPE_MARKER = /<!-- \/?(?:dbt-only|no-dbt) -->/;

/**
 * The text of a harness source as installed in a root with (`dbt` true) or
 * without `dbt_project.yml`. A span that applies keeps its text and loses
 * only its markers, so a dbt project's copy is the source byte for byte
 * minus the markers. A span that does not apply is cut out; when it covers
 * whole lines (it starts a line of the text written so far and ends one) its
 * last line break goes too, so no blank line is left behind. A span whose two
 * markers each sit alone on a line (the block form, used around a code block
 * so its fences stay at the start of a line) loses those two lines when kept.
 * Spans are read in order, so two side by side behave as if the first were
 * already applied.
 */
export function applyDbtScope(text: string, dbt: boolean): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(DBT_SCOPE_SPAN)) {
    const [whole, kind, inner, lineBreak] = match as unknown as [string, DbtScopeKind, string, string | undefined];
    out += text.slice(last, match.index);
    last = (match.index ?? 0) + whole.length;
    const atLineStart = out === '' || out.endsWith('\n');
    if ((kind === 'dbt-only') === dbt) {
      // Block form — each marker alone on its line (around a code block, say): the marker lines go.
      const block = atLineStart && lineBreak !== undefined && /^\r?\n/.test(inner) && inner.endsWith('\n');
      out += block ? inner.replace(/^\r?\n/, '') : inner + (lineBreak ?? '');
    } else if (lineBreak !== undefined && !atLineStart) {
      out += lineBreak;
    }
  }
  return out + text.slice(last);
}

type AssetSpec = Omit<HarnessAsset, 'content'>;

/** An asset whose `content` is its source as a dbt project installs it. */
function asset(spec: AssetSpec): HarnessAsset {
  return { ...spec, content: applyDbtScope(spec.source, true) };
}

/** Every file of the setup skill. The version marker is never in the source `.md`. */
export const CLAUDE_SETUP_SKILL_FILES: readonly HarnessAsset[] = [
  asset({ relativePath: 'SKILL.md', source: setupSkill, versioned: true }),
  asset({ relativePath: 'references/dbt-explained.md', source: dbtExplained, versioned: false, logicalPath: 'references/glossary.md' }),
  asset({ relativePath: 'references/dbt-setup.md', source: dbtSetup, versioned: false, dbtOnly: true }),
  asset({ relativePath: 'references/modelling-approaches.md', source: modellingApproaches, versioned: false }),
  asset({ relativePath: 'references/metadata.md', source: metadata, versioned: false, dbtOnly: true }),
  asset({ relativePath: 'references/building-the-model.md', source: buildingTheModel, versioned: false }),
  asset({ relativePath: 'references/verify-and-fix.md', source: verifyAndFix, versioned: false, dbtOnly: true }),
  asset({ relativePath: 'references/troubleshooting.md', source: troubleshooting, versioned: false }),
  asset({ relativePath: 'references/without-dbt.md', source: withoutDbt, versioned: false, logicalPath: 'references/walkthrough.md' }),
];

/** Alias: the files are the same for every target; only SKILL.md's frontmatter differs. */
export const SETUP_SKILL_FILES = CLAUDE_SETUP_SKILL_FILES;

/**
 * The setup skill's files for a root with (`dbt` true) or without
 * `dbt_project.yml`: without it, no dbt-only file, each file at its
 * `logicalPath` when it has one, and `content` scoped for no dbt.
 */
export function setupSkillAssets(dbt: boolean): readonly HarnessAsset[] {
  if (dbt) { return SETUP_SKILL_FILES; }
  return SETUP_SKILL_FILES
    .filter((a) => !a.dbtOnly)
    .map((a) => ({ ...a, relativePath: a.logicalPath ?? a.relativePath, content: applyDbtScope(a.source, false) }));
}

/**
 * The setup skill's paths a dbt project installs and a root without
 * `dbt_project.yml` does not: every `dbtOnly` file and the dbt-path name of
 * every file with a `logicalPath`. An install without dbt removes a copy of
 * one only when it is a text ERD Studio shipped (`isShippedSetupReference()`).
 */
export const DBT_SCOPE_SETUP_PATHS: readonly string[] = SETUP_SKILL_FILES
  .filter((a) => a.dbtOnly === true || a.logicalPath !== undefined)
  .map((a) => a.relativePath);

/**
 * The frontmatter fields the Agent Skills specification defines. `allowed-tools`
 * is in the spec too but experimental and interpreted per tool, so it is left
 * out of the portable copy on purpose.
 */
export const AGENT_SKILL_FRONTMATTER_KEYS: readonly string[] = ['name', 'description', 'license', 'compatibility', 'metadata'];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** Split a SKILL.md into its YAML frontmatter text and the body after the closing fence. */
export function splitFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) { return null; }
  return { yaml: match[1], body: content.slice(match[0].length) };
}

/**
 * The Agent Skills copy of a SKILL.md: the same body under a frontmatter that
 * keeps only `AGENT_SKILL_FRONTMATTER_KEYS` (in their original order and
 * style). Content with no frontmatter is returned unchanged.
 */
export function agentSkillFrontmatter(content: string): string {
  const parts = splitFrontmatter(content);
  if (!parts) { return content; }

  // First choice: drop whole top-level entries line by line, so the kept
  // ones stay byte-for-byte as authored (folded descriptions included).
  // A line starting a top-level key decides whether it and its indented /
  // `- item` continuation lines are kept.
  const kept: string[] = [];
  let keep = true;
  for (const line of parts.yaml.split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (key) { keep = AGENT_SKILL_FRONTMATTER_KEYS.includes(key[1]); }
    if (keep) { kept.push(line); }
  }
  const text = kept.join('\n').replace(/\s+$/, '');
  try {
    const parsed = parseDocument(text);
    const value: unknown = parsed.toJS();
    if (parsed.errors.length === 0 && value && typeof value === 'object'
      && Object.keys(value).every((k) => AGENT_SKILL_FRONTMATTER_KEYS.includes(k))) {
      return `---\n${text}\n---\n${parts.body}`;
    }
  } catch {
    // fall through to the structural rewrite
  }

  // Fallback for frontmatter the line scan cannot follow (flow maps, anchors…).
  const doc = parseDocument(parts.yaml);
  const map = doc.contents as { items?: Array<{ key: unknown }> } | null;
  const keyName = (key: unknown): string =>
    key && typeof key === 'object' && 'value' in key ? String((key as { value: unknown }).value) : String(key);
  if (map && Array.isArray(map.items)) {
    map.items = map.items.filter((pair) => AGENT_SKILL_FRONTMATTER_KEYS.includes(keyName(pair.key)));
  }
  const yaml = doc.toString({ lineWidth: 100 }).replace(/\s+$/, '');
  return `---\n${yaml}\n---\n${parts.body}`;
}

/** SKILL.md as installed for one target: verbatim for Claude Code, portable fields only for `.agents/`. */
export function skillForTarget(content: string, target: SkillHarnessTarget): string {
  return target === 'agents' ? agentSkillFrontmatter(content) : content;
}
