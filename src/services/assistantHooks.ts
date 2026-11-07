/**
 * The "load the ERD Studio skill before the first `.erd-studio` edit" hook for
 * the assistants other than Claude Code (whose `enforce-skill.sh` lives in
 * `harnessService.ts`): GitHub Copilot (the Copilot CLI and Copilot sessions
 * in VS Code read `.github/copilot/settings.local.json`; VS Code's own local
 * agent may not), Codex and Gemini CLI.
 *
 * Pure: no `vscode`, no `fs`. `HarnessService` reads and writes the files;
 * this module only generates the script, the command that registers it, and
 * merges that command into each tool's own JSON config.
 *
 * **Every hook here only ever denies.** On anything but the first edit to a
 * `.erd-studio` file in a session it prints nothing (Gemini CLI: `{}`, its
 * documented "no decision") and exits 0, so the tool's normal permission flow
 * decides. Nothing here ever prints an allow or approve decision; a test
 * checks every generated file. The script always exits 0 and the registered
 * command ends in `|| true`, because the Copilot CLI treats a failing hook as
 * a deny (fail closed): a broken hook must never block every tool call.
 *
 * Not yet supported: Cursor (its `preToolUse` blocks on output that is not a
 * documented decision and documents only `"permission":"allow"` for "go
 * ahead", which this hook must never print; an exit-2 deny with a silent
 * exit 0 otherwise may work but has not been checked in Cursor) and
 * Antigravity CLI (Gemini CLI's successor, reported to fail closed on a
 * missing decision). Both rely on the always-on skill.
 */

import type { AssistantHookSkipReason, SkippedAssistantHook } from '../types/harness';

export type HookedAssistantId = 'copilot' | 'codex' | 'gemini';

/** The assistants that get a pre-edit hook, in display order. */
export const HOOKED_ASSISTANTS: readonly HookedAssistantId[] = ['copilot', 'codex', 'gemini'];

export function isHookedAssistant(id: string): id is HookedAssistantId {
  return (HOOKED_ASSISTANTS as readonly string[]).includes(id);
}

/** Every hook script has this file name, in its tool's own folder. */
export const ASSISTANT_HOOK_SCRIPT_NAME = 'erd-studio-enforce-skill.sh';

export interface AssistantHookSpec {
  id: HookedAssistantId;
  /** The product's name as it spells it. */
  name: string;
  /** Workspace-relative path of the hook script. */
  script: string;
  /** Workspace-relative path of the JSON config the hook is registered in. */
  config: string;
  /**
   * Whether ERD Studio adds the config (and then the script) to `.gitignore`
   * when it creates the config. Copilot's file is a `.local` one by design;
   * Codex has no local variant, so a `.codex/hooks.json` ERD Studio creates is
   * kept out of Git. Gemini CLI's `.gemini/settings.json` holds the project's
   * other Gemini settings too, so it is never ignored.
   */
  ignoreConfig: boolean;
  /** The hook event name, as the config spells it. */
  event: string;
}

export const ASSISTANT_HOOKS: Readonly<Record<HookedAssistantId, AssistantHookSpec>> = {
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    script: `.github/copilot/hooks/${ASSISTANT_HOOK_SCRIPT_NAME}`,
    config: '.github/copilot/settings.local.json',
    ignoreConfig: true,
    event: 'preToolUse',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    script: `.codex/hooks/${ASSISTANT_HOOK_SCRIPT_NAME}`,
    config: '.codex/hooks.json',
    ignoreConfig: true,
    event: 'PreToolUse',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    script: `.gemini/hooks/${ASSISTANT_HOOK_SCRIPT_NAME}`,
    config: '.gemini/settings.json',
    ignoreConfig: false,
    event: 'BeforeTool',
  },
};

/**
 * The file-writing tools the script acts on, across the three tools (and
 * Claude-style names, which Copilot can report): every other tool name is
 * waved through. Also the Copilot matcher (anchored by Copilot).
 */
export const EDIT_TOOL_NAMES: readonly string[] = [
  // Copilot CLI / Copilot in VS Code (and Claude-style names it can report)
  'edit', 'create', 'write', 'str_replace_editor', 'str_replace', 'insert', 'apply_patch',
  'create_file', 'edit_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file',
  'Edit', 'Write', 'MultiEdit',
  // Gemini CLI
  'write_file', 'replace',
];

const MATCHERS: Readonly<Record<HookedAssistantId, string>> = {
  copilot: EDIT_TOOL_NAMES.join('|'),
  // Codex: apply_patch also matches its Edit and Write aliases.
  codex: 'apply_patch|Edit|Write',
  gemini: 'write_file|replace',
};

/** How the deny reason tells each tool to load the skill. */
const LOAD_SKILL: Readonly<Record<HookedAssistantId, string>> = {
  copilot: 'load the /erd-studio skill (file-format rules)',
  codex: 'load the $erd-studio skill (file-format rules)',
  gemini: 'activate the erd-studio skill (file-format rules)',
};

/** The reason a denied first edit carries, for one tool (before `applySemanticDir`). */
export function assistantHookDenyReason(id: HookedAssistantId): string {
  return `ERD Studio: ${LOAD_SKILL[id]} before editing .erd-studio files, then retry. `
    + 'This is a one-time check per session — the erd-studio-setup walkthrough expects it.';
}

/** The exact JSON the script prints to deny, in each tool's documented shape. */
export function assistantHookDenyJson(id: HookedAssistantId): string {
  const reason = assistantHookDenyReason(id);
  switch (id) {
    case 'copilot':
      // Top level, as the Copilot hooks reference documents it.
      return JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason });
    case 'codex':
      return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    case 'gemini':
      return JSON.stringify({ decision: 'deny', reason });
  }
}

/** What the script prints when it has no decision: nothing, or Gemini CLI's documented `{}`. */
const PASS_OUTPUT: Readonly<Record<HookedAssistantId, string>> = {
  copilot: '',
  codex: '',
  gemini: "printf '{}\\n'",
};

const SCRIPT_TEMPLATE = String.raw`#!/usr/bin/env bash
# <!-- erd-studio-harness: @@VERSION@@ -->
# ERD Studio — @@NAME@@ pre-edit hook (@@EVENT@@), written by Set Up My AI Helper.
# Blocks the first edit to a .erd-studio file in each @@NAME@@ session, so the
# erd-studio skill (the file-format rules) is loaded before anything is written.
# Every other call gets no decision, so @@NAME@@'s normal permission flow
# decides: this hook only ever denies, it never approves an edit. It always
# exits 0, so a problem in it can never block a tool call.

deny='@@DENY@@'

pass() {
@@PASS@@
  exit 0
}

input="$(cat)"
# A string field's value, from the payload as sent. A path written inside a
# file's content or a patch body stays escaped (\"path\"), so it never reads
# as the file being edited.
field() {
  printf '%s' "$2" | grep -o "\"$1\" *: *\"[^\"]*\"" | head -1 | sed 's/.*: *"//;s/"$//'
}
# The Copilot CLI sends the tool's arguments as one JSON-encoded string:
# decode that string (and nothing else) once, so its fields read the same.
args="$(printf '%s' "$input" | grep -oE '"toolArgs" *: *"(\\.|[^"\\])*"' | head -1 | sed 's/^"toolArgs" *: *"//;s/"$//;s/\\\(.\)/\1/g')"

tool="$(field tool_name "$input")"
[ -n "$tool" ] || tool="$(field toolName "$input")"
case "$tool" in
  @@TOOLS@@) ;;
  *) pass ;;
esac

session="$(field session_id "$input")"
[ -n "$session" ] || session="$(field sessionId "$input")"
session="$(printf '%s' "$session" | tr -cd 'A-Za-z0-9._-')"
if [ -z "$session" ]; then
  # No session id (an older build): check once a day per project folder
  # instead, never once per machine.
  session="nosession-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)-$(date +%Y%m%d)"
fi

# Every path the call writes: the file_path / filePath / path fields, and the
# file headers of an apply_patch patch (a header starts the patch or a line;
# a body line starts with +, - or a space, so it never counts).
paths="$(
  for text in "$input" "$args"; do
    printf '%s' "$text" | grep -oE '"(file_path|filePath|path)" *: *"[^"]*"' | sed 's/.*: *"//;s/"$//'
    printf '%s' "$text" | grep -oE '(^|"|\\n)\*\*\* (Add|Update|Delete) File: [^"\\]*|(^|"|\\n)\*\*\* Move to: [^"\\]*' | sed 's/^.*\*\*\* [A-Za-z ]*: //'
  done
)"

# Only files inside .erd-studio/ count. modelling-approach.md is free-form
# notes with no file format, so it needs no skill loaded first.
hit=""
while IFS= read -r p; do
  p="$(printf '%s' "$p" | tr '\\' '/' | tr -s '/')"
  case "$p" in
    ".erd-studio/modelling-approach.md"|*/".erd-studio/modelling-approach.md") ;;
    ".erd-studio/"*|*/".erd-studio/"*) hit=1 ;;
  esac
done <<EOF
$paths
EOF
[ -n "$hit" ] || pass

tmp="$TMPDIR"
[ -n "$tmp" ] || tmp=/tmp
flag="$tmp/.erd-studio-skill-@@ID@@-$session"
[ -f "$flag" ] && pass
# Deny only once the marker is written, so a read-only temp folder can never
# turn this into a deny on every edit.
touch "$flag" 2>/dev/null || pass
printf '%s\n' "$deny"
exit 0
`;

/** The hook script for one tool (before `applySemanticDir`), carrying `version` as its marker. */
export function generateAssistantHookScript(id: HookedAssistantId, version: string): string {
  const spec = ASSISTANT_HOOKS[id];
  const fill: Record<string, string> = {
    '@@VERSION@@': version,
    '@@NAME@@': spec.name,
    '@@EVENT@@': spec.event,
    '@@DENY@@': assistantHookDenyJson(id),
    '@@PASS@@': PASS_OUTPUT[id] ? `  ${PASS_OUTPUT[id]}` : '  :',
    '@@TOOLS@@': EDIT_TOOL_NAMES.join('|'),
    '@@ID@@': id,
  };
  let text = SCRIPT_TEMPLATE;
  for (const [token, value] of Object.entries(fill)) { text = text.split(token).join(value); }
  return text;
}

/**
 * The POSIX shell command each config registers. It looks for the script from
 * the start folder up to `/` — the tools run hooks from the session folder,
 * which may be below the project root — and is a silent no-op (exit 0, no
 * output) when the script is not there, e.g. in a clone that never ran Set Up
 * My AI Helper.
 */
export function assistantHookCommand(id: HookedAssistantId): string {
  const rel = ASSISTANT_HOOKS[id].script;
  // Gemini CLI sets $GEMINI_PROJECT_DIR; the others run hooks from the session folder.
  const start = id === 'gemini' ? 'd="$GEMINI_PROJECT_DIR"; [ -n "$d" ] || d="$PWD"; ' : 'd="$PWD"; ';
  return `${start}while [ "$d" != / ] && [ "$d" != . ] && [ ! -f "$d/${rel}" ]; do d="$(dirname "$d")"; done; `
    + `[ -f "$d/${rel}" ] && bash "$d/${rel}" || true`;
}

/**
 * On Windows the Copilot and Codex hooks run in PowerShell / cmd, where the
 * bash script cannot run: a no-op there (the skill is still always on).
 */
export const WINDOWS_NO_OP = 'exit 0';

/** The entry ERD Studio adds to each tool's hook list. */
export function assistantHookEntry(id: HookedAssistantId): Record<string, unknown> {
  const command = assistantHookCommand(id);
  switch (id) {
    case 'copilot':
      return { type: 'command', bash: command, powershell: WINDOWS_NO_OP, timeoutSec: 10, matcher: MATCHERS.copilot };
    case 'codex':
      return { matcher: MATCHERS.codex, hooks: [{ type: 'command', command, commandWindows: WINDOWS_NO_OP, timeout: 10 }] };
    case 'gemini':
      return { matcher: MATCHERS.gemini, hooks: [{ name: 'erd-studio-skill', type: 'command', command, timeout: 10000 }] };
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Whether a hook (flat entry or one inside a group) is ERD Studio's: any string field names the script. */
function isOurHook(h: unknown): boolean {
  return isObject(h) && Object.values(h).some((v) => typeof v === 'string' && v.includes(ASSISTANT_HOOK_SCRIPT_NAME));
}

/** Whether an event-list entry is or holds ERD Studio's hook. */
function entryHoldsOurs(entry: unknown): boolean {
  return isOurHook(entry) || (isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isOurHook));
}

/** The tool's event list in parsed settings, or `null` when it is not there in a usable shape. */
function eventList(settings: unknown, id: HookedAssistantId): unknown[] | null {
  if (!isObject(settings) || !isObject(settings.hooks)) { return null; }
  const list = settings.hooks[ASSISTANT_HOOKS[id].event];
  return Array.isArray(list) ? list : null;
}

/** Whether a config's text registers ERD Studio's hook for this tool. Malformed JSON (comments included): no. */
export function isAssistantHookRegistered(id: HookedAssistantId, text: string): boolean {
  try {
    return eventList(JSON.parse(text), id)?.some(entryHoldsOurs) ?? false;
  } catch {
    return false;
  }
}

/**
 * Why a config cannot take the hook: `jsonc` (comments or trailing commas, which
 * Gemini CLI's settings file allows: rewriting it would lose them), `not-json`
 * or `shape` (its `hooks` or event value is not the shape the tool documents).
 */
export type HookConfigProblem = 'jsonc' | 'not-json' | 'shape';

export type HookConfigMerge =
  | { status: 'written'; text: string }
  | { status: 'unchanged' }
  /** Left alone, never rewritten. */
  | { status: 'unusable'; problem: HookConfigProblem };

/**
 * `text` with its `//` and `/* *\/` comments and trailing commas removed,
 * outside strings. Only used to tell a commented file from a broken one.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { j += text[j] === '\\' ? 2 : 1; }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { i++; }
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** The indent unit a JSON file already uses (its first indented key), else two spaces. */
function indentOf(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : '  ';
}

/**
 * Merge ERD Studio's hook into one tool's config text (`null`: no file yet).
 * Every other key and hook is kept as it is, and the file keeps its indent,
 * line endings and final newline (or lack of one). An ERD Studio entry that is
 * already current is left alone; an older one is removed (keeping any other
 * hook that shares its group, dropping a group left empty) and the current
 * one appended once. A file that does not parse as plain JSON (comments
 * included), or whose `hooks` or event value has another shape, is never
 * rewritten.
 */
export function mergeAssistantHookConfig(id: HookedAssistantId, existing: string | null): HookConfigMerge {
  let settings: Json = {};
  const hasText = existing !== null && existing.trim() !== '';
  if (hasText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      let commented = false;
      try { JSON.parse(stripJsonComments(existing)); commented = true; } catch { commented = false; }
      return { status: 'unusable', problem: commented ? 'jsonc' : 'not-json' };
    }
    if (!isObject(parsed)) { return { status: 'unusable', problem: 'shape' }; }
    settings = parsed;
  }
  const event = ASSISTANT_HOOKS[id].event;
  if (settings.hooks !== undefined && !isObject(settings.hooks)) { return { status: 'unusable', problem: 'shape' }; }
  const hooks: Json = isObject(settings.hooks) ? settings.hooks : {};
  if (hooks[event] !== undefined && !Array.isArray(hooks[event])) { return { status: 'unusable', problem: 'shape' }; }
  const list: unknown[] = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];

  const entry = assistantHookEntry(id);
  const wanted = JSON.stringify(entry);
  const ours = list.filter(entryHoldsOurs);
  if (ours.length === 1 && JSON.stringify(ours[0]) === wanted) { return { status: 'unchanged' }; }

  const kept = list
    .map((e) => {
      if (isOurHook(e)) { return null; }
      if (isObject(e) && Array.isArray(e.hooks) && e.hooks.some(isOurHook)) {
        const rest = e.hooks.filter((h) => !isOurHook(h));
        return rest.length > 0 ? { ...e, hooks: rest } : null;
      }
      return e;
    })
    .filter((e) => e !== null);
  const next: Json = { ...settings, hooks: { ...hooks, [event]: [...kept, entry] } };
  const source = hasText ? existing : '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = !hasText || /\n\s*$/.test(source);
  const body = JSON.stringify(next, null, indentOf(source)).replace(/\n/g, eol);
  return { status: 'written', text: finalNewline ? body + eol : body };
}

/** One plain sentence for the Welcome panel on why a hook was left out. */
export function describeSkippedAssistantHook(skip: SkippedAssistantHook): string {
  const spec = ASSISTANT_HOOKS[skip.id];
  const left = `so ERD Studio left it alone and didn't add ${spec.name}'s safety check.`;
  const reasons: Record<AssistantHookSkipReason, string> = {
    'jsonc': `${spec.config} has comments in it, ${left}`,
    'not-json': `${spec.config} isn't valid JSON, ${left}`,
    'shape': `${spec.config} has a "hooks" setting ERD Studio doesn't recognise, ${left}`,
    'own-script': `${spec.script} is a file of your own, ${left}`,
    'newer-script': `${spec.script} comes from a newer ERD Studio, so this one didn't change ${spec.name}'s safety check.`,
  };
  return reasons[skip.reason];
}
