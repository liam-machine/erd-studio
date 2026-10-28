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

## Publish a New Version

Releases normally happen automatically: `.github/workflows/deploy.yml` runs when a PR is merged to `main` (docs-only, `test/fixtures/**`, `.planning/**`, `.github/**`, `mcp-server/**` and `proxy/**` PRs are skipped via `paths-ignore`, because every release triggers a save-all + window reload for users with a canvas open). A `changes` job then decides two things: whether the PR touched anything that ships (`dorny/paths-filter` with the same list plus `telemetry/**`, kept equal to `paths-ignore` by `test/unit/deployWorkflow.test.ts` — edit both together), and whether the telemetry Worker needs deploying (see `telemetry/README.md`); the `deploy` job runs only after `telemetry-worker` succeeded or was skipped, so a telemetry-only merge deploys the Worker and releases no extension. It type-checks, builds and tests, computes the next version via `scripts/release.mjs next-version` — max(`package.json`, latest marketplace version) + patch by default, or the exact version pinned in the `## Unreleased` heading when that heading names one (`## Unreleased — 1.0.0`) and it is ahead of everything published; falls back to `package.json` if `vsce show` fails, stamps the `## Unreleased` section of `CHANGELOG.md` with that version, **commits and pushes the bump before publishing** (with rebase retries), then runs `vsce package --no-dependencies` + `vsce publish`, and publishes the **same** VSIX to [Open VSX](https://open-vsx.org/extension/liamwynne/erd-studio) (`ovsx publish`, namespace `liamwynne`, secret `OVSX_PAT`). The Open VSX step is `continue-on-error`: the Marketplace is the primary registry and an Open VSX failure must never block the release or the GitHub Release. Claude PR approval is checked but only soft-enforced (a warning). Put user-facing release notes under `## Unreleased` in `CHANGELOG.md` as part of your PR.

Manual publishing (rare) must follow the same order so `main` never falls behind the marketplace:

**IMPORTANT: Always bump `version` in `package.json` before publishing.** The marketplace rejects re-publishing an existing version number — check the latest published version first with `npx @vscode/vsce show liamwynne.erd-studio --json | jq -r '.versions[0].version'`.

1. Bump `version` in `package.json` (`node scripts/release.mjs next-version --marketplace-json <(npx @vscode/vsce show liamwynne.erd-studio --json)` prints the right one) and update `CHANGELOG.md`
2. Commit the version bump and push
3. Package and publish (two-step is more reliable than single-step; `--no-dependencies` because esbuild bundles every runtime dependency into `dist/`):
   ```bash
   source .env && npx @vscode/vsce package --no-dependencies -o erd-studio.vsix && npx @vscode/vsce publish --packagePath erd-studio.vsix --pat "$AZURE_PAT" && npx ovsx publish --packagePath erd-studio.vsix --pat "$OVSX_PAT" && rm erd-studio.vsix
   ```

`npx @vscode/vsce ls --no-dependencies` shows exactly what will ship; CI fails if it lists more than 60 files. `.vscodeignore` excludes everything except `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `media/` icons, `media/onboarding/` (the video and its poster, about 8 MB) and `dist/` (the four bundles incl. `cli.js`, no sourcemaps) and `schemas/*.schema.json`; `media/walkthrough/*.svg` (the walkthrough illustrations) ship because `media/` is not excluded.

PATs are stored in `.env` as `AZURE_PAT` (Marketplace) and `OVSX_PAT` (Open VSX, also a GitHub Actions secret). The Azure PAT **must** be scoped to "All accessible organizations" (not a single org) — the marketplace sits outside any specific Azure DevOps org.
