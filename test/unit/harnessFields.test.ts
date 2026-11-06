/**
 * Context fields in the AI helper files (HARNESS_VERSION 46): the schema
 * skill's one "Fields" section, the fields.yml format and the setting-name
 * table in DBML.md, the YAML homes in LEGACY.md, SYNC.md's `filled_by: dbt`
 * copying, and the setup skill writing fields.yml. Wherever the text names a
 * built-in field, a reserved name or a rationale key, it is checked against
 * core's one catalogue, so the instructions and the code cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  BUILT_IN_FIELDS,
  DBML_SETTING_NAMES,
  ERD_SETTING_NAMES,
  FIELDS_FILE_PROBLEM_CODES,
  RATIONALE_FIELD_KEYS,
  RESERVED_FIELD_KEY_PREFIXES,
  STARTING_FIELD_LIST,
  UNSAFE_FIELD_KEYS,
  parseFieldsText,
} from '@erd-studio/core';
import { parse as parseYaml } from 'yaml';

import { HarnessService } from '../../src/services/harnessService';
import { CLAUDE_SETUP_SKILL_FILES, setupSkillAssets } from '../../src/services/harnessAssets';

const service = new HarnessService();
const schema = (name: string, dbt = true): string =>
  service.schemaSkillFiles({ dbt }).find(([n]) => n === name)![1];
const setup = (relativePath: string, dbt = true): string =>
  setupSkillAssets(dbt).find((a) => a.relativePath === relativePath)!.content;
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** The text from `heading` up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest);
  return heading + (next ? rest.slice(0, next.index) : rest);
}

/** The first ```yaml block in `text`. */
function yamlBlock(text: string): string {
  return /```yaml\n([\s\S]*?)```/.exec(text)![1];
}

const DOCTOR_FIELD_CODES = [
  'fieldValueOutsideChoices', 'fieldSpelledTwice', 'fieldOldSpellings', 'fieldRetired', 'fieldNotInList', 'fieldMetaShadowsBuiltIn',
];

describe('the schema skill: one "Fields" section', () => {
  const skill = schema('SKILL.md');
  const fields = section(skill, '## Fields');

  it('replaces "The team\'s metadata list" and "Design rationale" with one section', () => {
    expect(skill).not.toContain("### The team's metadata list");
    expect(skill).not.toContain('## Design rationale');
    expect(skill.match(/^## Fields$/gm)).toHaveLength(1);
    // No larger than the two sections it replaced (3771 bytes as a dbt project installs them),
    // so the Codex region keeps its headroom.
    expect(Buffer.byteLength(fields, 'utf-8')).toBeLessThanOrEqual(3771);
  });

  it('names the starting set exactly as core ships it', () => {
    const tables = STARTING_FIELD_LIST.tables.map((d) => d.key).join(', ');
    const columns = STARTING_FIELD_LIST.columns.map((d) => d.key).join(', ');
    expect(fields).toContain(`use the starting set: ${tables}; on columns ${columns}.`);
  });

  it('says how to write each type, filled_by and show_for, in the approved wording', () => {
    for (const text of [
      "Each field is one setting, `<key>: '<value>'`: on the Table line for a table field, on the column for a column field. Quote every value.",
      'type text: what the guidance asks for, in a sentence or two. type value: one short value. type choice: exactly one of its values. type yes-no: \'true\' or \'false\'.',
      'filled_by people: write only a value the user gives you',
      'show_for dimensions / facts: only on tables with that role.',
      'Leave a field out when you have nothing true to say. Never write a placeholder.',
      'open_questions: when you meet a choice you cannot make, write the question there and ask the user. When they answer, move the answer into decisions and remove the question.',
      'Keep every setting the list does not name exactly as it is.',
      'Retired fields (design, role_choice, grain_choice): keep them; offer once to move the text into decisions, showing the result first.',
    ]) {
      expect(flat(fields), text).toContain(text);
    }
  });

  it('edits old spellings in place and renames only what doctor lists, on a yes', () => {
    expect(flat(fields)).toContain('Old spellings (`rationale_<key>`, `meta_<key>`, an entry in `meta_json`) are the same field: change it where it is, never add a second copy.');
    expect(flat(fields)).toContain("Rename only what doctor's `erd.fields` lists as old spellings (`fieldOldSpellings`), and only when the user agrees; never a `meta_json` entry, nor a `meta_<key>` whose key is reserved or a built-in");
  });

  it('maps an old ## Metadata table onto fields.yml, and offers once to move it', () => {
    const text = flat(fields);
    expect(text).toContain('Source `dbt` is filled_by dbt, `the team` is people, Left out is left_out.');
    expect(text).toContain('Offer once to move it into fields.yml: show the result, and remove the old section on a yes.');
    // The Team Modelling Approach paragraph keeps its pinned sentences and points here.
    expect(skill).toContain("Which fields a table records is `.erd-studio/fields.yml`'s job; an old **Metadata** section is followed as \"Fields\" says.");
  });

  it('routes fix-fields-file in the check-your-work rule, and names only doctor codes that exist', () => {
    expect(skill).toContain('Fix every `fix-dbml-file` and `fix-fields-file` error before anything else');
    const named = new Set([schema('SKILL.md'), schema('DBML.md'), schema('LEGACY.md'), ...CLAUDE_SETUP_SKILL_FILES.map((a) => a.content)]
      .flatMap((t) => [...t.matchAll(/`(fields?[A-Z]\w+)`/g)].map((m) => m[1])));
    expect(named.size).toBeGreaterThan(0);
    for (const code of named) {
      expect([...FIELDS_FILE_PROBLEM_CODES, ...DOCTOR_FIELD_CODES], code).toContain(code);
    }
  });

  it('lists fields.yml in both layout trees', () => {
    expect(skill).toContain('├── fields.yml                      ← optional: the fields the team records (see "Fields")');
    expect(schema('LEGACY.md')).toContain('├── fields.yml                ← Optional: the fields the team records (see "Fields" in `SKILL.md`)');
  });
});

describe('the dbt meta procedure (filled_by dbt)', () => {
  const PROCEDURE = [
    '`~/.erd-studio-cli/bin/erd-studio inventory --models <name> --json` (`models[].meta`, `columns[].meta`, merged as dbt merges them: `config: meta:` wins, project `+meta` included)',
    'else the schema `.yml` (`meta:`, `config: meta:`) and `+meta` in `dbt_project.yml`',
  ];

  it('is in the shared skill part, so the DBML and the YAML install paths both reach it', () => {
    for (const [where, text] of [
      ['SKILL.md', schema('SKILL.md')],
      ['Codex AGENTS.md', service.generateContent('codex')],
      ['Copilot', service.generateContent('copilot')],
      ['Gemini', service.generateContent('gemini')],
    ] as const) {
      for (const p of PROCEDURE) expect(text, `${where}: ${p}`).toContain(p);
    }
    // Both format files send the assistant to it.
    expect(schema('DBML.md')).toContain('"Fields" in `SKILL.md`');
    expect(schema('LEGACY.md')).toContain('"Fields" in `SKILL.md`');
  });

  it('is left out of a folder without dbt, with every other dbt word', () => {
    for (const [name, text] of service.schemaSkillFiles({ dbt: false })) {
      expect(text, name).not.toMatch(/\bdbt\b|filled_by: dbt|filled_by dbt/);
    }
    expect(service.generateContent('codex', { dbt: false })).not.toMatch(/\bdbt\b/);
  });
});

describe('DBML.md: the fields.yml format and the setting names', () => {
  const dbml = schema('DBML.md');
  const format = section(dbml, '## fields.yml: the fields a project records');
  const names = section(dbml, '### Setting names');

  it.each([true, false])('its fields.yml example reads with no problem in core (dbt project: %s)', (dbt) => {
    const text = yamlBlock(section(schema('DBML.md', dbt), '## fields.yml: the fields a project records'));
    const { list, problems } = parseFieldsText(text);
    expect(problems).toEqual([]);
    expect(list.tables.map((d) => d.key)).toEqual([...STARTING_FIELD_LIST.tables.map((d) => d.key), 'owner', 'sensitivity']);
    expect(list.columns.map((d) => d.key)).toEqual([...STARTING_FIELD_LIST.columns.map((d) => d.key), 'pii']);
    expect(list.tables.find((d) => d.key === 'decisions')!.guidance).toBe('Choices finance signed off, and why.');
    expect(list.tables.find((d) => d.key === 'owner')!.filledBy).toBe(dbt ? 'dbt' : 'anyone');
    expect(list.tables.find((d) => d.key === 'sensitivity')!.filledBy).toBe('people');
    expect(list.leftOut).toEqual(dbt ? ['dimension', 'metrics'] : []);
  });

  it('describes every property of an entry', () => {
    for (const key of ['**key**', '**label**', '**guidance**', '**type**', '**filled_by**', '**show_for**', '**left_out**']) {
      expect(format, key).toContain(key);
    }
    expect(flat(format)).toContain('A missing `tables:` or `columns:` means the starting set\'s; `tables: []` means none.');
  });

  it('lists every built-in with core\'s guidance, and the retired ones as retired', () => {
    for (const def of BUILT_IN_FIELDS) {
      if (def.status === 'retired') {
        expect(format, def.key).toMatch(new RegExp(`\\*\\*Retired\\*\\*[^\\n]*\`${def.key}\``));
        continue;
      }
      const row = format.split('\n').find((l) => l.startsWith(`| \`${def.key}\` |`));
      expect(row, def.key).toBeDefined();
      expect(row, def.key).toContain(def.guidance!);
      expect(row, def.key).toContain(def.status === 'starting' ? '| starting |' : '| optional |');
    }
  });

  it('names every reserved setting and prefix core reserves', () => {
    for (const name of [...DBML_SETTING_NAMES, ...ERD_SETTING_NAMES, ...UNSAFE_FIELD_KEYS]) {
      expect(names, name).toContain(`\`${name}\``);
    }
    for (const prefix of RESERVED_FIELD_KEY_PREFIXES) {
      expect(names, prefix).toContain(`\`${prefix}\``);
    }
  });

  it('keeps meta_json for values that are not text, and the old-spelling rules', () => {
    const text = flat(names);
    expect(text).toContain('| `meta_json` | metadata that is not text: lists, maps, numbers, and `true` / `false` for a key that is not a yes-no field. A text value is its own setting |');
    expect(text).toContain('| `erd_<key>` | the same field, and it wins over `<key>`');
    expect(text).toContain('**Renaming old spellings** is the user\'s choice: only on a yes, all in one change, and only what doctor counts as `fieldOldSpellings`.');
    expect(text).toContain('Never rename `rationale_design`, `rationale_role_choice` or `rationale_grain_choice`');
    expect(text).toContain('an entry in `meta_json`, or a `meta_<key>` whose key is reserved or a built-in that is not metadata (`meta_purpose`, `meta_role`, `meta_retention`)');
    expect(text).toContain('`meta_<key>` is the same field only for a key of the team\'s own');
  });

  it('writes the example table with bare field settings', () => {
    const table = /```dbml\n([\s\S]*?)```/.exec(dbml)![1];
    expect(table).toContain("  purpose: 'Revenue reporting by day, customer and region',");
    expect(table).toContain("  owner: 'sales-data',");
    expect(table).toContain("[pii: 'true', note: 'Where the receipt was sent']");
    expect(table).not.toMatch(/rationale_|meta_owner|meta_pii/);
    expect(table).toContain('meta_json: \'{"tags":["finance"]}\'');
    // Column settings: pk; DBML's own; ERD Studio's flags; the fields; note last.
    expect(dbml).toContain("ERD Studio's (`natural_key`, `scd_type`, `additive_type`, `foreign_key`); the fields (`pii: 'true'`, any `meta_json`); then `note` last.");
  });
});

describe('LEGACY.md: the fields in a YAML table', () => {
  const legacy = schema('LEGACY.md');
  const homes = section(legacy, '### Fields in a YAML table');

  it('names every rationale key core reads, in camelCase, and the team fields in meta', () => {
    for (const key of RATIONALE_FIELD_KEYS) {
      expect(homes, key).toContain(`\`${key}\``);
    }
    expect(homes).toContain('a key of the `meta:` map');
    expect(homes).toContain('Write a camelCase key in `rationale:` (`openQuestions`, never `open_questions`)');
  });

  it('warns about older ERD Studio versions clearing the whole rationale map (A13)', () => {
    expect(flat(homes)).toContain('When their editor clears the last of those six on a table, it removes the whole `rationale:` map, the newer keys (`decisions`, `openQuestions`, …) with it.');
  });

  it('keeps the YAML value rules complete', () => {
    expect(flat(legacy)).toContain('**Keep the kind of value**: `true` / `false` stay unquoted and a list stays a list.');
    expect(legacy).toContain('keep the quotes when leaving them off would change the digits (`"1.10"`, `"007"`)');
  });

  it('its model example writes no retired rationale key', () => {
    const model = parseYaml(yamlBlock(legacy)) as { rationale: Record<string, string> };
    for (const key of Object.keys(model.rationale)) {
      expect(RATIONALE_FIELD_KEYS as readonly string[]).toContain(key);
      expect(['design', 'grainChoice', 'roleChoice']).not.toContain(key);
    }
  });
});

describe('no harness example writes a retired field', () => {
  const texts: Array<[string, string]> = [
    ...[true, false].flatMap((dbt) => service.schemaSkillFiles({ dbt }).map(([n, t]): [string, string] => [`${n} (dbt ${dbt})`, t])),
    ...[true, false].flatMap((dbt) => setupSkillAssets(dbt).map((a): [string, string] => [`${a.relativePath} (dbt ${dbt})`, a.content])),
  ];

  it.each(texts)('%s', (_name, text) => {
    expect(text).not.toMatch(/\b(?:rationale_)?(?:design|role_choice|grain_choice|roleChoice|grainChoice):\s*['"]/);
    expect(text).not.toMatch(/\brationale\.(?:design|roleChoice|grainChoice)\b/);
    expect(text).not.toMatch(/^\s+(?:design|roleChoice|grainChoice):/m);
  });
});

describe('SYNC.md copies the fields filled_by dbt', () => {
  it('in every row that copies dbt meta, DBML and legacy alike', () => {
    const sync = schema('SYNC.md');
    expect(sync).not.toContain('metadata list');
    expect(sync.match(/`fields\.yml` marks `filled_by: dbt` \(never a `left_out` key\)/g)).toHaveLength(4);
  });
});

describe('the setup skill writes fields.yml', () => {
  it('metadata.md proposes one list and saves it as fields.yml, never a ## Metadata table', () => {
    const metadata = setup('references/metadata.md');
    expect(metadata).toContain('Write `.erd-studio/fields.yml`, beside `layers.json`');
    expect(metadata).not.toContain('| Key | On | Values | Source |');
    // The offer, read as one sentence across its blockquote lines.
    expect(flat(metadata.replace(/\n\s*> /g, ' '))).toContain("I'll save the list in `.erd-studio/fields.yml` so every assistant fills in the same fields. Change any?");
    const { list, problems } = parseFieldsText(yamlBlock(section(metadata, '## 4. Saving it')));
    expect(problems).toEqual([]);
    expect(list.tables.find((d) => d.key === 'owner')!.filledBy).toBe('dbt');
    expect(list.columns.find((d) => d.key === 'pii')!.type).toBe('yes-no');
    expect(list.leftOut).toEqual(['dimension', 'metrics']);
    // An old list is moved only on a yes, with a preview.
    expect(section(metadata, '## 7. An old `## Metadata` list')).toContain('On a yes, show the file you will write');
  });

  it('SKILL.md offers the field list in Stage 4 and routes fix-fields-file, replacing lines only', () => {
    const skill = setup('SKILL.md');
    expect(flat(skill)).toContain('Then **the field list**, on every route, with or without a style: read `references/metadata.md`, follow sections 2–4.');
    expect(skill).toContain('`fix-fields-file`: `references/verify-and-fix.md`');
    expect(setup('references/verify-and-fix.md')).toContain('**`fix-fields-file`** is a doctor step, not a diff fix');
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('without dbt, the walkthrough adds fields to fields.yml filled by anyone or people only', () => {
    const walkthrough = setup('references/walkthrough.md', false);
    const text = flat(walkthrough);
    expect(text).toContain('offer once to add it to fields.yml, showing the entry first');
    expect(text).toContain('`filled_by: people` when only people fill it in');
    expect(walkthrough).not.toContain('filled_by: dbt');
    expect(walkthrough).not.toContain('references/metadata.md');
    const starting = [...STARTING_FIELD_LIST.tables, ...STARTING_FIELD_LIST.columns].map((d) => `\`${d.key}\``);
    for (const key of starting) expect(text, key).toContain(key);
  });

  it('the retired keys are gone from the approach mappings', () => {
    const approaches = setup('references/modelling-approaches.md');
    expect(approaches).toContain('`rationale.decisions: "Data Vault hub — conformed-dim is the closest ERD Studio role"`');
    expect(approaches).toContain('(never the retired `design`, `grainChoice` or `roleChoice`)');
  });
});

describe('the fixtures carry the current harness', () => {
  it('test/fixtures/dbt-project has the v46 schema skill as install() writes it (npm run regen-fixtures)', () => {
    const dir = path.resolve(__dirname, '../fixtures/dbt-project/.claude/skills/erd-studio');
    for (const [name, text] of service.schemaSkillFiles()) {
      expect(fs.readFileSync(path.join(dir, name), 'utf-8'), name).toBe(text);
    }
  });
});
