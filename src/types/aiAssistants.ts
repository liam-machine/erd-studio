/**
 * AI coding assistants the `/erd-studio-setup` guide runs in — Claude Code,
 * GitHub Copilot, OpenAI Codex, Gemini CLI and Cursor — plus the pure
 * detection function and the "which harness folders to install" rule.
 *
 * Pure: no `vscode`, no DOM, nothing from `src/services/**`. The host gathers
 * the inputs (installed extension ids, CLIs found by a PATH scan, the editor's
 * `appName`) and never spawns anything to detect an assistant.
 *
 * Skill folders (agentskills.io open standard, 2026-09):
 * - `.claude/skills/<name>/SKILL.md` — Claude Code (Copilot and Cursor read it too).
 * - `.agents/skills/<name>/SKILL.md` — GitHub Copilot (VS Code agent mode and
 *   Copilot CLI), Codex, Gemini CLI and Cursor.
 */

export type AiAssistantId = 'claude' | 'copilot' | 'codex' | 'gemini' | 'cursor';

/** The two places the harness installs skills. */
export type SkillHarnessTarget = 'claude' | 'agents';

export interface AiAssistantInfo {
  id: AiAssistantId;
  /** Display name, used verbatim in the panel and messages. */
  name: string;
  /** Exactly what the user types to start the guided setup. */
  prompt: string;
  /** One line on where to type it. */
  where: string;
  /** Marketplace ids of the assistant's VS Code extensions (lower-case). */
  extensionIds: readonly string[];
  /** CLI executables that indicate it is installed (found by a PATH scan, never run). */
  cliNames: readonly string[];
}

export const GEMINI_SETUP_SENTENCE = 'Set up ERD Studio for this dbt project';

/** Display order everywhere: Claude Code first (recommended), then the others. */
export const AI_ASSISTANTS: readonly AiAssistantInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    prompt: '/erd-studio-setup',
    where: 'Type it in Claude Code, started in your dbt project folder.',
    extensionIds: ['anthropic.claude-code'],
    cliNames: ['claude'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    prompt: '/erd-studio-setup',
    where: 'Type it in Copilot Chat in Agent mode (or the Copilot CLI).',
    extensionIds: ['github.copilot-chat', 'github.copilot'],
    cliNames: ['copilot'],
  },
  {
    id: 'codex',
    name: 'Codex',
    prompt: '$erd-studio-setup',
    where: 'Type it in Codex, or pick erd-studio-setup from /skills.',
    extensionIds: ['openai.chatgpt'],
    cliNames: ['codex'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    prompt: GEMINI_SETUP_SENTENCE,
    where: 'Gemini CLI has no command for skills: send this sentence, and say yes if it asks to activate the guide.',
    // The Gemini CLI Companion — Gemini CLI's own VS Code extension. Not
    // `google.geminicodeassist`: that is Gemini Code Assist, a different
    // product, and it is not established that it reads `.agents/skills/`.
    extensionIds: ['google.gemini-cli-vscode-ide-companion'],
    cliNames: ['gemini'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    prompt: '/erd-studio-setup',
    where: "Type it in Cursor's Agent chat (or cursor-agent).",
    extensionIds: [],
    cliNames: ['cursor-agent'],
  },
];

export const AI_ASSISTANT_IDS: readonly AiAssistantId[] = AI_ASSISTANTS.map((a) => a.id);

export function isAiAssistantId(value: unknown): value is AiAssistantId {
  return typeof value === 'string' && (AI_ASSISTANT_IDS as readonly string[]).includes(value);
}

export function assistantInfo(id: AiAssistantId): AiAssistantInfo {
  return AI_ASSISTANTS.find((a) => a.id === id)!;
}

/** Every CLI name any assistant is detected by — what the host scans PATH for. */
export const AI_ASSISTANT_CLI_NAMES: readonly string[] = AI_ASSISTANTS.flatMap((a) => a.cliNames);

export interface AssistantDetectionInput {
  /** Ids of installed VS Code extensions (any case). */
  extensionIds: readonly string[];
  /** CLI names found on PATH (or in their installer's usual home) — see `AI_ASSISTANT_CLI_NAMES`. */
  clisFound: readonly string[];
  /** `vscode.env.appName` — "Cursor" when running inside Cursor. */
  appName: string;
}

/** Which assistants are present, in `AI_ASSISTANTS` order. Never spawns anything: the host only reports what it found. */
export function detectAssistants(input: AssistantDetectionInput): AiAssistantId[] {
  const extensions = new Set(input.extensionIds.map((id) => id.toLowerCase()));
  const clis = new Set(input.clisFound);
  const inCursor = /cursor/i.test(input.appName);
  return AI_ASSISTANTS
    .filter((a) =>
      a.extensionIds.some((id) => extensions.has(id))
      || a.cliNames.some((name) => clis.has(name))
      || (a.id === 'cursor' && inCursor))
    .map((a) => a.id);
}

/**
 * Where the one-click setup installs the skills.
 *
 * - `.claude/skills/` when Claude Code is among the assistants.
 * - `.agents/skills/` only when a detected assistant needs it: Codex or
 *   Gemini CLI (they read only `.agents/skills/`), or Copilot / Cursor when
 *   Claude's folder is not also being installed. Copilot and Cursor read
 *   `.claude/skills/` too, so installing both next to Claude would list every
 *   ERD Studio skill twice in them, and neither documents which copy wins.
 *
 * With none detected it installs **both**: the user may install their
 * assistant after running setup, and the guide should already be waiting for
 * whichever one they pick. That default can show duplicate listings in Copilot
 * or Cursor; a missing guide would be worse.
 */
export function recommendedSkillTargets(assistants: readonly AiAssistantId[]): SkillHarnessTarget[] {
  if (assistants.length === 0) { return ['claude', 'agents']; }
  const claude = assistants.includes('claude');
  const targets: SkillHarnessTarget[] = [];
  if (claude) { targets.push('claude'); }
  const needsAgents = assistants.some((a) =>
    a === 'codex' || a === 'gemini' || (!claude && (a === 'copilot' || a === 'cursor')));
  if (needsAgents) { targets.push('agents'); }
  return targets;
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and Cursor". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) { return names[0] ?? ''; }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Display names of the assistants, in `AI_ASSISTANTS` order. */
export function assistantNames(ids: readonly AiAssistantId[]): string[] {
  return AI_ASSISTANTS.filter((a) => ids.includes(a.id)).map((a) => a.name);
}
