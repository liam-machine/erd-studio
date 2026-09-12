#!/usr/bin/env node
/**
 * Release helpers used by .github/workflows/deploy.yml.
 *
 *   node scripts/release.mjs next-version [--marketplace-json <file>] [--package-json <file>]
 *                                          [--changelog <file>]
 *     Prints the version to publish: max(package.json, latest marketplace version) + patch.
 *     The marketplace file is the output of `npx @vscode/vsce show <publisher.name> --json`;
 *     when it is missing or unparsable the local version is used as the base, so a
 *     desynced repo (lost bump commit, rewritten history) never fails with
 *     "version already exists" as long as the marketplace lookup succeeded.
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

/**
 * Highest version listed in `vsce show --json` output (`{ versions: [{ version }] }`).
 * Returns null when the payload has no valid versions.
 */
export function latestMarketplaceVersion(showJson) {
  const versions = Array.isArray(showJson?.versions) ? showJson.versions : [];
  let best = null;
  for (const entry of versions) {
    const version = entry?.version;
    if (!parseVersion(version)) {
      continue;
    }
    if (best === null || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
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
 */
export function resolveReleaseVersion(localVersion, marketplaceVersion, pinnedVersion, onNote) {
  const patch = nextPatchVersion(localVersion, marketplaceVersion);
  if (!pinnedVersion) {
    return patch;
  }
  const note = (message) => {
    if (typeof onNote === 'function') {
      onNote(message);
    }
  };
  if (!parseVersion(pinnedVersion)) {
    note(`ignoring malformed changelog pin "${pinnedVersion}"; releasing v${patch}`);
    return patch;
  }
  const floor = highestKnownVersion(localVersion, marketplaceVersion);
  if (compareVersions(pinnedVersion, floor) <= 0) {
    note(`changelog pins v${pinnedVersion}, which is not ahead of v${floor}; releasing v${patch} instead`);
    return patch;
  }
  note(`changelog pins v${pinnedVersion}; releasing that instead of v${patch}`);
  return pinnedVersion;
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
    const marketplace = latestMarketplaceVersion(readJsonIfPresent(args['marketplace-json']));
    if (marketplace === null) {
      console.error('warning: no marketplace version available; bumping from package.json only');
    }
    const changelogPath = args.changelog ?? path.join(cwd, 'CHANGELOG.md');
    const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const pinned = pinnedReleaseVersion(changelog);
    const version = resolveReleaseVersion(pkg.version, marketplace, pinned, (message) =>
      console.error(message),
    );
    process.stdout.write(`${version}\n`);
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

  console.error('Usage: release.mjs <next-version|changelog|notes> [options]');
  return 1;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exit(main());
}
