# Ripple map: what else moves when ERD Studio changes

The Impact Scout's checklist (see `council.md`). Each row reads "if the fix touches **this**,
then **that** must move too". The tag says who notices if it's forgotten:

- **[CI]**: a test or CI job fails. Still list it, so it's planned rather than discovered.
- **[convention]**: nothing fails. Only a reader of `CLAUDE.md` remembers. **These are the
  scout's real job.** A PR that misses one ships green and wrong.

`CLAUDE.md` is the source of truth. If a row here disagrees with it, `CLAUDE.md` wins and
this file is out of date: say so in the report.

## Always (every PR)

| Ripple | Tag |
|---|---|
| A user-facing note under `## Unreleased` in `CHANGELOG.md` (`### Added` / `### Changed` / `### Fixed` / `### Removed`). Never pin a version in the heading unless Liam asked. | [convention] |
| The base branch is `develop`, and the branch is cut from `origin/develop`. | [convention] |
| `CLAUDE.md` itself, when the fix changes a rule, a file it names, or a mechanism it describes. Stale guidance is a bug for the next session. | [convention] |

## The on-disk format and the AI harness

| If the fix touches… | …then also | Tag |
|---|---|---|
| The DBML storage format (2.0's default): a table, relationships or diagram `.dbml` file, a `.dbdiagram` layout, the DBML codec (`packages/core/src/dbml/`, `dbmlRichProperties.ts`, `src/providers/subjectAreaCodec.ts`) or where Refs live (`src/services/dbmlLibraryWrites.ts`) | Everything in the row below, plus the DBML twins under `packages/core/test/fixtures/dbml/`, `test/fixtures/dbml-native/`, the storage rows of `docs/dev/dbml.md`, and `npm run test:e2e:dbml` | [convention] |
| A relationships file (`tables/[<folder>/]_relationships.dbml`): its Refs, `use` lines or which file a Ref belongs in | `planDbmlLibraryWrites` stays the only placer (`planRelationshipWrite` still decides the relationships); `doctor`'s `erd.dbmlProblems` checks in `src/cli/dbmlProblems.ts` and their table in `docs/dev/onboarding-and-cli.md`; Convert's planner (`src/services/dbmlConversion.ts`) when the change affects what it writes | [convention] |
| Domain JSON, model yml or `layers.json` shape (`packages/core/src/types/semantic.ts`, a field, a naming rule, a relationship storage rule) | `SCHEMA_CONTENT` in `src/services/harnessService.ts` (its `SKILL_PART`, `DBML_PART` and `LEGACY_PART`) | [convention] |
| | **Bump `HARNESS_VERSION`** (the same file). Every installed harness then shows "outdated", which is the point. | [convention] |
| | `docs/semantic-domain-json-reference.md`, plus a "still read" note for any shape the writer stops producing | [convention] |
| | A fixture of the **old** shape under `packages/core/test/fixtures/` and its golden. Old files must always render (Confluence can't migrate). | [convention] |
| | The format-specific generators (`generateClaudeSkill`, `generateCopilotInstructions`, `generateGeminiStyleguide`, `generateCodexAgents`) | [convention] |
| A `HARNESS_VERSION` bump | Regenerate the harness copies checked in under `test/fixtures/**/.claude/skills/` and `.agents/skills/` in the same PR, so the fixture markers match | [convention] |
| The setup skill markdown (`src/harness/claude/erd-studio-setup/**`) | A new `references/*.md` must be listed in `src/services/harnessAssets.ts`. SKILL.md must stay under 500 lines. Both skill-folder variants come from the same source. | [CI] |
| | Bump `HARNESS_VERSION`: the installed setup skill is version-marked. | [convention] |
| The `erd-studio` CLI's output or flags | The setup skill text that reads that output (`SKILL.md`, `references/*.md`), and the CLI section of `CLAUDE.md` | [convention] |
| A new on-disk shape the reader must accept | `detectSubjectAreaFormat()` (JSON), `detectProjectStorage()` (storage) and `classifySemanticFile()` (paths) each stay the **only** detector. Never add a second one. | [convention] |

## Packages: a shipped product (the Confluence app)

| If the fix touches… | …then also | Tag |
|---|---|---|
| Anything under `packages/` | It's released to npm on merge to `main`. Treat each export, `ErdCanvas` props and the `DisplaySubjectArea` shape as a contract. | [convention] |
| | **The Confluence follow-up issue** in liam-machine/erd-studio-pro, so the app moves its exact pins (`cross-repo.md` A). The same applies to an on-disk format change. | [convention] |
| A new `Display*` field | It must be **optional**, and the renderer must draw correctly when it's absent (an older cached core built it) | [convention] |
| A removed or changed meaning of a `Display*` field | A breaking MINOR pinned in `packages/*/package.json`, and a Confluence cache-key note in the PR | [convention] |
| What the host posts as a `DisplaySubjectArea` | Goldens: `UPDATE_GOLDEN=1` **only** for an intended change, and say so in the PR | [CI] |
| Export output (Mermaid or DBML) | The goldens, a CHANGELOG line, and portability: every parser in `readDbmlEverywhere`, and Mermaid 10.0.0 | [CI] |
| Renderer CSS or TSX reading a new `--vscode-*` variable | The variable list in `packages/renderer/README.md` (a page embedding `ErdCanvas` must define it), **and** `dev-preview.html` in `CLAUDE.md` | [convention] |
| A renderer component's affordances | Viewer mode: gate with `useIsViewer()` as `viewer ? … : <upstream expression>`. Update `ErdCanvas.viewer.test.tsx`. | [CI] |
| Core importing Node built-ins, `vscode`, React or React Flow | Not allowed (`packagesBoundary.test.ts`) | [CI] |

## Extension surface

| If the fix touches… | …then also | Tag |
|---|---|---|
| A new command | `package.json` contributes, **and** the `NO_LEGACY_ALIAS` set in `src/extension.ts` | [CI] |
| | The `CLAUDE.md` mention, the walkthrough or Getting Started copy if user-facing, and the README feature list | [convention] |
| A new setting | Read it through `getErdStudioSetting()`. If it can point a request at a host or key, use `"scope": "machine"` **and** `USER_SCOPED_SETTINGS`. Add it to the Settings table in `CLAUDE.md`. | [convention] |
| A new webview ↔ host message | Both unions in `src/types/messages.ts`, a payload validator in `payloadValidation.ts`, a live sender **and** a handler, and an `EDIT_FEATURES` entry if it's an edit | [convention] |
| | Is it safe on the physical stage? Only non-mutating messages join the allowlist in `SemanticEditorProvider`, and the list in `CLAUDE.md`. | [convention] |
| A canvas edit | It goes through `applySubjectAreaEdit` / `applyTableEdit` (one `WorkspaceEdit`, one undo step). Record `ownWrites` for watched files. | [convention] |
| A relationship write | `planRelationshipWrite`, and the exhaustive checker (`test/unit/relationshipStateSpace.*`). New invariants go in `relationshipHealth.ts`. | [CI] |
| A service the CLI or MCP server bundles | No `import 'vscode'` (`cli.noVscode.test.ts`, and the mcp-server CI job) | [CI] |
| Comparison or diff logic | Only in `computeSubjectAreaDiff` / `buildSyncPlan`. The canvas and `erd-studio diff` must share one path. | [convention] |
| A new Welcome panel message | Its own union in `src/types/gettingStarted.ts`, `isGettingStartedToHost()`, and a sender plus a handler | [CI] |

## Telemetry and feedback

| If the fix touches… | …then also | Tag |
|---|---|---|
| A new telemetry feature or error key | `FEATURES` / `ERROR_CODES` in `telemetryPayload.ts` **and** the Worker's lists in `telemetry/src/index.js`, in the same order, plus `telemetry.json` | [CI] |
| A new heartbeat field | Optional, additive, with `HEARTBEAT_VERSION` unchanged. A D1 migration if stored. The Worker deploys first (`deploy.yml` handles the order). | [convention] |
| Text that can reach a filed issue or the model | It goes through `redactPaths()`. Never add a domain name or layer to `FeedbackSubjectAreaSummary`. | [CI] |
| Feedback dialog kinds, copy or tiers | `FEEDBACK_COPY` in `src/types/feedback.ts`. Never re-declare copy in the webview. | [convention] |

## Packaging and release

| If the fix touches… | …then also | Tag |
|---|---|---|
| New files that would ship | `.vscodeignore`: CI fails above 60 VSIX files | [CI] |
| A new top-level folder that never ships | Both `paths-ignore` **and** the `dorny/paths-filter` list in `deploy.yml` (`deployWorkflow.test.ts` holds them equal) | [CI] |
| `engines.vscode`, or a VS Code API newer than 1.85 | Not allowed. Feature-detect at runtime, like `getLanguageModelApi()`. | [convention] |
| Something that looks like a breaking change (dropping a `schemaVersion`, removing a command or setting, a layout change) | Ship it as a patch, but **name it in the PR** so Liam can decide on a minor | [convention] |

## Docs and onboarding

| If the fix touches… | …then also | Tag |
|---|---|---|
| Behaviour the README, walkthrough (`media/walkthrough/`) or Getting Started panel describes | That copy. A screenshot or video that now shows the old UI goes in the report; regenerating it isn't in scope. | [convention] |
| The getting-started video's subject | Note it. The video is regenerated by hand (`video/README.md`), never in this PR. | [convention] |
