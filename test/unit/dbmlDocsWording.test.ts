/**
 * The user and developer docs for native DBML storage (2.0) state the facts the code has:
 * which parsers read the split project, what a stray Metadata block does, which file a
 * `diff` fix names, the custom editor's real viewType, and the telemetry the release adds.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('native DBML storage docs', () => {
  it('Leaving ERD Studio qualifies 10.x and never says dbdiagram.io reads the split project', () => {
    const text = flat(read('docs/leaving-erd-studio.md'));
    expect(text).toContain('DBML parsers 9.1 and 11+ read them as a multi-file project (10.x too, unless a folder in the path has a space).');
    expect(text).not.toMatch(/Any DBML parser from 9\.1 on/);
    expect(text).not.toMatch(/the one dbdiagram\.io's own tools use/);
  });

  it('the format reference says a Metadata block with no target makes the table unreadable', () => {
    const text = flat(read('docs/semantic-domain-json-reference.md'));
    expect(text).toContain('A block whose target the file does not declare makes the table unreadable');
    expect(text).toContain('`doctor` lists it as a warning');
    expect(text).not.toContain('a block whose target the file does not declare is a warning');
  });

  it('the format reference runs diff on a .dbml diagram and names the DBML files a fix changes', () => {
    const text = flat(read('docs/semantic-domain-json-reference.md'));
    expect(text).toContain('`erd-studio diff --domain .erd-studio/{layer}/{domain}.dbml --json` (the `.json` diagram in a YAML project)');
    expect(text).toContain("the FK table's folder's `_relationships.dbml`");
    expect(text).not.toContain('`erd-studio diff --domain .erd-studio/{layer}/{domain}.json --json`');
  });

  it('architecture.md names the custom editor viewType package.json contributes', () => {
    const pkg = JSON.parse(read('package.json')) as { contributes: { customEditors: Array<{ viewType: string }> } };
    const viewType = pkg.contributes.customEditors[0].viewType;
    const text = read('docs/dev/architecture.md');
    expect(text).toContain(`\`${viewType}\` is contributed`);
    expect(text).not.toContain('erdStudio.semanticEditor');
  });

  it('the 2.0.0 notes mention the new telemetry keys, with no name or path sent', () => {
    const changelog = read('CHANGELOG.md');
    const start = changelog.search(/^## (Unreleased — 2\.0\.0|2\.0\.0 — )/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = changelog.slice(start + 1);
    const section = rest.slice(0, rest.search(/^## /m));
    expect(flat(section)).toContain('The anonymous daily usage report now also says whether a DBML project was open, how the **Convert Project to DBML** offer and command went');
    expect(flat(section)).toContain('why a `.dbml` table or diagram could not be read');
  });
});
