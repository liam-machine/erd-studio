/**
 * ERD Studio — usage telemetry collector (Cloudflare Worker).
 *
 * The endpoint the extension's daily heartbeat is posted to. Each install sends
 * one small JSON document per UTC day it was used, describing that day in
 * counts and buckets — how many canvases were opened, which features were
 * used, which error codes fired — after the day has ended. During an install's
 * first week, or on a day a new error fired, the extension may also send up to
 * three interim copies of the same day's summary while the day is still going
 * (marked by the `heartbeatProvisional` feature); each one, and then the final,
 * replaces the row through the `(install_id, day)` upsert. This Worker
 * validates each body and upserts that one row into D1, and counts what it
 * received or refused in the `worker_daily` ledger (below). That is the whole
 * job.
 *
 * It is not part of the extension build. Nothing in `esbuild.js`, the
 * tsconfigs or the npm scripts may come to depend on this directory, and
 * `telemetry/**` is listed in `.vscodeignore` so it never ships in the VSIX.
 * Deploy it by hand — see `README.md` in this directory.
 *
 * ## What it will and will not store
 *
 * The body is rebuilt from an allowlist, field by field, before anything is
 * written. A row is the validated body fields plus `received_day` (the UTC
 * date this Worker saw it, which is what retention keys on). Nothing else:
 *
 *   - **No IP address, no user-agent, no `cf` geo object, no header of any
 *     kind.** `request.headers` is read for exactly one thing — the declared
 *     `Content-Length`, as a size pre-check — and `request.cf` is never read.
 *     The tests bind a canary IP, user-agent and country and assert none of
 *     them reaches the SQL parameters.
 *   - **No free text.** Every stored value is an enum, a bucket, a bounded
 *     integer, a date, a version string matched by a strict regex, or the
 *     install id — a random UUID the extension mints once per VS Code profile
 *     (until 1.6.x it was replaced every 30 days).
 *   - **Unknown keys are dropped**, top-level and inside `features` / `errors`,
 *     so a newer extension that sends a field this Worker has never heard of
 *     still lands, minus that field — and an arbitrary client cannot use an
 *     unrecognised key to smuggle anything into storage.
 *
 * Raw rows are deleted 90 days after they were received by the `scheduled()`
 * handler below (a daily Cron Trigger). Only per-day aggregates with no install
 * ids are ever kept longer, and those live on the operator's machine, not here.
 *
 * ## The `worker_daily` ledger
 *
 * One row per UTC day (the day this Worker saw the request), extension version
 * family (`major.minor` from a parsed body's `extVersion`, else `other`),
 * outcome (`ok` / `denied`) and reason (`none`, `body_size`, `json` or
 * `shape_<field>` from a fixed list): how many heartbeats arrived, and how many
 * unknown `features` / `errors` keys and trail events were dropped from them.
 * It answers "is a version missing because nobody runs it, or because this
 * Worker refuses or strips what it sends". No install id, IP, header, body text
 * or unknown key name is ever stored in it; it is written only for
 * `POST /v1/heartbeat` (never for 404 / 405, `/known-fixes`, the kill switch or
 * a failed heartbeat upsert), best effort through `ctx.waitUntil`, so a ledger
 * failure never changes a response, and kept 90 days like the heartbeats.
 *
 * ## The known-fixes registry
 *
 * `GET /known-fixes` (or `HEAD`) returns `known-fixes.json` from this
 * directory, bundled at deploy time — the list of error codes a newer release
 * fixes, which the extension matches on the user's machine to offer an update
 * (format in README.md). It is static: the response is the same for everyone,
 * nothing about the request is read, stored or logged (not even a counted log
 * line, since how often it is asked would say how often errors happen), and it
 * touches no D1. A merged entry goes live with the next Worker deploy, without
 * an extension release.
 *
 * ## The rules it enforces, and why
 *
 *   - **Routes** — `POST /v1/heartbeat` and `GET`/`HEAD /known-fixes`, nothing
 *     else: another path is 404, another method on a known path is 405.
 *   - **Kill switch** — `KILL_SWITCH` truthy makes every request 503 before
 *     anything else, with no D1 access. `wrangler.toml` is its source of truth.
 *   - **Body cap** — a real heartbeat is a few hundred bytes. More than
 *     {@link MAX_BODY_BYTES} is refused (413) while it is still streaming, so
 *     the declared `Content-Length` is a free early exit, never the only check.
 *   - **Strict known fields** — a known field with a wrong type or an
 *     out-of-range value is a 400 and writes nothing. The day must be a real
 *     calendar date, not in the future and at most 7 days old, so a client with
 *     a broken clock cannot write rows retention would keep past 90 days.
 *   - **Fail closed** — a D1 error is a 503. The extension drops a failed send
 *     silently and does not resend that body (a later interim copy or the
 *     final of the same day may still arrive and replace the row), so nothing
 *     downstream cares which non-2xx it gets.
 *
 * No payload is ever logged — {@link log} takes fixed labels and numbers only.
 * CORS is deliberately absent: the caller is the VS Code extension host, not a
 * browser, so no preflight is answered and no origin is blessed.
 */

import KNOWN_FIXES from '../known-fixes.json' with { type: 'json' };

/** The heartbeat path. */
const ROUTE = '/v1/heartbeat';

/** The known-fixes registry path. */
const KNOWN_FIXES_ROUTE = '/known-fixes';

/**
 * How long a client or cache may reuse the registry. Short, so a newly merged
 * entry reaches users within the hour; the extension caches it for a day on
 * its own side anyway.
 */
const KNOWN_FIXES_MAX_AGE_SECONDS = 300;

/** Serialised once per isolate: the registry cannot change without a deploy. */
const KNOWN_FIXES_BODY = JSON.stringify(KNOWN_FIXES);

/**
 * Largest body accepted. A real heartbeat is under a kilobyte; every feature
 * and error key at once, each at its cap, passed 8 KB with the import guide's
 * keys and passes 16 KB with the 2.0.0 launch keys, so the cap is 32 KB (the
 * extension's telemetryPayload test holds that worst case under this limit,
 * and the extension trims its own body below 16 KB, so a Worker still at the
 * old cap never refuses a whole day).
 */
const MAX_BODY_BYTES = 32768;

/** A heartbeat may describe a day at most this many days before it is received. */
const MAX_DAY_AGE_DAYS = 7;

/**
 * How far ahead of ours a client's clock may run. Since 2.0 an interim copy
 * describes the client's own today, posted seconds after its midnight: a
 * clock a few minutes fast would name our tomorrow. Tomorrow is accepted
 * only this close to our midnight.
 */
const MAX_CLOCK_AHEAD_MS = 3_600_000;

/** Raw rows older than this (by `received_day`) are deleted by the cron. */
const RETENTION_DAYS = 90;

/** The telemetry contract version this Worker understands. */
const CONTRACT_VERSION = 1;

/** Random UUID v4 — the only identifier stored, minted once per VS Code profile. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MAJOR_MINOR = /^\d+\.\d+$/;

/**
 * Upper bound on the version-string fields, so a `9999…` of 1,000 digits that
 * still matches the regex cannot become a stored value.
 */
const MAX_VERSION_CHARS = 24;

const OS_VALUES = new Set(['darwin', 'win32', 'linux', 'other']);
const TENURE_VALUES = new Set(['0', '1-7', '8-30', '31-90', '90+']);
const ACTIVATION_VALUES = new Set(['project_found', 'no_project']);
const DOMAIN_COUNT_VALUES = new Set(['0', '1-3', '4-10', '10+']);
const MODEL_COUNT_VALUES = new Set(['none', '1-10', '11-50', '51+']);
const MANIFEST_VALUES = new Set(['ok', 'missing', 'stale', 'unknown']);

// Optional fields (extension 1.6.3+). An older client omits them and the row
// stores NULL; a present field with a bad value is still a 400.
const HOST_VALUES = new Set([
  'vscode', 'vscodeInsiders', 'cursor', 'windsurf', 'vscodium', 'trae', 'kiro', 'positron', 'antigravity', 'other',
]);
const REMOTE_VALUES = new Set(['local', 'ssh', 'wsl', 'container', 'codespaces', 'web', 'other']);
const RECENT_DAYS_VALUES = new Set(['0', '1', '2-3', '4-7', '8-14', '15-28']);
const FIRST_CANVAS_VALUES = new Set(['never', '0', '1-7', '8-30', '31-90', '90+']);
/** Stored in this order, like STAGES. */
const ASSISTANTS = ['claude', 'copilot', 'codex', 'gemini', 'cursor'];
const HARNESSES = ['claude', 'agents', 'copilot', 'gemini', 'codex'];
// Optional too (migrations/0003): how the workspace builds its physical tables,
// and on which platform. Absent means no detection ran that day; [] means it
// ran and found nothing.
const PHYSICAL_TOOLS = [
  'dbt', 'sqlmesh', 'dataform', 'databricksBundle', 'fabric', 'powerBi', 'sqlProject', 'flyway',
  'liquibase', 'alembic', 'prisma', 'django', 'rails', 'notebooks', 'ddlScripts', 'dbml',
];
const PLATFORMS = [
  'databricks', 'snowflake', 'bigquery', 'postgres', 'redshift', 'fabric', 'synapse', 'sqlserver',
  'duckdb', 'spark', 'trino', 'athena', 'mysql', 'oracle', 'clickhouse', 'other',
];

/**
 * The onboarding trail's own events (the extension's `TRAIL_MARKERS`), beside
 * every FEATURES key and ERROR_CODES code. Append-only, in the same order.
 */
const TRAIL_MARKERS = [
  'windowOpened',
  'windowClosed',
  'windowAway',
  'windowBack',
  'canvasOpened',
  'canvasClosed',
  'canvasHidden',
  'canvasShown',
  // 2.0 B15 — the first entry of a trail whose window was activated on an earlier UTC day
  'dayContinued',
];
/** The trail's limits (the extension's MAX_TRAIL, MAX_TRAIL_GAP_S, MAX_TRAIL_WINDOWS, MAX_COUNTER, MAX_TRAIL_DROPPED). */
const MAX_TRAIL = 100;
const MAX_TRAIL_GAP_S = 3600;
const MAX_TRAIL_WINDOWS = 20;
const MAX_TRAIL_REPEAT = 100;
const MAX_TRAIL_DROPPED = 10000;
/** Use per diagram (migrations/0006): at most 30 listed, plus the entry (id 0) that adds up the rest. */
const MAX_DIAGRAMS = 30;
const MAX_DIAGRAM_ID = 65535;
const MAX_DIAGRAM_EDITS = 1000;

/** Array fields keep this order when stored, whatever order the client sent. */
const STAGES = ['logical', 'physical'];
const SCHEMA_FORMATS = ['v5', 'v4'];

/** The only keys `features` may carry; anything else is dropped. */
const FEATURES = [
  'physicalStage',
  'compare',
  'syncPlan',
  'launchClaude',
  'dbtCompile',
  'annotation',
  'autoLayout',
  'addModel',
  'addRelationship',
  'harnessInstallClaude',
  'harnessInstallCopilot',
  'harnessInstallGemini',
  'harnessInstallCodex',
  'migrateV5',
  'feedbackOpened',
  'drawFromDbt',
  'addFromDbt',
  'emptyCanvas',
  'dbtParse',
  'harnessPresent',
  'manifestMissingCanvas',
  'manifestMissingPhysical',
  'manifestMissingDraw',
  'manifestMissingWelcome',
  'manifestMissingRefresh',
  'manifestNoTargetDir',
  'manifestCustomTargetPath',
  'manifestNoDbtFound',
  'manifestAfterParse',
  'manifestAppeared',
  'manifestHintDismissed',
  'editModel',
  'editColumn',
  'editKey',
  'editDetails',
  'editRelationship',
  'editLayout',
  'editAnnotation',
  'editUndo',
  'layoutUnder1s',
  'layout1to5s',
  'layoutOver5s',
  'layoutFailed',
  'domainCreated',
  'domainCreatedExternal',
  'walkthroughOpened',
  'gettingStartedOpened',
  'videoHalf',
  'videoEnded',
  'videoError',
  'trySample',
  'setupAiHelper',
  'copyPrompt',
  'openClaude',
  'openCopilotChat',
  'harnessInstallAgents',
  // Getting-started funnel: user choices and project states, never failures.
  'drawStarted',
  'drawNoModels',
  'drawNoLayers',
  'drawCancelScope',
  'drawCancelLayer',
  'drawCancelName',
  'drawNothingDrawable',
  'addFromDbtStarted',
  'addFromDbtNeedsV5',
  'addFromDbtNoModels',
  'addFromDbtAllPresent',
  'addFromDbtCancelled',
  'addFromDbtNothingDrawable',
  'trySampleCancelled',
  'trySampleNoGit',
  'setupHelperConflict',
  'setupHelperCancelled',
  'helperFirstPrompt',
  'openClaudeCli',
  'openClaudeExtension',
  'openClaudeNotFound',
  'openClaudeCancelled',
  'copilotChatNotFound',
  'copilotChatNoArgs',
  'welcomeDrawFromDbt',
  'welcomeOpenDiagram',
  // Move Relationships to Model Library (#126): the canvas offer and its
  // answers, then the command's own route.
  'relMoveOffered',
  'relMoveReview',
  'relMoveNotNow',
  'relMoveDeclined',
  'relMoveStarted',
  'relMoveCancelled',
  'relMoveNothingToMove',
  'relMoveCompleted',
  'relMoveLeftover',
  // Relationship rework (#133): use of the new behaviour, Move steps, and
  // the state of the relationships found on canvas open.
  'relDragTurned',
  'relSwapMoved',
  'relSwapRefusedKey',
  'relDeleteCopies',
  'relDeleteStillDrawn',
  'relRoleSet',
  'relCreateAnyway',
  'relDirectionAsked',
  'relMarkKey',
  'relComposite',
  'relSelfReference',
  'relCaseRespelled',
  'relMoveRehomed',
  'relMoveTurned',
  'relMoveConflictShown',
  'relMoveDisagreementLeft',
  'relMoveFileLocked',
  'relMoveKeptLibrary',
  'relMoveGroupLeft',
  'relStateStoredTwice',
  'relStateOneToMany',
  'relStateBackwards',
  'relStateDanglingModel',
  'relStateDanglingColumn',
  'relStateUnreadable',
  'relStatePartialComposite',
  'relStateDomainCopy',
  'exportMermaid',
  'exportDbml',
  'exportCancelled',
  'exportNoDiagrams',
  'exportDbmlRich',
  'exportAll',
  'importDbml',
  'importDbmlLayout',
  'importDbmlCancelled',
  'importDbmlInvalid',
  'logicalOnlyProject',
  'exampleDiagram',
  'blankDiagram',
  // Native DBML storage (2.0).
  'dbmlProject',
  'convertToDbml',
  'convertToDbmlOffered',
  'convertToDbmlDeclined',
  'convertToDbmlNotNow',
  'convertToDbmlCancelled',
  'convertToDbmlRefused',
  'dbmlForeignFormatWarned',
  // The start screen (the first five minutes; the extension's startActions.ts): a
  // start clicked on the Welcome panel (welcome*, beside the older
  // welcomeDrawFromDbt / welcomeOpenDiagram), the Get Started walkthrough
  // (walkthrough*) or the empty Diagrams view (sidebar*); the empty view's
  // starts were on screen (once a day); the Welcome panel closed with no
  // button pressed.
  'welcomeBlank',
  'welcomeImport',
  'welcomeExample',
  'welcomeConvert',
  'walkthroughBlank',
  'walkthroughImport',
  'walkthroughExample',
  'walkthroughConvert',
  'walkthroughDrawFromDbt',
  'sidebarBlank',
  'sidebarImport',
  'sidebarExample',
  'sidebarConvert',
  'sidebarDrawFromDbt',
  'sidebarStartShown',
  'welcomeLeftNoChoice',
  // New Diagram… closed before it wrote (at the layer or the name).
  'blankDiagramCancelled',
  // Open an Example Project…: an example written and its window opened; an
  // earlier copy opened instead; closed at the picker or the folder dialog;
  // which example (fixed product ids); its first diagram opened in the new window.
  'exampleOpened',
  'exampleReopened',
  'exampleCancelled',
  'exampleEnterpriseWarehouse',
  'exampleMedallion',
  'exampleDbtProjectLayers',
  'exampleKimballBusMatrix',
  'exampleDataVault',
  'exampleGitlabStyle',
  'exampleBigqueryVersioned',
  'exampleDataMesh',
  'exampleDiagramShown',
  // Import… (erdStudio.importModel): which source was picked, or the picker
  // closed. Import SQL DDL… and Import Semantic Model…: finished, closed
  // before writing, the user's files could not be read (not a failure of
  // ours); which SQL dialect the conversion ran with.
  'importPickDbml',
  'importPickSqlDdl',
  'importPickSemanticModel',
  'importPickCancelled',
  'importSqlDdl',
  'importSqlDdlCancelled',
  'importSqlDdlInvalid',
  'importSqlDialectPostgres',
  'importSqlDialectMysql',
  'importSqlDialectSqlserver',
  'importSqlDialectSnowflake',
  'importSqlDialectDatabricks',
  'importSemanticModel',
  'importSemanticModelCancelled',
  'importSemanticModelInvalid',
  // First run, measured: a true first activation on this machine (at most 1);
  // that first run was in a project that already had diagrams, so the
  // walkthrough waited (at most 1); the "This project has N diagrams" notice
  // shown, and its Open button pressed; the walkthrough was owed but another
  // prompt had this window (at most 1).
  'firstRun',
  'firstRunHasDiagrams',
  'diagramsNudgeShown',
  'diagramsNudgeOpened',
  'walkthroughWaited',
  // The start screen's suggestion (src/types/startActions.ts): the three
  // direct imports clicked on each surface (one click less than Import…'s
  // picker); which start a surface the host can see suggested (at most once
  // a day each); the Welcome panel's "Watch how" clip was played.
  'welcomeImportSemanticModel',
  'welcomeImportSqlDdl',
  'welcomeImportDbmlFile',
  'walkthroughImportSemanticModel',
  'walkthroughImportSqlDdl',
  'walkthroughImportDbmlFile',
  'sidebarImportSemanticModel',
  'sidebarImportSqlDdl',
  'sidebarImportDbmlFile',
  'startSuggestedConvert',
  'startSuggestedDrawFromDbt',
  'startSuggestedImportSemanticModel',
  'startSuggestedImportSqlDdl',
  'startSuggestedImportDbmlFile',
  'startSuggestedBlank',
  'howToClipPlayed',
  // The start suggestion (src/services/startSuggestion.ts): the one
  // notification a folder with no diagram gets when its start is obvious —
  // shown, and the user's answer: Create Diagram, More Options…, Don't Ask
  // Again, or closed; start suggestions turned off by the command (or, once
  // a day, a due suggestion kept back by the erdStudio.startSuggestions setting).
  'suggestPromptShown',
  'suggestPromptAccepted',
  'suggestPromptMore',
  'suggestPromptOff',
  'suggestPromptDismissed',
  'startSuggestionsOff',
  // The quick import (defaults chosen, one confirm): one finished, its
  // Change Options… chosen, it fell back to the step-by-step flow (nothing
  // found to take, or more files than it reads); the dry run's Review All…
  // was opened (every import source).
  'quickImport',
  'quickImportChangeOptions',
  'quickImportFellBack',
  'importReviewOpened',
  // The import guide (src/services/importGuide.ts, Bring In an Existing Data
  // Model…): opened (every open), and from where (the palette has none); which
  // card's button was pressed; a Copy button. Then the nothing-found
  // notification (src/services/startSuggestion.ts): a folder with no diagram and
  // nothing concrete, whose empty Diagrams view was opened — shown, and the
  // answer (closed = shown minus the three).
  'importGuideOpened',
  'importGuideFromWelcome',
  'importGuideFromWalkthrough',
  'importGuideFromSidebar',
  'importGuideFromPicker',
  'importGuideFromStartPick',
  'importGuideFromPrompt',
  'importGuideActionFound',
  'importGuideActionDbt',
  'importGuideActionDatabricks',
  'importGuideActionSnowflake',
  'importGuideActionPowerBi',
  'importGuideActionFabric',
  'importGuideActionFabricWarehouse',
  'importGuideActionSqlServer',
  'importGuideActionPostgres',
  'importGuideActionMysql',
  'importGuideActionDbml',
  'importGuideActionOtherTools',
  'importGuideActionFeedback',
  'importGuideCopied',
  'suggestPromptNothingShown',
  'suggestPromptNothingNewDiagram',
  'suggestPromptNothingGuide',
  'suggestPromptNothingOff',
  // Draft-first (docs/dev/draft-first.md §11).
  'draftShown',
  'draftShownAuto',
  'draftExampleShown',
  'draftSourceSqlDdl',
  'draftSourceSemanticModel',
  'draftSourceDbml',
  'draftSourceDbt',
  'draftKept',
  'draftChangeOptions',
  'draftDiscarded',
  'draftClosed',
  'draftOtherStart',
  'draftScopeChanged',
  'draftDetailsOpened',
  'draftRefreshed',
  'draftUnavailable',
  'suggestPromptShowMe',
  'importGuideFromDraft',
  // Each window's activation outcome, and an unused dbt project (presence).
  'activatedDbt',
  'activatedLogical',
  'activatedNoFolder',
  'dbtProjectUnused',
  // The onboarding guide, Show Me Around (src/types/onboardingGuide.ts): it
  // began (and whether the command asked), phase A ended by Keep on the
  // draft, phase B began on the canvas, it finished, it was skipped on the
  // draft or on the canvas, and its finish's Star on GitHub and its Set Up My
  // AI Helper button. Fixed keys only: never a table, a path or a count.
  'guideStarted',
  'guideStartedFromCommand',
  'guideDraftDone',
  'guideCanvasStarted',
  'guideCompleted',
  'guideSkippedOnDraft',
  'guideSkippedOnCanvas',
  'guideStarClicked',
  'guideAiHelperClicked',
  // Each step the first time it shows in a run (a step-by-step funnel), Back,
  // and a draft left (Discard or its tab closed) while the guide ran on it.
  'guideStepDraftBanner',
  'guideStepDraftMoreWays',
  'guideStepDraftKeep',
  'guideStepCanvasTable',
  'guideStepCanvasRelationship',
  'guideStepCanvasToolbar',
  'guideStepCanvasStages',
  'guideStepCanvasSidebar',
  'guideStepCanvasFiles',
  'guideStepCanvasFinish',
  'guideBack',
  'guideLeftDraft',
  'diagramsNudgeShowMeAround',
  // A draft's Open Folder… reloaded the window into a folder, and that folder's
  // draft showed at once (the no-folder example's route; the guide carries on).
  'draftAfterOpenFolder',
  // Run dbt parse outcomes. `dbtParse` stays the click (#113 continuity).
  'dbtParseLaunched',        // a dbt parse process started (any mode, also the rerun after dbt deps or Parse without your credentials)
  'dbtParseRefresh',         // …with a manifest.json already there (a refresh, can never be manifestAfterParse)
  'dbtParseNoDbt',           // no dbt found; the install message showed
  'dbtParseVenvDeclined',    // the project-venv modal was dismissed
  'dbtParseCloudCli',        // only the dbt Cloud CLI was found; not run
  'dbtParseBusy',            // a dbt run (parse, compile or deps) was already going, or starting, for the project
  'dbtParseNoProfiles',      // no profiles.yml anywhere: Parse without your credentials offered before any run
  'dbtParseNoStart',         // the executable could not be started, or cmd.exe could not quote a path it needs
  'dbtParseStopped',         // the user stopped it (closed the terminal, Ctrl+C)
  'dbtParseExitOk',
  'dbtParseExitFail',
  'dbtParseOkNoManifest',    // exit 0 but no manifest where ERD Studio reads it
  // why a dbt parse failed, by fixed category (dbt's output never leaves the machine)
  'dbtParseFailProfile', 'dbtParseFailTarget', 'dbtParseFailEnvVar', 'dbtParseFailAdapter',
  'dbtParseFailAdapterDeps', 'dbtParseFailDeps', 'dbtParseFailCredentials', 'dbtParseFailNoProject',
  'dbtParseFailDbtVersion', 'dbtParseFailProject', 'dbtParseFailOther',
  'dbtParseShowOutput',
  'dbtParseAdapterDocs',
  'dbtParseNoCreds',         // Parse without your credentials was chosen
  'dbtParseNoCredsAsked',    // its adapter pick list was shown
  'dbtParseNoCredsUnsupported', // no adapter it knows was installed
  'dbtParseNoCredsOk',
  'dbtParseNoCredsFail',
  // which adapter the placeholder profile used, by fixed product name
  'dbtNoCredsDuckdb', 'dbtNoCredsPostgres', 'dbtNoCredsRedshift', 'dbtNoCredsSnowflake', 'dbtNoCredsDatabricks',
  'dbtNoCredsBigquery', 'dbtNoCredsFabric', 'dbtNoCredsSqlserver', 'dbtNoCredsTrino', 'dbtNoCredsSpark',
  'dbtParseDeps',            // Run dbt deps was chosen
  'dbtDepsExitOk',
  'dbtDepsExitFail',
  'dbtParseOpenPhysical',    // Open Physical view was pressed after a parse
  'dbtCompileLaunched',
  'dbtCompileNoDbt',
  'dbtCompileVenvDeclined',
  'dbtCompileExitOk',
  'dbtCompileExitFail',
  'dbtCompileStopped',       // the user stopped Run dbt compile
  'dbtCompileNoStart',       // Run dbt compile's executable could not be started or quoted
  // 2.0.0 launch telemetry (plan items B2 to B19), appended in item order: no draft size buckets, nothing for B8 or B20.
  // 2.0 B2 — a same-day interim copy of the summary (first week, or a day with a new error)
  'heartbeatProvisional',
  // 2.0 B3 — the body was trimmed to stay under the size guard
  'heartbeatTrimmed',
  // 2.0 B4 — activation timing, the host dbt search, and why activation failed (by phase)
  'activationOver10s',
  'dbtSearchTimedOut',
  // 2.0 B5 — updates and mixed-version days
  'extUpdated',
  'extUpdatedMajor',
  'versionMixed',
  // 2.0 B6 — first-draft quality, as presence flags computed on the device (never a name, path or count)
  'draftOrphansMost',
  'draftEmptyTablesMost',
  'draftUntypedMost',
  'draftNoPkMost',
  'draftWideTablesMost',
  'draftRelsInferable',
  'draftLeftOut',
  'draftCapped',
  'draftReusesLibrary',
  'draftThinDbt',
  'draftThinSqlDdl',
  'draftThinSemanticModel',
  'draftThinDbml',
  'draftRelsNoneDbt',
  'draftRelsNoneSqlDdl',
  'draftRelsNoneSemanticModel',
  'draftRelsNoneDbml',
  'draftKeptThinDbt',
  'draftKeptThinSqlDdl',
  'draftKeptThinSemanticModel',
  'draftKeptThinDbml',
  'draftRejectedFastDbt',
  'draftRejectedFastSqlDdl',
  'draftRejectedFastSemanticModel',
  'draftRejectedFastDbml',
  'diagramDeleted',
  // 2.0 B7 — why an import failed or stopped
  'importSqlInvalidParse',
  'importSqlInvalidStructure',
  'importSqlInvalidDuplicateTable',
  'importSqlInvalidNoCreateTable',
  'importSqlRejectedCreateTable',
  'importSqlRejectedCreateOrReplace',
  'importSqlRejectedAlterTable',
  'importSqlRejectedCreateView',
  'importSqlRejectedCommentOn',
  'importSqlRejectedCreateIndex',
  'importSqlRejectedGrant',
  'importSqlRejectedSetUse',
  'importSqlRejectedOther',
  'importSqlFailPostgres',
  'importSqlFailMysql',
  'importSqlFailSqlserver',
  'importSqlFailSnowflake',
  'importSqlFailDatabricks',
  'importSqlTryAnotherDialect',
  'quickSqlNoDialect',
  'quickSqlDialectFallback',
  'importDbmlInvalidUse',
  'importDbmlInvalidSyntax',
  'importDbmlSeveralFieldsOneLine',
  'importDbmlNoTables',
  'importSemanticModelNoModel',
  'importSemanticModelParseTmdl',
  'importSemanticModelParseBim',
  'importSemanticModelSeveral',
  'importLimitTooManyFiles',
  'importLimitFileTooBig',
  'importLimitTooMuchText',
  'importInputUnreadable',
  'importStopNoLayers',
  'importStopYamlInDbml',
  'importStopUnsaved',
  'importStopNameTaken',
  'importStopRefusedWrite',
  'writeFailedPermission',
  'writeFailedDiskFull',
  // 2.0 B9 — why the automatic draft did not appear, and start-screen look failures
  'draftUnavailableSqlDdl',
  'draftUnavailableSemanticModel',
  'draftUnavailableDbml',
  'draftUnavailableDbt',
  'draftUnavailableExample',
  'draftWaitedForPrompt',
  'draftDropNothingFound',
  'draftDropUnreadable',
  'draftDropNoLayer',
  'draftDropBadName',
  'draftDropNothingDrawable',
  'draftDropNoDialect',
  'draftDropNeedsChoice',
  'startLookTimeout',
  'startLookGaveUp',
  // 2.0 B10 — command failures shown to the user
  'newDiagramNameTaken',
  'newDiagramNoLayers',
  // 2.0 B11 — Convert to DBML: refusal kinds, stops and storage state
  'convertRefusedReservedLayer',
  'convertRefusedLegacyFiles',
  'convertRefusedOther',
  'convertStopUnsaved',
  'convertStopChangedDuringPreview',
  'convertNothingToDo',
  'convertLeftAsIs',
  'convertOver60s',
  'storageYaml',
  'storageDbml',
  'storageMixed',
  'legacyDbmlTreeWarned',
  'canvasJsonV6',
  // 2.0 B12 — canvas handler failures, protocol rejects, watcher refresh failures
  'editRefused',
  'canvasReconnectReload',
  // 2.0 B13 — webview crashes and panels that never became ready
  'draftPageReady',
  'welcomePanelReady',
  'readySlowOver10s',
  // 2.0 B14 — why a DBML diagram failed to load, and diagrams that render degraded
  'domainLoadBlocking',
  'domainLoadOverLive',
  'dbmlLayoutBadLine',
  'dbmlLayoutDuplicateKey',
  'dbmlLayoutBadValue',
  'dbmlLayoutConflict',
  'dbmlDiagramReadOnly',
  'dbmlPendingRefs',
  'dbmlUnlinkedTables',
  'dbmlEmbeddedTablesShown',
  'diagramWarnModelNotFound',
  'diagramWarnForeignDbml',
  'dbmlEmbeddedTablesImport',
  // 2.0 B15 — time to the first draft and the first diagram, from the first run
  'ttfDraftUnder1m',
  'ttfDraft1to5m',
  'ttfDraft5to30m',
  'ttfDraftOver30m',
  'ttfDraftLaterDay',
  'ttfDiagramUnder1m',
  'ttfDiagram1to5m',
  'ttfDiagram5to30m',
  'ttfDiagramOver30m',
  'ttfDiagramLaterDay',
  // 2.0 B16 — AI helper hooks that were skipped, and helper install failures
  'hookSkippedJsonc',
  'hookSkippedNotJson',
  'hookSkippedShape',
  'hookSkippedOwnScript',
  'hookSkippedNewerScript',
  'hookSkippedCopilot',
  'hookSkippedCodex',
  'hookSkippedGemini',
  // 2.0 B17 — big diagrams: slow loads, layout failures and the draft layout
  'canvasLoadOver20s',
  'layoutStackFallback',
  'firstLayoutOver5s',
  'draftLayoutOver5s',
  'draftFitZoomUnder30',
  'draftLayoutFallback',
  'draftClosedWhileLayingOut',
  // 2.0 B18 — known-fix prompt answers, Welcome failures and small onboarding dead ends
  'knownFixOffered',
  'knownFixUpdate',
  'knownFixReload',
  'knownFixDismissed',
  'trySampleCloned',
  'trySampleZip',
  'trySampleGithub',
  'noFolderWarned',
  // 2.0 review — a stage switch or comparison met a diagram file the user broke (theirs, not ours)
  'handlerFileProblem',
  // 2.0 — the crash screen a webview shows after a render crash: which button was pressed
  'crashFallbackReload',
  'crashFallbackFeedback',
  // 2.0 import outcomes — how each import ended, by importer, then by SQL dialect (importOutcomeTelemetry.ts)
  'importOutcomeSqlDdlClean',
  'importOutcomeSqlDdlRepaired',
  'importOutcomeSqlDdlPartial',
  'importOutcomeSqlDdlFail',
  'importOutcomeSqlDdlCancelled',
  'importOutcomeSqlDdlTimedOut',
  'importOutcomeSemanticModelClean',
  'importOutcomeSemanticModelRepaired',
  'importOutcomeSemanticModelPartial',
  'importOutcomeSemanticModelFail',
  'importOutcomeSemanticModelCancelled',
  'importOutcomeSemanticModelTimedOut',
  'importOutcomeDbmlClean',
  'importOutcomeDbmlRepaired',
  'importOutcomeDbmlPartial',
  'importOutcomeDbmlFail',
  'importOutcomeDbmlCancelled',
  'importOutcomeDbmlTimedOut',
  'importOutcomeDbtClean',
  'importOutcomeDbtRepaired',
  'importOutcomeDbtPartial',
  'importOutcomeDbtFail',
  'importOutcomeDbtCancelled',
  'importOutcomeDbtTimedOut',
  'importSqlOutcomePostgresClean',
  'importSqlOutcomePostgresRepaired',
  'importSqlOutcomePostgresPartial',
  'importSqlOutcomePostgresFail',
  'importSqlOutcomePostgresCancelled',
  'importSqlOutcomePostgresTimedOut',
  'importSqlOutcomeMysqlClean',
  'importSqlOutcomeMysqlRepaired',
  'importSqlOutcomeMysqlPartial',
  'importSqlOutcomeMysqlFail',
  'importSqlOutcomeMysqlCancelled',
  'importSqlOutcomeMysqlTimedOut',
  'importSqlOutcomeSqlserverClean',
  'importSqlOutcomeSqlserverRepaired',
  'importSqlOutcomeSqlserverPartial',
  'importSqlOutcomeSqlserverFail',
  'importSqlOutcomeSqlserverCancelled',
  'importSqlOutcomeSqlserverTimedOut',
  'importSqlOutcomeSnowflakeClean',
  'importSqlOutcomeSnowflakeRepaired',
  'importSqlOutcomeSnowflakePartial',
  'importSqlOutcomeSnowflakeFail',
  'importSqlOutcomeSnowflakeCancelled',
  'importSqlOutcomeSnowflakeTimedOut',
  'importSqlOutcomeDatabricksClean',
  'importSqlOutcomeDatabricksRepaired',
  'importSqlOutcomeDatabricksPartial',
  'importSqlOutcomeDatabricksFail',
  'importSqlOutcomeDatabricksCancelled',
  'importSqlOutcomeDatabricksTimedOut',
  // 2.0 import outcomes — each loss-ledger cause class an import met (once per import, never a size)
  'importCauseParseError',
  'importCauseGrammarGap',
  'importCauseTemplatePlaceholder',
  'importCauseUnknownType',
  'importCauseReservedWord',
  'importCauseTrailingOption',
  'importCauseUnsupportedModifier',
  'importCauseProceduralBlock',
  'importCauseNotInFiles',
  'importCauseDroppedLater',
  'importCauseNoField',
  'importCauseNotDesign',
  'importCauseRenamed',
  'importCauseNormalised',
  'importCauseInferred',
  'importCauseCapped',
  'importCauseSavedOptional',
  'importCauseDuplicate',
  'importCauseCancelled',
  'importCauseTimeLimit',
  'importCauseOther',
  'draftDropTimeLimit',
  // Added after 2.0.0: the import guide's Microsoft Fabric card (its catalog
  // query's button and copy), and how an import started from its SQL buttons ended.
  'importGuideActionFabricCatalog',
  'importGuideCopiedFabricCatalog',
  'importFabricOutcomeClean',
  'importFabricOutcomeRepaired',
  'importFabricOutcomePartial',
  'importFabricOutcomeFail',
  'importFabricOutcomeCancelled',
  'importFabricOutcomeTimedOut',
  // The major update notice: it showed, and which of its two buttons was pressed.
  'majorUpdateNoticeShown',
  'majorUpdateNoticeShowMeAround',
  'majorUpdateNoticeWhatsNew',
  // Added after 2.0.4: the fallback that produced an auto layout whose default attempt failed.
  'layoutFallbackRung2',
  'layoutFallbackRung3',
  // #304: the host's dbt_project.yml search failed and the walk alone still found a dbt project.
  'dbtSearchFailedWalkFound',
  // Also added after 2.0.4 (#295): which stretch held a slow activation, a late start
  // suggestion, and the dbt search not waited for.
  'activationSlowDbtSearch',
  'activationSlowDiscovery',
  'activationSlowServices',
  'startLookLateSuggestion',
  'dbtSearchSkipped',
];

/** The only keys `errors` may carry; anything else is dropped. */
const ERROR_CODES = [
  // No longer recorded since 1.6.2 (#110): a missing manifest is the normal
  // state of a fresh clone, already reported by the canvas-open `manifest`
  // field. Kept for older clients and so the list order never shifts.
  'manifestMissing',
  'manifestMalformed',
  'manifestTimeout',
  'catalogUnreadable',
  'domainLoad',
  'modelFileParse',
  'layersInvalid',
  'editRejected',
  'migrationFailed',
  'other',
  'modelFileRead',
  'modelFileYamlIndent',
  'modelFileYamlScalar',
  'modelFileYamlStructure',
  'modelFileYamlDuplicateKey',
  'modelFileYamlOther',
  // Getting-started failures: something broke on the way to a first diagram.
  'walkthroughFailed',
  'drawFromDbtFailed',
  'drawWriteFailed',
  'addFromDbtFailed',
  'layoutFailed',
  'firstLayoutFailed',
  'sampleCloneFailed',
  'setupHarnessFailed',
  'launcherInstallFailed',
  'launcherRuntimeUnverified',
  'setupFailed',
  'claudeOpenCommandMissing',
  'claudeOpenFailed',
  'copilotChatOpenFailed',
  'welcomePanelFailed',
  'projectPathInvalid',
  'domainLoadNotDomain',
  'domainLoadMissing',
  'domainLoadUnreadable',
  'domainLoadJson',
  'domainLoadInvalid',
  'domainLoadInternal',
  // Move Relationships to Model Library (#126): refused because a file it
  // would change had unsaved edits, a write failed (every file restored), or
  // the command threw.
  'relMoveDirtyFiles',
  'relMoveWriteFailed',
  'relMoveFailed',
  // A canvas edit (or the duplicate-model rename) could not save a file.
  'saveFailed',
  // Relationship rework (#133): failed writes, and invariants a write broke.
  'relWriteFailed',
  'relHandlerFailed',
  'relSyncRefused',
  'relMoveRestoreFailed',
  'relInvNotCanonical',
  'relInvNotAsIntended',
  'relInvRoleLost',
  'relInvCopyLeft',
  'relInvOtherLost',
  'relInvOtherChanged',
  'relInvDuplicateInFile',
  'relInvDrawnTwice',
  'relInvGroupBroken',
  'relInvKeyNotMarked',
  'relInvCheckFailed',
  'exportFailed',
  'domainLoadEmpty',
  'domainLoadConflict',
  // Why a saveFailed save failed, which file kind, and the rename / undo-redo paths.
  'saveFailedRefused',
  'saveFailedThrew',
  'saveFailedModelFile',
  'saveFailedRename',
  'saveFailedReopen',
  'saveFailedUndoRedo',
  // Import DBML… failed while writing the new diagram.
  'importDbmlFailed',
  // Native DBML storage (2.0): a .dbml table file or diagram DBML could not
  // read, and Convert Project to DBML failed while writing.
  'modelFileDbmlSyntax',
  'modelFileDbmlInvalid',
  'modelFileDbmlStructure',
  'domainLoadDbml',
  'convertToDbmlFailed',
  // Open an Example Project… could not write the example's files.
  'exampleWriteFailed',
  // Import SQL DDL… / Import Semantic Model… failed (loading the SQL
  // importer, converting, or writing the new diagram) — not the user's files.
  'importSqlDdlFailed',
  'importSemanticModelFailed',
  // Draft-first: a draft could not be built (ours); the preview's layout failed.
  'draftBuildFailed',
  'draftLayoutFailed',
  // Run dbt parse: the placeholder profile could not be written to ERD Studio's
  // storage; ERD Studio's own Run dbt parse / compile code threw (never dbt's failure).
  'dbtProfileWriteFailed',
  'dbtRunFailed',
  // Re-reading manifest.json after it changed threw (#243): the diagrams may be stale until a reload.
  'manifestRetryFailed',
  // 2.0.0 launch telemetry (plan items B4 to B19), appended in item order.
  // 2.0 B4 — activation timing, the host dbt search, and why activation failed (by phase)
  'activationFailed',
  'activationFailedDiscovery',
  'activationFailedServices',
  'activationFailedViews',
  'activationFailedWatchers',
  'activationFailedCommands',
  'activationFailedPrompts',
  'activationPromptFailed',
  'dbtSearchFailed',
  // 2.0 B7 — why an import failed or stopped
  'importSqlEngineLoadFailed',
  'importDbmlParserThrew',
  'writeFailedOurs',
  // 2.0 B9 — why the automatic draft did not appear, and start-screen look failures
  'startLookFailed',
  'startContextFailed',
  // 2.0 B10 — command failures shown to the user
  'commandFailedOurs',
  'newDiagramWriteFailed',
  'layersFileFailed',
  'renameDiagramFailed',
  'deleteDiagramFailed',
  'exampleSaveFailed',
  // 2.0 B11 — Convert to DBML: refusal kinds, stops and storage state
  'convertToDbmlSelfCheck',
  'convertToDbmlUnrestored',
  'convertSaveFailed',
  // 2.0 B12 — canvas handler failures, protocol rejects, watcher refresh failures
  'handlerFailed',
  'handlerFailedModel',
  'handlerFailedColumn',
  'handlerFailedKey',
  'handlerFailedDetails',
  'handlerFailedLayout',
  'handlerFailedAnnotation',
  'handlerFailedUndo',
  'handlerFailedStage',
  'handlerFailedCompare',
  'handlerFailedRefresh',
  'handlerFailedOther',
  'dbmlWriteOverlap',
  'messageUnknownType',
  'physicalEditDropped',
  'refreshFailed',
  'refreshFailedManifest',
  'refreshFailedCatalog',
  'refreshFailedTable',
  'refreshFailedDiagram',
  'refreshFailedLayers',
  'refreshFailedDbtYml',
  // 2.0 B13 — webview crashes and panels that never became ready
  'webviewCrash',
  'webviewCrashCanvas',
  'webviewCrashDetailPanel',
  'webviewCrashToolbar',
  'webviewCrashDialogs',
  'webviewCrashCompare',
  'webviewCrashGuide',
  'webviewCrashDraft',
  'webviewCrashOther',
  'webviewWindowError',
  'webviewRejection',
  'webviewNoReadyCanvas',
  'webviewNoReadyDraft',
  'webviewNoReadyWelcome',
  // 2.0 B14 — why a DBML diagram failed to load, and diagrams that render degraded
  'domainLoadDbmlSyntax',
  'domainLoadDbmlInvalid',
  'domainLoadDbmlBinding',
  'domainLoadDbmlParserThrew',
  'domainLoadNewerSchema',
  'domainLoadNotADiagram',
  'domainLoadLegacyFormat',
  'modelFileDbmlNotOneTable',
  'modelFileDbmlNameMismatch',
  'modelFileDbmlUnsupportedElement',
  'modelFileDbmlMetadataTarget',
  'modelFileDbmlBinding',
  'modelFileDbmlInterpreter',
  // 2.0 B16 — AI helper hooks that were skipped, and helper install failures
  'harnessInstallFailed',
  'harnessInstallFailedClaude',
  'harnessInstallFailedAgents',
  'harnessInstallFailedCopilot',
  'harnessInstallFailedGemini',
  'harnessInstallFailedCodex',
  'launcherRefreshFailed',
  'harnessUpdateFailed',
  // 2.0 B17 — big diagrams: slow loads, layout failures and the draft layout
  'layoutFailedTimeout',
  'layoutFailedWorker',
  'layoutFailedStack',
  // 2.0 B18 — known-fix prompt answers, Welcome failures and small onboarding dead ends
  'welcomeFailedStart',
  'welcomeFailedSetup',
  'welcomeFailedOpenAssistant',
  'welcomeFailedSample',
  'welcomeFailedStatus',
  'welcomeFailedOther',
  'startCommandFailed',
  'sidebarListFailed',
  'exampleOpenFailed',
  'guideOpenFailed',
  // 2.0 B19 — every logged error, by area
  'loggedError',
  'loggedErrorCanvas',
  'loggedErrorImport',
  'loggedErrorDraft',
  'loggedErrorSidebar',
  'loggedErrorHarness',
  'loggedErrorDbt',
  'loggedErrorOther',
  // 2.0 (#262) — which canvas load step threw, beside domainLoadInternal (the total)
  'domainLoadInternalManifest',
  'domainLoadInternalYml',
  'domainLoadInternalCatalog',
  'domainLoadInternalRead',
  'domainLoadInternalPositions',
  'domainLoadInternalPhysical',
  'domainLoadInternalDisplay',
  'domainLoadInternalOther',
  // Added after 2.0.4 — what kind of diagram a failed auto layout (the
  // canvas's, beside layoutFailed, or a draft page's, beside draftLayoutFailed)
  // was, how it failed and how far the fallbacks got. Fixed keys: never a
  // count, a name or the error's text.
  // Its class, beside layoutFailedTimeout / Worker / Stack.
  'layoutFailedMemory',
  'layoutFailedUnsupported',
  'layoutFailedInput',
  'layoutFailedEngine',
  'layoutFailedResult',
  'layoutFailedOther',
  // The diagram's tables and relationships, as buckets.
  'layoutFailedTablesUnder50',
  'layoutFailedTables50to199',
  'layoutFailedTables200to499',
  'layoutFailedTables500Plus',
  'layoutFailedRelsUnder100',
  'layoutFailedRels100to499',
  'layoutFailedRels500to1999',
  'layoutFailedRels2000Plus',
  // How long it ran before it failed.
  'layoutFailedUnder1s',
  'layoutFailed1to5s',
  'layoutFailedOver5s',
  // Every fallback was tried and failed, and how the last one failed when
  // that was a timeout, the worker dying or memory.
  'layoutFailedAllRungs',
  'layoutFailedLastRungTimeout',
  'layoutFailedLastRungWorker',
  'layoutFailedLastRungMemory',
  // #304: why the host's dbt_project.yml search failed, counted beside dbtSearchFailed.
  'dbtSearchFailedRejected',
  'dbtSearchFailedSort',
  'dbtSearchFailedThrew',
];

/** Every event the trail may carry: a marker, a feature key, or an error code written `!code`. */
const TRAIL_EVENTS = new Set([...TRAIL_MARKERS, ...FEATURES, ...ERROR_CODES.map((code) => `!${code}`)]);

/**
 * Last write wins for a given install and day. The extension sends once per
 * day, so a conflict means a retry after a lost response or a second window
 * racing the first — either way the newer counts are at least as complete.
 */
const UPSERT_SQL = `INSERT INTO heartbeats (
  install_id, day, received_day, ext_version, vscode_major, os, tenure, activation,
  has_semantic_dir, domain_count, activations, canvas_opens, stages, schema_formats,
  model_count, manifest, catalog, features, errors,
  host, remote, dev, assistants, harnesses, active_days_28, canvas_days_28, first_canvas,
  physical_tools, platforms, trail, trail_dropped, diagrams
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
  ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)
ON CONFLICT(install_id, day) DO UPDATE SET
  received_day = excluded.received_day,
  ext_version = excluded.ext_version,
  vscode_major = excluded.vscode_major,
  os = excluded.os,
  tenure = excluded.tenure,
  activation = excluded.activation,
  has_semantic_dir = excluded.has_semantic_dir,
  domain_count = excluded.domain_count,
  activations = excluded.activations,
  canvas_opens = excluded.canvas_opens,
  stages = excluded.stages,
  schema_formats = excluded.schema_formats,
  model_count = excluded.model_count,
  manifest = excluded.manifest,
  catalog = excluded.catalog,
  features = excluded.features,
  errors = excluded.errors,
  host = excluded.host,
  remote = excluded.remote,
  dev = excluded.dev,
  assistants = excluded.assistants,
  harnesses = excluded.harnesses,
  active_days_28 = excluded.active_days_28,
  canvas_days_28 = excluded.canvas_days_28,
  first_canvas = excluded.first_canvas,
  physical_tools = excluded.physical_tools,
  platforms = excluded.platforms,
  trail = excluded.trail,
  trail_dropped = excluded.trail_dropped,
  diagrams = excluded.diagrams`;

const RETENTION_SQL = `DELETE FROM heartbeats WHERE received_day < date('now', '-${RETENTION_DAYS} days')`;

/**
 * The `worker_daily` ledger (migrations/0005): one counted row per received
 * day, version family, outcome and reason. `n` counts heartbeats; the
 * `dropped_*` columns add up what was dropped from accepted ones.
 */
const LEDGER_SQL = `INSERT INTO worker_daily (
  day, ext_family, outcome, reason, n, dropped_features, dropped_errors, dropped_trail
) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)
ON CONFLICT(day, ext_family, outcome, reason) DO UPDATE SET
  n = n + 1,
  dropped_features = dropped_features + excluded.dropped_features,
  dropped_errors = dropped_errors + excluded.dropped_errors,
  dropped_trail = dropped_trail + excluded.dropped_trail`;

const LEDGER_RETENTION_SQL = `DELETE FROM worker_daily WHERE day < date('now', '-${RETENTION_DAYS} days')`;

/**
 * Why a heartbeat was refused for its shape: the field that failed, from this
 * fixed list only (the ledger stores `shape_<field>`). Fields without their
 * own entry are `other`.
 */
const SHAPE_FIELDS = new Set([
  'installId', 'day', 'extVersion', 'vscodeMajor', 'os', 'tenure', 'activation', 'stages', 'schemaFormats',
  'modelCount', 'counts', 'features', 'errors', 'host', 'assistants', 'harnesses', 'physicalTools', 'platforms',
  'trail', 'trailDropped', 'diagrams', 'other',
]);

/** `major.minor` of an extension version, one digit of major and at most two of minor. */
const EXT_FAMILY = /^(\d)\.(\d{1,2})\./;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} [ctx] absent only in a direct call; then no ledger row is written
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    // Before the path, the method or D1, so "off" is free and total.
    if (isKilled(env)) {
      return refuse(503, 'kill_switch');
    }

    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === KNOWN_FIXES_ROUTE) {
        return serveKnownFixes(request);
      }
      if (pathname !== ROUTE) {
        return refuse(404, 'path');
      }
      if (request.method !== 'POST') {
        return refuse(405, 'method', { Allow: 'POST' });
      }
      // A thrown upsert lands in the catch below, before the ledger: a failed
      // D1 write is a log line only, never a ledger row.
      const { response, ledger } = await handleHeartbeat(request, env);
      recordLedger(env, ctx, ledger);
      return response;
    } catch (err) {
      // Only the error's *name* — a message can quote the input.
      log({ event: 'error', status: 503, kind: errorName(err) });
      return new Response(null, { status: 503, headers: baseHeaders() });
    }
  },

  /**
   * Daily retention sweep (Cron Trigger in wrangler.toml).
   *
   * Keyed on `received_day`, which this Worker sets, rather than on the
   * client-supplied `day`: the promise is "no raw row lives on Cloudflare longer
   * than 90 days", and only a date we wrote ourselves can keep it.
   *
   * @param {unknown} _controller
   * @param {Env} env
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   * @returns {Promise<void>}
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const result = await env.DB.prepare(RETENTION_SQL).run();
        log({ event: 'retention', deleted: result?.meta?.changes ?? 0 });
        // The ledger is keyed on the day this Worker wrote, like received_day.
        const ledger = await env.DB.prepare(LEDGER_RETENTION_SQL).run();
        log({ event: 'retention', table: 'worker_daily', deleted: ledger?.meta?.changes ?? 0 });
      })(),
    );
  },
};

/**
 * The bundled registry, identical for every caller. Deliberately reads nothing
 * from the request but its method and logs nothing at all.
 *
 * @param {Request} request
 * @returns {Response}
 */
function serveKnownFixes(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...baseHeaders(), Allow: 'GET, HEAD' } });
  }
  return new Response(request.method === 'HEAD' ? null : KNOWN_FIXES_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${KNOWN_FIXES_MAX_AGE_SECONDS}`,
    },
  });
}

/**
 * Read, validate, upsert. Returns the response with the ledger entry that
 * describes it; the caller writes the entry only once this has returned, so a
 * thrown upsert writes none.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<{ response: Response, ledger: LedgerEntry }>}
 */
async function handleHeartbeat(request, env) {
  const now = Date.now();
  const body = await readLimited(request.body, MAX_BODY_BYTES, request.headers.get('content-length'));
  if (!body.ok) {
    return { response: refuse(413, 'body_size'), ledger: ledgerEntry(now, 'other', 'denied', 'body_size') };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return { response: refuse(400, 'json'), ledger: ledgerEntry(now, 'other', 'denied', 'json') };
  }

  const family = extFamily(parsed);
  const result = validateHeartbeat(parsed, now);
  if (!result.ok) {
    return { response: refuse(400, 'shape'), ledger: ledgerEntry(now, family, 'denied', `shape_${result.field}`) };
  }
  const { heartbeat, dropped } = result;

  await env.DB.prepare(UPSERT_SQL)
    .bind(
      heartbeat.installId,
      heartbeat.day,
      utcDay(now),
      heartbeat.extVersion,
      heartbeat.vscodeMajor,
      heartbeat.os,
      heartbeat.tenure,
      heartbeat.activation,
      heartbeat.hasSemanticDir ? 1 : 0,
      heartbeat.domainCount,
      heartbeat.activations,
      heartbeat.canvasOpens,
      JSON.stringify(heartbeat.stages),
      JSON.stringify(heartbeat.schemaFormats),
      heartbeat.modelCount,
      heartbeat.manifest,
      heartbeat.catalog ? 1 : 0,
      JSON.stringify(heartbeat.features),
      JSON.stringify(heartbeat.errors),
      heartbeat.host,
      heartbeat.remote,
      heartbeat.dev === null ? null : heartbeat.dev ? 1 : 0,
      heartbeat.assistants === null ? null : JSON.stringify(heartbeat.assistants),
      heartbeat.harnesses === null ? null : JSON.stringify(heartbeat.harnesses),
      heartbeat.activeDays28,
      heartbeat.canvasDays28,
      heartbeat.firstCanvas,
      heartbeat.physicalTools === null ? null : JSON.stringify(heartbeat.physicalTools),
      heartbeat.platforms === null ? null : JSON.stringify(heartbeat.platforms),
      heartbeat.trail === null ? null : JSON.stringify(heartbeat.trail),
      heartbeat.trailDropped,
      heartbeat.diagrams === null ? null : JSON.stringify(heartbeat.diagrams),
    )
    .run();

  log({ event: 'ok', status: 204 });
  return {
    response: new Response(null, { status: 204, headers: baseHeaders() }),
    ledger: ledgerEntry(now, family, 'ok', 'none', dropped),
  };
}

// ---------------------------------------------------------------------------
// The worker_daily ledger
// ---------------------------------------------------------------------------

/**
 * @param {number} now
 * @param {string} family
 * @param {'ok' | 'denied'} outcome
 * @param {string} reason
 * @param {Dropped} [dropped]
 * @returns {LedgerEntry}
 */
function ledgerEntry(now, family, outcome, reason, dropped = { features: 0, errors: 0, trail: 0 }) {
  return { day: utcDay(now), family, outcome, reason, dropped };
}

/**
 * `major.minor` of a parsed body's `extVersion` (`2.0.3` → `2.0`), or `other`
 * for anything else, so the family is one of at most 1,000 values whatever a
 * client sends.
 *
 * @param {unknown} parsed
 * @returns {string}
 */
function extFamily(parsed) {
  const version = isPlainObject(parsed) ? /** @type {Record<string, unknown>} */ (parsed).extVersion : undefined;
  if (typeof version !== 'string' || version.length > MAX_VERSION_CHARS) return 'other';
  const match = EXT_FAMILY.exec(version);
  return match ? `${match[1]}.${match[2]}` : 'other';
}

/**
 * Best-effort ledger upsert, off the response path: scheduled with
 * `ctx.waitUntil` and caught, so neither a D1 error nor anything else here can
 * change the response already decided. Without a `ctx` (a direct call, not the
 * Workers runtime) it writes nothing.
 *
 * @param {Env} env
 * @param {ExecutionContext | undefined} ctx
 * @param {LedgerEntry} entry
 * @returns {void}
 */
function recordLedger(env, ctx, entry) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return;
  try {
    ctx.waitUntil(
      (async () => {
        try {
          await env.DB.prepare(LEDGER_SQL)
            .bind(entry.day, entry.family, entry.outcome, entry.reason, entry.dropped.features, entry.dropped.errors, entry.dropped.trail)
            .run();
        } catch (err) {
          log({ event: 'ledger_error', kind: errorName(err) });
        }
      })(),
    );
  } catch (err) {
    log({ event: 'ledger_error', kind: errorName(err) });
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The heartbeat to store, with how many unknown keys and trail events were
 * dropped from it, or the field that refused it when any known field is
 * missing or invalid. Unknown keys are ignored — the result is built only from
 * the fields named here, so nothing the client adds can reach the row.
 *
 * `features` and `errors` may be omitted (an idle day has neither), and so may
 * the fields added in extension 1.6.3 (`host` … `firstCanvas`, stored NULL when
 * absent); every other field is required. `field` is one of
 * {@link SHAPE_FIELDS}: the counters `activations` / `canvasOpens` are
 * `counts`, and the fields without their own entry are `other`.
 *
 * @param {unknown} raw
 * @param {number} now epoch ms, for the day-window check
 * @returns {{ ok: true, heartbeat: Heartbeat, dropped: Dropped } | { ok: false, field: string }}
 */
function validateHeartbeat(raw, now) {
  /** @param {string} field */
  const refused = (field) => ({ ok: /** @type {const} */ (false), field: SHAPE_FIELDS.has(field) ? field : 'other' });
  if (!isPlainObject(raw)) return refused('other');
  const b = /** @type {Record<string, unknown>} */ (raw);

  if (b.v !== CONTRACT_VERSION) return refused('other');
  if (typeof b.installId !== 'string' || !UUID_V4.test(b.installId)) return refused('installId');
  if (!isAcceptableDay(b.day, now)) return refused('day');
  if (!isVersion(b.extVersion, SEMVER)) return refused('extVersion');
  if (!isVersion(b.vscodeMajor, MAJOR_MINOR)) return refused('vscodeMajor');
  if (!isOneOf(b.os, OS_VALUES)) return refused('os');
  if (!isOneOf(b.tenure, TENURE_VALUES)) return refused('tenure');
  if (!isOneOf(b.activation, ACTIVATION_VALUES)) return refused('activation');
  if (typeof b.hasSemanticDir !== 'boolean') return refused('other');
  if (!isOneOf(b.domainCount, DOMAIN_COUNT_VALUES)) return refused('other');
  if (!isIntIn(b.activations, 0, 50)) return refused('counts');
  if (!isIntIn(b.canvasOpens, 0, 200)) return refused('counts');
  if (!isOneOf(b.modelCount, MODEL_COUNT_VALUES)) return refused('modelCount');
  if (!isOneOf(b.manifest, MANIFEST_VALUES)) return refused('other');
  if (typeof b.catalog !== 'boolean') return refused('other');

  const stages = subsetOf(b.stages, STAGES);
  if (!stages) return refused('stages');
  const schemaFormats = subsetOf(b.schemaFormats, SCHEMA_FORMATS);
  if (!schemaFormats) return refused('schemaFormats');

  const features = countsOf(b.features, FEATURES);
  if (!features) return refused('features');
  const errors = countsOf(b.errors, ERROR_CODES);
  if (!errors) return refused('errors');

  const host = optionalOneOf(b.host, HOST_VALUES);
  if (host === INVALID) return refused('host');
  const remote = optionalOneOf(b.remote, REMOTE_VALUES);
  const activeDays28 = optionalOneOf(b.activeDays28, RECENT_DAYS_VALUES);
  const canvasDays28 = optionalOneOf(b.canvasDays28, RECENT_DAYS_VALUES);
  const firstCanvas = optionalOneOf(b.firstCanvas, FIRST_CANVAS_VALUES);
  if ([remote, activeDays28, canvasDays28, firstCanvas].includes(INVALID)) return refused('other');
  if (b.dev !== undefined && typeof b.dev !== 'boolean') return refused('other');
  const assistants = b.assistants === undefined ? null : subsetOf(b.assistants, ASSISTANTS);
  if (b.assistants !== undefined && !assistants) return refused('assistants');
  const harnesses = b.harnesses === undefined ? null : subsetOf(b.harnesses, HARNESSES);
  if (b.harnesses !== undefined && !harnesses) return refused('harnesses');
  const trail = b.trail === undefined ? null : trailOf(b.trail);
  if (trail === INVALID) return refused('trail');
  if (b.trailDropped !== undefined && (b.trail === undefined || !isIntIn(b.trailDropped, 0, MAX_TRAIL_DROPPED))) return refused('trailDropped');
  const diagrams = b.diagrams === undefined ? null : diagramsOf(b.diagrams);
  if (diagrams === INVALID) return refused('diagrams');
  const physicalTools = b.physicalTools === undefined ? null : subsetOf(b.physicalTools, PHYSICAL_TOOLS);
  if (b.physicalTools !== undefined && !physicalTools) return refused('physicalTools');
  const platforms = b.platforms === undefined ? null : subsetOf(b.platforms, PLATFORMS);
  if (b.platforms !== undefined && !platforms) return refused('platforms');

  return {
    ok: true,
    dropped: { features: features.dropped, errors: errors.dropped, trail: trail === null ? 0 : trail.dropped },
    heartbeat: {
      // Lower-cased so one install cannot appear as two rows by changing case.
      installId: b.installId.toLowerCase(),
      day: /** @type {string} */ (b.day),
      extVersion: /** @type {string} */ (b.extVersion),
      vscodeMajor: /** @type {string} */ (b.vscodeMajor),
      os: /** @type {string} */ (b.os),
      tenure: /** @type {string} */ (b.tenure),
      activation: /** @type {string} */ (b.activation),
      hasSemanticDir: b.hasSemanticDir,
      domainCount: /** @type {string} */ (b.domainCount),
      activations: /** @type {number} */ (b.activations),
      canvasOpens: /** @type {number} */ (b.canvasOpens),
      stages,
      schemaFormats,
      modelCount: /** @type {string} */ (b.modelCount),
      manifest: /** @type {string} */ (b.manifest),
      catalog: b.catalog,
      features: features.counts,
      errors: errors.counts,
      host: /** @type {string | null} */ (host),
      remote: /** @type {string | null} */ (remote),
      dev: typeof b.dev === 'boolean' ? b.dev : null,
      assistants,
      harnesses,
      activeDays28: /** @type {string | null} */ (activeDays28),
      canvasDays28: /** @type {string | null} */ (canvasDays28),
      firstCanvas: /** @type {string | null} */ (firstCanvas),
      physicalTools,
      platforms,
      trail: trail === null ? null : trail.entries,
      trailDropped: trail === null ? null : typeof b.trailDropped === 'number' ? b.trailDropped : 0,
      diagrams,
    },
  };
}

/**
 * The onboarding trail: an array of at most {@link MAX_TRAIL} entries
 * `[event, gap, window, repeat]`, every value checked. An event this Worker
 * does not list (from a newer extension) is dropped and counted in `dropped`
 * (the ledger keeps the count, never the event), and the rest keep their
 * order; anything else malformed refuses the heartbeat ({@link INVALID}).
 *
 * @param {unknown} value
 * @returns {{ entries: Array<[string, number, number, number]>, dropped: number } | typeof INVALID}
 */
function trailOf(value) {
  if (!Array.isArray(value) || value.length > MAX_TRAIL) return INVALID;
  /** @type {Array<[string, number, number, number]>} */
  const entries = [];
  let dropped = 0;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) return INVALID;
    const [event, gap, window, repeat] = entry;
    if (typeof event !== 'string' || !/^!?[A-Za-z0-9]{1,64}$/.test(event)) return INVALID;
    if (!isIntIn(gap, 0, MAX_TRAIL_GAP_S) || !isIntIn(window, 1, MAX_TRAIL_WINDOWS) || !isIntIn(repeat, 1, MAX_TRAIL_REPEAT)) return INVALID;
    if (TRAIL_EVENTS.has(event)) entries.push([event, gap, window, repeat]);
    else dropped += 1;
  }
  return { entries, dropped };
}

/**
 * Use per diagram: an array of `[id, opens, edits]`, one entry per id, at
 * most {@link MAX_DIAGRAMS} with an id from 1 to {@link MAX_DIAGRAM_ID} plus
 * one with id 0 (the rest of the day's diagrams added up). Every value is a
 * whole number in range; anything else refuses the heartbeat ({@link INVALID}).
 *
 * @param {unknown} value
 * @returns {Array<[number, number, number]> | typeof INVALID}
 */
function diagramsOf(value) {
  if (!Array.isArray(value) || value.length > MAX_DIAGRAMS + 1) return INVALID;
  /** @type {Array<[number, number, number]>} */
  const entries = [];
  const seen = new Set();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return INVALID;
    const [id, opens, edits] = entry;
    if (!isIntIn(id, 0, MAX_DIAGRAM_ID) || seen.has(id)) return INVALID;
    if (!isIntIn(opens, 0, 200) || !isIntIn(edits, 0, MAX_DIAGRAM_EDITS)) return INVALID;
    seen.add(id);
    entries.push([id, opens, edits]);
  }
  if (entries.length - (seen.has(0) ? 1 : 0) > MAX_DIAGRAMS) return INVALID;
  return entries;
}

/** Marks an optional field that is present but invalid. */
const INVALID = Symbol('invalid');

/**
 * `null` when absent, the value when it is one of `allowed`, else {@link INVALID}.
 *
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {string | null | typeof INVALID}
 */
function optionalOneOf(value, allowed) {
  if (value === undefined) return null;
  return isOneOf(value, allowed) ? value : INVALID;
}

/**
 * A real `YYYY-MM-DD` calendar date between {@link MAX_DAY_AGE_DAYS} days ago
 * and today, UTC. Today is allowed (not only yesterday) so a client whose
 * clock is a few minutes ahead of ours is not refused at midnight, and
 * tomorrow within {@link MAX_CLOCK_AHEAD_MS} of our midnight, for the 2.0
 * interim copy of a fast clock's new day.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {boolean}
 */
function isAcceptableDay(value, now) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse accepts 2026-02-31 and rolls it over, so round-trip to reject it.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return false;
  const latest = utcDay(now + MAX_CLOCK_AHEAD_MS);
  const oldest = utcDay(now - MAX_DAY_AGE_DAYS * 86_400_000);
  // ISO dates compare correctly as strings.
  return value <= latest && value >= oldest;
}

/**
 * @param {unknown} value
 * @param {RegExp} pattern
 * @returns {value is string}
 */
function isVersion(value, pattern) {
  return typeof value === 'string' && value.length <= MAX_VERSION_CHARS && pattern.test(value);
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {value is string}
 */
function isOneOf(value, allowed) {
  return typeof value === 'string' && allowed.has(value);
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {value is number}
 */
function isIntIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The elements of `value` in `allowed` order, or `null` when it is not an
 * array or holds anything outside `allowed`. Duplicates collapse — they say
 * nothing the single value does not.
 *
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {string[] | null}
 */
function subsetOf(value, allowed) {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) return null;
  }
  return allowed.filter((item) => value.includes(item));
}

/**
 * A `{ key: count }` object reduced to the `allowed` keys, in `allowed` order,
 * with zero counts dropped. `undefined` is an empty object. Unknown keys are
 * dropped (a newer extension may know more features than we do) and only
 * counted, in `dropped`, never named; a known key with a non-integer or
 * out-of-range count is `null`.
 *
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {{ counts: Record<string, number>, dropped: number } | null}
 */
function countsOf(value, allowed) {
  if (value === undefined) return { counts: {}, dropped: 0 };
  if (!isPlainObject(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const count = source[key];
    if (!isIntIn(count, 0, 100)) return null;
    if (count > 0) counts[key] = count;
  }
  const known = new Set(allowed);
  const dropped = Object.keys(source).filter((key) => !known.has(key)).length;
  return { counts, dropped };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------------

/**
 * Reads at most `limit` bytes from `stream`, refusing rather than truncating.
 *
 * `Content-Length` is checked first so an oversized declared body costs
 * nothing, but the stream is counted too: the header is a claim, not a fact,
 * and a chunked body has none at all.
 *
 * @param {ReadableStream<Uint8Array> | null} stream
 * @param {number} limit
 * @param {string | null} [declaredLength]
 * @returns {Promise<{ ok: true, text: string } | { ok: false }>}
 */
async function readLimited(stream, limit, declaredLength) {
  if (declaredLength !== null && declaredLength !== undefined) {
    const declared = Number(declaredLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > limit) return { ok: false };
  }
  if (!stream) return { ok: true, text: '' };

  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `[vars]` are JSON values, so `KILL_SWITCH = true` arrives as a boolean.
 * Booleans and numbers are honoured both ways; any other non-string value is
 * unrecognised and refuses rather than serving on a switch that was set. Same
 * rule as the feedback proxy's.
 *
 * @param {Env} env
 * @returns {boolean}
 */
function isKilled(env) {
  const raw = env.KILL_SWITCH;
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw !== 'string') return true;
  const value = raw.trim().toLowerCase();
  return !(value === '' || value === '0' || value === 'false' || value === 'off' || value === 'no');
}

/**
 * @param {number} now epoch ms
 * @returns {string} `YYYY-MM-DD`, UTC
 */
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Responses and logging
// ---------------------------------------------------------------------------

/** @returns {Record<string, string>} */
function baseHeaders() {
  return { 'Cache-Control': 'no-store' };
}

/**
 * An empty-bodied refusal plus one counted log line. The extension ignores the
 * response entirely, so there is nothing useful to put in a body.
 *
 * @param {number} status
 * @param {string} reason literal label for the log — never derived from input
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function refuse(status, reason, headers) {
  log({ event: 'denied', status, reason });
  return new Response(null, { status, headers: { ...baseHeaders(), ...headers } });
}

/**
 * The only logging in this Worker. **Fixed labels and numbers only** — never a
 * body field, a header or an IP.
 *
 * @param {Record<string, string | number>} fields
 * @returns {void}
 */
function log(fields) {
  try {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
  } catch {
    // Logging must never be the thing that fails a request.
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).name) === 'string') {
    return (/** @type {any} */ (err).name);
  }
  return 'Error';
}

/**
 * @typedef {Object} Heartbeat
 * @property {string} installId
 * @property {string} day
 * @property {string} extVersion
 * @property {string} vscodeMajor
 * @property {string} os
 * @property {string} tenure
 * @property {string} activation
 * @property {boolean} hasSemanticDir
 * @property {string} domainCount
 * @property {number} activations
 * @property {number} canvasOpens
 * @property {string[]} stages
 * @property {string[]} schemaFormats
 * @property {string} modelCount
 * @property {string} manifest
 * @property {boolean} catalog
 * @property {Record<string, number>} features
 * @property {Record<string, number>} errors
 * @property {string | null} host
 * @property {string | null} remote
 * @property {boolean | null} dev
 * @property {string[] | null} assistants
 * @property {string[] | null} harnesses
 * @property {string | null} activeDays28
 * @property {string | null} canvasDays28
 * @property {string | null} firstCanvas
 * @property {string[] | null} physicalTools
 * @property {string[] | null} platforms
 * @property {Array<[string, number, number, number]> | null} trail
 * @property {number | null} trailDropped
 * @property {Array<[number, number, number]> | null} diagrams
 */

/**
 * How many unknown `features` / `errors` keys and trail events an accepted
 * heartbeat carried (and this Worker dropped).
 *
 * @typedef {Object} Dropped
 * @property {number} features
 * @property {number} errors
 * @property {number} trail
 */

/**
 * One `worker_daily` increment.
 *
 * @typedef {Object} LedgerEntry
 * @property {string} day the UTC day this Worker received the request
 * @property {string} family `major.minor` or `other`
 * @property {'ok' | 'denied'} outcome
 * @property {string} reason `none`, `body_size`, `json` or `shape_<field>`
 * @property {Dropped} dropped
 */

/**
 * The part of the Workers runtime context this Worker uses.
 *
 * @typedef {Object} ExecutionContext
 * @property {(promise: Promise<unknown>) => void} waitUntil
 */

/**
 * @typedef {Object} Env
 * @property {D1Database} DB The `erd-studio-telemetry` D1 database.
 * @property {string|boolean|number} [KILL_SWITCH] Any truthy-looking value makes every request 503.
 */

/**
 * Minimal shape of the D1 binding this Worker uses — declared so the file
 * type-checks on its own, without `@cloudflare/workers-types` installed.
 *
 * @typedef {Object} D1Database
 * @property {(sql: string) => D1PreparedStatement} prepare
 *
 * @typedef {Object} D1PreparedStatement
 * @property {(...values: unknown[]) => D1PreparedStatement} bind
 * @property {() => Promise<{ meta?: { changes?: number } }>} run
 */
