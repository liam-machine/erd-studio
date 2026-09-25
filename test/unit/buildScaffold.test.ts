import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import changelog from '../../CHANGELOG.md';

const root = path.resolve(__dirname, '../..');

describe('build scaffold (vitest mirrors esbuild)', () => {
  it('imports a .md file as its raw text', () => {
    expect(typeof changelog).toBe('string');
    expect(changelog).toBe(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8'));
  });

  it('defines __ERD_CLI_VERSION__ as the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version: string };
    expect(__ERD_CLI_VERSION__).toBe(pkg.version);
  });
});
