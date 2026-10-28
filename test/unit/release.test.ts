import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  parseVersion,
  compareVersions,
  latestMarketplaceVersion,
  nextPatchVersion,
  highestKnownVersion,
  pinnedReleaseVersion,
  resolveReleaseVersion,
  updateChangelog,
  extractReleaseNotes,
  isPreReleaseEntry,
  marketplaceVersions,
  publishedVersions,
  checkPrereleaseVersion,
  newestChangelogSection,
  prereleaseNotes,
  main,
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

describe('release.mjs — changelog-pinned releases', () => {
  const pinned = (heading: string) => pinnedReleaseVersion(`# Changelog\n\n${heading}\n\n### Added\n`);

  it('reads an explicit version from the Unreleased heading', () => {
    expect(pinned('## Unreleased — 1.0.0')).toBe('1.0.0');
    expect(pinned('## Unreleased - 2.3.4')).toBe('2.3.4');
    expect(pinned('## Unreleased (1.1.0)')).toBe('1.1.0');
  });

  it('pins nothing for a bare or absent Unreleased heading', () => {
    expect(pinned('## Unreleased')).toBeNull();
    expect(pinned('## Unreleased — first stable release')).toBeNull();
    expect(pinnedReleaseVersion('# Changelog\n\n## 0.6.53 — 2026-09-12\n')).toBeNull();
    expect(pinnedReleaseVersion('')).toBeNull();
    expect(pinnedReleaseVersion(null)).toBeNull();
  });

  it('reports the highest version already accounted for', () => {
    expect(highestKnownVersion('0.6.53', '0.6.53')).toBe('0.6.53');
    expect(highestKnownVersion('0.6.40', '0.6.53')).toBe('0.6.53');
    expect(highestKnownVersion('0.7.0', '0.6.53')).toBe('0.7.0');
    expect(highestKnownVersion('0.6.53', null)).toBe('0.6.53');
  });

  it('releases the pinned version when it moves forward', () => {
    expect(resolveReleaseVersion('0.6.53', '0.6.53', '1.0.0')).toBe('1.0.0');
    expect(resolveReleaseVersion('0.6.53', '0.6.53', '0.7.0')).toBe('0.7.0');
  });

  it('patch-bumps when there is no pin', () => {
    expect(resolveReleaseVersion('0.6.53', '0.6.53', null)).toBe('0.6.54');
    expect(resolveReleaseVersion('0.6.53', '0.6.53', undefined)).toBe('0.6.54');
  });

  it('ignores a pin that would republish an existing version', () => {
    expect(resolveReleaseVersion('0.6.53', '0.6.53', '0.6.53')).toBe('0.6.54');
    expect(resolveReleaseVersion('0.6.53', '0.6.53', '0.6.40')).toBe('0.6.54');
    expect(resolveReleaseVersion('0.6.40', '0.6.53', '0.6.45')).toBe('0.6.54');
  });

  it('ignores a malformed pin rather than failing the release', () => {
    expect(resolveReleaseVersion('0.6.53', '0.6.53', '1.0')).toBe('0.6.54');
    expect(resolveReleaseVersion('0.6.53', '0.6.53', 'stable')).toBe('0.6.54');
  });

  it('explains which rule chose the version', () => {
    const notes: string[] = [];
    resolveReleaseVersion('0.6.53', '0.6.53', '1.0.0', (m: string) => notes.push(m));
    expect(notes).toEqual(['changelog pins v1.0.0; releasing that instead of v0.6.54']);

    const rejected: string[] = [];
    resolveReleaseVersion('0.6.53', '0.6.53', '0.6.53', (m: string) => rejected.push(m));
    expect(rejected[0]).toMatch(/not ahead of v0\.6\.53; releasing v0\.6\.54/);
  });

  it('renames a pinned Unreleased heading like any other', () => {
    const content = '# Changelog\n\n## Unreleased — 1.0.0\n\n### Added\n\n- Thing\n';
    expect(updateChangelog(content, { version: '1.0.0', date: '2026-09-12' })).toContain(
      '## 1.0.0 — 2026-09-12',
    );
    expect(updateChangelog(content, { version: '1.0.0', date: '2026-09-12' })).not.toContain(
      'Unreleased',
    );
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

// The shape `npx @vscode/vsce show liamwynne.erd-studio --json` really returns: each version
// lists `properties` as `{ key, value }`, and a pre-release VSIX adds
// `Microsoft.VisualStudio.Code.PreRelease = "true"` (vsce package --pre-release).
const PRE = { key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' };
const ENGINE = { key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.85.0' };
const stable = (version: string) => ({ version, flags: 1, properties: [ENGINE] });
const pre = (version: string) => ({ version, flags: 1, properties: [ENGINE, PRE] });
const show = (...versions: object[]) => ({ versions, versionsTruncated: false });

describe('release.mjs — Marketplace channels', () => {
  it('recognises the pre-release property vsce writes', () => {
    expect(isPreReleaseEntry(pre('1.9.0'))).toBe(true);
    expect(isPreReleaseEntry(stable('1.7.2'))).toBe(false);
    expect(isPreReleaseEntry({ version: '1.7.2' })).toBe(false);
    expect(isPreReleaseEntry(null)).toBe(false);
  });

  it('accepts other plausible shapes defensively', () => {
    expect(isPreReleaseEntry({ version: '1.9.0', preRelease: true })).toBe(true);
    expect(isPreReleaseEntry({ version: '1.9.0', isPreRelease: 'true' })).toBe(true);
    expect(isPreReleaseEntry({ version: '1.9.0', properties: { 'Microsoft.VisualStudio.Code.PreRelease': 'true' } })).toBe(true);
    expect(isPreReleaseEntry({ version: '1.9.0', properties: [{ Id: 'Microsoft.VisualStudio.Code.PreRelease', Value: 'true' }] })).toBe(true);
    // The key with no value still marks a pre-release (vsce show checks presence only).
    expect(isPreReleaseEntry({ version: '1.9.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease' }] })).toBe(true);
    expect(isPreReleaseEntry({ version: '1.9.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'false' }] })).toBe(false);
  });

  it('lists every valid version with its channel', () => {
    expect(marketplaceVersions(show(pre('1.9.0'), stable('1.7.2'), { version: 'junk' }))).toEqual([
      { version: '1.9.0', preRelease: true },
      { version: '1.7.2', preRelease: false },
    ]);
    expect(publishedVersions(show(pre('1.9.0'), stable('1.7.2')))).toEqual(['1.9.0', '1.7.2']);
    expect(publishedVersions(null)).toEqual([]);
  });

  it('the latest marketplace version ignores pre-releases unless asked', () => {
    const data = show(pre('1.9.1'), pre('1.9.0'), stable('1.7.2'), stable('1.7.1'));
    expect(latestMarketplaceVersion(data)).toBe('1.7.2');
    expect(latestMarketplaceVersion(data, { includePreReleases: true })).toBe('1.9.1');
    expect(latestMarketplaceVersion(show(pre('1.9.0')))).toBeNull();
  });
});

describe('release.mjs — the stable release ignores pre-releases', () => {
  const published = ['1.9.1', '1.9.0', '1.7.2'];

  it('patch-bumps from the latest stable, not from a pre-release', () => {
    // The bug this guards: max(package.json, 1.9.0) + patch = 1.9.1 would ship 2.0 numbering to everyone.
    expect(resolveReleaseVersion('1.7.2', '1.7.2', null, undefined, published)).toBe('1.7.3');
  });

  it('skips a patch number a pre-release already took', () => {
    const notes: string[] = [];
    expect(resolveReleaseVersion('1.7.2', '1.7.2', null, (m: string) => notes.push(m), ['1.7.3', '1.7.4'])).toBe('1.7.5');
    expect(notes[0]).toMatch(/v1\.7\.3 is already on the Marketplace/);
  });

  it('releases a pin above every pre-release (promotion to stable)', () => {
    expect(resolveReleaseVersion('1.7.2', '1.7.2', '2.0.0', undefined, published)).toBe('2.0.0');
  });

  it('refuses a pin a pre-release already took instead of shipping a patch', () => {
    expect(() => resolveReleaseVersion('1.7.2', '1.7.2', '1.9.0', undefined, published)).toThrow(/already on the Marketplace as a pre-release/);
  });

  it('warns when a pin sits below a pre-release', () => {
    const notes: string[] = [];
    expect(resolveReleaseVersion('1.7.2', '1.7.2', '1.8.0', (m: string) => notes.push(m), published)).toBe('1.8.0');
    expect(notes.some((m) => /below pre-release v1\.9\.1/.test(m))).toBe(true);
  });

  it('next-version reads only stable Marketplace versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-'));
    writeFileSync(join(dir, 'show.json'), JSON.stringify(show(pre('1.9.0'), stable('1.7.2'))));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.7.2' }));
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = ['next-version', '--marketplace-json', join(dir, 'show.json'), '--package-json', join(dir, 'package.json'), '--changelog', join(dir, 'CHANGELOG.md')];
      expect(main(args, {})).toBe(0);
      expect(out).toHaveBeenCalledWith('1.7.3\n');

      writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased — 1.9.0\n');
      out.mockClear();
      expect(main(args, {})).toBe(1);
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe('release.mjs — checkPrereleaseVersion', () => {
  const market = show(stable('1.7.2'), stable('1.7.1'));
  const pinned = '# Changelog\n\n## Unreleased — 2.0.0\n\n### Added\n- DBML\n';
  const check = (version: string, extra: Record<string, unknown> = {}) =>
    checkPrereleaseVersion({ version, showJson: market, changelog: pinned, ...extra });

  it('accepts the recommended scheme: 1.9.0, 1.9.1 … below a pinned 2.0.0', () => {
    expect(check('1.9.0').errors).toEqual([]);
    expect(check('1.8.0').errors).toEqual([]);
    expect(check('1.9.1', { showJson: show(pre('1.9.0'), stable('1.7.2')) }).errors).toEqual([]);
  });

  it('requires a plain x.y.z', () => {
    for (const bad of ['v1.9.0', '1.9', '1.9.0-beta.1', '', 'latest']) {
      expect(check(bad).errors[0]).toMatch(/not a plain x\.y\.z/);
    }
  });

  it('fails when the Marketplace could not be read', () => {
    expect(check('1.9.0', { showJson: null }).errors[0]).toMatch(/Could not read the Marketplace/);
    expect(check('1.9.0', { showJson: {} }).errors[0]).toMatch(/Could not read the Marketplace/);
  });

  it('must be above the latest stable and off its patch line', () => {
    expect(check('1.7.0').errors.join()).toMatch(/not above the latest stable release v1\.7\.2/);
    expect(check('1.7.9').errors.join()).toMatch(/stable 1\.7\.x patch line/);
  });

  it('must not already be on the Marketplace, in either channel', () => {
    expect(check('1.7.2').errors.join()).toMatch(/already on the Marketplace as a STABLE release/);
    const withPre = show(pre('1.9.0'), stable('1.7.2'));
    expect(check('1.9.0', { showJson: withPre }).errors.join()).toMatch(/already on the Marketplace as a pre-release; use v1\.9\.1/);
  });

  it('a re-run of the same workflow run may find its own pre-release published', () => {
    const withPre = show(pre('1.9.0'), stable('1.7.2'));
    const result = check('1.9.0', { showJson: withPre, rerun: true });
    expect(result.errors).toEqual([]);
    expect(result.notes.join()).toMatch(/re-run/);
    // …but never a stable one.
    expect(check('1.7.2', { rerun: true }).errors.join()).toMatch(/STABLE/);
  });

  it('must be above every other pre-release', () => {
    const withPre = show(pre('1.9.2'), stable('1.7.2'));
    expect(check('1.9.1', { showJson: withPre }).errors.join()).toMatch(/below the pre-release v1\.9\.2/);
  });

  it('must be below the version the ref pins for its stable release', () => {
    expect(check('2.0.0').errors.join()).toMatch(/not below v2\.0\.0/);
    expect(check('2.1.0').errors.join()).toMatch(/not below v2\.0\.0/);
  });

  it('without a pin it passes with a note', () => {
    const result = check('1.9.0', { changelog: '# Changelog\n\n## Unreleased\n' });
    expect(result.errors).toEqual([]);
    expect(result.notes.join()).toMatch(/pins no version/);
  });

  it('a brand-new listing with no versions only checks the format and the pin', () => {
    expect(check('0.1.0', { showJson: show() }).errors).toEqual([]);
  });

  it('the CLI exits 1 on an invalid version and 0 on a valid one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prerelease-'));
    writeFileSync(join(dir, 'show.json'), JSON.stringify(market));
    writeFileSync(join(dir, 'CHANGELOG.md'), pinned);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run = (v: string, env = {}) =>
        main(['check-prerelease', '--version', v, '--marketplace-json', join(dir, 'show.json'), '--changelog', join(dir, 'CHANGELOG.md')], env);
      expect(run('1.9.0')).toBe(0);
      expect(run('2.0.0', { GITHUB_ACTIONS: 'true' })).toBe(1);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^::error::/));
      expect(main(['check-prerelease', '--version', '1.9.0', '--marketplace-json', join(dir, 'missing.json')], {})).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});

describe('release.mjs — pre-release notes', () => {
  const changelog = '# Changelog\n\nIntro.\n\n## Unreleased — 2.0.0\n\n### Added\n\n- DBML storage\n\n## 1.7.2 — 2026-10-23\n\n- Old\n';

  it('reads the newest section', () => {
    expect(newestChangelogSection(changelog)).toEqual({ heading: 'Unreleased — 2.0.0', body: '### Added\n\n- DBML storage' });
    expect(newestChangelogSection('# Changelog\n')).toBeNull();
  });

  it('puts the opt-in header above the newest section', () => {
    const notes = prereleaseNotes(changelog, '1.9.0');
    expect(notes).toMatch(/v1\.9\.0 is an opt-in pre-release/);
    expect(notes).toMatch(/Switch to Pre-Release Version/);
    expect(notes).toMatch(/Switch to Release Version/);
    expect(notes).toMatch(/teammates on the stable version, or by ERD Studio for Confluence/);
    expect(notes).toContain('- DBML storage');
    expect(notes).not.toContain('- Old');
    expect(notes.indexOf('opt-in')).toBeLessThan(notes.indexOf('DBML storage'));
  });

  it('links the changelog when there is no section', () => {
    expect(prereleaseNotes('', '1.9.0')).toMatch(/See \[CHANGELOG\.md\]/);
  });
});
