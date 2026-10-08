#!/usr/bin/env node
/**
 * Release helpers for the npm packages, used by .github/workflows/publish-packages.yml.
 *
 * The Confluence app (private repo liam-machine/erd-studio-pro) consumes @erd-studio/core
 * and @erd-studio/renderer from npm, so every change to them that lands on main is
 * published automatically, the same way every extension change reaches the Marketplace.
 *
 *   node scripts/release-packages.mjs plan [--out <file>]
 *     Decides, for each package in dependency order, whether to publish and at which
 *     version, and prints the plan as JSON (also written to --out):
 *       - not on npm yet                      -> its package.json version
 *       - package.json version ahead of npm   -> that version (a pin: how a PR declares a
 *                                                minor release, and how a rerun retries one
 *                                                that failed after the bump was pushed)
 *       - shipped files changed since the tag
 *         `<name>@<latest on npm>`, or a
 *         package it pins is being published -> max(package.json, npm) + patch
 *       - otherwise                           -> skipped
 *     Tests and vitest.config.ts are not shipped, so a test-only change publishes nothing.
 *     A missing tag counts as "changed" (with a warning): one extra patch release is
 *     harmless, a change that never reaches npm is not.
 *
 *   node scripts/release-packages.mjs apply --plan <file>
 *     Writes the planned versions into packages/{core,renderer}/package.json, re-pins every
 *     internal dependency exactly (the renderer pins core) and updates the root
 *     package.json's dependencies, which the extension build resolves to the workspaces.
 *     The workflow then refreshes package-lock.json with `npm install --package-lock-only`.
 *
 * Pure functions are exported for unit tests (test/unit/releasePackages.test.ts).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion } from './release.mjs';

/** The published workspaces, in dependency order (a package only depends on earlier ones). */
export const PACKAGES = [
  { name: '@erd-studio/core', dir: 'packages/core' },
  { name: '@erd-studio/renderer', dir: 'packages/renderer' },
];

/** Paths inside a package directory that are never part of what npm ships. */
export const UNSHIPPED_PATHS = ['test', 'vitest.config.ts'];

/**
 * Highest stable x.y.z version in `npm view <pkg> versions --json` output, which is an
 * array, or a bare string when only one version exists. Null when there is none.
 */
export function latestPublishedVersion(versionsJson) {
  const list = Array.isArray(versionsJson) ? versionsJson : versionsJson == null ? [] : [versionsJson];
  let best = null;
  for (const version of list) {
    if (!parseVersion(version)) {
      continue;
    }
    if (best === null || compareVersions(version, best) > 0) {
      best = String(version).trim();
    }
  }
  return best;
}

function patchAbove(local, published) {
  const base = published && compareVersions(published, local) > 0 ? published : local;
  const [major, minor, patch] = parseVersion(base);
  return `${major}.${minor}.${patch + 1}`;
}

/** The names of the other planned packages that `manifest` depends on. */
function internalDependencies(manifest, names) {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
  return Object.keys(deps).filter((dep) => names.has(dep));
}

/**
 * Decide what to publish.
 *
 * `inputs` is in dependency order; each entry is `{ name, dir, manifest, published, changed }`
 * where `published` is the latest version on npm (null when the package is not there) and
 * `changed` says whether its shipped files differ from that release.
 *
 * Returns `[{ name, dir, local, published, next, reason }]`; `next` is null for a package
 * that is skipped.
 */
export function planPackages(inputs) {
  const names = new Set(inputs.map((input) => input.name));
  const next = new Map();
  const plan = [];
  for (const { name, dir, manifest, published, changed } of inputs) {
    const local = manifest.version;
    if (!parseVersion(local)) {
      throw new Error(`${name}: package.json version "${local}" is not x.y.z`);
    }
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
    const repinned = internalDependencies(manifest, names).filter(
      (dep) => next.has(dep) && deps[dep] !== next.get(dep),
    );

    let version = null;
    let reason;
    if (published === null) {
      version = local;
      reason = 'not on npm yet';
    } else if (compareVersions(local, published) > 0) {
      version = local;
      reason = `package.json is ahead of npm (${published})`;
    } else if (changed) {
      version = patchAbove(local, published);
      reason = `changed since ${published}`;
    } else if (repinned.length > 0) {
      version = patchAbove(local, published);
      reason = `re-pins ${repinned.map((dep) => `${dep}@${next.get(dep)}`).join(', ')}`;
    } else {
      reason = `unchanged since ${published}`;
    }

    if (version !== null) {
      next.set(name, version);
    }
    plan.push({ name, dir, local, published, next: version, reason });
  }
  return plan;
}

/**
 * A copy of `manifest` with the plan applied: its own version (when it is a planned
 * package being published) and every internal dependency pinned exactly to the version
 * being published. `dependencies`, `peerDependencies` and `devDependencies` are covered.
 */
export function applyPlanToManifest(manifest, plan) {
  const versions = new Map(plan.filter((entry) => entry.next).map((entry) => [entry.name, entry.next]));
  const updated = { ...manifest };
  if (versions.has(manifest.name)) {
    updated.version = versions.get(manifest.name);
  }
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    if (!manifest[field]) {
      continue;
    }
    const deps = { ...manifest[field] };
    for (const dep of Object.keys(deps)) {
      if (versions.has(dep)) {
        deps[dep] = versions.get(dep);
      }
    }
    updated[field] = deps;
  }
  return updated;
}

/** Arguments for `git diff` over a package's shipped files. */
export function shippedPathspec(dir) {
  return ['--', dir, ...UNSHIPPED_PATHS.map((p) => `:(exclude)${dir}/${p}`)];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Latest version on npm, null when the package does not exist. Other failures throw. */
function npmPublishedVersion(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return latestPublishedVersion(JSON.parse(out || 'null'));
  } catch (error) {
    const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
    if (/E404|404 Not Found/.test(text)) {
      return null;
    }
    // A registry outage must stop the release, never read as "not published".
    throw new Error(`npm view ${name} failed:\n${text || error}`);
  }
}

/** Whether the package's shipped files differ between the release tag and HEAD. */
function changedSinceTag(name, dir, published, cwd) {
  const tag = `${name}@${published}`;
  try {
    execFileSync('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], { cwd, stdio: 'ignore' });
  } catch {
    console.error(`warning: no git tag ${tag}; treating ${name} as changed`);
    return true;
  }
  try {
    execFileSync('git', ['diff', '--quiet', tag, 'HEAD', ...shippedPathspec(dir)], { cwd, stdio: 'ignore' });
    return false;
  } catch (error) {
    if (error?.status === 1) {
      return true;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[arg.slice(2)] = next;
        i++;
      } else {
        args[arg.slice(2)] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  const cwd = process.cwd();

  if (command === 'plan') {
    const inputs = PACKAGES.map(({ name, dir }) => {
      const manifest = readJson(path.join(cwd, dir, 'package.json'));
      if (manifest.name !== name) {
        throw new Error(`${dir}/package.json is named "${manifest.name}", expected "${name}"`);
      }
      const published = npmPublishedVersion(name);
      const changed = published === null ? true : changedSinceTag(name, dir, published, cwd);
      return { name, dir, manifest, published, changed };
    });
    const plan = planPackages(inputs);
    for (const entry of plan) {
      const verdict = entry.next ? `publish ${entry.next}` : 'skip';
      console.error(`${entry.name}: ${verdict} (${entry.reason})`);
    }
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    if (typeof args.out === 'string') {
      fs.writeFileSync(args.out, json);
    }
    process.stdout.write(json);
    return 0;
  }

  if (command === 'apply') {
    if (typeof args.plan !== 'string') {
      console.error('apply: --plan is required');
      return 1;
    }
    const plan = readJson(args.plan);
    const files = [path.join(cwd, 'package.json'), ...PACKAGES.map(({ dir }) => path.join(cwd, dir, 'package.json'))];
    for (const file of files) {
      const before = readJson(file);
      const after = applyPlanToManifest(before, plan);
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        writeJson(file, after);
        console.error(`Updated ${path.relative(cwd, file)}`);
      }
    }
    return 0;
  }

  console.error('usage: release-packages.mjs plan [--out <file>] | apply --plan <file>');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
