import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import {
  HarnessService,
  HARNESS_TARGETS,
  HARNESS_VERSION,
  CODEX_REGION_BEGIN,
  CODEX_REGION_END,
  applySemanticDir,
  agentsManagedFiles,
  claudeManagedFiles,
  extractHarnessVersion,
  findCodexRegion,
  mergeCodexContent,
} from '../../src/services/harnessService';
import { parse as parseYaml } from 'yaml';
import {
  AGENT_SKILL_FRONTMATTER_KEYS,
  AGENTS_SETUP_SKILL_DIR,
  CLAUDE_SETUP_SKILL_DIR,
  CLAUDE_SETUP_SKILL_FILES,
  splitFrontmatter,
} from '../../src/services/harnessAssets';

const CLAUDE = HARNESS_TARGETS.find((t) => t.id === 'claude')!;
const AGENTS = HARNESS_TARGETS.find((t) => t.id === 'agents')!;
const AGENTS_SCHEMA_SKILL = '.agents/skills/erd-studio/SKILL.md';
const AGENTS_SYNC_GUIDE = '.agents/skills/erd-studio/SYNC.md';
const AGENTS_SETUP_SKILL = '.agents/skills/erd-studio-setup/SKILL.md';

/** A SKILL.md's frontmatter as parsed YAML, plus the body after it. */
function parseSkill(content: string): { fm: Record<string, unknown>; body: string } {
  const parts = splitFrontmatter(content);
  if (!parts) { throw new Error('no frontmatter'); }
  return { fm: parseYaml(parts.yaml) as Record<string, unknown>, body: parts.body };
}
const SCHEMA_SKILL = '.claude/skills/erd-studio/SKILL.md';
const SYNC_GUIDE = '.claude/skills/erd-studio/SYNC.md';
const HOOK = '.claude/skills/erd-studio/enforce-skill.sh';
const SETUP_SKILL = '.claude/skills/erd-studio-setup/SKILL.md';
const CURRENT_MARKER = `<!-- erd-studio-harness: ${HARNESS_VERSION} -->`;

function writeFile(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

/** Rewrite every marker in a file to an older version, as a v17 install would have left it. */
function ageMarker(root: string, rel: string, version = '17'): void {
  writeFile(root, rel, read(root, rel).replace(CURRENT_MARKER, `<!-- erd-studio-harness: ${version} -->`));
}

/** Every file under `root`, relative, with its contents — to prove a call wrote nothing. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); } else { out[path.relative(root, p)] = fs.readFileSync(p, 'utf-8'); }
    }
  };
  walk(root);
  return out;
}

describe('HarnessService', () => {
  let service: HarnessService;
  let tmpDir: string;

  beforeEach(() => {
    service = new HarnessService();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('HARNESS_TARGETS', () => {
    it('has 5 targets', () => {
      expect(HARNESS_TARGETS).toHaveLength(5);
    });

    it('covers claude, agents, copilot, gemini, codex', () => {
      const ids = HARNESS_TARGETS.map(t => t.id);
      expect(ids).toEqual(['claude', 'agents', 'copilot', 'gemini', 'codex']);
    });

    it('labels the Agent Skills target with the tools that read it', () => {
      expect(AGENTS.label).toContain('Agent Skills — GitHub Copilot, Codex, Gemini CLI, Cursor');
      expect(AGENTS.relativePath).toBe(AGENTS_SCHEMA_SKILL);
      // Never ignored: Gemini CLI's read_file refuses gitignored paths.
      expect(AGENTS.gitignorePattern).toBeUndefined();
    });
  });

  describe('generateContent', () => {
    it('generates Claude SKILL.md with YAML frontmatter', () => {
      const content = service.generateContent('claude');
      expect(content).toContain('---\nname: erd-studio');
      expect(content).toContain('description:');
      expect(content).toContain('# ERD Studio');
      expect(content).toContain('schemaVersion');
    });

    it('generates Copilot instructions with applyTo glob covering JSON and YAML', () => {
      const content = service.generateContent('copilot');
      expect(content).toContain("applyTo: '**/.erd-studio/**'");
      expect(content).not.toContain("applyTo: '**/.erd-studio/**/*.json'");
      expect(content).toContain("name: 'ERD Studio'");
      expect(content).toContain('# ERD Studio');
    });

    it('rewrites the data directory when a custom semanticDir is configured', () => {
      const custom = new HarnessService('docs/erd');
      for (const target of HARNESS_TARGETS) {
        const content = custom.generateContent(target.id);
        expect(content).not.toContain('.erd-studio/');
        expect(content).toContain('docs/erd/');
        // Version marker and skill identifiers are untouched
        expect(extractHarnessVersion(content)).toBe(HARNESS_VERSION);
      }
      expect(custom.generateContent('copilot')).toContain("applyTo: '**/docs/erd/**'");
      expect(custom.generateContent('claude')).toContain('name: erd-studio');
    });

    it('leaves content unchanged for the default semanticDir', () => {
      const explicit = new HarnessService('.erd-studio');
      for (const target of HARNESS_TARGETS) {
        expect(explicit.generateContent(target.id)).toBe(service.generateContent(target.id));
      }
    });

    it('generates Gemini styleguide with review rules', () => {
      const content = service.generateContent('gemini');
      expect(content).toContain('# ERD Studio');
      expect(content).toContain('Code Review Rules');
      expect(content).toContain('Schema version');
    });

    it('generates Codex AGENTS.md section', () => {
      const content = service.generateContent('codex');
      expect(content).toContain('## ERD Studio Domain Files');
      expect(content).toContain('# ERD Studio');
    });

    it('wraps the Codex section in BEGIN/END region markers with the version marker inside', () => {
      const content = service.generateContent('codex');
      const begin = content.indexOf(CODEX_REGION_BEGIN);
      const end = content.indexOf(CODEX_REGION_END);
      const version = content.indexOf(`<!-- erd-studio-harness: ${HARNESS_VERSION} -->`);
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(begin);
      expect(version).toBeGreaterThan(begin);
      expect(version).toBeLessThan(end);
    });

    it('all formats include schema content', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        expect(content).toContain('schemaVersion');
        expect(content).toContain('viewConfig');
        expect(content).toContain('logical');
        expect(content).toContain('.erd-studio/{layer}/{domain}.json');
      }
    });

    it('all formats explain per-layer model folders', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        expect(content).toContain('logical-models/{folder}/{name}.yml');
        expect(content).toContain('unique across all folders');
        expect(content).toContain('logical-models/gold/fct_sale.yml');
        expect(content).toContain('logical-models/*/{name}.yml');
      }
    });

    it('all formats include sync reconciliation pointer', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        expect(content).toContain('## Sync Reconciliation');
        expect(content).toContain('.sync-plan.json');
      }
    });

    it('all formats embed a version marker', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        const version = extractHarnessVersion(content);
        expect(version).toBe(HARNESS_VERSION);
      }
    });
  });

  describe('install', () => {
    it('creates Claude SKILL.md in .claude/skills/erd-studio/', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(result.alreadyExisted).toBe(false);
      expect(fs.existsSync(result.filePath)).toBe(true);

      const content = fs.readFileSync(result.filePath, 'utf-8');
      expect(content).toContain('name: erd-studio');
    });

    it('creates Copilot instructions in .github/instructions/', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'copilot')!;
      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(fs.existsSync(result.filePath)).toBe(true);

      const content = fs.readFileSync(result.filePath, 'utf-8');
      expect(content).toContain('applyTo:');
    });

    it('creates Gemini styleguide in .gemini/', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'gemini')!;
      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it('creates AGENTS.md for Codex', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it('appends to existing AGENTS.md for Codex', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# Existing Content\n\nDo not remove.\n');

      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(result.alreadyExisted).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toContain('# Existing Content');
      expect(content).toContain('## ERD Studio Domain Files');
    });

    it('does not duplicate Codex content on repeated install', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;

      service.install(tmpDir, target);
      service.install(tmpDir, target);

      const content = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
      const matches = content.match(/## ERD Studio Domain Files/g);
      expect(matches).toHaveLength(1);
    });

    it('preserves user content in AGENTS.md when updating with overwrite=true', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# Team rules\n\nNEVER touch prod.\n');
      service.install(tmpDir, target); // first install appends

      // Simulate a HARNESS_VERSION bump by rewriting the embedded marker,
      // and add user content *after* the ERD section too.
      const installed = fs.readFileSync(agentsPath, 'utf-8')
        .replace(`<!-- erd-studio-harness: ${HARNESS_VERSION} -->`, '<!-- erd-studio-harness: 1 -->')
        + '\n## Deployment\n\nUse pnpm.\n';
      fs.writeFileSync(agentsPath, installed);
      expect(service.detectStale(tmpDir).map(t => t.id)).toEqual(['codex']);

      const result = service.install(tmpDir, target, true);
      expect(result.success).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toContain('# Team rules');
      expect(content).toContain('NEVER touch prod.');
      expect(content).toContain('## Deployment');
      expect(content).toContain('Use pnpm.');
      expect(content).toContain(`<!-- erd-studio-harness: ${HARNESS_VERSION} -->`);
      expect(content).not.toContain('<!-- erd-studio-harness: 1 -->');
      expect(content.match(/## ERD Studio Domain Files/g)).toHaveLength(1);
      expect(content.match(new RegExp(CODEX_REGION_BEGIN, 'g'))).toHaveLength(1);
      // User content ordering is preserved: rules before the section, deployment after.
      expect(content.indexOf('# Team rules')).toBeLessThan(content.indexOf(CODEX_REGION_BEGIN));
      expect(content.indexOf(CODEX_REGION_END)).toBeLessThan(content.indexOf('## Deployment'));
      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('upgrades a pre-region (v15-style) Codex section in place without duplicating it', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(
        agentsPath,
        '# Team rules\n\nUse pnpm.\n\n## ERD Studio Domain Files\n\nold schema text\n\n<!-- erd-studio-harness: 15 -->\n\n## After\n\nkeep me\n',
      );
      expect(service.detectStale(tmpDir).map(t => t.id)).toEqual(['codex']);

      const result = service.install(tmpDir, target, true);
      expect(result.success).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content).toContain('Use pnpm.');
      expect(content).toContain('keep me');
      expect(content).not.toContain('old schema text');
      expect(content.match(/## ERD Studio Domain Files/g)).toHaveLength(1);
      expect(content).toContain(CODEX_REGION_BEGIN);
      expect(content).toContain(`<!-- erd-studio-harness: ${HARNESS_VERSION} -->`);
      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('appends (never replaces) when overwrite=true and AGENTS.md has no ERD section', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# Hand-written\n');

      const result = service.install(tmpDir, target, true);
      expect(result.success).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf-8');
      expect(content.startsWith('# Hand-written\n')).toBe(true);
      expect(content).toContain(CODEX_REGION_BEGIN);
    });

    it('refuses to overwrite non-Codex files by default', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const result = service.install(tmpDir, target, false);
      expect(result.success).toBe(false);
      expect(result.error).toBe('File already exists');
    });

    it('overwrites non-Codex files when overwrite=true', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const result = service.install(tmpDir, target, true);
      expect(result.success).toBe(true);
    });

    it('creates nested directories automatically', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      const result = service.install(tmpDir, target);

      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'erd-studio'))).toBe(true);
    });

    it('writes companion SYNC.md alongside Claude SKILL.md', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const syncPath = path.join(tmpDir, '.claude', 'skills', 'erd-studio', 'SYNC.md');
      expect(fs.existsSync(syncPath)).toBe(true);

      const content = fs.readFileSync(syncPath, 'utf-8');
      expect(content).toContain('Sync Reconciliation Guide');
      expect(content).toContain('add-column-to-physical');
      expect(content).toContain('update-type-in-logical');
      expect(content).toContain('requiresCompile');

      const version = extractHarnessVersion(content);
      expect(version).toBe(HARNESS_VERSION);
    });

    it('writes companion files using the custom semanticDir', () => {
      const custom = new HarnessService('.erd');
      const target = HARNESS_TARGETS.find((t) => t.id === 'claude')!;
      custom.install(tmpDir, target);

      const hook = fs.readFileSync(path.join(tmpDir, '.claude/skills/erd-studio/enforce-skill.sh'), 'utf-8');
      expect(hook).toContain('*/.erd/*)');
      expect(hook).not.toContain('*/.erd-studio/*)');
      // The per-session flag file keeps its name — it is not a data directory reference
      expect(hook).toContain('/tmp/.erd-studio-skill-');

      const sync = fs.readFileSync(path.join(tmpDir, '.claude/skills/erd-studio/SYNC.md'), 'utf-8');
      expect(sync).not.toContain('.erd-studio/');
    });

    it('writes enforce-skill.sh alongside Claude SKILL.md', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const hookPath = path.join(tmpDir, '.claude', 'skills', 'erd-studio', 'enforce-skill.sh');
      expect(fs.existsSync(hookPath)).toBe(true);

      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('#!/usr/bin/env bash');
      expect(content).toContain('permissionDecision');
      expect(content).toContain('session_id');
    });

    it('enforce-skill.sh gates model files in a layer folder too', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);
      const hookPath = path.join(tmpDir, '.claude', 'skills', 'erd-studio', 'enforce-skill.sh');
      const session = `vitest-${process.pid}-${Date.now()}`;
      const flag = `/tmp/.erd-studio-skill-${session}`;
      try {
        const input = JSON.stringify({ session_id: session, tool_name: 'Write', tool_input: { file_path: '/repo/.erd-studio/logical-models/gold/fct_sale.yml' } });
        const out = execFileSync('bash', [hookPath], { input, encoding: 'utf-8' });
        expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
      } finally {
        fs.rmSync(flag, { force: true });
      }
    });

    it('creates settings.local.json with PreToolUse hook on first install', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('enforce-skill.sh');
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('$CLAUDE_PROJECT_DIR');
    });

    it('does not duplicate hook entry on repeated install', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);
      service.install(tmpDir, target, true);

      const settings = JSON.parse(fs.readFileSync(
        path.join(tmpDir, '.claude', 'settings.local.json'), 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
    });

    it('merges hook into existing settings.local.json without clobbering other keys', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(npm:*)'] } }));

      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.permissions?.allow).toContain('Bash(npm:*)');
      expect(settings.hooks?.PreToolUse).toHaveLength(1);
    });

    it('skips hook merge when settings.local.json has malformed JSON', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ "permissions": { broken');

      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      // File should be untouched (malformed JSON preserved, not overwritten)
      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(content).toContain('broken');
    });

    it('replaces legacy check-skill.sh entry with enforce-skill.sh on upgrade', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/erd-studio/check-skill.sh"' }],
          }],
        },
      }));

      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('enforce-skill.sh');
      expect(settings.hooks.PreToolUse[0].hooks[0].command).not.toContain('check-skill.sh');
    });

    it('guards the hook command so it is a no-op where $CLAUDE_PROJECT_DIR is unset', () => {
      service.install(tmpDir, HARNESS_TARGETS.find(t => t.id === 'claude')!);
      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf-8'));
      expect(settings.hooks.PreToolUse[0].hooks[0].command)
        .toBe('[ -n "$CLAUDE_PROJECT_DIR" ] && bash "$CLAUDE_PROJECT_DIR/.claude/skills/erd-studio/enforce-skill.sh" || true');
    });

    it('upgrades an unguarded enforce-skill.sh command and keeps other hooks in the same entry', () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Edit|Write',
            hooks: [
              { type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/.claude/skills/erd-studio/enforce-skill.sh"' },
              { type: 'command', command: 'echo mine' },
            ],
          }],
        },
      }));
      service.install(tmpDir, HARNESS_TARGETS.find(t => t.id === 'claude')!);
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const commands = settings.hooks.PreToolUse.flatMap((e: { hooks: Array<{ command: string }> }) => e.hooks.map((h) => h.command));
      expect(commands).toEqual(['echo mine', expect.stringMatching(/^\[ -n "\$CLAUDE_PROJECT_DIR" \]/)]);
    });

    it('does not write SYNC.md for non-Claude targets', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'copilot')!;
      service.install(tmpDir, target);

      const syncPath = path.join(tmpDir, '.github', 'instructions', 'SYNC.md');
      expect(fs.existsSync(syncPath)).toBe(false);
    });

    it('adds gitignore entry on first install', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const gitignorePath = path.join(tmpDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('.claude/skills/erd-studio/');
      expect(content).toContain('# ERD Studio AI coding harness');
    });

    it('does not add gitignore entry on overwrite (update)', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'copilot')!;
      // First install — creates gitignore entry
      service.install(tmpDir, target);

      const gitignorePath = path.join(tmpDir, '.gitignore');
      const contentBefore = fs.readFileSync(gitignorePath, 'utf-8');

      // Overwrite (simulates version update where file already existed)
      service.install(tmpDir, target, true);

      const contentAfter = fs.readFileSync(gitignorePath, 'utf-8');
      expect(contentAfter).toBe(contentBefore);
    });

    it('does not duplicate gitignore entries on repeated fresh installs', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'gemini')!;
      // First install
      service.install(tmpDir, target);

      // Delete the harness file to simulate fresh install
      fs.unlinkSync(path.join(tmpDir, target.relativePath));

      // Second fresh install
      service.install(tmpDir, target);

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      const matches = content.match(/\.gemini\/styleguide\.md/g);
      expect(matches).toHaveLength(1);
    });

    it('groups multiple harness entries under one gitignore section', () => {
      const claude = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      const copilot = HARNESS_TARGETS.find(t => t.id === 'copilot')!;
      service.install(tmpDir, claude);
      // Delete copilot file to simulate fresh install
      service.install(tmpDir, copilot);

      const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.claude/skills/erd-studio/');
      expect(content).toContain('.github/instructions/erd-studio.instructions.md');

      // Should only have one section header
      const headers = content.match(/# ERD Studio AI coding harness/g);
      expect(headers).toHaveLength(1);
    });

    it('does not add gitignore entry for codex (AGENTS.md)', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'codex')!;
      service.install(tmpDir, target);

      const gitignorePath = path.join(tmpDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(false);
    });

    it('appends to existing .gitignore without corrupting it', () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n');

      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.env');
      expect(content).toContain('.claude/skills/erd-studio/');
    });
  });

  describe('detectExisting', () => {
    it('returns false for all targets in empty workspace', () => {
      const existing = service.detectExisting(tmpDir);

      for (const target of HARNESS_TARGETS) {
        expect(existing.get(target.id)).toBe(false);
      }
    });

    it('detects installed harnesses', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      const existing = service.detectExisting(tmpDir);
      expect(existing.get('claude')).toBe(true);
      expect(existing.get('copilot')).toBe(false);
    });
  });

  describe('findCodexRegion / mergeCodexContent', () => {
    it('finds a BEGIN/END delimited region', () => {
      const content = `before\n${CODEX_REGION_BEGIN}\nbody\n${CODEX_REGION_END}\nafter\n`;
      const region = findCodexRegion(content)!;
      expect(content.slice(region.start, region.end)).toBe(`${CODEX_REGION_BEGIN}\nbody\n${CODEX_REGION_END}`);
    });

    it('falls back to heading…version-marker for pre-region installs', () => {
      const content = 'before\n## ERD Studio Domain Files\nbody\n<!-- erd-studio-harness: 3 -->\nafter\n';
      const region = findCodexRegion(content)!;
      expect(content.slice(region.start, region.end)).toBe('## ERD Studio Domain Files\nbody\n<!-- erd-studio-harness: 3 -->');
    });

    it('returns null when no managed region exists', () => {
      expect(findCodexRegion('# nothing here\n')).toBeNull();
      expect(findCodexRegion('## ERD Studio Domain Files\nno marker\n')).toBeNull();
    });

    it('mergeCodexContent replaces only the managed region', () => {
      const existing = `A\n${CODEX_REGION_BEGIN}\nold\n${CODEX_REGION_END}\nB\n`;
      const merged = mergeCodexContent(existing, `\n${CODEX_REGION_BEGIN}\nnew\n${CODEX_REGION_END}\n`);
      expect(merged).toBe(`A\n${CODEX_REGION_BEGIN}\nnew\n${CODEX_REGION_END}\nB\n`);
    });

    it('mergeCodexContent appends when no managed region exists', () => {
      const merged = mergeCodexContent('A\n', `\n${CODEX_REGION_BEGIN}\nnew\n${CODEX_REGION_END}\n`);
      expect(merged).toBe(`A\n\n${CODEX_REGION_BEGIN}\nnew\n${CODEX_REGION_END}\n`);
    });
  });

  describe('extractHarnessVersion', () => {
    it('extracts version from marker', () => {
      expect(extractHarnessVersion('<!-- erd-studio-harness: 1 -->\nsome content')).toBe('1');
    });

    it('returns null when no marker present', () => {
      expect(extractHarnessVersion('# Just a markdown file\nno marker here')).toBeNull();
    });
  });

  describe('detectStale', () => {
    it('returns empty array when no harnesses installed', () => {
      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('returns empty array when installed harnesses are current', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target);

      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('treats a file with no version marker as unmanaged (never stale)', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      const filePath = path.join(tmpDir, target.relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '# Old content with no version marker\n');

      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('never flags a hand-written .gemini/styleguide.md as stale', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'gemini')!;
      const filePath = path.join(tmpDir, target.relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '# Our own Gemini review rules\n\nBe nice.\n');

      expect(service.detectStale(tmpDir)).toEqual([]);
      expect(service.detectExisting(tmpDir).get('gemini')).toBe(true);
    });

    it('detects harness with old version as stale', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'copilot')!;
      const filePath = path.join(tmpDir, target.relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '<!-- erd-studio-harness: 0 -->\n# Old schema\n');

      const stale = service.detectStale(tmpDir);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('copilot');
    });

    it('ignores AGENTS.md without ERD Studio section', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '# My agents\nNo ERD Studio here.\n');

      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('detects stale Codex when ERD Studio section exists with old version', () => {
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      fs.writeFileSync(agentsPath, '## ERD Studio Domain Files\nold content\n\n<!-- erd-studio-harness: 0 -->\n');

      const stale = service.detectStale(tmpDir);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe('codex');
    });

    it('does not flag current-version harnesses as stale', () => {
      // Install all targets
      for (const target of HARNESS_TARGETS) {
        service.install(tmpDir, target);
      }

      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('lists the Claude target\'s version-marked files', () => {
      expect(claudeManagedFiles()).toEqual([SCHEMA_SKILL, SYNC_GUIDE, SETUP_SKILL]);
    });

    it('flags claude when a current SKILL.md has a missing or outdated SYNC.md', () => {
      service.install(tmpDir, CLAUDE);
      fs.unlinkSync(path.join(tmpDir, SYNC_GUIDE));
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['claude']);

      service.install(tmpDir, CLAUDE, true);
      ageMarker(tmpDir, SYNC_GUIDE);
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['claude']);
    });

    it('flags claude when the setup skill carries an older marker', () => {
      service.install(tmpDir, CLAUDE);
      ageMarker(tmpDir, SETUP_SKILL);
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['claude']);
    });

    it('does not flag claude for a missing setup skill (harnessStatus reports it)', () => {
      service.install(tmpDir, CLAUDE);
      fs.rmSync(path.join(tmpDir, CLAUDE_SETUP_SKILL_DIR), { recursive: true });
      expect(service.detectStale(tmpDir)).toEqual([]);
      expect(service.harnessStatus(tmpDir).claude.setupSkill).toBe('missing');
    });

    it('does not flag claude for a hand-written (unmarked) setup skill', () => {
      service.install(tmpDir, CLAUDE);
      writeFile(tmpDir, SETUP_SKILL, '# my own setup notes\n');
      expect(service.detectStale(tmpDir)).toEqual([]);
    });

    it('flags a v17 Claude install (the bump that delivers the setup skill)', () => {
      service.install(tmpDir, CLAUDE);
      fs.rmSync(path.join(tmpDir, CLAUDE_SETUP_SKILL_DIR), { recursive: true });
      ageMarker(tmpDir, SCHEMA_SKILL);
      ageMarker(tmpDir, SYNC_GUIDE);
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['claude']);

      // "Update All" = install(overwrite) — writes the setup skill too.
      service.install(tmpDir, CLAUDE, true);
      expect(service.detectStale(tmpDir)).toEqual([]);
      expect(extractHarnessVersion(read(tmpDir, SETUP_SKILL))).toBe(HARNESS_VERSION);
    });
  });

  describe('HARNESS_VERSION', () => {
    it('is 20 (model alias: the same table name in two layers, issue #76 follow-up)', () => {
      expect(HARNESS_VERSION).toBe('20');
    });
  });

  describe('enforce-skill.sh hook', () => {
    const DENY_TEXT = 'ERD Studio: load the /erd-studio skill (file-format rules) before editing .erd-studio files, then retry. This is a one-time check per session — the /erd-studio-setup walkthrough expects it.';

    function hookText(svc: HarnessService = service): string {
      svc.install(tmpDir, CLAUDE, true);
      return read(tmpDir, HOOK);
    }

    it('never auto-approves: no "permissionDecision":"allow" anywhere in the script', () => {
      for (const dir of ['.erd-studio', '.erd', 'docs/erd']) {
        const text = hookText(new HarnessService(dir));
        expect(text).not.toContain('"permissionDecision":"allow"');
        expect(text).not.toMatch(/permissionDecision"\s*:\s*"allow/);
      }
    });

    it('carries the new deny text', () => {
      expect(hookText()).toContain(DENY_TEXT);
    });

    it('rewrites the deny text for a custom semanticDir without touching the skill names', () => {
      const text = hookText(new HarnessService('.erd'));
      expect(text).toContain('before editing .erd files');
      expect(text).toContain('/erd-studio-setup walkthrough');
    });

    const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
    it.skipIf(!hasBash)('denies the first .erd-studio edit per session, then stays silent', () => {
      const script = path.join(tmpDir, 'hook.sh');
      fs.writeFileSync(script, hookText());
      const session = `vitest-${process.pid}-${Date.now()}`;
      const flag = `/tmp/.erd-studio-skill-${session}`;
      const run = (filePath: string) => spawnSync('bash', [script], {
        input: JSON.stringify({ session_id: session, tool_name: 'Write', tool_input: { file_path: filePath } }),
        encoding: 'utf-8',
      });
      try {
        const other = run('/proj/models/orders.sql');
        expect(other.status).toBe(0);
        expect(other.stdout).toBe('');

        const first = run('/proj/.erd-studio/gold/orders.json');
        expect(first.status).toBe(0);
        const decision = JSON.parse(first.stdout);
        expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(decision.hookSpecificOutput.permissionDecisionReason).toBe(DENY_TEXT);

        const second = run('/proj/.erd-studio/gold/orders.json');
        expect(second.status).toBe(0);
        expect(second.stdout).toBe('');
      } finally {
        fs.rmSync(flag, { force: true });
      }
    });

    it.skipIf(!hasBash)('stays silent for any tool that is not Claude Code\'s Edit or Write (Copilot ignores the matcher)', () => {
      const script = path.join(tmpDir, 'hook.sh');
      fs.writeFileSync(script, hookText());
      const session = `vitest-tool-${process.pid}-${Date.now()}`;
      const flag = `/tmp/.erd-studio-skill-${session}`;
      try {
        for (const toolName of ['editFiles', 'runInTerminal', '']) {
          const r = spawnSync('bash', [script], {
            input: JSON.stringify({ session_id: session, tool_name: toolName, tool_input: { file_path: '/proj/.erd-studio/gold/orders.json' } }),
            encoding: 'utf-8',
          });
          expect(r.status, toolName).toBe(0);
          expect(r.stdout, toolName).toBe('');
        }
        expect(fs.existsSync(flag)).toBe(false);
      } finally {
        fs.rmSync(flag, { force: true });
      }
    });

    it.skipIf(!hasBash)('the registered command is a silent no-op where $CLAUDE_PROJECT_DIR is unset', () => {
      service.install(tmpDir, CLAUDE);
      const settings = JSON.parse(read(tmpDir, '.claude/settings.local.json'));
      const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
      const env = { ...process.env };
      delete env.CLAUDE_PROJECT_DIR;
      const r = spawnSync('bash', ['-c', command], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/p/.erd-studio/x.json' } }),
        encoding: 'utf-8', env,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  describe('setup skill install (claude companion)', () => {
    it('writes every setup skill file, with the version marker appended to SKILL.md only', () => {
      const result = service.install(tmpDir, CLAUDE);
      expect(result.success).toBe(true);

      for (const asset of CLAUDE_SETUP_SKILL_FILES) {
        const rel = `${CLAUDE_SETUP_SKILL_DIR}/${asset.relativePath}`;
        const content = read(tmpDir, rel);
        if (asset.versioned) {
          expect(content.endsWith(`\n\n${CURRENT_MARKER}\n`)).toBe(true);
          expect(content.startsWith(asset.content.replace(/\s*$/, ''))).toBe(true);
        } else {
          expect(content).toBe(asset.content);
          expect(extractHarnessVersion(content)).toBeNull();
        }
        expect(result.filesWritten).toContain(rel);
      }
      expect(CLAUDE_SETUP_SKILL_FILES.filter((a) => a.versioned).map((a) => a.relativePath)).toEqual(['SKILL.md']);
    });

    it('never puts the marker in the source markdown', () => {
      for (const asset of CLAUDE_SETUP_SKILL_FILES) {
        expect(extractHarnessVersion(asset.content)).toBeNull();
      }
    });

    it('reports every file it wrote, workspace-relative with forward slashes', () => {
      const result = service.install(tmpDir, CLAUDE);
      expect(result.filesWritten).toEqual(expect.arrayContaining([
        SCHEMA_SKILL, SYNC_GUIDE, HOOK, '.claude/settings.local.json', SETUP_SKILL, '.gitignore',
      ]));
      for (const rel of result.filesWritten!) {
        expect(rel).not.toContain('\\');
        expect(path.isAbsolute(rel)).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, rel))).toBe(true);
      }
    });

    it('does not report settings.local.json when the hook is already registered', () => {
      service.install(tmpDir, CLAUDE);
      const again = service.install(tmpDir, CLAUDE, true);
      expect(again.filesWritten).not.toContain('.claude/settings.local.json');
      expect(again.filesWritten).not.toContain('.gitignore');
    });

    it('applies semanticDir to the setup skill but leaves ~/.erd-studio-cli untouched', () => {
      const sample = 'Run `~/.erd-studio-cli/bin/erd-studio doctor --json`, then edit .erd-studio/gold/x.json and `.erd-studio/logical-models/`.';
      const rewritten = applySemanticDir(sample, 'docs/erd');
      expect(rewritten).toContain('~/.erd-studio-cli/bin/erd-studio doctor --json');
      expect(rewritten).toContain('docs/erd/gold/x.json');
      expect(rewritten).toContain('`docs/erd/logical-models/`');
      expect(rewritten).not.toMatch(/\.erd-studio(?![\w-])/);

      const custom = new HarnessService('docs/erd');
      custom.install(tmpDir, CLAUDE);
      for (const asset of CLAUDE_SETUP_SKILL_FILES) {
        const installed = read(tmpDir, `${CLAUDE_SETUP_SKILL_DIR}/${asset.relativePath}`);
        expect(installed).not.toMatch(/\.erd-studio(?![\w-])/);
        expect(installed.startsWith(applySemanticDir(asset.content, 'docs/erd').replace(/\s*$/, ''))).toBe(true);
        // The launcher path is the same for every semanticDir.
        const launcherRefs = asset.content.match(/~\/\.erd-studio-cli/g)?.length ?? 0;
        expect(installed.match(/~\/\.erd-studio-cli/g)?.length ?? 0).toBe(launcherRefs);
      }
      // The skill's own allowed-tools rule names the launcher.
      expect(read(tmpDir, SETUP_SKILL)).toContain('~/.erd-studio-cli/bin/erd-studio');
    });

    it('leaves a hand-written setup SKILL.md alone unless replaceUnmanagedSetupSkill is set', () => {
      writeFile(tmpDir, SETUP_SKILL, '# mine\n');
      const result = service.install(tmpDir, CLAUDE);
      expect(result.success).toBe(true);
      expect(read(tmpDir, SETUP_SKILL)).toBe('# mine\n');
      expect(fs.existsSync(path.join(tmpDir, CLAUDE_SETUP_SKILL_DIR, 'references'))).toBe(false);
      expect(result.filesWritten).not.toContain(SETUP_SKILL);

      service.install(tmpDir, CLAUDE, true, { replaceUnmanagedSetupSkill: true });
      expect(extractHarnessVersion(read(tmpDir, SETUP_SKILL))).toBe(HARNESS_VERSION);
    });

    it("an unmarked setup SKILL.md survives Update All / the QuickPick (install(root, claude, true))", () => {
      service.install(tmpDir, CLAUDE);
      writeFile(tmpDir, SETUP_SKILL, '# mine\n');
      ageMarker(tmpDir, SCHEMA_SKILL);
      const result = service.install(tmpDir, CLAUDE, true);
      expect(result.success).toBe(true);
      expect(read(tmpDir, SETUP_SKILL)).toBe('# mine\n');
      expect(result.filesWritten).not.toContain(SETUP_SKILL);
      // The primary file the prompt named is still updated.
      expect(extractHarnessVersion(read(tmpDir, SCHEMA_SKILL))).toBe(HARNESS_VERSION);
    });

    it('refreshes a managed setup SKILL.md even without overwrite (it is ours)', () => {
      service.install(tmpDir, CLAUDE);
      fs.unlinkSync(path.join(tmpDir, SCHEMA_SKILL));
      ageMarker(tmpDir, SETUP_SKILL);
      service.install(tmpDir, CLAUDE);
      expect(extractHarnessVersion(read(tmpDir, SETUP_SKILL))).toBe(HARNESS_VERSION);
    });
  });

  describe('setup skill gitignore', () => {
    it('ignores both skill directories on a fresh install', () => {
      service.install(tmpDir, CLAUDE);
      const lines = read(tmpDir, '.gitignore').split('\n');
      expect(lines).toContain('.claude/skills/erd-studio/');
      expect(lines).toContain('.claude/skills/erd-studio-setup/');
      expect(read(tmpDir, '.gitignore').match(/# ERD Studio AI coding harness/g)).toHaveLength(1);
    });

    it('adds the setup line for a v17 upgrader whose schema skill is ignored', () => {
      writeFile(tmpDir, '.gitignore', 'node_modules/\n\n# ERD Studio AI coding harness (auto-generated, safe to remove)\n.claude/skills/erd-studio/\n');
      writeFile(tmpDir, SCHEMA_SKILL, `old\n<!-- erd-studio-harness: 17 -->\n`);

      const result = service.install(tmpDir, CLAUDE, true);
      expect(result.alreadyExisted).toBe(true);
      expect(result.filesWritten).toContain('.gitignore');
      const lines = read(tmpDir, '.gitignore').split('\n');
      expect(lines).toContain('.claude/skills/erd-studio-setup/');
      expect(lines.indexOf('.claude/skills/erd-studio-setup/')).toBeGreaterThan(lines.indexOf('.claude/skills/erd-studio/'));
      expect(lines).toContain('node_modules/');
    });

    it('recognises a schema-skill line written with a leading slash', () => {
      writeFile(tmpDir, '.gitignore', '/.claude/skills/erd-studio\n');
      writeFile(tmpDir, SCHEMA_SKILL, `old\n<!-- erd-studio-harness: 17 -->\n`);
      service.install(tmpDir, CLAUDE, true);
      expect(read(tmpDir, '.gitignore').split('\n')).toContain('.claude/skills/erd-studio-setup/');
    });

    it('follows a user who tracks the schema skill: no setup line either', () => {
      writeFile(tmpDir, '.gitignore', 'node_modules/\n');
      writeFile(tmpDir, SCHEMA_SKILL, `old\n<!-- erd-studio-harness: 17 -->\n`);
      service.install(tmpDir, CLAUDE, true);
      expect(read(tmpDir, '.gitignore')).toBe('node_modules/\n');
    });

    it('does not re-add the setup line once the directory exists', () => {
      service.install(tmpDir, CLAUDE);
      writeFile(tmpDir, '.gitignore', '.claude/skills/erd-studio/\n');
      service.install(tmpDir, CLAUDE, true);
      expect(read(tmpDir, '.gitignore')).toBe('.claude/skills/erd-studio/\n');
    });
  });

  describe('agents target (.agents/skills — Copilot, Codex, Gemini CLI, Cursor)', () => {
    it('writes the schema skill, SYNC.md and the setup skill, but no hook or Claude settings', () => {
      const result = service.install(tmpDir, AGENTS);
      expect(result.success).toBe(true);
      expect(result.filesWritten).toEqual(expect.arrayContaining([AGENTS_SCHEMA_SKILL, AGENTS_SYNC_GUIDE, AGENTS_SETUP_SKILL]));
      for (const asset of CLAUDE_SETUP_SKILL_FILES) {
        expect(fs.existsSync(path.join(tmpDir, AGENTS_SETUP_SKILL_DIR, asset.relativePath)), asset.relativePath).toBe(true);
      }
      expect(fs.existsSync(path.join(tmpDir, '.agents/skills/erd-studio/enforce-skill.sh'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
      expect(agentsManagedFiles()).toEqual([AGENTS_SCHEMA_SKILL, AGENTS_SYNC_GUIDE, AGENTS_SETUP_SKILL]);
    });

    it('uses the same schema skill text as Claude Code, with portable frontmatter only', () => {
      expect(service.generateContent('agents')).toBe(service.generateContent('claude'));
      const { fm } = parseSkill(service.generateContent('agents'));
      expect(Object.keys(fm).every((k) => AGENT_SKILL_FRONTMATTER_KEYS.includes(k))).toBe(true);
      expect(fm.name).toBe('erd-studio'); // == the folder name, as the spec requires
      expect((fm.description as string).length).toBeLessThanOrEqual(1024);
    });

    it('installs two frontmatter variants of the setup SKILL.md: Claude-specific and portable', () => {
      service.install(tmpDir, CLAUDE);
      service.install(tmpDir, AGENTS);
      const claude = parseSkill(read(tmpDir, SETUP_SKILL));
      const agents = parseSkill(read(tmpDir, AGENTS_SETUP_SKILL));

      // .claude copy: Claude Code's allowed-tools list and argument-hint, as authored.
      expect(Array.isArray(claude.fm['allowed-tools'])).toBe(true);
      expect((claude.fm['allowed-tools'] as string[]).some((t) => t.startsWith('Bash('))).toBe(true);
      expect(typeof claude.fm['argument-hint']).toBe('string');
      expect(read(tmpDir, SETUP_SKILL).startsWith(CLAUDE_SETUP_SKILL_FILES[0].content.replace(/\s*$/, ''))).toBe(true);

      // .agents copy: only spec fields, never a Claude Bash() pattern.
      expect(Object.keys(agents.fm).every((k) => AGENT_SKILL_FRONTMATTER_KEYS.includes(k))).toBe(true);
      expect(agents.fm).not.toHaveProperty('allowed-tools');
      expect(agents.fm).not.toHaveProperty('argument-hint');
      expect(read(tmpDir, AGENTS_SETUP_SKILL)).not.toContain('Bash(');
      expect(agents.fm.name).toBe('erd-studio-setup');
      expect(agents.fm.name).toBe(path.basename(AGENTS_SETUP_SKILL_DIR));
      expect(/^[a-z0-9-]{1,64}$/.test(agents.fm.name as string)).toBe(true);
      expect(agents.fm.description).toBe(claude.fm.description);
      expect((agents.fm.description as string).length).toBeLessThanOrEqual(1024);

      // Same body, same version marker, same references.
      expect(agents.body).toBe(claude.body);
      expect(extractHarnessVersion(read(tmpDir, AGENTS_SETUP_SKILL))).toBe(HARNESS_VERSION);
      for (const asset of CLAUDE_SETUP_SKILL_FILES.filter((a) => a.relativePath !== 'SKILL.md')) {
        expect(read(tmpDir, `${AGENTS_SETUP_SKILL_DIR}/${asset.relativePath}`)).toBe(read(tmpDir, `${CLAUDE_SETUP_SKILL_DIR}/${asset.relativePath}`));
      }
    });

    it('setupSkillFiles returns exactly what install writes', () => {
      service.install(tmpDir, AGENTS);
      for (const [rel, content] of service.setupSkillFiles('agents')) {
        expect(read(tmpDir, `${AGENTS_SETUP_SKILL_DIR}/${rel}`)).toBe(content);
      }
    });

    it('rewrites the data directory for a custom semanticDir in the .agents copies too', () => {
      new HarnessService('docs/erd').install(tmpDir, AGENTS);
      expect(read(tmpDir, AGENTS_SCHEMA_SKILL)).toContain('docs/erd/logical-models/');
      expect(read(tmpDir, AGENTS_SCHEMA_SKILL)).not.toContain('.erd-studio/');
    });

    it('leaves a hand-written .agents setup SKILL.md alone unless told to replace it', () => {
      writeFile(tmpDir, AGENTS_SETUP_SKILL, '# mine\n');
      service.install(tmpDir, AGENTS);
      expect(read(tmpDir, AGENTS_SETUP_SKILL)).toBe('# mine\n');
      service.install(tmpDir, AGENTS, true, { replaceUnmanagedSetupSkill: true });
      expect(extractHarnessVersion(read(tmpDir, AGENTS_SETUP_SKILL))).toBe(HARNESS_VERSION);
    });

    it('is stale when its marker is old, its SYNC.md is missing, or its setup skill is outdated', () => {
      service.install(tmpDir, AGENTS);
      expect(service.detectStale(tmpDir)).toEqual([]);
      ageMarker(tmpDir, AGENTS_SETUP_SKILL);
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['agents']);
      service.install(tmpDir, AGENTS, true);
      fs.unlinkSync(path.join(tmpDir, AGENTS_SYNC_GUIDE));
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['agents']);
      expect(service.harnessStatus(tmpDir).agents.schemaSkill).toBe('outdated');
      service.install(tmpDir, AGENTS, true);
      ageMarker(tmpDir, AGENTS_SCHEMA_SKILL);
      expect(service.detectStale(tmpDir).map((t) => t.id)).toEqual(['agents']);
    });

    describe('gitignore', () => {
      it('never ignores the .agents skill folders (Gemini CLI cannot read an ignored file)', () => {
        const result = service.install(tmpDir, AGENTS);
        expect(result.filesWritten).not.toContain('.gitignore');
        expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);
      });

      it('adds no .agents line even when the Claude skill is ignored', () => {
        service.install(tmpDir, CLAUDE); // adds the .claude/skills lines
        const before = read(tmpDir, '.gitignore');
        service.install(tmpDir, AGENTS);
        expect(read(tmpDir, '.gitignore')).toBe(before);
        expect(before).not.toContain('.agents/');
      });
    });
  });

  describe('modelling-approach.md', () => {
    it('every target tells the assistant to read and follow .erd-studio/modelling-approach.md', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        expect(content, target.id).toContain('.erd-studio/modelling-approach.md');
        expect(content, target.id).toMatch(/read it before creating or editing models and follow it/);
        expect(content, target.id).toContain('ERD Studio never parses it');
      }
      expect(new HarnessService('docs/erd').generateContent('claude')).toContain('docs/erd/modelling-approach.md');
    });

    const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
    it.skipIf(!hasBash)('the Claude hook lets modelling-approach.md through without using up the one-time check', () => {
      service.install(tmpDir, CLAUDE);
      const script = path.join(tmpDir, HOOK);
      const session = `vitest-ma-${process.pid}-${Date.now()}`;
      const flag = `/tmp/.erd-studio-skill-${session}`;
      const run = (filePath: string) => spawnSync('bash', [script], {
        input: JSON.stringify({ session_id: session, tool_name: 'Write', tool_input: { file_path: filePath } }),
        encoding: 'utf-8',
      });
      try {
        const approach = run('/proj/.erd-studio/modelling-approach.md');
        expect(approach.status).toBe(0);
        expect(approach.stdout).toBe('');
        expect(fs.existsSync(flag)).toBe(false);
        const domain = run('/proj/.erd-studio/gold/orders.json');
        expect(JSON.parse(domain.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
      } finally {
        fs.rmSync(flag, { force: true });
      }
    });
  });

  describe('harnessStatus', () => {
    it('reports everything missing in an empty workspace', () => {
      expect(service.harnessStatus(tmpDir)).toEqual({
        claude: { schemaSkill: 'missing', setupSkill: 'missing', hookRegistered: false },
        agents: { schemaSkill: 'missing', setupSkill: 'missing' },
        copilot: 'missing',
        gemini: 'missing',
        codex: 'missing',
      });
    });

    it('reports a fresh install of every target as current', () => {
      for (const target of HARNESS_TARGETS) { service.install(tmpDir, target); }
      expect(service.harnessStatus(tmpDir)).toEqual({
        claude: { schemaSkill: 'current', setupSkill: 'current', hookRegistered: true },
        agents: { schemaSkill: 'current', setupSkill: 'current' },
        copilot: 'current',
        gemini: 'current',
        codex: 'current',
      });
    });

    it('distinguishes outdated, unmanaged and missing files', () => {
      writeFile(tmpDir, SCHEMA_SKILL, `x\n<!-- erd-studio-harness: 17 -->\n`);
      writeFile(tmpDir, SETUP_SKILL, '# hand-written\n');
      writeFile(tmpDir, '.github/instructions/erd-studio.instructions.md', '<!-- erd-studio-harness: 3 -->\n');
      writeFile(tmpDir, '.gemini/styleguide.md', '# ours, not ERD Studio\n');
      writeFile(tmpDir, 'AGENTS.md', '# Agents, no ERD section\n');
      expect(service.harnessStatus(tmpDir)).toEqual({
        claude: { schemaSkill: 'outdated', setupSkill: 'unmanaged', hookRegistered: false },
        agents: { schemaSkill: 'missing', setupSkill: 'missing' },
        copilot: 'outdated',
        gemini: 'unmanaged',
        codex: 'missing',
      });
    });

    it('reads a current SKILL.md with a missing SYNC.md as outdated', () => {
      service.install(tmpDir, CLAUDE);
      fs.unlinkSync(path.join(tmpDir, SYNC_GUIDE));
      expect(service.harnessStatus(tmpDir).claude.schemaSkill).toBe('outdated');
    });

    it('reports an outdated Codex region', () => {
      writeFile(tmpDir, 'AGENTS.md', '# Rules\n\n## ERD Studio Domain Files\nold\n<!-- erd-studio-harness: 9 -->\n');
      expect(service.harnessStatus(tmpDir).codex).toBe('outdated');
    });

    it('needs both the hook script and its registration for hookRegistered', () => {
      service.install(tmpDir, CLAUDE);
      fs.unlinkSync(path.join(tmpDir, HOOK));
      expect(service.harnessStatus(tmpDir).claude.hookRegistered).toBe(false);

      service.install(tmpDir, CLAUDE, true);
      writeFile(tmpDir, '.claude/settings.local.json', '{"hooks":{"PreToolUse":[]}}');
      expect(service.harnessStatus(tmpDir).claude.hookRegistered).toBe(false);

      writeFile(tmpDir, '.claude/settings.local.json', '{ broken');
      expect(service.harnessStatus(tmpDir).claude.hookRegistered).toBe(false);
    });
  });

  describe('installRecommended', () => {
    it('installs the Claude target only on a fresh workspace', () => {
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('installed');
      expect(result.unmanaged).toEqual([]);
      expect(result.filesWritten).toEqual(expect.arrayContaining([SCHEMA_SKILL, SYNC_GUIDE, HOOK, SETUP_SKILL]));
      const status = service.harnessStatus(tmpDir);
      expect(status.claude).toEqual({ schemaSkill: 'current', setupSkill: 'current', hookRegistered: true });
      expect([status.copilot, status.gemini, status.codex]).toEqual(['missing', 'missing', 'missing']);
      expect(status.agents).toEqual({ schemaSkill: 'missing', setupSkill: 'missing' });
      expect(fs.existsSync(path.join(tmpDir, '.agents'))).toBe(false);
    });

    it('is unchanged (and writes nothing) when everything is current', () => {
      service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      const before = snapshot(tmpDir);
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result).toEqual({ status: 'unchanged', unmanaged: [], filesWritten: [], targets: ['claude'] });
      expect(snapshot(tmpDir)).toEqual(before);
    });

    it('updates an outdated install', () => {
      service.install(tmpDir, CLAUDE);
      ageMarker(tmpDir, SCHEMA_SKILL);
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('updated');
      expect(extractHarnessVersion(read(tmpDir, SCHEMA_SKILL))).toBe(HARNESS_VERSION);
    });

    it('updates when only the setup skill is missing (a v18 install from elsewhere)', () => {
      service.install(tmpDir, CLAUDE);
      fs.rmSync(path.join(tmpDir, CLAUDE_SETUP_SKILL_DIR), { recursive: true });
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('updated');
      expect(result.filesWritten).toContain(SETUP_SKILL);
    });

    it('updates when the hook registration was removed', () => {
      service.install(tmpDir, CLAUDE);
      fs.unlinkSync(path.join(tmpDir, '.claude/settings.local.json'));
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('updated');
      expect(result.filesWritten).toContain('.claude/settings.local.json');
      expect(service.harnessStatus(tmpDir).claude.hookRegistered).toBe(true);
    });

    it('asks first, writing nothing, when either SKILL.md is unmanaged', () => {
      writeFile(tmpDir, SCHEMA_SKILL, '# my schema notes\n');
      writeFile(tmpDir, SETUP_SKILL, '# my setup notes\n');
      const before = snapshot(tmpDir);
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result).toEqual({
        status: 'needs-confirmation', unmanaged: [SCHEMA_SKILL, SETUP_SKILL], filesWritten: [], targets: ['claude'],
      });
      expect(snapshot(tmpDir)).toEqual(before);
    });

    it('asks first when only the setup SKILL.md is unmanaged', () => {
      service.install(tmpDir, CLAUDE);
      writeFile(tmpDir, SETUP_SKILL, '# my setup notes\n');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('needs-confirmation');
      expect(result.unmanaged).toEqual([SETUP_SKILL]);
      expect(read(tmpDir, SETUP_SKILL)).toBe('# my setup notes\n');
    });

    it('replaces unmanaged files once confirmed', () => {
      writeFile(tmpDir, SCHEMA_SKILL, '# my schema notes\n');
      writeFile(tmpDir, SETUP_SKILL, '# my setup notes\n');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: true });
      expect(result.status).toBe('updated');
      expect(result.unmanaged).toEqual([]);
      expect(extractHarnessVersion(read(tmpDir, SCHEMA_SKILL))).toBe(HARNESS_VERSION);
      expect(extractHarnessVersion(read(tmpDir, SETUP_SKILL))).toBe(HARNESS_VERSION);
    });

    it('Keep mine with only the setup SKILL.md hand-written installs the schema skill and hook', () => {
      writeFile(tmpDir, SETUP_SKILL, '# my setup notes\n');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false, keepUnmanaged: true });
      expect(result.status).toBe('installed');
      expect(read(tmpDir, SETUP_SKILL)).toBe('# my setup notes\n');
      expect(result.filesWritten).toEqual(expect.arrayContaining([SCHEMA_SKILL, SYNC_GUIDE, HOOK, '.claude/settings.local.json']));
      expect(result.filesWritten).not.toContain(SETUP_SKILL);
      expect(service.harnessStatus(tmpDir).claude).toEqual({ schemaSkill: 'current', setupSkill: 'unmanaged', hookRegistered: true });
    });

    it('Keep mine with only the schema SKILL.md hand-written installs the setup skill and hook', () => {
      writeFile(tmpDir, SCHEMA_SKILL, '# my schema notes\n');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false, keepUnmanaged: true });
      expect(result.status).toBe('updated');
      expect(read(tmpDir, SCHEMA_SKILL)).toBe('# my schema notes\n');
      expect(result.filesWritten).toEqual(expect.arrayContaining([SETUP_SKILL, HOOK]));
      expect(result.filesWritten).not.toContain(SCHEMA_SKILL);
      expect(service.harnessStatus(tmpDir).claude).toMatchObject({ schemaSkill: 'unmanaged', setupSkill: 'current', hookRegistered: true });
    });

    it('Keep mine follows the gitignore choice for the new setup skill directory', () => {
      writeFile(tmpDir, SCHEMA_SKILL, '# my schema notes\n');
      writeFile(tmpDir, '.gitignore', 'node_modules/\n.claude/skills/erd-studio/\n');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false, keepUnmanaged: true });
      expect(result.filesWritten).toContain('.gitignore');
      expect(read(tmpDir, '.gitignore').split('\n')).toContain('.claude/skills/erd-studio-setup/');
    });

    it('reports failed when the install cannot write', () => {
      // `.claude` as a plain file makes every mkdir under it fail.
      fs.writeFileSync(path.join(tmpDir, '.claude'), 'not a directory');
      const result = service.installRecommended(tmpDir, { assistants: ['claude'], replaceUnmanaged: false });
      expect(result.status).toBe('failed');
      expect(result.error).toBeTruthy();
      expect(result.filesWritten).toEqual([]);
    });
  });
  describe('installRecommended for the detected assistants', () => {
    it('installs only .agents/skills for assistants other than Claude Code', () => {
      const result = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['codex', 'gemini'] });
      expect(result.status).toBe('installed');
      expect(result.targets).toEqual(['agents']);
      expect(result.filesWritten).toEqual(expect.arrayContaining([AGENTS_SCHEMA_SKILL, AGENTS_SYNC_GUIDE, AGENTS_SETUP_SKILL]));
      expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
      expect(service.harnessStatus(tmpDir).agents).toEqual({ schemaSkill: 'current', setupSkill: 'current' });
    });

    it('installs both folders for Claude Code plus Codex or Gemini, and both when none is detected', () => {
      for (const assistants of [['claude', 'codex'] as const, ['claude', 'gemini'] as const, [] as const]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-both-'));
        try {
          const result = service.installRecommended(dir, { replaceUnmanaged: false, assistants });
          expect(result.targets).toEqual(['claude', 'agents']);
          expect(result.status).toBe('installed');
          const status = service.harnessStatus(dir);
          expect(status.claude).toEqual({ schemaSkill: 'current', setupSkill: 'current', hookRegistered: true });
          expect(status.agents).toEqual({ schemaSkill: 'current', setupSkill: 'current' });
          // .gitignore lists each Claude path once; `.agents/` is never ignored.
          const lines = read(dir, '.gitignore').split('\n').filter((l) => l.startsWith('.'));
          expect(lines).toEqual(['.claude/skills/erd-studio/', '.claude/skills/erd-studio-setup/']);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('omitting assistants means none detected: both folders', () => {
      expect(service.installRecommended(tmpDir, { replaceUnmanaged: false }).targets).toEqual(['claude', 'agents']);
    });

    it('installs only .claude/skills for Claude Code plus Copilot or Cursor (they read it too)', () => {
      for (const assistants of [['claude', 'copilot'] as const, ['claude', 'cursor'] as const]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-claude-only-'));
        try {
          const result = service.installRecommended(dir, { replaceUnmanaged: false, assistants });
          expect(result.targets).toEqual(['claude']);
          expect(fs.existsSync(path.join(dir, '.agents'))).toBe(false);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('adds only the missing folder when a new assistant appears, and is then unchanged', () => {
      service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['claude'] });
      const claudeBefore = read(tmpDir, SCHEMA_SKILL);
      const result = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['claude', 'codex'] });
      expect(result.status).toBe('updated');
      expect(result.filesWritten.every((f) => !f.startsWith('.claude/'))).toBe(true);
      expect(read(tmpDir, SCHEMA_SKILL)).toBe(claudeBefore);
      expect(service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['claude', 'codex'] }).status).toBe('unchanged');
    });

    it('asks before replacing a hand-written .agents SKILL.md, and Keep mine leaves it', () => {
      writeFile(tmpDir, AGENTS_SETUP_SKILL, '# my own\n');
      const first = service.installRecommended(tmpDir, { replaceUnmanaged: false, assistants: ['copilot'] });
      expect(first).toEqual({ status: 'needs-confirmation', unmanaged: [AGENTS_SETUP_SKILL], filesWritten: [], targets: ['agents'] });
      const kept = service.installRecommended(tmpDir, { replaceUnmanaged: false, keepUnmanaged: true, assistants: ['copilot'] });
      expect(kept.status).toBe('installed');
      expect(read(tmpDir, AGENTS_SETUP_SKILL)).toBe('# my own\n');
      expect(kept.filesWritten).toContain(AGENTS_SCHEMA_SKILL);
      // A hand-written Claude copy is irrelevant when only .agents is being installed.
      writeFile(tmpDir, SCHEMA_SKILL, '# mine\n');
      expect(service.installRecommended(tmpDir, { replaceUnmanaged: true, assistants: ['copilot'] }).status).toBe('updated');
      expect(read(tmpDir, SCHEMA_SKILL)).toBe('# mine\n');
    });
  });
});
