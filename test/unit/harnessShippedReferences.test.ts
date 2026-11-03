import { describe, it, expect } from 'vitest';
import { CLAUDE_SETUP_SKILL_FILES, DBT_SCOPE_SETUP_PATHS } from '../../src/services/harnessAssets';
import { SHIPPED_SETUP_REFERENCE_HASHES, isShippedSetupReference, shippedReferenceHash } from '../../src/services/harnessShippedReferences';

describe('shipped setup-reference texts (what an install without dbt may remove)', () => {
  it('covers exactly the dbt-scope paths: the dbt-only references and the dbt names of the renamed ones', () => {
    expect([...DBT_SCOPE_SETUP_PATHS].sort()).toEqual([
      'references/dbt-explained.md',
      'references/dbt-setup.md',
      'references/metadata.md',
      'references/verify-and-fix.md',
      'references/without-dbt.md',
    ]);
    expect(Object.keys(SHIPPED_SETUP_REFERENCE_HASHES).sort()).toEqual([...DBT_SCOPE_SETUP_PATHS].sort());
  });

  it.each(DBT_SCOPE_SETUP_PATHS)('lists the text this build installs in a dbt project for %s (add the printed hash when a reference changes)', (relativePath) => {
    const asset = CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === relativePath)!;
    const hash = shippedReferenceHash(asset.content);
    expect(SHIPPED_SETUP_REFERENCE_HASHES[relativePath], `add '${hash}' to SHIPPED_SETUP_REFERENCE_HASHES['${relativePath}']`).toContain(hash);
    expect(isShippedSetupReference(relativePath, asset.content)).toBe(true);
  });

  it('reads CRLF line ends as LF, and never matches an edited text or another path', () => {
    const asset = CLAUDE_SETUP_SKILL_FILES.find((a) => a.relativePath === 'references/dbt-setup.md')!;
    expect(isShippedSetupReference(asset.relativePath, asset.content.replace(/\n/g, '\r\n'))).toBe(true);
    expect(isShippedSetupReference(asset.relativePath, `${asset.content}\nMy own note.\n`)).toBe(false);
    expect(isShippedSetupReference('references/metadata.md', asset.content)).toBe(false);
    expect(isShippedSetupReference('references/glossary.md', asset.content)).toBe(false);
  });
});
