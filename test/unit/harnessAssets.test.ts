import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import {
  AGENT_SKILL_FRONTMATTER_KEYS,
  AGENTS_SETUP_SKILL_DIR,
  CLAUDE_SETUP_SKILL_DIR,
  CLAUDE_SETUP_SKILL_FILES,
  SETUP_SKILL_DIRS,
  agentSkillFrontmatter,
  skillForTarget,
  splitFrontmatter,
} from '../../src/services/harnessAssets';
import { HarnessService, extractHarnessVersion } from '../../src/services/harnessService';
import { dbtCommands, dbtInvocation, VENV_CANDIDATES, type DbtCandidate, type DbtFlavour } from '../../src/services/dbtEnv';

const SOURCE_DIR = path.resolve(__dirname, '../../src/harness/claude/erd-studio-setup');
const skill = CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === 'SKILL.md')!;

/** The YAML between the leading `---` fences of SKILL.md. */
function frontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) { throw new Error('SKILL.md has no frontmatter'); }
  return parseYaml(match[1]) as Record<string, unknown>;
}

/**
 * Claude Code's `Bash(prefix:*)` rule: the command is the prefix itself or
 * starts with it followed by a space. Any other rule must match exactly.
 */
function bashRuleMatches(rule: string, command: string): boolean {
  const m = rule.match(/^Bash\((.*)\)$/);
  if (!m) { return false; }
  const body = m[1];
  if (body.endsWith(':*')) {
    const prefix = body.slice(0, -2);
    return command === prefix || command.startsWith(prefix + ' ');
  }
  return command === body;
}

describe('harnessAssets', () => {
  it('installs into .claude/skills/erd-studio-setup and .agents/skills/erd-studio-setup', () => {
    expect(CLAUDE_SETUP_SKILL_DIR).toBe('.claude/skills/erd-studio-setup');
    expect(AGENTS_SETUP_SKILL_DIR).toBe('.agents/skills/erd-studio-setup');
    expect(SETUP_SKILL_DIRS).toEqual({ claude: CLAUDE_SETUP_SKILL_DIR, agents: AGENTS_SETUP_SKILL_DIR });
  });

  it('ships every reference in the source directory (a new one cannot be forgotten)', () => {
    const onDisk = fs.readdirSync(path.join(SOURCE_DIR, 'references')).filter((f) => f.endsWith('.md')).sort();
    const listed = CLAUDE_SETUP_SKILL_FILES.map((a) => a.relativePath)
      .filter((p) => p.startsWith('references/')).map((p) => p.slice('references/'.length)).sort();
    expect(listed).toEqual(onDisk);
  });

  it('lists SKILL.md and the six references, each backed by a real source file', () => {
    expect(CLAUDE_SETUP_SKILL_FILES.map((a) => a.relativePath)).toEqual([
      'SKILL.md',
      'references/dbt-explained.md',
      'references/dbt-setup.md',
      'references/modelling-approaches.md',
      'references/building-the-model.md',
      'references/verify-and-fix.md',
      'references/troubleshooting.md',
    ]);
    for (const asset of CLAUDE_SETUP_SKILL_FILES) {
      const onDisk = fs.readFileSync(path.join(SOURCE_DIR, asset.relativePath), 'utf-8');
      // The md loader inlines the file verbatim.
      expect(asset.content).toBe(onDisk);
      expect(asset.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('versions SKILL.md only, and no source file carries a marker', () => {
    expect(CLAUDE_SETUP_SKILL_FILES.filter((a) => a.versioned).map((a) => a.relativePath)).toEqual(['SKILL.md']);
    for (const asset of CLAUDE_SETUP_SKILL_FILES) {
      expect(extractHarnessVersion(asset.content)).toBeNull();
    }
  });

  describe('SKILL.md', () => {
    it('is under 500 lines', () => {
      expect(skill.content.split('\n').length).toBeLessThan(500);
    });

    it('has YAML frontmatter naming the skill with a description of at most 1024 characters', () => {
      const fm = frontmatter(skill.content);
      expect(fm.name).toBe('erd-studio-setup');
      expect(typeof fm.description).toBe('string');
      const description = fm.description as string;
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(1024);
    });

    it('pre-approves read-only tools in list form, never Edit or Write', () => {
      const tools = frontmatter(skill.content)['allowed-tools'];
      expect(Array.isArray(tools)).toBe(true);
      const list = tools as string[];
      expect(list).toEqual(expect.arrayContaining([
        'Read',
        'Glob',
        'Grep',
        'Bash(~/.erd-studio-cli/bin/erd-studio:*)',
        'Bash(~/.erd-studio-cli/bin/erd-studio.cmd:*)',
        'Bash(dbt --version)',
        'Bash(dbt parse:*)',
        'Bash(dbt docs generate:*)',
        'Bash(dbt compile --write-catalog:*)',
        'Bash(dbt debug:*)',
        'Bash(dbt deps:*)',
      ]));
      for (const tool of list) {
        expect(tool).not.toMatch(/^(Edit|Write|MultiEdit|NotebookEdit)\b/);
      }
    });

    const rules = (): string[] =>
      (frontmatter(skill.content)['allowed-tools'] as string[]).filter((t) => t.startsWith('Bash('));
    const approved = (command: string): boolean => rules().some((rule) => bashRuleMatches(rule, command));

    /** Every `dbt.commands.*` + `run-deps` string doctor can emit for `candidate`, across all flavours. */
    function doctorCommands(candidate: DbtCandidate, root: string, platform: NodeJS.Platform): string[] {
      const invocation = dbtInvocation(candidate, root, platform);
      const out = [`${invocation} deps`];
      for (const flavour of ['core-v1', 'fusion-v2', 'cloud-cli', 'unknown'] as DbtFlavour[]) {
        const c = dbtCommands(flavour, invocation);
        for (const cmd of [c.parse, c.catalog, c.debug]) { if (cmd) { out.push(cmd); } }
      }
      return out;
    }

    it('pre-approves every dbt command doctor emits for a dbt on the PATH (bare `dbt`)', () => {
      const commands = [
        'dbt --version',
        ...doctorCommands({ executable: '/usr/local/bin/dbt', source: 'path' }, '/p', 'linux'),
        // An activated venv / conda env is the first dbt on the PATH, so it is bare `dbt` too.
        ...doctorCommands({ executable: '/p/.venv/bin/dbt', source: 'venv', onPath: true }, '/p', 'linux'),
        ...doctorCommands({ executable: '/e/bin/dbt', source: 'virtual-env', onPath: true }, '/p', 'linux'),
        ...doctorCommands({ executable: 'C:\\e\\Scripts\\dbt.exe', source: 'conda', onPath: true }, 'C:\\p', 'win32'),
      ];
      for (const command of commands) {
        expect(approved(command), command).toBe(true);
      }
    });

    it('never pre-approves a dbt the project ships or any other path: those always prompt', () => {
      // Deliberate (review finding): a cloned repo can ship any `.venv/bin/dbt`, so running one
      // must go through Claude Code's own approval prompt, which shows the exact path.
      const commands: string[] = [];
      for (const dir of VENV_CANDIDATES) {
        commands.push(...doctorCommands({ executable: `/p/${dir}/bin/dbt`, source: 'venv' }, '/p', 'linux'));
        commands.push(...doctorCommands({ executable: `C:\\p\\${dir}\\Scripts\\dbt.exe`, source: 'venv' }, 'C:\\p', 'win32'));
      }
      commands.push(...doctorCommands({ executable: '/opt/tools/dbt', source: 'override' }, '/p', 'linux'));
      commands.push(...doctorCommands({ executable: '/home/me/.pyenv/shims/dbt', source: 'shim' }, '/p', 'linux'));
      for (const command of commands) {
        expect(command.startsWith('dbt '), command).toBe(false);
        expect(approved(command), command).toBe(false);
      }
      // And the venv forms are written with forward slashes on Windows (Git Bash).
      expect(dbtInvocation({ executable: 'C:\\p\\.venv\\Scripts\\dbt.exe', source: 'venv' }, 'C:\\p', 'win32')).toBe('.venv/Scripts/dbt.exe');
    });

    it('does not pre-approve dbt commands that change the warehouse or delete files', () => {
      for (const command of ['dbt run', 'dbt build', 'dbt seed --full-refresh', 'dbt snapshot', 'dbt run-operation drop_all', 'dbt clean', 'dbt --version; rm -rf x']) {
        expect(approved(command), command).toBe(false);
      }
    });

    it('pre-approves the launcher on both shims', () => {
      for (const command of [
        '~/.erd-studio-cli/bin/erd-studio doctor --json',
        '~/.erd-studio-cli/bin/erd-studio doctor --json --trust-venv',
        '~/.erd-studio-cli/bin/erd-studio inventory --summary --json',
        '~/.erd-studio-cli/bin/erd-studio diff --all --json',
        '~/.erd-studio-cli/bin/erd-studio.cmd doctor --json',
      ]) {
        expect(approved(command), command).toBe(true);
      }
    });

    it("names the canvas's real button labels", () => {
      const toolbar = fs.readFileSync(path.resolve(__dirname, '../../webview/components/Toolbar/Toolbar.tsx'), 'utf-8');
      const panel = fs.readFileSync(path.resolve(__dirname, '../../webview/components/DiscrepancyPanel/DiscrepancyPanel.tsx'), 'utf-8');
      expect(toolbar).toContain("'⊕ Diff'");
      expect(panel).toContain('⊕ Sync');
      const all = CLAUDE_SETUP_SKILL_FILES.map((a) => a.content).join('\n');
      expect(all).toContain('⊕ Diff');
      expect(all).not.toMatch(/Compare to Physical|\*\*Compare\*\*|All Physical/);
    });

    it('uses no `!` dynamic-context injection', () => {
      expect(skill.content).not.toMatch(/!`[^`]+`/);
    });
  });

  describe('frontmatter variants', () => {
    const SAMPLE = [
      '---',
      'name: demo-skill',
      'description: >-',
      '  Folded text that',
      '  spans lines.',
      'argument-hint: "[area]"',
      'allowed-tools:',
      '  - Read',
      '  - Bash(dbt parse:*)',
      'license: MIT',
      'allowed-tools-extra:',
      '- Grep',
      'metadata:',
      '  owner: erd-studio',
      '---',
      '',
      '# Body',
      'Uses Bash(x:*) in prose, which stays.',
      '',
    ].join('\n');

    it('keeps only the spec fields, byte-for-byte, and the body untouched', () => {
      const out = agentSkillFrontmatter(SAMPLE);
      expect(out).toBe([
        '---',
        'name: demo-skill',
        'description: >-',
        '  Folded text that',
        '  spans lines.',
        'license: MIT',
        'metadata:',
        '  owner: erd-studio',
        '---',
        '',
        '# Body',
        'Uses Bash(x:*) in prose, which stays.',
        '',
      ].join('\n'));
      const fm = parseYaml(splitFrontmatter(out)!.yaml) as Record<string, unknown>;
      expect(fm).toEqual({ name: 'demo-skill', description: 'Folded text that spans lines.', license: 'MIT', metadata: { owner: 'erd-studio' } });
    });

    it('falls back to a structural rewrite for frontmatter the line scan cannot follow', () => {
      const flow = '---\n{ name: x, description: y, allowed-tools: [Read] }\n---\nbody\n';
      const out = agentSkillFrontmatter(flow);
      expect(parseYaml(splitFrontmatter(out)!.yaml)).toEqual({ name: 'x', description: 'y' });
      expect(out.endsWith('---\nbody\n')).toBe(true);
    });

    it('leaves content without frontmatter alone', () => {
      expect(agentSkillFrontmatter('# no frontmatter\n')).toBe('# no frontmatter\n');
    });

    it('the real setup SKILL.md: Claude copy verbatim, .agents copy portable and otherwise identical', () => {
      expect(skillForTarget(skill.content, 'claude')).toBe(skill.content);
      const agents = skillForTarget(skill.content, 'agents');
      const fm = parseYaml(splitFrontmatter(agents)!.yaml) as Record<string, unknown>;
      expect(Object.keys(fm).every((k) => AGENT_SKILL_FRONTMATTER_KEYS.includes(k))).toBe(true);
      expect(fm.name).toBe('erd-studio-setup');
      expect(fm.description).toBe(frontmatter(skill.content).description);
      expect(splitFrontmatter(agents)!.body).toBe(splitFrontmatter(skill.content)!.body);
      expect(splitFrontmatter(agents)!.yaml).not.toContain('Bash(');
    });
  });
});

// Agent Skills spec limits (agentskills.io; VS Code Copilot and Cursor enforce them, and Copilot
// silently skips a skill with invalid frontmatter): name == folder, <= 64 chars of [a-z0-9-],
// description <= 1024 chars — checked on what is actually installed, under a long semanticDir.
describe('installed skill frontmatter stays within the Agent Skills limits', () => {
  const LONG_DIR = 'analytics/warehouse/documentation/entity-relationship-diagrams/.erd-studio-data';
  for (const target of ['claude', 'agents'] as const) {
    for (const semanticDir of ['.erd-studio', LONG_DIR]) {
      it(`${target}, semanticDir ${semanticDir}`, () => {
        const service = new HarnessService(semanticDir);
        const checks: Array<[string, string]> = [
          ['erd-studio-setup', new Map(service.setupSkillFiles(target)).get('SKILL.md')!],
          ['erd-studio', service.generateContent(target)],
        ];
        for (const [folder, content] of checks) {
          const fm = frontmatter(content);
          expect(fm.name, folder).toBe(folder);
          expect(fm.name as string).toMatch(/^[a-z0-9-]+$/);
          expect((fm.name as string).length).toBeLessThanOrEqual(64);
          expect(typeof fm.description).toBe('string');
          expect((fm.description as string).length, `${folder} description`).toBeLessThanOrEqual(1024);
        }
      });
    }
  }
});
