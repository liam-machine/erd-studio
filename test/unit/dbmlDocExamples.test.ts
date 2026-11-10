/**
 * Every ```dbml example the user and the AI assistants read is already in
 * the canonical layout (`formatDbml` gives it back unchanged): the README,
 * the docs, the setup skill's references and the schema skill as
 * `HarnessService` installs it. An example in another layout teaches a
 * layout ERD Studio rewrites on its next save.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { formatDbml } from '@erd-studio/core/dbml';

import { HarnessService } from '../../src/services/harnessService';

const REPO = path.resolve(__dirname, '../..');

/** Every .md file under `dir` (relative to the repo). */
function markdown(dir: string): string[] {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? markdown(p) : e.name.endsWith('.md') ? [p] : [];
  });
}

/** The ```dbml fences of `text`, each with the line it starts on. */
function fences(text: string): Array<{ line: number; body: string }> {
  return [...text.matchAll(/```dbml\r?\n([\s\S]*?)```/g)].map((m) => ({
    line: text.slice(0, m.index).split('\n').length,
    body: m[1],
  }));
}

const SOURCES: Array<[string, string]> = [
  ...['README.md', ...markdown('docs'), ...markdown('src/harness')].map((p): [string, string] => [p, fs.readFileSync(path.join(REPO, p), 'utf-8')]),
  ...new HarnessService().schemaSkillFiles().map(([name, text]): [string, string] => [`schema skill ${name}`, text]),
];

describe('the DBML examples in the docs and the harness', () => {
  it('finds the README sample and the setup skill worked example', () => {
    const where = SOURCES.flatMap(([name, text]) => fences(text).map(() => name));
    expect(where).toContain('README.md');
    expect(where).toContain(path.join('src/harness/claude/erd-studio-setup/references/building-the-model.md'));
  });

  it('are each in the canonical layout', () => {
    const off: string[] = [];
    for (const [name, text] of SOURCES) {
      for (const { line, body } of fences(text)) {
        const result = formatDbml(body);
        if (result.skipped) off.push(`${name}:${line} ${result.skipped}`);
        else if (result.changed) off.push(`${name}:${line} is not in the canonical layout:\n${result.text}`);
      }
    }
    expect(off).toEqual([]);
  });
});
