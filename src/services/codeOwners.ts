/**
 * The project's CODEOWNERS file, read only, so the Table Library can say who
 * reviews a change to a table ("Reviewed by @acme/orders-team").
 *
 * GitHub's rules, as far as a table file needs them: the first file found of
 * `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` at the repository
 * root; one rule per line (`pattern owner…`), `#` comments and blank lines
 * skipped; the **last** matching rule wins, and a rule with no owners leaves
 * the path unowned. Patterns: a leading `/` anchors at the root, as does a
 * `/` inside the pattern; a pattern with no `/` matches at any depth; `*`
 * matches within one folder, `**` across folders; a trailing `/` matches
 * everything in that folder. A pattern whose last part has no wildcard also
 * matches a folder of that name and everything in it (`/docs` owns
 * `docs/a/b.md`), while `docs/*` owns only the files directly in `docs/`.
 *
 * No `vscode`: pure parsing and matching, plus a small cached reader.
 * Owner names are shown in tooltips only, never sent anywhere.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One CODEOWNERS rule. */
export interface CodeOwnersRule {
  readonly pattern: string;
  /** `@user`, `@org/team` or an email; empty for a rule that leaves paths unowned. */
  readonly owners: readonly string[];
  readonly regex: RegExp;
}

/** Where GitHub looks for the file, in its order. */
export const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A glob (no leading `/`, no trailing `/`) as a regex body. */
function globBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` is any number of folders (none too); `**` elsewhere is anything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

/** A CODEOWNERS pattern as a regex over a `/`-separated path from the repository root. Undefined for an empty pattern. */
export function codeOwnersPatternRegex(raw: string): RegExp | undefined {
  let pattern = raw.trim();
  if (pattern === '') return undefined;
  const dirOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (pattern === '') {
    // `/` alone: everything.
    return /^.*$/;
  }
  const last = pattern.slice(pattern.lastIndexOf('/') + 1);
  const descends = dirOnly || !/[*?]/.test(last) || /\*\*$/.test(pattern);
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = dirOnly ? '/.*$' : descends ? '(?:/.*)?$' : '$';
  return new RegExp(prefix + globBody(pattern) + suffix);
}

/** The rules of a CODEOWNERS file's text, in file order. Lines that are not rules are skipped. */
export function parseCodeOwners(text: string): CodeOwnersRule[] {
  const rules: CodeOwnersRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    // An inline comment starts at a `#` after whitespace.
    const withoutComment = trimmed.replace(/\s+#.*$/, '');
    const [pattern, ...owners] = withoutComment.split(/\s+/);
    const regex = codeOwnersPatternRegex(pattern);
    if (!regex) continue;
    rules.push({ pattern, owners, regex });
  }
  return rules;
}

/** The owners of `relPath` (`/`-separated, from the repository root): the last matching rule's, or none. */
export function codeOwnersOf(rules: readonly CodeOwnersRule[], relPath: string): readonly string[] {
  const target = relPath.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].regex.test(target)) return rules[i].owners;
  }
  return [];
}

/**
 * Reads the CODEOWNERS file of the first of `roots` that has one, checked
 * against its mtime and size, so a tooltip never re-reads an unchanged file.
 * Never writes.
 */
export class CodeOwnersReader {
  private cached: { file: string; signature: string; root: string; rules: CodeOwnersRule[] } | undefined;
  /** The last look on disk, reused for a moment: a tree render asks once per row. */
  private lastLook: { at: number; found: { root: string; rules: CodeOwnersRule[] } | undefined } | undefined;

  /** `roots`: the folders to look in, most likely first (the workspace folder, then the project). */
  constructor(
    private readonly roots: () => readonly string[],
    /** How long one look on disk is reused, in ms. */
    private readonly reuseMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The owners of the file at `filePath` (absolute), or none when no CODEOWNERS covers it. */
  ownersOf(filePath: string): readonly string[] {
    const found = this.load();
    if (!found) return [];
    const rel = path.relative(found.root, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
    return codeOwnersOf(found.rules, rel.split(path.sep).join('/'));
  }

  private load(): { root: string; rules: CodeOwnersRule[] } | undefined {
    const at = this.now();
    if (this.lastLook && at - this.lastLook.at < this.reuseMs) return this.lastLook.found;
    const found = this.look();
    this.lastLook = { at, found };
    return found;
  }

  private look(): { root: string; rules: CodeOwnersRule[] } | undefined {
    for (const root of this.roots()) {
      for (const location of CODEOWNERS_LOCATIONS) {
        const file = path.join(root, ...location.split('/'));
        let signature: string;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          signature = `${stat.mtimeMs}:${stat.size}`;
        } catch {
          continue;
        }
        if (this.cached && this.cached.file === file && this.cached.signature === signature) return this.cached;
        try {
          const rules = parseCodeOwners(fs.readFileSync(file, 'utf-8'));
          this.cached = { file, signature, root, rules };
          return this.cached;
        } catch {
          continue;
        }
      }
    }
    this.cached = undefined;
    return undefined;
  }
}
