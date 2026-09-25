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
 * vscode-free: bundled into both `dist/extension.js` and `dist/cli.js`.
 */

import { parseDocument } from 'yaml';
import type { SkillHarnessTarget } from '../types/aiAssistants';
import setupSkill from '../harness/claude/erd-studio-setup/SKILL.md';
import dbtExplained from '../harness/claude/erd-studio-setup/references/dbt-explained.md';
import dbtSetup from '../harness/claude/erd-studio-setup/references/dbt-setup.md';
import buildingTheModel from '../harness/claude/erd-studio-setup/references/building-the-model.md';
import modellingApproaches from '../harness/claude/erd-studio-setup/references/modelling-approaches.md';
import verifyAndFix from '../harness/claude/erd-studio-setup/references/verify-and-fix.md';
import troubleshooting from '../harness/claude/erd-studio-setup/references/troubleshooting.md';

export interface HarnessAsset {
  /** Path relative to the skill directory, POSIX separators. */
  relativePath: string;
  content: string;
  /** Append the harness version marker when installing (SKILL.md only). */
  versioned: boolean;
}

/** Workspace-relative directory the setup skill installs into for Claude Code. */
export const CLAUDE_SETUP_SKILL_DIR = '.claude/skills/erd-studio-setup';

/** Workspace-relative directory the setup skill installs into for the Agent Skills tools. */
export const AGENTS_SETUP_SKILL_DIR = '.agents/skills/erd-studio-setup';

export const SETUP_SKILL_DIRS: Readonly<Record<SkillHarnessTarget, string>> = {
  claude: CLAUDE_SETUP_SKILL_DIR,
  agents: AGENTS_SETUP_SKILL_DIR,
};

/** Every file of the setup skill. The version marker is never in the source `.md`. */
export const CLAUDE_SETUP_SKILL_FILES: readonly HarnessAsset[] = [
  { relativePath: 'SKILL.md', content: setupSkill, versioned: true },
  { relativePath: 'references/dbt-explained.md', content: dbtExplained, versioned: false },
  { relativePath: 'references/dbt-setup.md', content: dbtSetup, versioned: false },
  { relativePath: 'references/modelling-approaches.md', content: modellingApproaches, versioned: false },
  { relativePath: 'references/building-the-model.md', content: buildingTheModel, versioned: false },
  { relativePath: 'references/verify-and-fix.md', content: verifyAndFix, versioned: false },
  { relativePath: 'references/troubleshooting.md', content: troubleshooting, versioned: false },
];

/** Alias: the files are the same for every target; only SKILL.md's frontmatter differs. */
export const SETUP_SKILL_FILES = CLAUDE_SETUP_SKILL_FILES;

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
