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

  it('lists SKILL.md and the eight references, each backed by a real source file', () => {
    expect(CLAUDE_SETUP_SKILL_FILES.map((a) => a.relativePath)).toEqual([
      'SKILL.md',
      'references/dbt-explained.md',
      'references/dbt-setup.md',
      'references/modelling-approaches.md',
      'references/metadata.md',
      'references/building-the-model.md',
      'references/verify-and-fix.md',
      'references/troubleshooting.md',
      'references/without-dbt.md',
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

    describe('routes (quick start by default, enrich, full setup)', () => {
      const body = (): string => splitFrontmatter(skill.content)!.body;
      const reference = (name: string): string =>
        CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === `references/${name}`)!.content;

      it('defines all three routes and picks one itself rather than asking', () => {
        expect(body()).toMatch(/\*\*Quick start\*\* — everyone else/);
        expect(body()).toMatch(/\*\*Enrich\*\* — doctor's `erd\.domains` is above 0/);
        expect(body()).toMatch(/\*\*Full setup\*\* — the user asks for it/);
        expect(body()).toContain('never ask the user to choose');
      });

      it('defers the modelling style until after the first canvas in a quick start', () => {
        expect(body()).toContain('never before the first canvas');
        expect(body()).toContain(
          "\"Want me to apply your team's modelling style — keys,\n    grain, SCD? That's the next step.\"",
        );
        // The quick start mirrors dbt through the documented no-style rules, which must still exist.
        expect(body()).toContain('"When no style is agreed"');
        expect(reference('modelling-approaches.md')).toContain('**When no style is agreed**');
      });

      it('does not gate a quick start on the catalog', () => {
        expect(body()).toContain('**`run-catalog`** — full setup only');
      });

      it('names the no-AI Draw from dbt command as it is contributed', () => {
        expect(body()).toContain('**ERD Studio: Draw from dbt…**');
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
          contributes: { commands: { command: string; title: string; category?: string }[] };
        };
        const command = pkg.contributes.commands.find((c) => c.command === 'erdStudio.drawFromDbt');
        expect(command, 'erdStudio.drawFromDbt is contributed').toBeDefined();
        expect(command!.title.startsWith('Draw from dbt')).toBe(true);
      });

      it('enriches an existing diagram with design fields only, never rebuilding it', () => {
        const start = body().indexOf('## Enriching an existing diagram');
        expect(start).toBeGreaterThan(-1);
        const section = body().slice(start, body().indexOf('## Reference files'));
        expect(section).toContain('never rebuild, rename, or change a column, type or relationship');
        expect(section).toContain('ask "Add these?" once');
        for (const field of ['isPrimaryKey', 'isForeignKey', 'grain', 'isNaturalKey', 'modelRole', 'rationale']) {
          expect(section).toContain(field);
        }
      });

      it('keeps every safety rule on the shorter path', () => {
        expect(body()).toContain('never `dbt run`, `build`, `seed` or `snapshot`');
        expect(body()).toContain('`--trust-venv`');
        expect(body()).toContain('**Stop after 3 rounds.**');
        expect(body()).toContain('**referenced by name, never rewritten**');
        // Canvas-fallback mode moved to the troubleshooting reference; SKILL.md still points at it.
        expect(body()).toContain('**canvas-fallback mode**\n(`references/troubleshooting.md`)');
        expect(reference('troubleshooting.md')).toContain('## Canvas-fallback mode (no helper available)');
      });
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

describe('setup skill: where relationships go (#126)', () => {
  const ref = (name: string): string =>
    fs.readFileSync(path.join(__dirname, '../../src/harness/claude/erd-studio-setup/references', name), 'utf-8');

  it('builds a first diagram with relationships in the from-model yml, not the domain file', () => {
    const building = ref('building-the-model.md');
    expect(building).toContain('"relationships": []');
    expect(building).toMatch(/additiveType: additive\nrelationships:\n {2}- fromColumn: customer_id\n {4}toModel: dim_customer/);
    expect(building).toContain('never move existing relationships from one place to the');
    expect(building).not.toMatch(/"relationships": \[\n\s+\{ "fromModel"/);
  });

  it('fixes a relationship wherever it is defined', () => {
    const fix = ref('verify-and-fix.md');
    for (const kind of ['remove-column', 'remove-relationship', 'resolve-phantom']) {
      const row = fix.split('\n').find((l) => l.startsWith(`| \`${kind}\``)) ?? '';
      expect(row, kind).toMatch(/relationships:/);
    }
    // D5: the fix names the canonical entry and both files; the assistant swaps nothing itself.
    const setCardinality = fix.split('\n').find((l) => l.startsWith('| `set-cardinality`')) ?? '';
    expect(setCardinality).toMatch(/Write `relationship`.*in `file`.*`movesFrom`/);
  });
});

describe('setup skill: merge conflicts are the user\'s to settle (#150)', () => {
  const ref = (name: string): string =>
    fs.readFileSync(path.join(__dirname, '../../src/harness/claude/erd-studio-setup/references', name), 'utf-8');
  const body = (): string => splitFrontmatter(skill.content)!.body;
  const cli = (name: string): string => fs.readFileSync(path.resolve(__dirname, '../../src/cli', name), 'utf-8');

  it('names the signals doctor and diff really emit', () => {
    // The ids and fields the skill teaches must be the CLI's own spelling.
    expect(cli('doctor.ts')).toContain("id: 'resolve-merge-conflicts'");
    expect(cli('doctor.ts')).toContain('conflictedDomainFiles: ConflictedSubjectAreaFile[]');
    expect(cli('diff.ts')).toContain("code: 'merge-conflict'");
    expect(cli('diff.ts')).toContain('mergeConflict?: true');

    expect(body()).toContain('`resolve-merge-conflicts`');
    expect(body()).toContain('`mergeConflict: true`');
    expect(body()).toContain('`merge-conflict` error');
    const trouble = ref('troubleshooting.md');
    for (const signal of ['`resolve-merge-conflicts`', '`erd.conflictedDomainFiles`', '`mergeConflict: true`',
      '`erd.unreadableModelFiles`', 'code `merge-conflict`']) {
      expect(trouble, signal).toContain(signal);
    }
  });

  it('stops, shows the file and line, and asks rather than picking a side', () => {
    expect(body()).toContain('Stop and follow `references/troubleshooting.md` → "Merge conflicts"; never pick a side or run git.');
    const start = ref('troubleshooting.md').indexOf('## Merge conflicts');
    expect(start).toBeGreaterThan(-1);
    const section = ref('troubleshooting.md').slice(start, ref('troubleshooting.md').indexOf('\n## ', start + 1));
    expect(section).toContain('Tell the user the file and line in plain words');
    expect(section).toContain('**Only `viewConfig.positions` differ**');
    expect(section).toContain('say either side is\n     safe');
    expect(section).toContain('ask which to keep');
    expect(section).toContain('Never pick a side unasked.');
    for (const git of ['`git add`', '`git checkout --ours` / `--theirs`', '`git merge`', '`git commit`']) {
      expect(section, git).toContain(git);
    }
    expect(section).toContain('re-run doctor');
  });

  it('never treats a merge conflict as a YAML fix', () => {
    const fix = ref('verify-and-fix.md');
    const row = fix.split('\n').find((l) => l.startsWith('| `fix-model-yaml`')) ?? '';
    expect(row).toContain('**Except when the file\'s `unreadableModelFiles` entry has `mergeConflict: true`:**');
    expect(row).toContain('do not edit it; ask the user');
    expect(fix).toContain('**Merge conflicts** are always the user\'s');
    expect(ref('building-the-model.md')).toContain('`mergeConflict: true`: that file holds two versions from a git merge');
    // Every place SKILL.md tells the assistant to fix a fix-model-yaml carves the conflict out.
    expect(body()).toContain('except a merge conflict, which is the user\'s to settle (Stage 1)');
    expect(body()).toContain('re-run the diff (a merge conflict: Stage 1)');
  });

  it('puts mergeConflict on the unreadableModelFiles entry, never on the fix or the step', () => {
    // The CLI carries the flag only on UnreadableTableFile; Fix and NextStep have no such field.
    const block = (src: string, name: string): string => {
      const start = src.indexOf(`export interface ${name} {`);
      expect(start, name).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf('\n}', start));
    };
    expect(block(cli('diff.ts'), 'UnreadableTableFile')).toContain('mergeConflict?: true');
    expect(block(cli('diff.ts'), 'Fix')).not.toContain('mergeConflict');
    expect(block(cli('doctor.ts'), 'NextStep')).not.toContain('mergeConflict');
    // So no skill text may say a fix or step "with" / "has" / "marked" the flag, and every
    // paragraph or table row that names the flag also names where it really sits.
    const texts: Record<string, string> = { 'SKILL.md': body() };
    for (const name of fs.readdirSync(path.join(__dirname, '../../src/harness/claude/erd-studio-setup/references'))) {
      texts[name] = ref(name);
    }
    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).not.toMatch(/`fix-model-yaml`(?: step| fix| step or fix)? (?:with|has|marked) `mergeConflict/);
      expect(text, name).not.toContain('Except with `mergeConflict');
      for (const para of text.split(/\n\s*\n|\n(?=\|)/)) {
        // Where the flag sits: an unreadableModelFiles entry, or (native DBML storage) a dbmlProblems entry.
        if (para.includes('`mergeConflict: true`')) { expect(para, `${name}: ${para}`).toMatch(/unreadableModelFiles|dbmlProblems/); }
      }
    }
  });

  it('pre-approves no git command', () => {
    const tools = frontmatter(skill.content)['allowed-tools'] as string[];
    expect(tools.filter((t) => /^Bash\(git\b/.test(t))).toEqual([]);
  });
});

describe('setup skill: the Without dbt route', () => {
  const body = (): string => splitFrontmatter(skill.content)!.body;
  const ref = (name: string): string =>
    CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === `references/${name}`)!.content;
  const route = (): string => ref('without-dbt.md');
  /** Line breaks folded, so a phrase reads the same wherever the source wraps it. */
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  const cli = (name: string): string => fs.readFileSync(path.resolve(__dirname, '../../src/cli', name), 'utf-8');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')) as {
    contributes: { commands: { command: string; title: string; category?: string }[] };
  };
  const title = (command: string): string | undefined => pkg.contributes.commands.find((c) => c.command === command)?.title;

  it('checks for dbt_project.yml before the dbt greeting and hands the whole walkthrough to the reference', () => {
    const check = body().indexOf('**First, look for dbt:** Glob `dbt_project.yml`');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body().indexOf('- ERD Studio shows data two ways.'));
    expect(flat(body())).toContain(
      'None → the **Without dbt** route: follow `references/without-dbt.md` from its start instead of Stages 0–6, never suggesting dbt.',
    );
    expect(body()).toContain('| `references/without-dbt.md` | The project has no `dbt_project.yml`: the whole Without dbt route |');
    expect(frontmatter(skill.content).description as string).toContain('Without dbt, designs a first diagram');
  });

  it('points only at reference files the skill ships', () => {
    const shipped = new Set(CLAUDE_SETUP_SKILL_FILES.map((a) => a.relativePath));
    for (const text of [body(), route()]) {
      for (const [mention] of text.matchAll(/references\/[a-z-]+\.md/g)) {
        expect(shipped.has(mention), mention).toBe(true);
      }
    }
  });

  it('runs only the helper commands that work without dbt: never diff, never dbt', () => {
    const subcommands = [...route().matchAll(/erd-studio(?:\.cmd)? ([a-z]+)/g)].map((m) => m[1]);
    expect(subcommands.length).toBeGreaterThan(0);
    for (const sub of subcommands) {
      expect(['doctor', 'export'], sub).toContain(sub);
    }
    expect(route()).not.toMatch(/\bdbt (parse|deps|debug|docs|compile|run|build|seed|snapshot|--version)\b/);
    expect(route()).toContain('**Never run `diff`.**');
    expect(route()).toContain('never run a `dbt` command');
    // The one mention of installing dbt is the rule against suggesting it.
    expect(route().match(/install(?:ing)? dbt/gi)).toEqual(['install dbt']);
    expect(route()).toContain('**Never tell the user to install dbt**');
  });

  it("reads doctor's logical-only signals by the CLI's own spelling", () => {
    expect(cli('context.ts')).toContain('dbtProject: boolean');
    expect(cli('doctor.ts')).toContain("skippedChecks?: { reason: 'not-dbt-project'");
    expect(flat(route())).toContain('reports `dbtProject: false` and `skippedChecks` with reason `not-dbt-project`');
    // project.found is false in a logical-only folder: the route must not send the user looking for dbt.
    expect(flat(route())).toContain('do not ask which folder holds a dbt project');
    // Doctor runs in step 1 even in an empty folder (it exits 0 there), so a missing or stale
    // helper shows up before the design work, not after every file is written.
    expect(flat(route())).toContain('every time, even in an empty folder');
    expect(flat(route())).not.toContain('skip doctor until step 5');
    expect(cli('doctor.ts')).toContain('semanticDirExists');
    expect(flat(route())).toContain('**`erd.semanticDirExists: false`** → there is nothing to check yet');
    expect(cli('doctor.ts')).toContain("id: 'turn-round-relationships'");
    for (const id of ['`fix-model-yaml`', '`fix-dbml-file`', '`resolve-merge-conflicts`', '`resolve-format-conflicts`', '`finish-dbml-conversion`', '`import-dbml-file`', '`turn-round-relationships`', '`erd.storage`']) {
      expect(route(), id).toContain(id);
    }
  });

  it('offers a description, a DBML file or the existing tables, and designs with keys, grain and relationships', () => {
    const text = flat(route());
    for (const start of ['**Enrich what is there**', '**From a DBML file**', '**From a description**']) {
      expect(text, start).toContain(start);
    }
    for (const field of ['isPrimaryKey: true', 'isNaturalKey: true', 'isForeignKey: true', '`many-to-one`', '`grain`', 'rationale.purpose']) {
      expect(text, field).toContain(field);
    }
    // A new design states the intended design, so the dbt route's as-built rule is lifted explicitly.
    expect(text).toContain("the dbt route's \"describe what dbt does today\" rule and its Target-design backlog do not apply");
    expect(text).toContain('A table that already has a file is **referenced by name, never rewritten**');
    expect(text).toContain('Never rename a table or column, change a type, or remove anything without asking');
  });

  it('names the commands as they are contributed', () => {
    expect(title('erdStudio.importDbml')).toBe('Import DBML…');
    expect(route()).toContain('**ERD Studio: Import DBML…**');
    expect(title('erdStudio.exportDiagram')).toBe('Export Diagram…');
    expect(route()).toContain('**ERD Studio: Export Diagram…**');
    expect(title('erdStudio.openExampleDiagram')).toBe('Open Example Diagram');
    expect(route()).toContain('**ERD Studio: Open Example Diagram**');
  });

  it("follows the product's wording rules", () => {
    const text = flat(route());
    expect(text).toContain('DBML is an open format');
    expect(text).not.toMatch(/open standard|open[- ]source|lossless|round[- ]trip|sync(?:s|ing)? with dbdiagram/i);
    expect(text).not.toMatch(/\bharness\b/i);
    expect(text).toContain('the commands call a diagram a *subject area*');
    // No Physical tab, Diff or sync plan in a folder without dbt — only the one "Using dbt?" line.
    expect(text).toContain('"Using dbt? Open its folder to compare your design with what dbt built."');
    expect(text).not.toContain('⊕ Sync');
  });
});

describe('setup skill: native DBML storage (§7.3)', () => {
  const body = (): string => splitFrontmatter(skill.content)!.body;
  const ref = (name: string): string =>
    CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === `references/${name}`)!.content;
  const flat = (text: string): string => text.replace(/\s+/g, ' ');

  it('stays under 500 lines with the new next steps and CLI codes routed', () => {
    expect(skill.content.split('\n').length).toBeLessThan(500);
    // Each id is in SKILL.md or a reference SKILL.md links.
    const linked = [...body().matchAll(/`references\/([\w-]+\.md)`/g)].map((m) => m[1]);
    const reachable = [body(), ...[...new Set(linked)].map(ref)].join('\n');
    for (const id of ['fix-dbml-file', 'resolve-format-conflicts', 'finish-dbml-conversion', 'import-dbml-file', 'dbml-invalid', 'not-a-diagram']) {
      expect(reachable, id).toContain(`\`${id}\``);
    }
    // The CLI really emits them.
    const cli = (name: string): string => fs.readFileSync(path.resolve(__dirname, '../../src/cli', name), 'utf-8');
    for (const id of ['fix-dbml-file', 'resolve-format-conflicts', 'finish-dbml-conversion', 'import-dbml-file']) {
      expect(cli('doctor.ts'), id).toContain(`'${id}'`);
    }
    expect(cli('diff.ts')).toContain("'dbml-invalid'");
    expect(cli('diff.ts')).toContain("'not-a-diagram'");
  });

  it('replaces the named lines of SKILL.md', () => {
    expect(flat(body())).toContain('a `fix-model-yaml` or `fix-dbml-file` whose file entry has `mergeConflict: true`, or a `dbmlProblems` entry with `mergeConflict: true`, at any stage): git left two versions in a file.');
    expect(body()).toContain('run `doctor` and fix each `fix-model-yaml` / `fix-dbml-file` file:line it lists first (usually a value to quote) —');
    expect(body()).toContain('- **`fix-model-yaml` / `fix-dbml-file`** first, always: the file does not parse — fix that line (DBML: `references/troubleshooting.md`)');
    expect(body()).toContain('1. Glob `.erd-studio/*/*.{dbml,json}` and propose one domain (');
  });

  it("route 2's Glob skips node_modules and the ERD Studio folder, whose own files are DBML", () => {
    const text = flat(ref('without-dbt.md'));
    expect(text).toContain('one (`**/*.dbml`, skipping `node_modules` and the ERD Studio folder itself, `.erd-studio/`');
    expect(text).toContain('ERD Studio stores its own model as DBML too, split into one file per table');
    expect(text).not.toContain('stay the only copy');
    expect(text).toContain('A new project writes **DBML** (doctor\'s `erd.storage` says `dbml`)');
  });

  it('writes DBML first in the build recipe, with YAML as the legacy branch', () => {
    const building = ref('building-the-model.md');
    for (const heading of ['## Table file (DBML) — field by field', '## Relationships (DBML)', '## Diagram file (DBML)', '## Worked example (DBML)', '## Legacy: model yml — field by field', '## Legacy: domain JSON']) {
      expect(building, heading).toContain(heading);
    }
    expect(building.indexOf('## Table file (DBML)')).toBeLessThan(building.indexOf('## Legacy: model yml'));
    // Each fix kind has its DBML translation, and the ids are unchanged.
    const fix = ref('verify-and-fix.md');
    expect(fix).toContain('| `fix-dbml-file` |');
    expect(fix).toContain('| kind | Edit (DBML) |');
    // A conflicted relationships file: keep both sides, then doctor reports a Ref twice.
    expect(flat(ref('troubleshooting.md'))).toContain("offer to keep both sides' Ref lines and both sides' `use` lines, then run doctor");
  });
});
