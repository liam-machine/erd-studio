/**
 * UI wording in the code users read: every string literal, template and JSX
 * text under webview/, webview-draft/, packages/renderer/src/ and src/cli/ says "diagram",
 * never "subject area" (docs/dev/onboarding-and-cli.md, "User-facing wording").
 *
 * Identifiers (`subjectArea`, `SubjectAreaFileError`), comments and message
 * type names and ids (`fix-subject-area-naming`) never hold the words with
 * a space between them, so they pass. The only
 * literals allowed to say it are the real titles of the two file-format
 * commands, quoted so a user can find them in the Command Palette.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['webview', 'webview-draft', 'packages/renderer/src', 'src/cli'];

/** The two commands that keep "Subject Area" in their titles (`uiWording.test.ts`). */
const COMMAND_TITLES = [/Migrate Subject Areas to the Central Table Library/g, /Set Up Subject Areas Directory/g];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every piece of literal text in `file`: strings, template parts and JSX text. */
export function literalTexts(fileName: string, text: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    // Module specifiers are paths, not words.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      || ts.isJsxText(node)
    ) {
      // A property key (`'subject area': …`) is a key, not text a user reads.
      const parent = node.parent;
      const isKey = parent && (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
      if (!isKey) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push({ line, text: (node as ts.LiteralLikeNode).text ?? node.getText(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function saysSubjectArea(text: string): boolean {
  let words = text;
  for (const title of COMMAND_TITLES) words = words.replace(title, '');
  return /subject\s+areas?/i.test(words);
}

describe('source wording: "diagram", never "subject area"', () => {
  it('finds literal text and skips comments, identifiers, imports and keys', () => {
    const sample = [
      "import { x } from './subject area/x';",
      '// a subject area comment',
      'const subjectArea = 1;',
      "const keyed = { 'subject area': 1 };",
      "const shown = 'Remove from this diagram';",
      'const el = <p>Open a subject area</p>;',
      'const t = `in ${n} subject areas`;',
    ].join('\n');
    const texts = literalTexts('sample.tsx', sample).map((t) => t.text);
    expect(texts.filter(saysSubjectArea)).toEqual(['Open a subject area', ' subject areas']);
    expect(texts).toContain('Remove from this diagram');
  });

  it('lets the two file-format commands keep their real titles', () => {
    expect(saysSubjectArea('run "ERD Studio: Migrate Subject Areas to the Central Table Library" first')).toBe(false);
    expect(saysSubjectArea('No subject areas to compare.')).toBe(true);
  });

  it.each(SCANNED)('%s says "diagram" in every string a user reads', (dir) => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/subject\s+area/i.test(text)) continue;
      for (const literal of literalTexts(file, text)) {
        if (saysSubjectArea(literal.text)) offenders.push(`${path.relative(ROOT, file)}:${literal.line}: ${literal.text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
