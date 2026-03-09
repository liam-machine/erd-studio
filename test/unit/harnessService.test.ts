import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HarnessService, HARNESS_TARGETS } from '../../src/services/harnessService';

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
      expect(content).toContain('# ERD Studio JSON Schema');
      expect(content).toContain('schemaVersion');
    });

    it('generates Copilot instructions with applyTo glob', () => {
      const content = service.generateContent('copilot');
      expect(content).toContain("applyTo: '**/erd-studio/**/*.json'");
      expect(content).toContain("name: 'ERD Studio Schema'");
      expect(content).toContain('# ERD Studio JSON Schema');
    });

    it('generates Gemini styleguide with review rules', () => {
      const content = service.generateContent('gemini');
      expect(content).toContain('# ERD Studio JSON Schema');
      expect(content).toContain('Code Review Rules');
      expect(content).toContain('Schema version');
    });

    it('generates Codex AGENTS.md section', () => {
      const content = service.generateContent('codex');
      expect(content).toContain('## ERD Studio Domain Files');
      expect(content).toContain('# ERD Studio JSON Schema');
    });

    it('all formats include v3 schema content', () => {
      for (const target of HARNESS_TARGETS) {
        const content = service.generateContent(target.id);
        expect(content).toContain('schemaVersion');
        expect(content).toContain('viewConfig');
        expect(content).toContain('conceptual');
        expect(content).toContain('logical');
        expect(content).toContain('erd-studio/{layer}/{domain}.json');
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
});
