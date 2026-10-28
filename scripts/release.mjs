#!/usr/bin/env node
/**
 * Release helpers used by .github/workflows/deploy.yml (stable) and
 * .github/workflows/prerelease.yml (opt-in pre-release channel).
 *
 *   node scripts/release.mjs next-version [--marketplace-json <file>] [--package-json <file>]
 *                                          [--changelog <file>]
 *     Prints the version to publish: max(package.json, latest STABLE marketplace version) + patch.
 *     Pre-release versions on the Marketplace are never the base: a published 1.9.0
 *     pre-release must not turn the next stable patch into 1.9.1. A patch that a pre-release
 *     already took is skipped, and a changelog pin that a pre-release already took, or that
 *     sits below one, fails the run (before anything is committed) rather than shipping.
 *     The marketplace file is the output of `npx @vscode/vsce show <publisher.name> --json`;
 *     when it is missing or unparsable the local version is used as the base, so a
 *     desynced repo (lost bump commit, rewritten history) never fails with
 *     "version already exists" as long as the marketplace lookup succeeded. A changelog pin
 *     ahead of package.json fails when the lookup failed: without the Marketplace list it
 *     cannot be checked against the pre-releases, and vsce's --skip-duplicate would quietly
 *     skip a pin that collides with one (its duplicate check ignores the channel).
 *
 *     A patch bump is the default, not the only option: writing an explicit version in the
 *     changelog's Unreleased heading — `## Unreleased — 1.0.0` — releases exactly that
 *     version instead, which is how a minor or major release is declared. The pin lives
 *     next to the notes it describes, in the file the PR already edits. It may only move
 *     the version forward; a pin at or below something already published is ignored in
 *     favour of the patch bump, so it can never resurrect the "version already exists"
 *     failure this function exists to prevent.
 *
 *   node scripts/release.mjs changelog --version <v> [--date YYYY-MM-DD] [--changelog <file>]
 *                                      [--pr-title <title>] [--pr-number <n>]
 *     Rewrites CHANGELOG.md for the release. A `## Unreleased` heading is renamed to the
 *     version heading; otherwise a new section is inserted from the PR title (which is
 *     also read from the PR_TITLE / PR_NUMBER environment variables).
 *
 *   node scripts/release.mjs check-prerelease --version <v> --marketplace-json <file>
 *                                            [--changelog <file>]
 *                                            [--rerun --head <sha> --tag-commit <sha>]
 *     Fails (exit 1) unless <v> is a safe pre-release number: strict x.y.z, above every
 *     version on the Marketplace in either channel, on a newer major.minor than the latest
 *     stable (so stable patch bumps never catch up with it), and below the version pinned in
 *     the changelog's `## Unreleased — X.Y.Z` heading, so the eventual stable release moves
 *     pre-release users onto it. `--rerun` (a re-run of the same workflow run) accepts <v>
 *     already being on the Marketplace as a pre-release only when the `prerelease-v<v>` tag
 *     (`--tag-commit`, created just before the first publish) marks this run's commit
 *     (`--head`), so a re-run can never attach a different build to a published version.
 *     A missing Marketplace lookup fails.
 *
 *   node scripts/release.mjs prerelease-notes --version <v> [--changelog <file>]
 *     Prints the GitHub Release body for a pre-release: an opt-in / how-to-switch / shared-repo
 *     caveat header, then the newest CHANGELOG section.
 *
 *   node scripts/release.mjs notes --version <v> [--changelog <file>]
 *     Prints the CHANGELOG body for that version (everything under the `## <v>` heading,
 *     up to the next `## ` heading) so deploy.yml can hand it to `gh release create`.
 *     Exits 0 with a one-line placeholder when the section is missing or empty, because a
 *     release with thin notes is better than a failed deploy after a successful publish.
 *
 * Pure functions are exported for unit tests (test/unit/release.test.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse "1.2.3" (optionally "v1.2.3") into [major, minor, patch]; null when invalid. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Semver-style numeric comparison of two "x.y.z" strings. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    throw new Error(`Cannot compare versions "${a}" and "${b}"`);
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** The version property vsce writes into a pre-release VSIX and `vsce show` reports back. */
export const PRE_RELEASE_PROPERTY = 'Microsoft.VisualStudio.Code.PreRelease';

/**
 * Whether one `vsce show --json` version entry is a pre-release.
 *
 * The real shape (vsce 3.x / 4.x, verified against liamwynne.erd-studio) is
 * `{ version, properties: [{ key, value }] }`, and a pre-release carries
 * `{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }`; vsce's own `show`
 * treats the key's presence as the marker. Other shapes are accepted defensively (a
 * boolean `preRelease` / `isPreRelease`, `properties` as an object, `id` / `Id` keys).
 * Errs towards "pre-release": counting a stable version as a pre-release only lowers the
 * stable base (and a collision is skipped), while the opposite would ship pre-release
 * numbering to every stable user.
 */
export function isPreReleaseEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  for (const flag of [entry.preRelease, entry.isPreRelease, entry.prerelease]) {
    if (flag === true || String(flag).toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = entry.properties;
  const properties = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([key, value]) => ({ key, value }))
      : [];
  return properties.some((property) => {
    const key = property?.key ?? property?.id ?? property?.Id;
    if (key !== PRE_RELEASE_PROPERTY) {
      return false;
    }
    const value = property?.value ?? property?.Value;
    return String(value ?? 'true').trim().toLowerCase() !== 'false';
  });
}

/** Every valid version in `vsce show --json` output, with its channel. */
export function marketplaceVersions(showJson) {
  const versions = Array.isArray(showJson?.versions) ? showJson.versions : [];
  const result = [];
  for (const entry of versions) {
    const version = typeof entry?.version === 'string' ? entry.version.trim() : entry?.version;
    if (!parseVersion(version)) {
      continue;
    }
    result.push({ version: String(version), preRelease: isPreReleaseEntry(entry) });
  }
  return result;
}

/** Highest of a list of "x.y.z" strings; null for an empty list. */
function highestOf(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
}

/**
 * Highest version listed in `vsce show --json` output (`{ versions: [{ version }] }`).
 * Stable versions only by default — pre-releases must never be the base of a stable
 * release — or every channel with `{ includePreReleases: true }`. Returns null when the
 * payload has no matching valid versions.
 */
export function latestMarketplaceVersion(showJson, { includePreReleases = false } = {}) {
  return highestOf(
    marketplaceVersions(showJson)
      .filter((entry) => includePreReleases || !entry.preRelease)
      .map((entry) => entry.version),
  );
}

/** Every version on the Marketplace in either channel (normalised, no `v`). */
export function publishedVersions(showJson) {
  return marketplaceVersions(showJson).map((entry) => normaliseVersion(entry.version));
}

function normaliseVersion(version) {
  const parsed = parseVersion(version);
  return parsed ? parsed.join('.') : String(version);
}

function bumpPatch(version) {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The highest version already accounted for: the greater of the local package.json
 * version and the latest marketplace version. Nothing may be published at or below it.
 */
export function highestKnownVersion(localVersion, marketplaceVersion) {
  const local = parseVersion(localVersion);
  if (!local) {
    throw new Error(`Invalid package.json version: "${localVersion}"`);
  }
  const market = parseVersion(marketplaceVersion);
  const base = market && compareVersions(marketplaceVersion, localVersion) > 0 ? market : local;
  return `${base[0]}.${base[1]}.${base[2]}`;
}

/**
 * Version to publish next: the greater of the local package.json version and the
 * latest marketplace version, patch-bumped.
 */
export function nextPatchVersion(localVersion, marketplaceVersion) {
  const base = parseVersion(highestKnownVersion(localVersion, marketplaceVersion));
  return `${base[0]}.${base[1]}.${base[2] + 1}`;
}

/**
 * Explicit release version pinned in the changelog's Unreleased heading.
 *
 * `## Unreleased — 1.0.0` pins 1.0.0; a bare `## Unreleased` pins nothing. Returns null
 * when there is no Unreleased heading or it carries no valid version.
 */
export function pinnedReleaseVersion(content) {
  const heading = /^## Unreleased([^\n]*)$/m.exec(String(content ?? ''));
  if (!heading) {
    return null;
  }
  const version = /(\d+\.\d+\.\d+)/.exec(heading[1]);
  return version && parseVersion(version[1]) ? version[1] : null;
}

/**
 * The version to release: the changelog's pin when it moves the version forward,
 * otherwise a patch bump. `onNote` receives a human-readable explanation whenever a pin
 * is present, so the deploy log says which rule decided the number.
 *
 * `marketplaceVersion` is the latest STABLE version (see `latestMarketplaceVersion`).
 * `published` lists every version on the Marketplace in either channel: a patch number a
 * pre-release already took is skipped, and a pin a pre-release already took, or one below a
 * pre-release, throws — the deploy then stops before it commits anything.
 */
export function resolveReleaseVersion(localVersion, marketplaceVersion, pinnedVersion, onNote, published = []) {
  const note = (message) => {
    if (typeof onNote === 'function') {
      onNote(message);
    }
  };
  const taken = new Set([...(published ?? [])].map(normaliseVersion));
  let patch = nextPatchVersion(localVersion, marketplaceVersion);
  while (taken.has(patch)) {
    const next = bumpPatch(patch);
    note(`v${patch} is already on the Marketplace (a pre-release); trying v${next}`);
    patch = next;
  }
  if (!pinnedVersion) {
    return patch;
  }
  if (!parseVersion(pinnedVersion)) {
    note(`ignoring malformed changelog pin "${pinnedVersion}"; releasing v${patch}`);
    return patch;
  }
  const floor = highestKnownVersion(localVersion, marketplaceVersion);
  if (compareVersions(pinnedVersion, floor) <= 0) {
    note(`changelog pins v${pinnedVersion}, which is not ahead of v${floor}; releasing v${patch} instead`);
    return patch;
  }
  if (taken.has(normaliseVersion(pinnedVersion))) {
    throw new Error(
      `changelog pins v${pinnedVersion}, which is already on the Marketplace as a pre-release. ` +
        'Pin a stable version above every pre-release in the `## Unreleased — X.Y.Z` heading.',
    );
  }
  // VS Code installs the highest version a user's channel allows, so a stable release
  // below a pre-release never reaches anyone who opted in (docs/dev/releasing.md:
  // the pin "must be above every pre-release").
  const highestPublished = highestOf([...taken].filter((v) => parseVersion(v)));
  if (highestPublished && compareVersions(pinnedVersion, highestPublished) < 0) {
    throw new Error(
      `changelog pins v${pinnedVersion}, below pre-release v${highestPublished}, so pre-release users ` +
        'would never get it. Pin a stable version above every pre-release in the `## Unreleased — X.Y.Z` heading.',
    );
  }
  note(`changelog pins v${pinnedVersion}; releasing that instead of v${patch}`);
  return pinnedVersion;
}

function normaliseSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
}

/**
 * Check a requested pre-release version before anything is built or published.
 *
 * Returns `{ errors, notes }`; the version is safe when `errors` is empty. Rules:
 * - strict `x.y.z` (no `v`, no suffix — the Marketplace accepts nothing else);
 * - the Marketplace lookup must have worked (a pre-release is never guessed);
 * - not already on the Marketplace in either channel. A `rerun` of the same workflow run
 *   may find it there as a pre-release and carries on, but only when `tagCommit` (the
 *   commit the `prerelease-v<version>` tag marks; the first attempt tags it before it
 *   publishes) equals `headCommit` (the commit this attempt checked out). A branch ref
 *   re-resolves on a re-run, and another run's re-run must not adopt this version;
 * - above the latest stable, on a newer major.minor than it — the stable deploy only
 *   patch-bumps, so a pre-release on the stable x.y line would be caught up with and
 *   leapfrogged by an ordinary stable patch;
 * - above every other pre-release (VS Code installs the highest version, so a lower
 *   pre-release would never reach anyone);
 * - below the changelog's pinned stable version, when there is one, so that release moves
 *   pre-release users onto it. Without a pin this is only a note.
 */
export function checkPrereleaseVersion({ version, showJson, changelog, rerun = false, headCommit, tagCommit }) {
  const errors = [];
  const notes = [];
  const requested = String(version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(requested)) {
    errors.push(`"${requested}" is not a plain x.y.z version (no "v" prefix or suffix).`);
    return { errors, notes };
  }
  if (!showJson || !Array.isArray(showJson.versions)) {
    errors.push('Could not read the Marketplace versions (vsce show failed), so the version cannot be checked.');
    return { errors, notes };
  }

  const entries = marketplaceVersions(showJson);
  const same = entries.filter((entry) => compareVersions(entry.version, requested) === 0);
  if (same.some((entry) => !entry.preRelease)) {
    errors.push(`v${requested} is already on the Marketplace as a STABLE release.`);
  } else if (same.length > 0 && !rerun) {
    errors.push(`v${requested} is already on the Marketplace as a pre-release; use v${bumpPatch(requested)}.`);
  } else if (same.length > 0) {
    const head = normaliseSha(headCommit);
    const tagged = normaliseSha(tagCommit);
    if (!head || head !== tagged) {
      errors.push(
        `v${requested} is already on the Marketplace as a pre-release, and the prerelease-v${requested} tag ` +
          (tagged ? `marks ${tagged.slice(0, 7)}` : 'does not exist') +
          `, not this run's commit${head ? ` ${head.slice(0, 7)}` : ''}. A re-run only finishes a release of the ` +
          `same commit (a branch ref may have moved since); dispatch a new run with v${bumpPatch(requested)}.`,
      );
    } else {
      notes.push(`v${requested} is already on the Marketplace as a pre-release of this commit; re-run, carrying on`);
    }
  }

  const others = entries.filter((entry) => compareVersions(entry.version, requested) !== 0);
  const latestStable = highestOf(others.filter((entry) => !entry.preRelease).map((entry) => entry.version));
  const latestPre = highestOf(others.filter((entry) => entry.preRelease).map((entry) => entry.version));
  if (latestStable) {
    const [stableMajor, stableMinor] = parseVersion(latestStable);
    const [major, minor] = parseVersion(requested);
    if (compareVersions(requested, latestStable) <= 0) {
      errors.push(`v${requested} is not above the latest stable release v${latestStable}.`);
    } else if (major === stableMajor && minor === stableMinor) {
      errors.push(
        `v${requested} is on the stable ${stableMajor}.${stableMinor}.x patch line, which the stable deploy ` +
          `bumps on every merge. Use a newer minor, e.g. v${stableMajor}.${stableMinor + 1}.0 or higher.`,
      );
    }
  }
  if (latestPre && compareVersions(requested, latestPre) < 0) {
    errors.push(
      `v${requested} is below the pre-release v${latestPre} already published; VS Code installs the ` +
        'highest version, so nobody would get it.',
    );
  }

  const pinned = pinnedReleaseVersion(changelog);
  if (pinned && compareVersions(requested, pinned) >= 0) {
    errors.push(
      `v${requested} is not below v${pinned}, the stable version pinned in the ref's CHANGELOG ` +
        '(`## Unreleased — X.Y.Z`); pre-releases must sort below it so its release moves pre-release users onto it.',
    );
  } else if (!pinned) {
    notes.push(
      `The ref's CHANGELOG pins no version in its ## Unreleased heading. When this work ships as stable, ` +
        `pin a version above v${requested} there, or pre-release users will not move onto it.`,
    );
  }
  return { errors, notes };
}

/**
 * The newest section of a changelog: the first `## ` heading's text and its body (up to the
 * next `## `). Null when there is none.
 */
export function newestChangelogSection(content) {
  const text = String(content ?? '');
  const start = /^## (.*)$/m.exec(text);
  if (!start) {
    return null;
  }
  const rest = text.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return { heading: start[1].trim(), body: (next ? rest.slice(0, next.index) : rest).trim() };
}

/** GitHub Release body for a pre-release: the opt-in header, then the newest changelog section. */
export function prereleaseNotes(changelog, version) {
  const header = [
    `> **v${version} is an opt-in pre-release.** Only people who choose the pre-release channel get it; everyone else stays on the stable version.`,
    '>',
    '> **Try it:** in VS Code open the Extensions view, select **ERD Studio** and click **Switch to Pre-Release Version** (VSCodium, Cursor and Windsurf show the same button for Open VSX). **Go back:** click **Switch to Release Version**.',
    '>',
    '> **Shared repos:** files this version writes (for example a project stored as DBML) may not be readable by teammates on the stable version, or by ERD Studio for Confluence, until they update. Keep a shared repo on one channel.',
  ].join('\n');
  const section = newestChangelogSection(changelog);
  const body = section?.body
    ? `## What's in it\n\n_From CHANGELOG.md, \`## ${section.heading}\`._\n\n${section.body}`
    : 'See [CHANGELOG.md](https://github.com/liam-machine/erd-studio/blob/main/CHANGELOG.md) for details.';
  return `${header}\n\n${body}\n`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the changelog content updated for `version`.
 *
 * - If a `## <version>` heading already exists the content is returned unchanged.
 * - If a `## Unreleased` heading exists it is renamed to `## <version> — <date>`.
 * - Otherwise a new section is inserted before the first `## ` heading (or appended),
 *   with a single bullet built from the PR title / number.
 */
export function updateChangelog(content, { version, date, prTitle, prNumber }) {
  if (!parseVersion(version)) {
    throw new Error(`Invalid release version: "${version}"`);
  }
  const heading = `## ${version} — ${date}`;

  if (new RegExp(`^## ${escapeRegExp(version)}(\\s|$)`, 'm').test(content)) {
    return content;
  }

  const unreleased = /^## Unreleased[^\n]*$/m;
  if (unreleased.test(content)) {
    return content.replace(unreleased, heading);
  }

  const title = (prTitle ?? '').trim();
  const number = String(prNumber ?? '').trim();
  const bullet = title ? `- ${title}${number ? ` (#${number})` : ''}` : '- Maintenance release';
  const section = `${heading}\n\n${bullet}\n`;

  const firstHeading = content.search(/^## /m);
  if (firstHeading === -1) {
    const body = content.replace(/\s*$/, '');
    return body ? `${body}\n\n${section}` : section;
  }
  return `${content.slice(0, firstHeading)}${section}\n${content.slice(firstHeading)}`;
}

/**
 * Return the release-notes body for `version` from changelog `content`.
 *
 * Everything under the `## <version>` heading up to the next `## ` heading, trimmed.
 * `### ` subheadings are kept — only a level-2 heading ends the section. Returns `''`
 * when there is no section for that version.
 */
export function extractReleaseNotes(content, version) {
  const heading = new RegExp(`^## ${escapeRegExp(String(version ?? '').trim())}(?:\\s|$).*$`, 'm');
  const start = heading.exec(String(content ?? ''));
  if (!start) {
    return '';
  }
  const rest = content.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Today's date as YYYY-MM-DD (UTC). */
export function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJsonIfPresent(file) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`warning: could not parse ${file}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const command = args._[0];
  const cwd = process.cwd();

  if (command === 'next-version') {
    const packageJsonPath = args['package-json'] ?? path.join(cwd, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const showJson = readJsonIfPresent(args['marketplace-json']);
    const marketplace = latestMarketplaceVersion(showJson);
    if (marketplace === null) {
      console.error('warning: no marketplace version available; bumping from package.json only');
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const pinned = pinnedReleaseVersion(changelog);
    const lookupFailed = !showJson || !Array.isArray(showJson.versions);
    if (lookupFailed && pinned && parseVersion(pinned) && parseVersion(pkg.version) && compareVersions(pinned, pkg.version) > 0) {
      console.error(
        `error: changelog pins v${pinned}, but the Marketplace lookup failed, so it cannot be checked against ` +
          'the pre-releases (a pin a pre-release took would be skipped as a duplicate). Re-run the deploy.',
      );
      return 1;
    }
    let version;
    try {
      version = resolveReleaseVersion(
        pkg.version,
        marketplace,
        pinned,
        (message) => console.error(message),
        publishedVersions(showJson),
      );
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
    process.stdout.write(`${version}\n`);
    return 0;
  }

  if (command === 'check-prerelease') {
    const version = args.version;
    if (typeof version !== 'string') {
      console.error('check-prerelease: --version is required');
      return 1;
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const { errors, notes } = checkPrereleaseVersion({
      version,
      showJson: readJsonIfPresent(args['marketplace-json']),
      changelog,
      rerun: args.rerun === true || args.rerun === 'true',
      headCommit: typeof args.head === 'string' ? args.head : undefined,
      tagCommit: typeof args['tag-commit'] === 'string' ? args['tag-commit'] : undefined,
    });
    const annotate = env.GITHUB_ACTIONS === 'true';
    for (const message of notes) {
      console.error(annotate ? `::notice::${message}` : `note: ${message}`);
    }
    for (const message of errors) {
      console.error(annotate ? `::error::${message}` : `error: ${message}`);
    }
    if (errors.length > 0) {
      return 1;
    }
    console.error(`v${version} is a valid pre-release version`);
    return 0;
  }

  if (command === 'prerelease-notes') {
    const version = args.version;
    if (typeof version !== 'string') {
      console.error('prerelease-notes: --version is required');
      return 1;
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    process.stdout.write(prereleaseNotes(existing, version));
    return 0;
  }

  if (command === 'changelog') {
    const version = args.version;
    if (typeof version !== 'string') {
      console.error('changelog: --version is required');
      return 1;
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '# Changelog\n';
    const updated = updateChangelog(existing, {
      version,
      date: typeof args.date === 'string' ? args.date : isoDate(),
      prTitle: typeof args['pr-title'] === 'string' ? args['pr-title'] : env.PR_TITLE,
      prNumber: typeof args['pr-number'] === 'string' ? args['pr-number'] : env.PR_NUMBER,
    });
    if (updated !== existing) {
      fs.writeFileSync(changelogPath, updated);
      console.error(`Updated ${path.relative(cwd, changelogPath)} for v${version}`);
    } else {
      console.error(`${path.relative(cwd, changelogPath)} already has an entry for v${version}`);
    }
    return 0;
  }

  if (command === 'notes') {
    const version = args.version;
    if (typeof version !== 'string') {
      console.error('notes: --version is required');
      return 1;
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const notes = extractReleaseNotes(existing, version);
    if (!notes) {
      console.error(`warning: no CHANGELOG section found for v${version}`);
      process.stdout.write(`See [CHANGELOG.md](https://github.com/liam-machine/erd-studio/blob/main/CHANGELOG.md) for details.\n`);
      return 0;
    }
    process.stdout.write(`${notes}\n`);
    return 0;
  }

  console.error('Usage: release.mjs <next-version|check-prerelease|prerelease-notes|changelog|notes> [options]');
  return 1;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exit(main());
}
