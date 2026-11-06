import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import {
  ASSISTANT_HOOKS,
  HOOKED_ASSISTANTS,
  assistantHookCommand,
  assistantHookDenyReason,
  assistantHookEntry,
  describeSkippedAssistantHook,
  generateAssistantHookScript,
  isAssistantHookRegistered,
  mergeAssistantHookConfig,
  type HookedAssistantId,
} from '../../src/services/assistantHooks';
import {
  HARNESS_TARGETS,
  HARNESS_VERSION,
  HarnessService,
  extractHarnessVersion,
  recommendedHookAssistants,
} from '../../src/services/harnessService';

const CLAUDE = HARNESS_TARGETS.find((t) => t.id === 'claude')!;
const AGENTS = HARNESS_TARGETS.find((t) => t.id === 'agents')!;
const ALL: HookedAssistantId[] = ['copilot', 'codex', 'gemini'];

/** Any allow / approve / ask decision, in any of the three tools' shapes (or Cursor's). */
const APPROVING = /"(permissionDecision|decision|permission)"\s*:\s*"(allow|approve|ask)"/i;

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

let tmpDir: string;
let tmpFlags: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-hooks-'));
  tmpFlags = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-hook-flags-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpFlags, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFileSync(path.join(tmpDir, ...rel.split('/')), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(tmpDir, ...rel.split('/')));
const write = (rel: string, text: string) => {
  const p = path.join(tmpDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

/** The payload each tool sends for a file edit, in its documented shape. */
function payload(id: HookedAssistantId, filePath: string, session: string, tool?: string): string {
  switch (id) {
    case 'copilot':
      // camelCase preToolUse: toolArgs as a JSON-encoded string, as the how-to's sample shows.
      return JSON.stringify({ sessionId: session, timestamp: 1, cwd: '/p', toolName: tool ?? 'edit', toolArgs: JSON.stringify({ path: filePath, old_str: 'a', new_str: 'b' }) });
    case 'codex':
      return JSON.stringify({
        session_id: session, hook_event_name: 'PreToolUse', tool_name: tool ?? 'apply_patch', tool_use_id: 't1', cwd: '/p',
        tool_input: { command: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-a\n+b\n*** End Patch\n` },
      });
    case 'gemini':
      return JSON.stringify({ session_id: session, hook_event_name: 'BeforeTool', tool_name: tool ?? 'write_file', cwd: '/p', tool_input: { file_path: filePath, content: 'x' } });
  }
}

/** What each tool's script prints when it has no decision. */
const SILENT: Record<HookedAssistantId, string> = { copilot: '', codex: '', gemini: '{}\n' };

/** The deny reason as each tool's documented deny shape carries it. */
function reasonOf(id: HookedAssistantId, stdout: string): string {
  const out = JSON.parse(stdout);
  switch (id) {
    case 'copilot':
      expect(out.permissionDecision).toBe('deny');
      return out.permissionDecisionReason;
    case 'codex':
      expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      return out.hookSpecificOutput.permissionDecisionReason;
    case 'gemini':
      expect(out.decision).toBe('deny');
      return out.reason;
  }
}

function writeScript(id: HookedAssistantId, semanticDir = '.erd-studio'): string {
  new HarnessService(semanticDir).install(tmpDir, AGENTS, true, { hookAssistants: [id] });
  return path.join(tmpDir, ...ASSISTANT_HOOKS[id].script.split('/'));
}

function run(script: string, input: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [script], { input, encoding: 'utf-8', env: { ...process.env, TMPDIR: tmpFlags, ...env } });
}

describe('assistant hooks only ever deny', () => {
  it('no generated script or config entry carries an allow, approve or ask decision, in any semanticDir', () => {
    for (const dir of ['.erd-studio', '.erd', 'docs/erd']) {
      for (const id of ALL) {
        const script = generateAssistantHookScript(id, HARNESS_VERSION);
        expect(script, id).not.toMatch(APPROVING);
        expect(JSON.stringify(assistantHookEntry(id)), id).not.toMatch(APPROVING);
        new HarnessService(dir).install(tmpDir, AGENTS, true, { hookAssistants: ALL });
        expect(read(ASSISTANT_HOOKS[id].script), `${dir} ${id}`).not.toMatch(APPROVING);
        expect(read(ASSISTANT_HOOKS[id].config), `${dir} ${id}`).not.toMatch(APPROVING);
      }
    }
  });

  it('every script always exits 0 and its registered command ends in || true (Copilot fails closed on an error)', () => {
    for (const id of ALL) {
      expect(generateAssistantHookScript(id, HARNESS_VERSION).trimEnd().endsWith('exit 0'), id).toBe(true);
      expect(assistantHookCommand(id).endsWith('|| true'), id).toBe(true);
    }
  });

  it('each script carries the harness version marker', () => {
    for (const id of ALL) {
      expect(extractHarnessVersion(generateAssistantHookScript(id, HARNESS_VERSION))).toBe(HARNESS_VERSION);
    }
  });

  it('Windows runs a no-op where the tool has a Windows command (Copilot, Codex)', () => {
    expect(assistantHookEntry('copilot').powershell).toBe('exit 0');
    const codex = assistantHookEntry('codex') as { hooks: Array<Record<string, unknown>> };
    expect(codex.hooks[0].commandWindows).toBe('exit 0');
  });
});

describe.skipIf(!hasBash)('running each hook script with sample payloads', () => {
  for (const id of ALL) {
    describe(ASSISTANT_HOOKS[id].name, () => {
      it('denies the first .erd-studio edit with the reason, then stays silent; other paths are untouched', () => {
        const script = writeScript(id);
        const session = `s-${id}`;

        const other = run(script, payload(id, '/p/models/orders.sql', session));
        expect(other.status).toBe(0);
        expect(other.stdout).toBe(SILENT[id]);
        expect(fs.readdirSync(tmpFlags)).toEqual([]);

        const first = run(script, payload(id, '/p/.erd-studio/gold/tables/orders.dbml', session));
        expect(first.status).toBe(0);
        expect(reasonOf(id, first.stdout)).toBe(assistantHookDenyReason(id));

        const second = run(script, payload(id, '/p/.erd-studio/gold/tables/orders.dbml', session));
        expect(second.status).toBe(0);
        expect(second.stdout).toBe(SILENT[id]);

        // A new session is checked again.
        expect(reasonOf(id, run(script, payload(id, '/p/.erd-studio/x.dbml', `${session}-2`)).stdout)).toBe(assistantHookDenyReason(id));
      });

      it('gates a relative path too, and lets modelling-approach.md through without spending the check', () => {
        const script = writeScript(id);
        const notes = run(script, payload(id, '.erd-studio/modelling-approach.md', 'rel'));
        expect(notes.stdout).toBe(SILENT[id]);
        expect(fs.readdirSync(tmpFlags)).toEqual([]);
        expect(reasonOf(id, run(script, payload(id, '.erd-studio/gold/diagrams/orders.dbml', 'rel')).stdout)).toBe(assistantHookDenyReason(id));
      });

      it('waves through a tool that does not write files', () => {
        const script = writeScript(id);
        for (const tool of ['view', 'read_file', 'run_shell_command', 'shell', '']) {
          const r = run(script, payload(id, '/p/.erd-studio/gold/tables/orders.dbml', 'tools', tool));
          expect(r.status, tool).toBe(0);
          expect(r.stdout, tool).toBe(SILENT[id]);
        }
        expect(fs.readdirSync(tmpFlags)).toEqual([]);
      });

      it('never denies on every call when the marker cannot be written, and exits 0 on garbage input', () => {
        const script = writeScript(id);
        const missing = path.join(tmpFlags, 'no', 'such', 'dir');
        for (let i = 0; i < 2; i++) {
          const r = run(script, payload(id, '/p/.erd-studio/a.dbml', 'ro'), { TMPDIR: missing });
          expect(r.status).toBe(0);
          expect(r.stdout).toBe(SILENT[id]);
        }
        for (const input of ['', 'not json', '{"tool_name": 3}']) {
          const r = run(script, input);
          expect(r.status, input).toBe(0);
          expect(r.stdout, input).toBe(SILENT[id]);
        }
      });

      it('follows a custom semanticDir', () => {
        const script = writeScript(id, 'docs/erd');
        expect(run(script, payload(id, '/p/.erd-studio/a.dbml', 'custom')).stdout).toBe(SILENT[id]);
        const denied = reasonOf(id, run(script, payload(id, '/p/docs/erd/gold/tables/a.dbml', 'custom')).stdout);
        expect(denied).toContain('before editing docs/erd files');
        expect(denied).toContain('erd-studio skill');
        expect(read(ASSISTANT_HOOKS[id].script)).toContain('.erd-studio-skill-');
      });
    });
  }

  it('Copilot: also reads toolArgs sent as an object, and the Claude-style names it can report', () => {
    const script = writeScript('copilot');
    const r = run(script, JSON.stringify({ session_id: 'obj', tool_name: 'Edit', tool_input: { path: '/p/.erd-studio/a.dbml' } }));
    expect(reasonOf('copilot', r.stdout)).toBe(assistantHookDenyReason('copilot'));
  });

  it('Gemini CLI: reads a Windows path', () => {
    const script = writeScript('gemini');
    const r = run(script, JSON.stringify({ session_id: 'win', tool_name: 'replace', tool_input: { file_path: 'C:\\proj\\.erd-studio\\gold\\a.dbml' } }));
    expect(reasonOf('gemini', r.stdout)).toBe(assistantHookDenyReason('gemini'));
  });

  it('a path written inside file content or a patch body is not the file being edited', () => {
    const codex = writeScript('codex');
    const patch = JSON.stringify({ session_id: 'body', tool_name: 'apply_patch', tool_input: {
      command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const p = { "path": ".erd-studio/x.dbml" };\n-*** Update File: .erd-studio/y.dbml\n+const p = 1;\n*** End Patch\n',
    } });
    expect(run(codex, patch).stdout).toBe('');
    const gemini = writeScript('gemini');
    const content = JSON.stringify({ session_id: 'body', tool_name: 'write_file', tool_input: { file_path: 'docs/notes.md', content: '{"file_path": ".erd-studio/x.dbml"}' } });
    expect(run(gemini, content).stdout).toBe('{}\n');
    const copilot = writeScript('copilot');
    const args = JSON.stringify({ sessionId: 'body', toolName: 'create', toolArgs: JSON.stringify({ path: 'docs/notes.md', file_text: '{"path": ".erd-studio/x.dbml"}' }) });
    expect(run(copilot, args).stdout).toBe('');
    expect(fs.readdirSync(tmpFlags)).toEqual([]);
    // The real path inside Copilot's encoded toolArgs still counts.
    const real = JSON.stringify({ sessionId: 'body', toolName: 'create', toolArgs: JSON.stringify({ path: '.erd-studio/x.dbml', file_text: 'docs/notes.md' }) });
    expect(reasonOf('copilot', run(copilot, real).stdout)).toBe(assistantHookDenyReason('copilot'));
  });

  it('without a session id, checks once per project folder per day, never on every edit', () => {
    const script = writeScript('copilot');
    const noSession = JSON.stringify({ toolName: 'edit', toolArgs: JSON.stringify({ path: '.erd-studio/a.dbml' }) });
    expect(reasonOf('copilot', run(script, noSession).stdout)).toBe(assistantHookDenyReason('copilot'));
    expect(run(script, noSession).stdout).toBe('');
    expect(fs.readdirSync(tmpFlags)).toEqual([expect.stringMatching(/^\.erd-studio-skill-copilot-nosession-\d+-\d{8}$/)]);
  });

  it('Codex: an added file in a patch counts, and a patch that only touches other files does not', () => {
    const script = writeScript('codex');
    const other = JSON.stringify({ session_id: 'p', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: models/x.sql\n+select 1\n*** End Patch\n' } });
    expect(run(script, other).stdout).toBe('');
    const added = JSON.stringify({ session_id: 'p', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: models/x.sql\n@@\n*** Add File: .erd-studio/gold/tables/x.dbml\n+Table x {}\n*** End Patch\n' } });
    expect(reasonOf('codex', run(script, added).stdout)).toBe(assistantHookDenyReason('codex'));
  });

  it('the registered command finds the script from a folder below the project, and is a silent no-op without it', () => {
    for (const id of ALL) {
      new HarnessService().install(tmpDir, AGENTS, true, { hookAssistants: [id] });
      const sub = path.join(tmpDir, 'models', 'marts');
      fs.mkdirSync(sub, { recursive: true });
      const env = { ...process.env, TMPDIR: tmpFlags, GEMINI_PROJECT_DIR: '' };
      for (const shell of ['bash', 'sh']) {
        fs.rmSync(tmpFlags, { recursive: true, force: true });
        fs.mkdirSync(tmpFlags);
        const r = spawnSync(shell, ['-c', assistantHookCommand(id)], { cwd: sub, input: payload(id, '/p/.erd-studio/a.dbml', `cmd-${shell}`), encoding: 'utf-8', env });
        expect(r.status, `${id} ${shell}`).toBe(0);
        expect(reasonOf(id, r.stdout), `${id} ${shell}`).toBe(assistantHookDenyReason(id));
      }
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'no-hook-'));
      try {
        const r = spawnSync('bash', ['-c', assistantHookCommand(id)], { cwd: elsewhere, input: payload(id, '/p/.erd-studio/a.dbml', 'none'), encoding: 'utf-8', env });
        expect(r.status, id).toBe(0);
        expect(r.stdout, id).toBe('');
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    }
  });

  it('Gemini CLI: the command starts from $GEMINI_PROJECT_DIR', () => {
    new HarnessService().install(tmpDir, AGENTS, true, { hookAssistants: ['gemini'] });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cwd-'));
    try {
      const r = spawnSync('bash', ['-c', assistantHookCommand('gemini')], {
        cwd: elsewhere, input: payload('gemini', '/p/.erd-studio/a.dbml', 'gpd'), encoding: 'utf-8',
        env: { ...process.env, TMPDIR: tmpFlags, GEMINI_PROJECT_DIR: tmpDir },
      });
      expect(reasonOf('gemini', r.stdout)).toBe(assistantHookDenyReason('gemini'));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('mergeAssistantHookConfig', () => {
  for (const id of ALL) {
    const event = ASSISTANT_HOOKS[id].event;
    describe(ASSISTANT_HOOKS[id].name, () => {
      it('creates the config, and is then unchanged', () => {
        const first = mergeAssistantHookConfig(id, null);
        expect(first.status).toBe('written');
        const text = (first as { text: string }).text;
        expect(JSON.parse(text)).toEqual({ hooks: { [event]: [assistantHookEntry(id)] } });
        expect(isAssistantHookRegistered(id, text)).toBe(true);
        expect(mergeAssistantHookConfig(id, text)).toEqual({ status: 'unchanged' });
      });

      it("keeps the user's other settings and hooks", () => {
        const theirs = { model: 'x', hooks: { [event]: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'echo theirs' }] }], Other: [{ x: 1 }] } };
        const merged = mergeAssistantHookConfig(id, JSON.stringify(theirs));
        const out = JSON.parse((merged as { text: string }).text);
        expect(out.model).toBe('x');
        expect(out.hooks.Other).toEqual([{ x: 1 }]);
        expect(out.hooks[event]).toEqual([theirs.hooks[event][0], assistantHookEntry(id)]);
      });

      it('replaces an older ERD Studio entry once, keeping a hook that shares its group', () => {
        const old = { type: 'command', command: `bash .old/${'erd-studio-enforce-skill.sh'}`, bash: `bash .old/erd-studio-enforce-skill.sh` };
        const theirs = { type: 'command', command: 'echo theirs' };
        const text = JSON.stringify({ hooks: { [event]: [{ matcher: 'x', hooks: [old, theirs] }, old] } });
        const out = JSON.parse((mergeAssistantHookConfig(id, text) as { text: string }).text);
        expect(out.hooks[event]).toEqual([{ matcher: 'x', hooks: [theirs] }, assistantHookEntry(id)]);
      });

      it('leaves a file it cannot read as JSON, or of another shape, alone', () => {
        expect(mergeAssistantHookConfig(id, '{ broken')).toEqual({ status: 'unusable', problem: 'not-json' });
        expect(mergeAssistantHookConfig(id, '[]')).toEqual({ status: 'unusable', problem: 'shape' });
        expect(mergeAssistantHookConfig(id, '{"hooks": []}')).toEqual({ status: 'unusable', problem: 'shape' });
        expect(mergeAssistantHookConfig(id, JSON.stringify({ hooks: { [event]: {} } }))).toEqual({ status: 'unusable', problem: 'shape' });
        expect(isAssistantHookRegistered(id, '{ broken')).toBe(false);
      });

      it('never rewrites a file with comments or trailing commas (they would be lost)', () => {
        expect(mergeAssistantHookConfig(id, '{\n  // mine\n  "theme": "dark", /* x */\n}\n')).toEqual({ status: 'unusable', problem: 'jsonc' });
        expect(mergeAssistantHookConfig(id, '{ "url": "http://x//y", }')).toEqual({ status: 'unusable', problem: 'jsonc' });
        // A "//" inside a string is not a comment.
        expect(mergeAssistantHookConfig(id, '{ "url": "http://x//y" }').status).toBe('written');
      });

      it("keeps the file's indent, line endings and final newline", () => {
        const tabbed = (mergeAssistantHookConfig(id, '{\n\t"theme": "dark"\n}') as { text: string }).text;
        expect(tabbed).toMatch(/^\{\n\t"theme": "dark",\n\t"hooks"/);
        expect(tabbed.endsWith('}')).toBe(true);
        const four = (mergeAssistantHookConfig(id, '{\r\n    "theme": "dark"\r\n}\r\n') as { text: string }).text;
        expect(four).toMatch(/^\{\r\n    "theme": "dark",\r\n    "hooks"/);
        expect(four.endsWith('}\r\n')).toBe(true);
        expect(four.replace(/\r\n/g, '')).not.toContain('\n');
        expect((mergeAssistantHookConfig(id, null) as { text: string }).text).toMatch(/^\{\n  "hooks"[\s\S]*\}\n$/);
      });
    });
  }
});

describe('HarnessService: installing the assistant hooks', () => {
  const service = new HarnessService();

  it('install() alone adds no assistant hook (Update All never adds a tool config)', () => {
    service.install(tmpDir, AGENTS, true);
    service.install(tmpDir, CLAUDE, true);
    for (const id of ALL) {
      expect(exists(ASSISTANT_HOOKS[id].script), id).toBe(false);
      expect(exists(ASSISTANT_HOOKS[id].config), id).toBe(false);
    }
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: false, codex: false, gemini: false });
  });

  it('the agents folder registers the asked-for hooks; Copilot and Codex files are ignored, Gemini CLI settings are not', () => {
    const result = service.install(tmpDir, AGENTS, true, { hookAssistants: ['claude', 'copilot', 'codex', 'gemini', 'cursor'] });
    expect(result.filesWritten).toEqual(expect.arrayContaining(ALL.flatMap((id) => [ASSISTANT_HOOKS[id].script, ASSISTANT_HOOKS[id].config])));
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: true, codex: true, gemini: true });
    for (const id of ALL) {
      expect(fs.statSync(path.join(tmpDir, ...ASSISTANT_HOOKS[id].script.split('/'))).mode & 0o111, id).not.toBe(0);
    }
    const ignored = read('.gitignore').split('\n');
    expect(ignored).toEqual(expect.arrayContaining([
      '.github/copilot/settings.local.json', '.github/copilot/hooks/erd-studio-enforce-skill.sh',
      '.codex/hooks.json', '.codex/hooks/erd-studio-enforce-skill.sh',
    ]));
    expect(ignored.some((l) => l.startsWith('.gemini') || l.startsWith('.agents'))).toBe(false);
    // No Cursor hook, and no Claude settings from the agents folder.
    expect(exists('.cursor')).toBe(false);
    expect(exists('.claude')).toBe(false);
  });

  it('the Claude folder adds only the Copilot hook (Codex and Gemini CLI do not read .claude/skills)', () => {
    service.install(tmpDir, CLAUDE, true, { hookAssistants: ['copilot', 'codex', 'gemini'] });
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: true, codex: false, gemini: false });
  });

  it("merges into the user's existing configs, and never ignores a config ERD Studio did not create", () => {
    write('.gemini/settings.json', JSON.stringify({ theme: 'dark', hooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo x' }] }] } }));
    write('.codex/hooks.json', JSON.stringify({ hooks: { PostToolUse: [] } }));
    service.install(tmpDir, AGENTS, true, { hookAssistants: ['codex', 'gemini'] });
    const gemini = JSON.parse(read('.gemini/settings.json'));
    expect(gemini.theme).toBe('dark');
    expect(gemini.hooks.BeforeTool).toHaveLength(2);
    expect(JSON.parse(read('.codex/hooks.json')).hooks.PostToolUse).toEqual([]);
    const ignored = exists('.gitignore') ? read('.gitignore') : '';
    expect(ignored).not.toContain('.codex/');
  });

  it('leaves a malformed config, and a hand-written script at its path, alone', () => {
    write('.codex/hooks.json', '{ broken');
    write('.gemini/hooks/erd-studio-enforce-skill.sh', '#!/bin/bash\necho mine\n');
    const result = service.install(tmpDir, AGENTS, true, { hookAssistants: ['codex', 'gemini'] });
    expect(read('.codex/hooks.json')).toBe('{ broken');
    expect(exists('.codex/hooks/erd-studio-enforce-skill.sh')).toBe(false);
    expect(read('.gemini/hooks/erd-studio-enforce-skill.sh')).toBe('#!/bin/bash\necho mine\n');
    expect(exists('.gemini/settings.json')).toBe(false);
    expect(result.success).toBe(true);
  });

  it('a later install keeps a registered hook current without being asked, and writes nothing when it is', () => {
    service.install(tmpDir, AGENTS, true, { hookAssistants: ['codex'] });
    write('.codex/hooks/erd-studio-enforce-skill.sh', '#!/usr/bin/env bash\n# <!-- erd-studio-harness: 40 -->\nexit 0\n');
    const update = service.install(tmpDir, AGENTS, true);
    expect(update.filesWritten).toContain('.codex/hooks/erd-studio-enforce-skill.sh');
    expect(extractHarnessVersion(read('.codex/hooks/erd-studio-enforce-skill.sh'))).toBe(HARNESS_VERSION);
    const again = service.install(tmpDir, AGENTS, true);
    expect(again.filesWritten!.some((f) => f.startsWith('.codex'))).toBe(false);
    expect(exists('.github/copilot')).toBe(false);
  });

  it('a script from a newer ERD Studio is never replaced', () => {
    const newer = '#!/usr/bin/env bash\n# <!-- erd-studio-harness: 999 -->\nexit 0\n';
    write('.github/copilot/hooks/erd-studio-enforce-skill.sh', newer);
    service.install(tmpDir, AGENTS, true, { hookAssistants: ['copilot'] });
    expect(read('.github/copilot/hooks/erd-studio-enforce-skill.sh')).toBe(newer);
  });

  it('status needs both the script and its registration', () => {
    service.install(tmpDir, AGENTS, true, { hookAssistants: ['copilot'] });
    expect(service.harnessStatus(tmpDir).hooks.copilot).toBe(true);
    fs.unlinkSync(path.join(tmpDir, '.github/copilot/hooks/erd-studio-enforce-skill.sh'));
    expect(service.harnessStatus(tmpDir).hooks.copilot).toBe(false);
    service.install(tmpDir, AGENTS, true, { hookAssistants: ['copilot'] });
    write('.github/copilot/settings.local.json', '{"hooks":{"preToolUse":[]}}');
    expect(service.harnessStatus(tmpDir).hooks.copilot).toBe(false);
  });
});

describe('Set Up My AI Helper (installRecommended) and the assistant hooks', () => {
  const service = new HarnessService();

  it('recommends the detected hooked assistants, and Copilot and Codex when none is detected', () => {
    expect(recommendedHookAssistants([])).toEqual(['copilot', 'codex']);
    expect(recommendedHookAssistants(['claude', 'cursor'])).toEqual([]);
    expect(recommendedHookAssistants(['gemini', 'claude', 'copilot'])).toEqual(['copilot', 'gemini']);
    expect(HOOKED_ASSISTANTS).toEqual(ALL);
  });

  it('Claude Code plus Copilot: the Copilot hook comes with the Claude folder', () => {
    const result = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['claude', 'copilot'] });
    expect(result.targets).toEqual(['claude']);
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: true, codex: false, gemini: false });
  });

  it('Gemini CLI alone: only its hook', () => {
    service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['gemini'] });
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: false, codex: false, gemini: true });
    expect(exists('.github/copilot')).toBe(false);
    expect(exists('.codex')).toBe(false);
  });

  it('Cursor alone: no hook (it has none ERD Studio can use)', () => {
    service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['cursor'] });
    expect(service.harnessStatus(tmpDir).hooks).toEqual({ copilot: false, codex: false, gemini: false });
    expect(exists('.cursor')).toBe(false);
  });

  it('a hook left out on purpose is reported, and counts as in place (no "updated" on every run)', () => {
    const commented = '{\n  // our team settings\n  "theme": "dark"\n}\n';
    write('.gemini/settings.json', commented);
    const first = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['gemini'] });
    expect(first.status).toBe('installed');
    expect(first.skippedHooks).toEqual([{ id: 'gemini', reason: 'jsonc' }]);
    const second = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['gemini'] });
    expect(second.status).toBe('unchanged');
    expect(second.filesWritten).toEqual([]);
    expect(second.skippedHooks).toEqual([{ id: 'gemini', reason: 'jsonc' }]);
    expect(read('.gemini/settings.json')).toBe(commented);
    expect(exists('.gemini/hooks')).toBe(false);

    write('.github/copilot/hooks/erd-studio-enforce-skill.sh', '#!/bin/bash\necho mine\n');
    const assistants = ['copilot'] as const;
    expect(service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants }).skippedHooks).toEqual([{ id: 'copilot', reason: 'own-script' }]);
    expect(service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants }).status).toBe('unchanged');
  });

  it('describes a skipped hook in one plain sentence', () => {
    expect(describeSkippedAssistantHook({ id: 'gemini', reason: 'jsonc' }))
      .toBe(".gemini/settings.json has comments in it, so ERD Studio left it alone and didn't add Gemini CLI's safety check.");
    for (const reason of ['jsonc', 'not-json', 'shape', 'own-script', 'newer-script'] as const) {
      expect(describeSkippedAssistantHook({ id: 'codex', reason })).toMatch(/^\.codex\/.*Codex's safety check\.$/);
    }
  });

  it('is unchanged once installed, and puts a removed hook back', () => {
    const assistants = ['codex'] as const;
    expect(service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants }).status).toBe('installed');
    expect(service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants }).status).toBe('unchanged');
    write('.codex/hooks.json', '{"hooks":{}}');
    const repaired = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants });
    expect(repaired.status).toBe('updated');
    expect(repaired.filesWritten).toEqual(['.codex/hooks.json']);
    expect(service.harnessStatus(tmpDir).hooks.codex).toBe(true);
  });
});

describe('the Welcome panel names the hook files', () => {
  it('ASSISTANT_HOOK_CONFIGS mirrors ASSISTANT_HOOKS', async () => {
    const { ASSISTANT_HOOK_CONFIGS } = await import('../../src/types/gettingStarted');
    expect(ASSISTANT_HOOK_CONFIGS).toEqual(ALL.map((id) => [ASSISTANT_HOOKS[id].config, ASSISTANT_HOOKS[id].name]));
  });

  it('groups them under a safety check titled by the assistants set up', async () => {
    const { describeWrittenFiles } = await import('../../src/types/gettingStarted');
    const groups = describeWrittenFiles([
      '.codex/hooks/erd-studio-enforce-skill.sh', '.codex/hooks.json',
      '.github/copilot/hooks/erd-studio-enforce-skill.sh', '.github/copilot/settings.local.json',
      '.claude/skills/erd-studio/enforce-skill.sh',
    ]);
    expect(groups.map((g) => g.title)).toEqual(['A safety check for Claude Code', 'A safety check for GitHub Copilot and Codex']);
    expect(groups[1].paths).toHaveLength(4);
    expect(groups[1].why).toBe('Makes them load those rules before their first edit to your diagrams. GitHub Copilot\'s and Codex\'s files stay out of git.');
    const gemini = describeWrittenFiles(['.gemini/settings.json', '.gemini/hooks/erd-studio-enforce-skill.sh'])[0];
    expect(gemini.title).toBe('A safety check for Gemini CLI');
    expect(gemini.why).not.toContain('Codex');
    expect(gemini.why).toContain('.gemini/settings.json');
    expect(describeWrittenFiles(['.github/copilot/settings.local.json'])[0].why).not.toMatch(/Codex|Gemini/);
  });
});
