import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  HarnessService,
  HARNESS_TARGETS,
  HARNESS_VERSION,
  CODEX_REGION_BEGIN,
  CODEX_REGION_END,
  extractHarnessVersion,
  findCodexRegion,
  mergeCodexContent,
} from '../../src/services/harnessService';

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
    it('has 4 targets', () => {
      expect(HARNESS_TARGETS).toHaveLength(4);
    });

    it('covers claude, copilot, gemini, codex', () => {
      const ids = HARNESS_TARGETS.map(t => t.id);
      expect(ids).toEqual(['claude', 'copilot', 'gemini', 'codex']);
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
  });
});
