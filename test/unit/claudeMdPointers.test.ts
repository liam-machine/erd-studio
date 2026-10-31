/**
 * The root CLAUDE.md is kept short by pointing at docs/dev/*.md and nested
 * CLAUDE.md files. A pointer to a moved or renamed file fails silently in an
 * agent's context, so every repo path the root file names must exist.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const PATH_PREFIXES = /^(docs|src|packages|test|webview|telemetry|scripts|\.github)\//;

function referencedPaths(markdown: string): string[] {
    const found = new Set<string>();
    for (const match of markdown.matchAll(/`([^`\s]+)`/g)) {
        const token = match[1];
        if (PATH_PREFIXES.test(token) && !/[*{}<>]/.test(token)) found.add(token);
    }
    return [...found];
}

describe('root CLAUDE.md pointers', () => {
    const text = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    const paths = referencedPaths(text);

    it('names the docs it relocated content to', () => {
        expect(paths).toContain('docs/dev/architecture.md');
        expect(paths).toContain('packages/CLAUDE.md');
        expect(paths).toContain('src/harness/CLAUDE.md');
    });

    it('points at the native DBML storage docs (2.0)', () => {
        expect(paths).toContain('docs/dev/dbml.md');
        expect(paths).toContain('docs/plans/native-dbml-storage.md');
        expect(text).toMatch(/DBML storage, import and export/);
        expect(text).toMatch(/DBML, an open format/);
        expect(text).not.toMatch(/open standard/);
    });

    it.each(paths)('%s exists', (p) => {
        expect(fs.existsSync(path.join(ROOT, p))).toBe(true);
    });
});
