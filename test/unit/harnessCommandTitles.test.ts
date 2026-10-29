/**
 * Every command the AI helper files name as **ERD Studio: X** exists in
 * package.json under that title (docs/dev/onboarding-and-cli.md: "Every
 * command, button and label named must exist in package.json or the UI as
 * written"). An assistant that names a title the Command Palette does not
 * have sends the user looking for nothing.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push({ file: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf-8') });
    }
  };
  walk(path.join(ROOT, 'src', 'harness'));
  out.push({ file: 'src/services/harnessService.ts', text: fs.readFileSync(path.join(ROOT, 'src', 'services', 'harnessService.ts'), 'utf-8') });
  return out;
}

describe('the AI helper files name only commands that exist', () => {
  it('every **ERD Studio: X** is a contributed command title', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { contributes: { commands: Array<{ title: string }> } };
    const titles = new Set(pkg.contributes.commands.map((c) => c.title));
    const unknown: string[] = [];
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(/\*\*ERD Studio: ([^*]+?)\*\*/g)) {
        // A title wrapped over lines (in a blockquote too) is one title.
        const title = m[1].replace(/\n\s*>?\s*/g, ' ').replace(/\s+/g, ' ').trim();
        if (!titles.has(title)) unknown.push(`${file}: ${title}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
