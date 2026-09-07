#!/usr/bin/env node
/**
 * Release helpers used by .github/workflows/deploy.yml.
 *
 *   node scripts/release.mjs next-version [--marketplace-json <file>] [--package-json <file>]
 *     Prints the version to publish: max(package.json, latest marketplace version) + patch.
 *     The marketplace file is the output of `npx @vscode/vsce show <publisher.name> --json`;
 *     when it is missing or unparsable the local version is used as the base, so a
 *     desynced repo (lost bump commit, rewritten history) never fails with
 *     "version already exists" as long as the marketplace lookup succeeded.
 *
 *   node scripts/release.mjs changelog --version <v> [--date YYYY-MM-DD] [--changelog <file>]
 *                                      [--pr-title <title>] [--pr-number <n>]
 *     Rewrites CHANGELOG.md for the release. A `## Unreleased` heading is renamed to the
 *     version heading; otherwise a new section is inserted from the PR title (which is
 *     also read from the PR_TITLE / PR_NUMBER environment variables).
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
 * Version to publish next: the greater of the local package.json version and the
 * latest marketplace version, patch-bumped.
 */
export function nextPatchVersion(localVersion, marketplaceVersion) {
  const local = parseVersion(localVersion);
  if (!local) {
    throw new Error(`Invalid package.json version: "${localVersion}"`);
  }
  const market = parseVersion(marketplaceVersion);
  const base = market && compareVersions(marketplaceVersion, localVersion) > 0 ? market : local;
  return `${base[0]}.${base[1]}.${base[2] + 1}`;
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
    process.stdout.write(`${nextPatchVersion(pkg.version, marketplace)}\n`);
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

  console.error('Usage: release.mjs <next-version|changelog> [options]');
  return 1;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exit(main());
}
