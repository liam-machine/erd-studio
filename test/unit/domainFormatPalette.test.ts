import * as fs from 'fs';
import * as path from 'path';

import { describe, it, expect } from 'vitest';

import { describeUnsupportedDomainFormat } from '../../src/types/semantic';

// The rest of describeUnsupportedDomainFormat's tests live with the function in
// packages/core/test/unit/domainFormat.test.ts. This one reads the extension's
// package.json (the command palette entry), so it stays with the extension.
describe('describeUnsupportedDomainFormat', () => {
  it('names the file and the migration command for legacy and hybrid', () => {
    // The remediation must quote the command exactly as the palette shows it,
    // otherwise searching the palette for the quoted string finds nothing.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'),
    ) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
    const command = packageJson.contributes.commands.find((c) => c.command === 'erdStudio.migrateToV5')!;
    const paletteEntry = `${command.category}: ${command.title}`;
    expect(paletteEntry).toBe('ERD Studio: Migrate Domains to Central Model Store');

    const legacy = describeUnsupportedDomainFormat('legacy', '/p.json')!;
    expect(legacy).toContain('/p.json');
    expect(legacy).toContain(`"${paletteEntry}"`);
    const hybrid = describeUnsupportedDomainFormat('hybrid', '/p.json')!;
    expect(hybrid).toContain('/p.json');
    expect(hybrid).toContain(`"${paletteEntry}"`);
  });
});
