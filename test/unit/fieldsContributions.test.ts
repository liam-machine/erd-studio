/**
 * Context fields in package.json: the Customise Fields… command (opens
 * .erd-studio/fields.yml, or the starting set as an unsaved file), the JSON
 * Schema VS Code's YAML extension applies to that file, and the walkthrough
 * step that names the fields an assistant adds. The command's handler and its
 * NO_LEGACY_ALIAS entry are pinned with the other commands in
 * extension.activate.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus: { commandPalette: Array<{ command: string; when?: string }> };
    yamlValidation: Array<{ fileMatch: string | string[]; url: string }>;
    walkthroughs: Array<{ steps: Array<{ id: string; description: string }> }>;
  };
};

describe('package.json: context fields', () => {
  it('contributes Customise Fields… in the ERD Studio category, in the palette whenever a project is open', () => {
    expect(pkg.contributes.commands.filter((c) => c.command === 'erdStudio.customiseFields')).toEqual([
      { command: 'erdStudio.customiseFields', title: 'Customise Fields…', category: 'ERD Studio' },
    ]);
    expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === 'erdStudio.customiseFields')).toEqual([
      { command: 'erdStudio.customiseFields', when: 'erdStudio.hasProject' },
    ]);
  });

  it('validates exactly the root fields.yml with schemas/fields.schema.json', () => {
    const entries = pkg.contributes.yamlValidation.filter((v) => v.url === './schemas/fields.schema.json');
    expect(entries).toEqual([{ fileMatch: '**/.erd-studio/fields.yml', url: './schemas/fields.schema.json' }]);
    expect(fs.existsSync(path.join(ROOT, 'schemas/fields.schema.json'))).toBe(true);
  });

  it('the walkthrough names the fields an assistant adds, not the retired "rationale"', () => {
    const enrich = pkg.contributes.walkthroughs.flatMap((w) => w.steps).find((s) => s.id === 'enrich');
    expect(enrich?.description).toContain('Add grain, keys, purpose and decisions');
    expect(enrich?.description).not.toMatch(/rationale/i);
  });
});
