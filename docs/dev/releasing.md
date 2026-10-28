# Versioning and releasing

> Moved out of the root `CLAUDE.md` so it loads only when needed. The rules that always apply are in the root `CLAUDE.md`; this is the mechanics.

**Marketplace:** https://marketplace.visualstudio.com/items?itemName=liamwynne.erd-studio

The old `liamwynne.dbt-semantic-designer` extension has been unpublished and removed from the marketplace. Only `liamwynne.erd-studio` exists now.

## Versioning (Semantic Versioning)

Every released artifact follows [SemVer 2.0](https://semver.org), `MAJOR.MINOR.PATCH`, and each has its own version:

| Artifact | Version lives in | Who bumps it | Released by |
|---|---|---|---|
| VS Code extension | root `package.json` `version` | `deploy.yml` on merge (you choose the level in `CHANGELOG.md`) | `deploy.yml` (Marketplace + Open VSX + GitHub Release) |
| `@erd-studio/core` | `packages/core/package.json` | `publish-packages.yml` on merge (patch); you, in the PR, only for a minor/major | `publish-packages.yml` (npm, trusted publishing) |
| `@erd-studio/renderer` | `packages/renderer/package.json` | `publish-packages.yml` on merge (patch, and whenever core is released); you, in the PR, only for a minor/major | `publish-packages.yml` (npm, trusted publishing) |
| Harness files | `HARNESS_VERSION` | you (see "Harness Versioning") | the extension |
| Domain file format | `schemaVersion` / `CURRENT_SCHEMA_VERSION` (the newest read in any format), `CURRENT_JSON_SCHEMA_VERSION` (JSON) | you, with a migration | the extension |
| DBML diagram format | `erd_schema_version` on a diagram's `Project` / `DBML_SCHEMA_VERSION` (`packages/core/src/types/semantic.ts`) | you, with a migration; raise `CURRENT_SCHEMA_VERSION` with it | the extension |

**Extension: every release is a PATCH bump unless Liam explicitly asks for a minor or major one.**
- **PATCH is the default for everything, new features included.** Leave the heading as a bare `## Unreleased` and the workflow bumps the third number. Do **not** pin a version in the heading on your own judgement, however large or user-visible the change is.
- **MINOR / MAJOR only on an explicit request** ("make this 1.6.0", "this is a minor release", "bump the major"). Then pin it in the changelog heading (`## Unreleased — 1.6.0`), and for a major explain the upgrade path in the notes.
- If a change looks like it *could* warrant more than a patch (a breaking change: dropping a domain `schemaVersion` or requiring a migration, removing or renaming commands or settings, raising `engines.vscode`, changing the on-disk file layout), say so in your reply and let Liam decide. Still ship it as a patch unless he says otherwise.
- Never edit the root `version` by hand in a PR; the workflow owns it. A pin only moves the version forward, and resets to patch bumps after it ships.
- Group user-facing notes under `## Added` / `## Changed` / `## Fixed` / `## Removed` ([Keep a Changelog](https://keepachangelog.com)). A PR with nothing user-visible may leave `## Unreleased` empty; the workflow then records the PR title.

**Packages: pick the level by their public API**, meaning every export of each entry point, `ErdCanvas` props, exported types and the `DisplaySubjectArea` shape.
- **While `0.x`** (now): a breaking change bumps **MINOR** (`0.1.x → 0.2.0`), and everything else bumps PATCH. Go to `1.0.0` once the API is stable and has an outside consumer. After that, use normal SemVer (breaking = MAJOR).
- **Publishing is automatic** (`.github/workflows/publish-packages.yml`, on every push to `main` touching `packages/**`; logic in `scripts/release-packages.mjs`, tested by `test/unit/releasePackages.test.ts`). It runs compile, `build:packages` and the full test suite, then per package, in dependency order:
  - shipped files (everything under the package except `test/` and `vitest.config.ts`) changed since the git tag `<name>@<latest on npm>` → **PATCH** above `max(package.json, npm)`;
  - `package.json` version already ahead of npm → published **as is**. This is the pin: to release a MINOR (a breaking change while `0.x`), set the new version in the PR — in `packages/core/package.json` and/or `packages/renderer/package.json`, plus the renderer's exact `@erd-studio/core` pin and the root `package.json` dependencies — and run `npm install` so the lockfile agrees. Nothing else needs a manual bump;
  - core released → the renderer is **re-pinned** to it and released too, because it pins core exactly;
  - otherwise skipped (a test-only change publishes nothing).

  It then commits `chore: release … [packages]` (both `packages/*/package.json`, the root `package.json` dependencies, `package-lock.json`) and pushes it to `main` **before** `npm publish` (as `deploy.yml` does), publishes with provenance, and tags each release `<name>@<version>`. A rerun, or **Run workflow** on the Actions tab, retries exactly the pushed versions and skips any already on npm. Like the extension's `[deploy]` commits, these bump commits reach `develop` through the usual main → develop sync PR.
- **Auth is npm trusted publishing (OIDC)** — no npm token exists anywhere. Each package lists `liam-machine/erd-studio` + `publish-packages.yml` as its trusted publisher on npmjs.com with **npm publish** allowed; renaming the workflow file breaks publishing until both are re-registered. Needs Node ≥ 22.14 and npm ≥ 11.5.1 in the job (it installs a pinned npm).
- A PR that changes only extension code doesn't touch the packages. A package change also gets an extension release through `deploy.yml`, because the extension bundles the packages from source.
- Never unpublish or overwrite a published version. Fix forward with a new PATCH, and `npm deprecate` a bad release.
- The Confluence app pins exact versions and bumps them deliberately in `erd-studio-pro` (after its pixel-compare harness and backend tests). An npm release here does not change the live app by itself.

## Pre-releases (opt-in)

`.github/workflows/prerelease.yml` publishes a branch to the Marketplace and Open VSX **pre-release channel**: only people who click **Switch to Pre-Release Version** on ERD Studio in the Extensions view get it; everyone else stays on the stable release. Use it to put a big, risky change (the 2.0 native-DBML storage, PR #226) in front of early adopters before it merges. Everyday changes do not need it.

**Version scheme.** Pre-releases are numbered **between the latest stable and the stable version the branch will ship as**: with stable at 1.7.x and the branch's CHANGELOG pinning `## Unreleased — 2.0.0`, use **1.9.0, 1.9.1, …** (Microsoft's convention is an odd minor for pre-releases; any number in the range works). VS Code installs the highest version a user's channel allows, so the stable 2.0.0 must be above every pre-release for pre-release users to move onto it. `scripts/release.mjs check-prerelease` enforces this before anything is built; the version must be:
- a plain `x.y.z`, not already on the Marketplace in either channel (a re-run of the same workflow run may find its own pre-release there and carries on, but only when the `prerelease-v<version>` tag marks the commit the re-run checked out);
- above the latest stable **and on a newer minor** than it (1.7.5 is refused while stable is 1.7.x: the stable deploy's patch bumps would catch up with it);
- above every earlier pre-release;
- below the version pinned in the ref's `## Unreleased — X.Y.Z` heading. Without a pin it passes with a note: pin the stable version (above the pre-release) before the branch merges.

**Run it** (once `prerelease.yml` is on `main`; GitHub only dispatches workflows that exist on the default branch):

```bash
gh workflow run prerelease.yml -f ref=feat/native-dbml-storage -f version=1.9.0
gh run watch "$(gh run list --workflow prerelease.yml -L 1 --json databaseId -q '.[0].databaseId')"
```

It checks out `ref`, validates the version against `vsce show`, checks the telemetry Worker (below), runs `npm ci`, compile, build and tests, sets the version **in the run's checkout only** (`npm version --no-git-tag-version`; nothing is committed or pushed to any branch), then `vsce package --pre-release`, the 60-file check, `vsce publish --pre-release` and `ovsx publish --pre-release` (non-fatal, as in `deploy.yml`), and finally a GitHub Release marked **pre-release, never Latest**, tagged `prerelease-v<version>` (never the stable `v<version>`) on the released commit, with the VSIX attached. The tag is created through the API just before the first publish (a stale one left by a run that never published is moved). Its notes are an opt-in header plus the ref's newest CHANGELOG section (`release.mjs prerelease-notes`). It never publishes the npm packages and never deploys the telemetry Worker. A re-run (**Re-run failed jobs**) retries the same version of the **same commit**: a re-run resolves a branch `ref` again, so when the version is already on the Marketplace it fails unless the `prerelease-v<version>` tag still marks the commit it checked out (if the branch has moved, dispatch a new run with the next version). The publishes use `--skip-duplicate`, and an existing GitHub Release keeps the VSIX it has (a re-run only attaches one that is missing).

**Telemetry.** A new extension's telemetry keys are dropped by an older Worker, which is why `deploy.yml` deploys the Worker first. The pre-release workflow does not deploy it (that would put an unmerged branch's Worker and D1 migrations into production, and moving the `telemetry-worker-deployed` tag off `main` would confuse `deploy.yml`). Instead it fails when the ref changes `telemetry/` (not `*.md`) beyond the deployed Worker (`git diff telemetry-worker-deployed...<ref>`; a ref that is merely behind `main` passes). To fix: land those `telemetry/` changes on `main` on their own (a telemetry-only merge deploys the Worker and releases no extension; the contract is additive, so the stable extension is unaffected), then re-run. Or dispatch with `-f allow_undeployed_telemetry=true` to accept losing the new keys until then.

**What users do.** Opt in: Extensions view → **ERD Studio** → **Switch to Pre-Release Version** (VSCodium, Cursor and Windsurf show the same button for Open VSX). Opt out: **Switch to Release Version**, which reinstalls the latest stable.

**Shared repos.** Files a pre-release writes may not be readable by teammates on the stable version, or by ERD Studio for Confluence (which pins its own `@erd-studio/core`), until they update. 2.0 writes DBML files the stable version and the Confluence app do not read. Say so wherever you announce a pre-release; the GitHub Release notes already do.

**Promoting to stable.** Merge the feature PR as usual. Its `## Unreleased — X.Y.Z` pin must be above every pre-release (2.0.0 after 1.9.x; a pin a pre-release took, or one below a pre-release, fails the deploy before anything is committed, as does a pin when the Marketplace lookup fails); `deploy.yml` then releases exactly that version to everyone, and pre-release users move onto it because it is the highest. The stable deploy ignores pre-releases when it computes a patch, so 1.9.0 being on the Marketplace never turns the next stable patch into 1.9.1. Unpinned patches (1.7.3, …) sort below the pre-release, so pre-release users get those fixes in the next pre-release, as with any VS Code pre-release channel.

## Publish a New Version

Releases normally happen automatically: `.github/workflows/deploy.yml` runs when a PR is merged to `main` (docs-only, `test/fixtures/**`, `.planning/**`, `.github/**`, release-tooling (`scripts/release.mjs`, `scripts/release-packages.mjs` and their tests), `mcp-server/**` and `proxy/**` PRs are skipped via `paths-ignore`, because every release triggers a save-all + window reload for users with a canvas open). A `changes` job then decides two things: whether the PR touched anything that ships (`dorny/paths-filter` with the same list plus `telemetry/**`, kept equal to `paths-ignore` by `test/unit/deployWorkflow.test.ts` — edit both together), and whether the telemetry Worker needs deploying (see `telemetry/README.md`); the `deploy` job runs only after `telemetry-worker` succeeded or was skipped, so a telemetry-only merge deploys the Worker and releases no extension. It type-checks, builds and tests, computes the next version via `scripts/release.mjs next-version` — max(`package.json`, latest **stable** marketplace version) + patch by default (pre-releases are never the base; a patch number a pre-release already took is skipped, and a pin one took, or one below a pre-release, fails the run before anything is committed), or the exact version pinned in the `## Unreleased` heading when that heading names one (`## Unreleased — 1.0.0`) and it is ahead of everything published; falls back to `package.json` if `vsce show` fails (a pin then fails the run instead, since it cannot be checked against the pre-releases), stamps the `## Unreleased` section of `CHANGELOG.md` with that version, **commits and pushes the bump before publishing** (with rebase retries), then runs `vsce package --no-dependencies` + `vsce publish`, and publishes the **same** VSIX to [Open VSX](https://open-vsx.org/extension/liamwynne/erd-studio) (`ovsx publish`, namespace `liamwynne`, secret `OVSX_PAT`). The Open VSX step is `continue-on-error`: the Marketplace is the primary registry and an Open VSX failure must never block the release or the GitHub Release. Claude PR approval is checked but only soft-enforced (a warning). Put user-facing release notes under `## Unreleased` in `CHANGELOG.md` as part of your PR.

Manual publishing (rare) must follow the same order so `main` never falls behind the marketplace:

**IMPORTANT: Always bump `version` in `package.json` before publishing.** The marketplace rejects re-publishing an existing version number — check the latest published version first with `npx @vscode/vsce show liamwynne.erd-studio --json | jq -r '.versions[0].version'` (that can be a pre-release; `next-version` below skips pre-releases).

1. Bump `version` in `package.json` (`node scripts/release.mjs next-version --marketplace-json <(npx @vscode/vsce show liamwynne.erd-studio --json)` prints the right one) and update `CHANGELOG.md`
2. Commit the version bump and push
3. Package and publish (two-step is more reliable than single-step; `--no-dependencies` because esbuild bundles every runtime dependency into `dist/`):
   ```bash
   source .env && npx @vscode/vsce package --no-dependencies -o erd-studio.vsix && npx @vscode/vsce publish --packagePath erd-studio.vsix --pat "$AZURE_PAT" && npx ovsx publish --packagePath erd-studio.vsix --pat "$OVSX_PAT" && rm erd-studio.vsix
   ```

`npx @vscode/vsce ls --no-dependencies` shows exactly what will ship; CI fails if it lists more than 60 files. `.vscodeignore` excludes everything except `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `media/` icons, `media/onboarding/` (the video and its poster, about 8 MB) and `dist/` (the four bundles incl. `cli.js`, no sourcemaps) and `schemas/*.schema.json`; `media/walkthrough/*.svg` (the walkthrough illustrations) ship because `media/` is not excluded.

PATs are stored in `.env` as `AZURE_PAT` (Marketplace) and `OVSX_PAT` (Open VSX, also a GitHub Actions secret). The Azure PAT **must** be scoped to "All accessible organizations" (not a single org) — the marketplace sits outside any specific Azure DevOps org.
