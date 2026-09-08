import { describe, it, expect } from 'vitest';
import {
  parseVersion,
  compareVersions,
  latestMarketplaceVersion,
  nextPatchVersion,
  updateChangelog,
  extractReleaseNotes,
  // @ts-expect-error — plain ESM helper without type declarations (used by deploy.yml)
} from '../../scripts/release.mjs';

describe('release.mjs — version helpers', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('0.6.46')).toEqual([0, 6, 46]);
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion(' 1.2.3 ')).toEqual([1, 2, 3]);
  });

  it('rejects malformed versions', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3-beta')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('compares versions numerically, not lexically', () => {
    expect(compareVersions('0.6.9', '0.6.10')).toBe(-1);
    expect(compareVersions('0.7.0', '0.6.46')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('picks the highest marketplace version regardless of list order', () => {
    const show = { versions: [{ version: '0.6.40' }, { version: '0.6.46' }, { version: '0.6.9' }] };
    expect(latestMarketplaceVersion(show)).toBe('0.6.46');
  });

  it('returns null when marketplace data is missing or empty', () => {
    expect(latestMarketplaceVersion(null)).toBeNull();
    expect(latestMarketplaceVersion({})).toBeNull();
    expect(latestMarketplaceVersion({ versions: [] })).toBeNull();
    expect(latestMarketplaceVersion({ versions: [{ version: 'garbage' }] })).toBeNull();
  });

  it('bumps from the marketplace when the repo is behind (lost bump commit)', () => {
    // 2026-05-08 incident: package.json was 0.6.39 while 0.6.40 was already published.
    expect(nextPatchVersion('0.6.39', '0.6.40')).toBe('0.6.41');
  });

  it('bumps from package.json when it is ahead of the marketplace', () => {
    expect(nextPatchVersion('0.7.0', '0.6.46')).toBe('0.7.1');
  });

  it('bumps normally when both are in sync', () => {
    expect(nextPatchVersion('0.6.46', '0.6.46')).toBe('0.6.47');
  });

  it('falls back to package.json when the marketplace lookup failed', () => {
    expect(nextPatchVersion('0.6.46', null)).toBe('0.6.47');
    expect(nextPatchVersion('0.6.46', undefined)).toBe('0.6.47');
  });

  it('throws on an invalid local version', () => {
    expect(() => nextPatchVersion('nope', '0.6.46')).toThrow(/Invalid package.json version/);
  });
});

describe('release.mjs — updateChangelog', () => {
  const opts = { version: '0.6.47', date: '2026-09-07', prTitle: 'fix: something', prNumber: '51' };

  it('renames an Unreleased heading to the release heading', () => {
    const input = '# Changelog\n\n## Unreleased\n\n### Fixed\n\n- A fix\n\n## 0.6.27 — 2026-04-21\n\n- Old\n';
    const out = updateChangelog(input, opts);
    expect(out).toContain('## 0.6.47 — 2026-09-07\n\n### Fixed\n\n- A fix');
    expect(out).not.toContain('Unreleased');
    expect(out).toContain('## 0.6.27 — 2026-04-21');
  });

  it('inserts a new section from the PR title when there is no Unreleased heading', () => {
    const input = '# Changelog\n\nAll notable changes.\n\n## 0.6.27 — 2026-04-21\n\n- Old\n';
    const out = updateChangelog(input, opts);
    expect(out).toBe(
      '# Changelog\n\nAll notable changes.\n\n## 0.6.47 — 2026-09-07\n\n- fix: something (#51)\n\n## 0.6.27 — 2026-04-21\n\n- Old\n',
    );
  });

  it('appends when the changelog has no sections yet', () => {
    const out = updateChangelog('# Changelog\n', { ...opts, prNumber: undefined });
    expect(out).toBe('# Changelog\n\n## 0.6.47 — 2026-09-07\n\n- fix: something\n');
  });

  it('uses a generic bullet when no PR title is available', () => {
    const out = updateChangelog('', { version: '0.6.47', date: '2026-09-07' });
    expect(out).toBe('## 0.6.47 — 2026-09-07\n\n- Maintenance release\n');
  });

  it('leaves the changelog untouched when the version already has an entry', () => {
    const input = '# Changelog\n\n## 0.6.47 — 2026-09-07\n\n- Already written\n';
    expect(updateChangelog(input, opts)).toBe(input);
  });

  it('does not treat a longer version as a match (0.6.4 vs 0.6.47)', () => {
    const input = '# Changelog\n\n## 0.6.47 — 2026-09-07\n\n- Newer\n';
    const out = updateChangelog(input, { ...opts, version: '0.6.4' });
    expect(out).toContain('## 0.6.4 — 2026-09-07');
    expect(out).toContain('## 0.6.47 — 2026-09-07');
  });

  it('rejects an invalid version', () => {
    expect(() => updateChangelog('', { ...opts, version: 'latest' })).toThrow(/Invalid release version/);
  });
});

describe('release.mjs — extractReleaseNotes', () => {
  const changelog = [
    '# Changelog',
    '',
    'All notable changes.',
    '',
    '## 0.6.50 — 2026-09-08',
    '',
    '### Fixed',
    '',
    '- Newest thing',
    '',
    '## 0.6.49 — 2026-09-07',
    '',
    '- Older thing',
    '',
  ].join('\n');

  it('returns the body under the matching heading', () => {
    expect(extractReleaseNotes(changelog, '0.6.50')).toBe('### Fixed\n\n- Newest thing');
  });

  it('stops at the next level-2 heading but keeps level-3 subheadings', () => {
    const notes = extractReleaseNotes(changelog, '0.6.50');
    expect(notes).toContain('### Fixed');
    expect(notes).not.toContain('Older thing');
  });

  it('reads a section that is not the first one', () => {
    expect(extractReleaseNotes(changelog, '0.6.49')).toBe('- Older thing');
  });

  it('does not treat a longer version as a match (0.6.4 vs 0.6.49)', () => {
    expect(extractReleaseNotes(changelog, '0.6.4')).toBe('');
  });

  it('returns an empty string for a missing version or empty content', () => {
    expect(extractReleaseNotes(changelog, '9.9.9')).toBe('');
    expect(extractReleaseNotes('', '0.6.50')).toBe('');
  });
});
