/**
 * Pure half of the usage telemetry: the daily counters, the reducers that
 * update them, and the one function that turns a finished day into the
 * heartbeat body the telemetry Worker accepts.
 *
 * Keep this module free of `vscode` and of Node built-ins. Everything the
 * heartbeat can say is decided here, by type: a feature or error is one of the
 * fixed keys below or it cannot be recorded at all, and every size is a bucket
 * rather than a number. There is no field that could carry a name, a path or a
 * message, so there is nothing to scrub. `TelemetryService` owns storage,
 * timing and the network.
 *
 * The shape is a contract with `telemetry/` (the Worker) — change both
 * together, and bump `HEARTBEAT_VERSION` when a field changes meaning.
 */

import type { TableLoadErrorKind } from '@erd-studio/core';

export const HEARTBEAT_VERSION = 1;

/** Features whose use is counted. The Worker drops any key not in this list. */
export const FEATURES = [
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
  // Once per day at most (recordFeatureOnce): an ERD Studio AI harness file
  // is installed in the open project. A presence flag, not a usage count.
  'harnessPresent',
  // #113 — where a missing manifest is met (once per day each, featureOnce).
  'manifestMissingCanvas',
  'manifestMissingPhysical',
  'manifestMissingDraw',
  'manifestMissingWelcome',
  'manifestMissingRefresh',
  // #113 — why it is missing (once per day each; booleans only, never a path).
  'manifestNoTargetDir',
  'manifestCustomTargetPath',
  'manifestNoDbtFound',
  // #113 — a manifest.json appeared after being missing: within 10 minutes of
  // a Run dbt parse launch, or otherwise.
  'manifestAfterParse',
  'manifestAppeared',
  // #113 — the Logical-stage missing-manifest hint was dismissed.
  'manifestHintDismissed',
  // Canvas edit requests, one per accepted message, by kind (EDIT_FEATURES).
  'editModel',
  'editColumn',
  'editKey',
  'editDetails',
  'editRelationship',
  'editLayout',
  'editAnnotation',
  'editUndo',
  // How long an auto layout took in the webview, or that it failed.
  'layoutUnder1s',
  'layout1to5s',
  'layoutOver5s',
  'layoutFailed',
  // Where diagrams come from: the New Domain command, or a domain file that
  // appeared on disk without ERD Studio writing it (an AI assistant, a hand
  // edit, a git pull).
  'domainCreated',
  'domainCreatedExternal',
  // Onboarding steps.
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
  // The generic Agent Skills target (.agents/skills/), installed for Copilot,
  // Codex, Gemini CLI or Cursor.
  'harnessInstallAgents',
  // Getting-started funnel: where a new user stops, and the routes taken.
  // User choices and project states only — anything that broke is an ERROR_CODE.
  // Import from dbt (the command, also reached from the Welcome panel and the walkthrough).
  'drawStarted',
  'drawNoModels',
  'drawNoLayers',
  'drawCancelScope',
  'drawCancelLayer',
  'drawCancelName',
  'drawNothingDrawable',
  // Add models from dbt on a canvas (the empty-canvas card and the toolbar).
  'addFromDbtStarted',
  'addFromDbtNeedsV5',
  'addFromDbtNoModels',
  'addFromDbtAllPresent',
  'addFromDbtCancelled',
  'addFromDbtNothingDrawable',
  // Try the Sample Project.
  'trySampleCancelled',
  'trySampleNoGit',
  // Set Up My AI Helper: a hand-written skill was in the way, and the Replace /
  // Keep mine modal was dismissed.
  'setupHelperConflict',
  'setupHelperCancelled',
  // An assistant launch button was pressed before the helper was set up.
  'helperFirstPrompt',
  // Which route Open Claude Code took, or that its confirm was dismissed.
  'openClaudeCli',
  'openClaudeExtension',
  'openClaudeNotFound',
  'openClaudeCancelled',
  // Open Copilot Chat: no chat command (docs opened instead), or only the bare open worked.
  'copilotChatNotFound',
  'copilotChatNoArgs',
  // Welcome panel buttons that lead to a diagram.
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
  // Relationship rework (#133). Use of the new behaviour, one per action:
  // a drag from the "one" side stored turned round on the many side; ⇄ moved
  // the record to the other model's file; ⇄ refused because it would make a
  // whole key the many side; a delete removed more than one stored copy; the
  // notice that another diagram still draws its own copy of a deleted link; a
  // role set or changed; the New Relationship dialog's "Create anyway"
  // against key evidence; the dialog asked for the direction (no evidence);
  // "Mark as key" used; a composite link or a self-reference created; and
  // (once a day, on canvas open) a link drawn whose ends are spelled in
  // another case than the real names.
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
  // Move Relationships (#133), once per completed run that did each: moved a
  // one-to-many to its many side, turned a backwards many-to-one round, showed
  // a conflict picker, left two disagreeing model-file copies, left a model
  // file alone (it would lose a comment or an unreadable entry), kept the
  // model library's version over a diagram copy that differed, left a
  // composite key whole in the diagrams because it could not move.
  'relMoveRehomed',
  'relMoveTurned',
  'relMoveConflictShown',
  'relMoveDisagreementLeft',
  'relMoveFileLocked',
  'relMoveKeptLibrary',
  'relMoveGroupLeft',
  // The state of the user's relationships, once a day each, on canvas open
  // (relationshipHealth.surveyLibrary). Their files, not our failures — a
  // write that produces one of these is caught by a relInv* error instead.
  'relStateStoredTwice',
  'relStateOneToMany',
  'relStateBackwards',
  'relStateDanglingModel',
  'relStateDanglingColumn',
  'relStateUnreadable',
  'relStatePartialComposite',
  'relStateDomainCopy',
  // Export Diagram… (Mermaid / DBML): one per completed export, by format,
  // and a cancel at any step. A failure is the `exportFailed` error.
  'exportMermaid',
  'exportDbml',
  'exportCancelled',
  // A project state, not a cancel: run with no canvas focused and no diagram to pick.
  'exportNoDiagrams',
  // DBML round trip: the rich export (positions in its erd_layout), Export All
  // Diagrams…, and Import DBML… — a completed import, one whose file had an
  // erd_layout, a cancel at any step, and a file DBML could not read (the
  // user's file, not a failure of ours). A failure is `importDbmlFailed`.
  'exportDbmlRich',
  'exportAll',
  'importDbml',
  'importDbmlLayout',
  'importDbmlCancelled',
  'importDbmlInvalid',
  // Logical-only mode (a folder without dbt_project.yml): activation resolved
  // such a root (once a day, featureOnce); Open Example Diagram wrote the
  // example; New Diagram created a diagram in such a project.
  'logicalOnlyProject',
  'exampleDiagram',
  'blankDiagram',
  // Native DBML storage (2.0): a DBML project was open (presence, once a day);
  // Convert Project to DBML finished; its offer was shown and answered
  // (declined for good, or Not Now); the command was closed before it wrote,
  // or refused the project (a user's state, not a failure); and the toast
  // that an older helper wrote a .yml or .json into a DBML project.
  'dbmlProject',
  'convertToDbml',
  'convertToDbmlOffered',
  'convertToDbmlDeclined',
  'convertToDbmlNotNow',
  'convertToDbmlCancelled',
  'convertToDbmlRefused',
  'dbmlForeignFormatWarned',
  // The start screen (the first five minutes; src/types/startActions.ts): a
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
  // shown, and the user's answer: Convert to DBML… (suggestPromptAccepted;
  // Show Me is suggestPromptShowMe), More Options… (no longer sent), Don't
  // Ask Again, or closed; start suggestions turned off by the command (or, once
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
  // was opened (every import source; no longer sent: the draft's details
  // drawer replaced it, draftDetailsOpened).
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
  // Draft-first (docs/dev/draft-first.md §11): the read-only draft preview and what was chosen on it.
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
  // Each window's activation outcome, counted per activation (the `activation`
  // field keeps only the day's last): a dbt project, a folder without dbt
  // (logical-only), no folder. Then a presence flag, once a day: a
  // dbt_project.yml exists in the workspace (seen by project discovery, the
  // host's search, the start screen's look or the tooling scan) that this
  // window does not use.
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
  'dbtParseOpenPhysical',    // Open Physical view was pressed after a parse and switched a diagram
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
  // The automatic draft stopped by the import's time limit before it read a table.
  'draftDropTimeLimit',
  // Added after 2.0.0. The import guide's Microsoft Fabric card: its catalog
  // query's Import the CSV… button, a copy of that query (beside
  // importGuideCopied), and how an import started from either of the card's
  // SQL buttons ended (beside importOutcomeSqlDdl* and importSqlOutcome*,
  // never instead of them: Fabric is read as SQL Server).
  'importGuideActionFabricCatalog',
  'importGuideCopiedFabricCatalog',
  'importFabricOutcomeClean',
  'importFabricOutcomeRepaired',
  'importFabricOutcomePartial',
  'importFabricOutcomeFail',
  'importFabricOutcomeCancelled',
  'importFabricOutcomeTimedOut',
  // The major update notice (src/services/majorUpdateNotice.ts), once per
  // machine per major version: it showed, its Show Me Around was pressed
  // (beside the guide's own keys), its What's New was pressed (the bundled
  // changelog opened). Never a version.
  'majorUpdateNoticeShown',
  'majorUpdateNoticeShowMeAround',
  'majorUpdateNoticeWhatsNew',
  // Added after 2.0.4. An auto layout (the canvas's or a draft page's) whose
  // default attempt failed was produced by a fallback: Brandes–Köpf node
  // placement (rung 2), or that with post-compaction left out (rung 3).
  'layoutFallbackRung2',
  'layoutFallbackRung3',
  // #304: the host's search for dbt_project.yml failed (dbtSearchFailed) and
  // the bounded walk alone still found a dbt project. Not an error: the user
  // lost nothing. Activation only, never Select dbt Project….
  'dbtSearchFailedWalkFound',
] as const;
export type TelemetryFeature = (typeof FEATURES)[number];

/** Failure classes that are counted. Anything else is `other`. */
export const ERROR_CODES = [
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
  // Why a logical-models file failed (#110), recorded beside `modelFileParse`,
  // which stays the total. One per TableFileErrorKind, via tableFileErrorCode().
  'modelFileRead',
  'modelFileYamlIndent',
  'modelFileYamlScalar',
  'modelFileYamlStructure',
  'modelFileYamlDuplicateKey',
  'modelFileYamlOther',
  // Getting started: each one means something broke on a new user's path.
  // The walkthrough command threw (the Welcome panel opened instead).
  'walkthroughFailed',
  // Import from dbt threw, or could not write the diagram.
  'drawFromDbtFailed',
  'drawWriteFailed',
  // Add models from dbt on a canvas threw (a rejected edit is `editRejected`).
  'addFromDbtFailed',
  // An auto layout failed in the webview; `firstLayoutFailed` is the subset
  // that was the first-open layout of a fresh diagram.
  'layoutFailed',
  'firstLayoutFailed',
  // git.clone of the sample project threw (the GitHub page was offered instead).
  'sampleCloneFailed',
  // Set Up My AI Helper: the skill install failed, the launcher install failed,
  // the launcher's VS Code runtime check failed, or the flow threw.
  'setupHarnessFailed',
  'launcherInstallFailed',
  'launcherRuntimeUnverified',
  'setupFailed',
  // Open Claude Code: the extension is installed but none of the known open
  // commands exists, or the one found threw.
  'claudeOpenCommandMissing',
  'claudeOpenFailed',
  // Open Copilot Chat: the chat command exists but both ways of opening it threw.
  'copilotChatOpenFailed',
  // A Welcome panel message handler or status check threw.
  'welcomePanelFailed',
  // erdStudio.projectPath names a folder with no dbt_project.yml.
  'projectPathInvalid',
  // Why a canvas failed to load, recorded beside `domainLoad`, which stays the
  // total. One per SubjectAreaLoadFailure, via subjectAreaLoadErrorCode().
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
  // Relationship rework (#133). A relationship write whose edit or save
  // failed; a relationship handler threw something other than a refusal it
  // explains; a model file's relationships: list could not be rewritten in
  // place, so the edit was refused; a Move write failed and some file could
  // not be put back.
  'relWriteFailed',
  'relHandlerFailed',
  'relSyncRefused',
  'relMoveRestoreFailed',
  // A relationship write broke an invariant (relationshipHealth
  // .checkRelationshipWrite). Recorded, logged, never blocking: the written
  // link is not one canonical copy in its home, not the cardinality or
  // direction asked for, lost its role; a deleted (or re-keyed) link left a
  // copy; another link vanished or changed; a file gained a duplicate entry;
  // the canvas draws a link twice; a composite key is no longer one valid
  // group; "Mark as primary key" did not flag the key; the check itself threw.
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
  // Export Diagram… could not read the domain or write the chosen file.
  'exportFailed',
  // Why a domain file's text could not be parsed, split out of `domainLoadJson`
  // (which stays the fallback, now only a JSON syntax error): the file stayed
  // empty through every re-read, or it holds unresolved git conflict markers.
  'domainLoadEmpty',
  'domainLoadConflict',
  // Why a save counted as `saveFailed` failed, recorded beside it (which stays
  // the total): VS Code refused it and the file is still unsaved (typically
  // changed on disk since VS Code read it), save() threw (typically a closed
  // document: ours to fix), or re-opening the document to save it threw
  // (typically the file system: the user's). `saveFailedModelFile`: a model
  // file was among the unsaved (otherwise only diagram files were).
  // `saveFailedRename` / `saveFailedUndoRedo`: the failure came from the
  // duplicate-model rename or an undo/redo flush, not a canvas edit.
  'saveFailedRefused',
  'saveFailedThrew',
  'saveFailedModelFile',
  'saveFailedRename',
  'saveFailedReopen',
  'saveFailedUndoRedo',
  // Import DBML… could not write the new diagram (appended after the saveFailed split).
  'importDbmlFailed',
  // Native DBML storage (2.0): why a .dbml table file failed, counted beside
  // modelFileParse (a DBML syntax error, a file DBML rejects, a file that is
  // not one self-contained Table); a .dbml diagram DBML could not read,
  // beside domainLoad; and Convert Project to DBML failed while writing.
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
  // Draft-first: building a draft threw (ours), and the preview's layout (ELK) failed.
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
  // #304: why the host's search for dbt_project.yml failed, one beside each
  // dbtSearchFailed (the total): findFiles rejected, reading or sorting what
  // it returned threw, or findFiles threw before returning a promise.
  'dbtSearchFailedRejected',
  'dbtSearchFailedSort',
  'dbtSearchFailedThrew',
] as const;
export type TelemetryErrorCode = (typeof ERROR_CODES)[number];

/**
 * The onboarding trail's own events, beside every {@link FEATURES} key and
 * {@link ERROR_CODES} code: a window opened (activation) or closed (best
 * effort: VS Code may not wait for it), the window lost and regained the focus
 * (another app or VS Code window, only when away 5 s or more), a canvas opened,
 * closed, or went behind another tab and came back (5 s or more). Append-only;
 * the Worker keeps the same list in the same order.
 */
export const TRAIL_MARKERS = [
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
] as const;
export type TrailMarker = (typeof TRAIL_MARKERS)[number];
/**
 * A trail event: a {@link FEATURES} key, an {@link ERROR_CODES} code written
 * `!code` (a few codes share a feature's name, `layoutFailed`), or a marker.
 */
export type TrailEvent = TelemetryFeature | `!${TelemetryErrorCode}` | TrailMarker;

/** The trail's id for an error code. */
export function trailError(code: TelemetryErrorCode): `!${TelemetryErrorCode}` {
  return `!${code}`;
}

/**
 * One entry of the onboarding trail: `[event, gap, window, repeat]`.
 * - `event`: a fixed id ({@link TrailEvent}), never a name, path or message;
 * - `gap`: whole seconds since the trail's previous entry (any window), 0 for
 *   the day's first, capped at {@link MAX_TRAIL_GAP_S} ("an hour or more");
 * - `window`: which window it came from, numbered 1, 2, … in the order each
 *   first added to the day's trail (capped at {@link MAX_TRAIL_WINDOWS});
 * - `repeat`: the same event again from the same window straight after,
 *   folded into one entry (a run of `editLayout` while dragging), capped at
 *   {@link MAX_COUNTER}.
 * The time spent on a step is the next entry's `gap`.
 */
export type TrailEntry = [event: TrailEvent, gap: number, window: number, repeat: number];

/** The trail is kept for an install's first days (and any day the guide runs). */
export const TRAIL_DAYS = 7;
/** At most this many entries a day; later ones are only counted (`trailDropped`). */
export const MAX_TRAIL = 100;
/**
 * B15: entries past this many take only errors (`!code`) and the
 * `windowClosed` / `canvasClosed` markers, so a busy day still shows what went
 * wrong and how it ended. Other events past it are only counted.
 */
export const TRAIL_GENERAL_MAX = 90;
export const MAX_TRAIL_GAP_S = 3600;
export const MAX_TRAIL_WINDOWS = 20;
export const MAX_TRAIL_DROPPED = 10000;
/** A focus or tab change shorter than this is not news (alt-tab and back). */
export const TRAIL_AWAY_MIN_MS = 5000;

const TRAIL_EVENT_SET: ReadonlySet<string> = new Set<string>([...TRAIL_MARKERS, ...FEATURES, ...ERROR_CODES.map(trailError)]);

export function isTrailEvent(value: unknown): value is TrailEvent {
  return typeof value === 'string' && TRAIL_EVENT_SET.has(value);
}

export type ActivationOutcome = 'project_found' | 'no_project';
export type TenureBucket = '0' | '1-7' | '8-30' | '31-90' | '90+';
export type SubjectAreaCountBucket = '0' | '1-3' | '4-10' | '10+';
/** `none` means no canvas with a model in it was opened that day. */
export type TableCountBucket = 'none' | '1-10' | '11-50' | '51+';
export type ManifestState = 'ok' | 'missing' | 'stale' | 'unknown';
export type TelemetryStage = 'logical' | 'physical';
export type TelemetrySchemaFormat = 'v5' | 'v4';
export type TelemetryOs = 'darwin' | 'win32' | 'linux' | 'other';

export const MAX_ACTIVATIONS = 50;
export const MAX_CANVAS_OPENS = 200;
export const MAX_COUNTER = 100;
/** At most this many diagrams are listed for one day; the rest are added up under {@link OTHER_DIAGRAM_ID}. */
export const MAX_DIAGRAMS = 30;
/** A diagram's number is a random integer from 1 to this, made up on the device ({@link DiagramUse}). */
export const MAX_DIAGRAM_ID = 65535;
/** The entry that adds up every diagram past {@link MAX_DIAGRAMS} on one day. */
export const OTHER_DIAGRAM_ID = 0;
export const MAX_DIAGRAM_EDITS = 1000;

/** The Worker refuses a day older than this, so a heartbeat for one is not sent. */
export const MAX_HEARTBEAT_AGE_DAYS = 7;

/** How far back the on-device retention counts look, in days (including the reported day). */
export const RETENTION_WINDOW_DAYS = 28;

/**
 * The editor app the extension runs in, from `vscode.env.appName`. A fixed
 * list: an app not named here is `other`, never its name.
 */
export const HOSTS = [
  'vscode',
  'vscodeInsiders',
  'cursor',
  'windsurf',
  'vscodium',
  'trae',
  'kiro',
  'positron',
  'antigravity',
  'other',
] as const;
export type TelemetryHost = (typeof HOSTS)[number];

/** Where the extension host runs: `vscode.env.remoteName`, or `web` for vscode.dev-style hosts. */
export const REMOTES = ['local', 'ssh', 'wsl', 'container', 'codespaces', 'web', 'other'] as const;
export type TelemetryRemote = (typeof REMOTES)[number];

/** AI assistants, in `AI_ASSISTANTS` order (`src/types/aiAssistants.ts`). */
export const ASSISTANTS = ['claude', 'copilot', 'codex', 'gemini', 'cursor'] as const;
export type TelemetryAssistant = (typeof ASSISTANTS)[number];

/** ERD Studio harness targets, as `HARNESS_TARGETS` ids. */
export const HARNESSES = ['claude', 'agents', 'copilot', 'gemini', 'codex'] as const;
export type TelemetryHarness = (typeof HARNESSES)[number];

/**
 * How the open workspace builds its physical tables, as found by
 * `detectPhysicalTooling()` (`src/services/physicalTooling.ts`).
 */
export const PHYSICAL_TOOLS = [
  'dbt',
  'sqlmesh',
  'dataform',
  'databricksBundle',
  'fabric',
  'powerBi',
  'sqlProject',
  'flyway',
  'liquibase',
  'alembic',
  'prisma',
  'django',
  'rails',
  'notebooks',
  'ddlScripts',
  'dbml',
] as const;
export type TelemetryPhysicalTool = (typeof PHYSICAL_TOOLS)[number];

/** The data platforms those tables live on, from the same detection. */
export const PLATFORMS = [
  'databricks',
  'snowflake',
  'bigquery',
  'postgres',
  'redshift',
  'fabric',
  'synapse',
  'sqlserver',
  'duckdb',
  'spark',
  'trino',
  'athena',
  'mysql',
  'oracle',
  'clickhouse',
  'other',
] as const;
export type TelemetryPlatform = (typeof PLATFORMS)[number];

/** How many of the last {@link RETENTION_WINDOW_DAYS} days something happened on. */
export type RecentDaysBucket = '0' | '1' | '2-3' | '4-7' | '8-14' | '15-28';
/** Days from first activation to the first canvas open, or `never` (yet). */
export type FirstCanvasBucket = TenureBucket | 'never';

/**
 * One diagram's use on one day: `[id, opens, edits]`. `id` is a random number
 * the extension made up for the diagram and keeps on the device; it is not
 * derived from the diagram's name, path or contents, so it says only "the same
 * diagram as on another day". `opens` counts canvas opens, `edits` the edit
 * requests made on its canvas.
 */
export type DiagramUse = [id: number, opens: number, edits: number];

/** Everything counted for one UTC day, as kept in globalState. */
export interface DailyCounters {
  /** The UTC day (`YYYY-MM-DD`) these counts describe. */
  day: string;
  /** Most recent activation outcome; `null` until this window has activated. */
  activation: ActivationOutcome | null;
  hasSemanticDir: boolean;
  domainCount: SubjectAreaCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: TableCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
  /**
   * The running environment, stamped on every update ({@link stampEnv}) so the
   * day is labelled with the version that counted it, not the one running when
   * the heartbeat goes out the next day. Absent in counters from older builds.
   */
  env?: CounterEnv;
  /** Today's use per diagram ({@link recordDiagramUse}). Absent until a diagram is opened or edited. */
  diagrams?: DiagramUse[];
  /** AI assistants detected on this machine today (union). */
  assistants?: TelemetryAssistant[];
  /** ERD Studio harness targets installed and version-marked in the open project today (union). */
  harnesses?: TelemetryHarness[];
  /**
   * How today's workspaces build their physical tables (union). Absent when no
   * detection ran today, which is sent as absent — not as an empty list, which
   * means "looked, found nothing". Not carried over by {@link nextDay}: it
   * describes workspaces, and detection runs again on the next day's activation.
   */
  physicalTools?: TelemetryPhysicalTool[];
  /** The data platforms found by the same detection (union), on the same terms. */
  platforms?: TelemetryPlatform[];
  /**
   * The onboarding trail ({@link recordTrail}): the day's events in order, with
   * the seconds between them. Absent on a day it was not kept ({@link trailKept}).
   */
  trail?: TrailEntry[];
  /** Entries past {@link MAX_TRAIL}, counted only. */
  trailDropped?: number;
  /** Epoch ms of the trail's last entry, for the next gap. Kept on the device; never sent. */
  trailAt?: number;
  /** `trailAt` before the last entry, so {@link retractTrail} can put it back. Never sent. */
  trailPrevAt?: number;
}

/** The per-day environment facts, as stamped by {@link stampEnv}. */
export interface CounterEnv {
  extVersion: string;
  vscodeVersion: string;
  host: TelemetryHost;
  remote: TelemetryRemote;
  /** Any update today came from an Extension Development Host or a test run. */
  dev: boolean;
}

/** What the extension host knows about itself, supplied at send time. */
export interface HeartbeatEnv {
  installId: string;
  extVersion: string;
  /** `vscode.version`, e.g. `1.104.2`. Reduced to `major.minor`. */
  vscodeVersion: string;
  /** `process.platform`. */
  platform: string;
  /** The UTC day of first activation (`YYYY-MM-DD`). */
  firstSeenDay: string;
  /** Recent UTC days with an activation — kept on the device, never sent as dates. */
  activeDays?: string[];
  /** Recent UTC days with a canvas open — kept on the device, never sent as dates. */
  canvasDays?: string[];
  /** The UTC day a canvas was first opened, if ever. */
  firstCanvasDay?: string | null;
  /** Fallback when the counters carry no stamped environment (older stored state). */
  host?: TelemetryHost;
  remote?: TelemetryRemote;
  dev?: boolean;
}

/** The exact request body POSTed to `/v1/heartbeat`. */
export interface HeartbeatBody {
  v: typeof HEARTBEAT_VERSION;
  installId: string;
  day: string;
  extVersion: string;
  vscodeMajor: string;
  os: TelemetryOs;
  tenure: TenureBucket;
  activation: ActivationOutcome;
  hasSemanticDir: boolean;
  domainCount: SubjectAreaCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: TableCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
  host: TelemetryHost;
  remote: TelemetryRemote;
  dev: boolean;
  assistants: TelemetryAssistant[];
  harnesses: TelemetryHarness[];
  activeDays28: RecentDaysBucket;
  canvasDays28: RecentDaysBucket;
  firstCanvas: FirstCanvasBucket;
  /** Omitted when no detection ran that day. */
  physicalTools?: TelemetryPhysicalTool[];
  /** Omitted when no detection ran that day. */
  platforms?: TelemetryPlatform[];
  /** Use per diagram that day; omitted when no diagram was opened or edited. */
  diagrams?: DiagramUse[];
  /** The onboarding trail; omitted on a day it was not kept. */
  trail?: TrailEntry[];
  /** With `trail`: entries past its cap, counted only. */
  trailDropped?: number;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** The UTC day of `date` as `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export function tenureBucket(days: number): TenureBucket {
  if (days <= 0) return '0';
  if (days <= 7) return '1-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return '90+';
}

export function subjectAreaCountBucket(count: number): SubjectAreaCountBucket {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 10) return '4-10';
  return '10+';
}

export function tableCountBucket(count: number): TableCountBucket {
  if (count <= 0) return 'none';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  return '51+';
}

const TABLE_COUNT_ORDER: readonly TableCountBucket[] = ['none', '1-10', '11-50', '51+'];

export function recentDaysBucket(count: number): RecentDaysBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 7) return '4-7';
  if (count <= 14) return '8-14';
  return '15-28';
}

/** `vscode.env.appName` → a fixed host id. Order matters: Insiders before stable. */
export function hostBucket(appName: string): TelemetryHost {
  const name = appName.toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name.includes('trae')) return 'trae';
  if (name.includes('kiro')) return 'kiro';
  if (name.includes('positron')) return 'positron';
  if (name.includes('antigravity')) return 'antigravity';
  if (name.includes('visual studio code')) return name.includes('insiders') ? 'vscodeInsiders' : 'vscode';
  return 'other';
}

/** `vscode.env.remoteName` (undefined when local) and whether the UI is the web one. */
export function remoteBucket(remoteName: string | undefined, isWeb: boolean): TelemetryRemote {
  if (!remoteName) return isWeb ? 'web' : 'local';
  if (remoteName === 'ssh-remote') return 'ssh';
  if (remoteName === 'wsl') return 'wsl';
  if (remoteName === 'dev-container' || remoteName === 'attached-container') return 'container';
  if (remoteName === 'codespaces') return 'codespaces';
  return 'other';
}

/**
 * `days` plus `day`, dropping days more than {@link RETENTION_WINDOW_DAYS} days
 * before `day`, sorted and without duplicates. The dates stay on the device; only the
 * count ({@link recentDaysCount}) is sent.
 */
export function rememberDay(days: readonly string[] | undefined, day: string): string[] {
  // Only days that have aged out are dropped; a later day (the clock moved
  // back) is kept, and recentDaysCount ignores it until it is in the window.
  const kept = new Set((days ?? []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && daysBetween(d, day) < RETENTION_WINDOW_DAYS));
  kept.add(day);
  return [...kept].sort();
}

/** How many of `days` fall in the {@link RETENTION_WINDOW_DAYS} days ending on `day`. */
export function recentDaysCount(days: readonly string[] | undefined, day: string): number {
  return new Set((days ?? []).filter(d => inWindow(d, day))).size;
}

function inWindow(d: string, day: string): boolean {
  const age = daysBetween(d, day);
  return age >= 0 && age < RETENTION_WINDOW_DAYS;
}

/** Days from first activation to the first canvas, as of `day`. */
export function firstCanvasBucket(firstSeenDay: string, firstCanvasDay: string | null | undefined, day: string): FirstCanvasBucket {
  if (!firstCanvasDay || daysBetween(firstCanvasDay, day) < 0) return 'never';
  return tenureBucket(daysBetween(firstSeenDay, firstCanvasDay));
}

export function osBucket(platform: string): TelemetryOs {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
}

/** `1.104.2` → `1.104`; anything unrecognisable → `0.0`. */
export function vscodeMajor(version: string): string {
  return /^(\d+\.\d+)/.exec(version)?.[1] ?? '0.0';
}

/** `1.4.0` and `1.4.0-beta.1` → `1.4.0`; anything unrecognisable → `0.0.0`. */
export function extVersion(version: string): string {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? '0.0.0';
}

// ---------------------------------------------------------------------------
// Reducers — each returns a new DailyCounters and never mutates its input.
// ---------------------------------------------------------------------------

export function emptyCounters(day: string): DailyCounters {
  return {
    day,
    activation: null,
    hasSemanticDir: false,
    domainCount: '0',
    activations: 0,
    canvasOpens: 0,
    stages: [],
    schemaFormats: [],
    modelCount: 'none',
    manifest: 'unknown',
    catalog: false,
    features: {},
    errors: {},
  };
}

/**
 * The counters for `day` that follow `prev`. The project facts from the last
 * activation (outcome, `.erd-studio/` present, domain count) describe a window
 * that is still open, so they carry over; every count starts again.
 */
export function nextDay(prev: DailyCounters, day: string): DailyCounters {
  return {
    ...emptyCounters(day),
    activation: prev.activation,
    hasSemanticDir: prev.hasSemanticDir,
    domainCount: prev.domainCount,
    ...(prev.env ? { env: prev.env } : {}),
    ...(prev.assistants ? { assistants: prev.assistants } : {}),
    ...(prev.harnesses ? { harnesses: prev.harnesses } : {}),
  };
}

/**
 * Label the day with the environment doing the counting. `dev` sticks for the
 * day once set, so a mixed day (a dev host and the everyday window sharing one
 * install) is flagged rather than passed off as ordinary use.
 */
export function stampEnv(state: DailyCounters, env: CounterEnv): DailyCounters {
  const dev = env.dev || state.env?.dev === true;
  const same = state.env
    && state.env.extVersion === env.extVersion
    && state.env.vscodeVersion === env.vscodeVersion
    && state.env.host === env.host
    && state.env.remote === env.remote
    && state.env.dev === dev;
  if (same) return state;
  // B5: something was already counted today by another ERD Studio version (an
  // update mid-day, or an old window still open beside a new one). The env
  // that nextDay carries over to an empty new day is not a mixed day. Call
  // this before the reducer that counts the new event, as update() does.
  const mixed = Boolean(state.env?.extVersion) && state.env?.extVersion !== env.extVersion && hasCounts(state);
  const stamped: DailyCounters = { ...state, env: { ...env, dev } };
  return mixed ? recordFeatureOnce(stamped, 'versionMixed') : stamped;
}

/** Whether anything was counted on `state`'s day: an activation, a canvas, a feature or an error. */
export function hasCounts(state: DailyCounters): boolean {
  return (
    state.activations > 0 ||
    state.canvasOpens > 0 ||
    Object.keys(state.features ?? {}).length > 0 ||
    Object.keys(state.errors ?? {}).length > 0
  );
}

export function recordAssistants(state: DailyCounters, found: readonly TelemetryAssistant[]): DailyCounters {
  return { ...state, assistants: unionIn(state.assistants, found, ASSISTANTS) };
}

export function recordHarnesses(state: DailyCounters, found: readonly TelemetryHarness[]): DailyCounters {
  return { ...state, harnesses: unionIn(state.harnesses, found, HARNESSES) };
}

/** A finished detection of one workspace. Empty lists still mark the day as looked at. */
export function recordPhysicalTooling(
  state: DailyCounters,
  found: { tools: readonly TelemetryPhysicalTool[]; platforms: readonly TelemetryPlatform[] },
): DailyCounters {
  return {
    ...state,
    physicalTools: unionIn(state.physicalTools, found.tools, PHYSICAL_TOOLS),
    platforms: unionIn(state.platforms, found.platforms, PLATFORMS),
  };
}

/** `a ∪ b`, restricted to `order` and in its order. */
function unionIn<T extends string>(a: readonly T[] | undefined, b: readonly T[], order: readonly T[]): T[] {
  return order.filter(v => a?.includes(v) || b.includes(v));
}

export function recordActivation(
  state: DailyCounters,
  info: { outcome: ActivationOutcome; hasSemanticDir: boolean; domainCount: number },
): DailyCounters {
  return {
    ...state,
    activation: info.outcome,
    hasSemanticDir: info.hasSemanticDir,
    domainCount: subjectAreaCountBucket(info.domainCount),
    activations: Math.min(state.activations + 1, MAX_ACTIVATIONS),
  };
}

export function recordCanvasOpen(
  state: DailyCounters,
  info: { stage: TelemetryStage; format: TelemetrySchemaFormat; modelCount: number },
): DailyCounters {
  const seen = tableCountBucket(info.modelCount);
  const largest = TABLE_COUNT_ORDER.indexOf(seen) > TABLE_COUNT_ORDER.indexOf(state.modelCount) ? seen : state.modelCount;
  return {
    ...state,
    canvasOpens: Math.min(state.canvasOpens + 1, MAX_CANVAS_OPENS),
    stages: addOnce(state.stages, info.stage),
    schemaFormats: addOnce(state.schemaFormats, info.format),
    modelCount: largest,
  };
}

/**
 * Count one open or one edit of the diagram numbered `id`. Past
 * {@link MAX_DIAGRAMS} diagrams in a day, a new one is added up under
 * {@link OTHER_DIAGRAM_ID}, so the day's totals stay right.
 */
export function recordDiagramUse(state: DailyCounters, id: number, kind: 'open' | 'edit'): DailyCounters {
  if (!isDiagramId(id)) return state;
  const list = sentDiagrams(state.diagrams);
  const listed = list.some(d => d[0] === id);
  const real = list.filter(d => d[0] !== OTHER_DIAGRAM_ID).length;
  const target = listed || real < MAX_DIAGRAMS ? id : OTHER_DIAGRAM_ID;
  const prev = list.find(d => d[0] === target) ?? [target, 0, 0];
  const next: DiagramUse = [
    target,
    Math.min(prev[1] + (kind === 'open' ? 1 : 0), MAX_CANVAS_OPENS),
    Math.min(prev[2] + (kind === 'edit' ? 1 : 0), MAX_DIAGRAM_EDITS),
  ];
  return { ...state, diagrams: [...list.filter(d => d[0] !== target), next] };
}

function isDiagramId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= MAX_DIAGRAM_ID;
}

/**
 * `diagrams` as sent: well-formed entries only, every number clamped, one
 * entry per id, at most {@link MAX_DIAGRAMS} plus the "other" entry.
 */
export function sentDiagrams(diagrams: unknown): DiagramUse[] {
  if (!Array.isArray(diagrams)) return [];
  const out: DiagramUse[] = [];
  for (const d of diagrams) {
    if (!Array.isArray(d) || d.length !== 3) continue;
    const id: unknown = d[0];
    if (id !== OTHER_DIAGRAM_ID && !isDiagramId(id)) continue;
    if (out.some(o => o[0] === id)) continue;
    if (id !== OTHER_DIAGRAM_ID && out.filter(o => o[0] !== OTHER_DIAGRAM_ID).length >= MAX_DIAGRAMS) continue;
    out.push([id as number, clampCount(d[1], MAX_CANVAS_OPENS), clampCount(d[2], MAX_DIAGRAM_EDITS)]);
  }
  return out;
}

export function recordStage(state: DailyCounters, stage: TelemetryStage): DailyCounters {
  return { ...state, stages: addOnce(state.stages, stage) };
}

export function recordManifest(state: DailyCounters, manifest: Exclude<ManifestState, 'unknown'>): DailyCounters {
  return { ...state, manifest };
}

export function recordCatalog(state: DailyCounters, present: boolean): DailyCounters {
  return { ...state, catalog: state.catalog || present };
}

export function recordFeature(state: DailyCounters, feature: TelemetryFeature): DailyCounters {
  return { ...state, features: bump(state.features, feature) };
}

/** Count `feature` at most once for the day — a presence flag, not a usage count. */
export function recordFeatureOnce(state: DailyCounters, feature: TelemetryFeature): DailyCounters {
  return state.features[feature] ? state : recordFeature(state, feature);
}

const TABLE_FILE_ERROR_CODES: Record<TableLoadErrorKind, TelemetryErrorCode> = {
  read: 'modelFileRead',
  yamlIndent: 'modelFileYamlIndent',
  yamlScalar: 'modelFileYamlScalar',
  yamlStructure: 'modelFileYamlStructure',
  yamlDuplicateKey: 'modelFileYamlDuplicateKey',
  yamlOther: 'modelFileYamlOther',
  dbmlSyntax: 'modelFileDbmlSyntax',
  dbmlInvalid: 'modelFileDbmlInvalid',
  dbmlStructure: 'modelFileDbmlStructure',
};

/** The error sub-code counted for a model-file failure of `kind`; recorded alongside `modelFileParse`. */
export function tableFileErrorCode(kind: TableLoadErrorKind): TelemetryErrorCode {
  return TABLE_FILE_ERROR_CODES[kind] ?? 'modelFileYamlOther';
}

/**
 * Why a canvas could not load its domain: not a domain path, the file is gone
 * or cannot be read, its text is not JSON, it is empty, it holds git conflict
 * markers, it is JSON that fails validation (schema version, format, layer),
 * anything else threw, or (native DBML storage) a `.dbml` diagram's text is
 * not DBML ERD Studio can read.
 */
export type SubjectAreaLoadFailure = 'notDomain' | 'missing' | 'unreadable' | 'json' | 'empty' | 'conflict' | 'invalid' | 'internal' | 'dbml';

const SUBJECT_AREA_LOAD_ERROR_CODES: Record<SubjectAreaLoadFailure, TelemetryErrorCode> = {
  notDomain: 'domainLoadNotDomain',
  missing: 'domainLoadMissing',
  unreadable: 'domainLoadUnreadable',
  json: 'domainLoadJson',
  empty: 'domainLoadEmpty',
  conflict: 'domainLoadConflict',
  invalid: 'domainLoadInvalid',
  internal: 'domainLoadInternal',
  dbml: 'domainLoadDbml',
};

/** The error sub-code counted for a canvas load failure of `kind`; recorded alongside `domainLoad`. */
export function subjectAreaLoadErrorCode(kind: SubjectAreaLoadFailure): TelemetryErrorCode {
  return SUBJECT_AREA_LOAD_ERROR_CODES[kind] ?? 'domainLoadInternal';
}

/**
 * The canvas load step that was running when an `internal` failure threw
 * (#262): the dbt files (manifest, schema yml, catalog), the diagram and its
 * tables, the positions for new tables, the Physical stage's build or the
 * Logical stage's display build, or anything after the payload went out.
 */
export type SubjectAreaLoadStep = 'manifest' | 'yml' | 'catalog' | 'read' | 'positions' | 'physical' | 'display' | 'other';

const SUBJECT_AREA_LOAD_STEP_CODES: Record<SubjectAreaLoadStep, TelemetryErrorCode> = {
  manifest: 'domainLoadInternalManifest',
  yml: 'domainLoadInternalYml',
  catalog: 'domainLoadInternalCatalog',
  read: 'domainLoadInternalRead',
  positions: 'domainLoadInternalPositions',
  physical: 'domainLoadInternalPhysical',
  display: 'domainLoadInternalDisplay',
  other: 'domainLoadInternalOther',
};

/** The error code counted beside `domainLoadInternal` for the step an internal load failure threw in (#262). */
export function subjectAreaLoadStepCode(step: SubjectAreaLoadStep): TelemetryErrorCode {
  return SUBJECT_AREA_LOAD_STEP_CODES[step] ?? 'domainLoadInternalOther';
}

/** Why a save failed (see saveDocument in src/providers/documentSave.ts). */
export type SaveFailure = 'refused' | 'threw' | 'reopenFailed';

/** The error sub-code counted for a save that failed for `reason`; recorded alongside `saveFailed`. */
export function saveFailureCode(reason: SaveFailure): TelemetryErrorCode {
  // Exhaustive, so a new reason fails to compile until it has its own code.
  switch (reason) {
    case 'refused': return 'saveFailedRefused';
    case 'threw': return 'saveFailedThrew';
    case 'reopenFailed': return 'saveFailedReopen';
  }
}

/**
 * Every error code to record for one failed save step: `saveFailed` (the
 * total), one per distinct reason, and where it happened.
 */
export function saveFailureCodes(
  reasons: Iterable<SaveFailure>,
  where: { modelFile?: boolean; rename?: boolean; undoRedo?: boolean } = {},
): TelemetryErrorCode[] {
  const codes: TelemetryErrorCode[] = ['saveFailed'];
  for (const reason of new Set(reasons)) codes.push(saveFailureCode(reason));
  if (where.modelFile) codes.push('saveFailedModelFile');
  if (where.rename) codes.push('saveFailedRename');
  if (where.undoRedo) codes.push('saveFailedUndoRedo');
  return codes;
}

/** The feature key for an auto layout that took `ms` milliseconds, or failed. */
export function layoutFeature(ms: number, ok: boolean): TelemetryFeature {
  if (!ok) return 'layoutFailed';
  if (ms < 1000) return 'layoutUnder1s';
  if (ms <= 5000) return 'layout1to5s';
  return 'layoutOver5s';
}

export function recordError(state: DailyCounters, code: TelemetryErrorCode): DailyCounters {
  return { ...state, errors: bump(state.errors, code) };
}

/**
 * Whether `day` is one of the {@link TRAIL_DAYS} days that start on
 * `startDay` (that day and the six after it). An absent or malformed start,
 * or a day before it, is never in.
 */
export function withinTrailDays(startDay: string | undefined, day: string): boolean {
  if (!startDay) return false;
  const age = daysBetween(startDay, day);
  return Number.isFinite(age) && age >= 0 && age < TRAIL_DAYS;
}

/**
 * Whether the trail is kept today: an install's first {@link TRAIL_DAYS} days,
 * the {@link TRAIL_DAYS} days from the start after a major update
 * (`majorSeenDay`, B5; never a minor or patch update), a day whose trail has
 * already begun, or the event that begins it anyway (the guide starting, also
 * on a later day through Show Me Around).
 */
export function trailKept(state: DailyCounters, firstSeenDay: string, event: TrailEvent, majorSeenDay?: string): boolean {
  if (Array.isArray(state.trail)) return true;
  if (event === 'guideStarted') return true;
  return withinTrailDays(firstSeenDay, state.day) || withinTrailDays(majorSeenDay, state.day);
}

/**
 * B2/B5: whether `day` may send onboarding (and settle) interim copies: an
 * install's first {@link TRAIL_DAYS} days, unless its first counted start was
 * an update (an existing user, not a new one), or the {@link TRAIL_DAYS} days
 * from the start after a major update. Error copies need neither.
 */
export function onboardingWindowDay(day: string, o: { firstSeenDay: string; upgradedInstall?: boolean; majorSeenDay?: string }): boolean {
  return (!o.upgradedInstall && withinTrailDays(o.firstSeenDay, day)) || withinTrailDays(o.majorSeenDay, day);
}

/** The window number this window takes in today's trail: one past the highest so far. */
export function nextTrailWindow(state: DailyCounters): number {
  const highest = (state.trail ?? []).reduce((m, e) => Math.max(m, e[2]), 0);
  return Math.min(highest + 1, MAX_TRAIL_WINDOWS);
}

/**
 * Add `event` to the day's trail at `now` (epoch ms) from `window`. The same
 * event from the same window straight after the last entry folds into it
 * (`repeat`); past {@link MAX_TRAIL} entries it is only counted.
 */
export function recordTrail(state: DailyCounters, event: TrailEvent, now: number, window: number): DailyCounters {
  if (!isTrailEvent(event)) return state;
  const trail = Array.isArray(state.trail) ? state.trail : [];
  const w = Math.min(Math.max(1, Math.trunc(window) || 1), MAX_TRAIL_WINDOWS);
  const last = trail[trail.length - 1];
  // Fold only straight after: once entries are being dropped, the last kept one is not the previous event.
  if (last && last[0] === event && last[2] === w && !state.trailDropped) {
    const folded: TrailEntry = [last[0], last[1], last[2], Math.min(last[3] + 1, MAX_COUNTER)];
    return { ...state, trail: [...trail.slice(0, -1), folded], trailAt: now };
  }
  if (trail.length >= MAX_TRAIL || (trail.length >= TRAIL_GENERAL_MAX && !isReservedTrailEvent(event))) {
    return { ...state, trail, trailDropped: Math.min((state.trailDropped ?? 0) + 1, MAX_TRAIL_DROPPED), trailAt: now };
  }
  const gap = trail.length === 0 || typeof state.trailAt !== 'number'
    ? 0
    : Math.min(Math.max(0, Math.round((now - state.trailAt) / 1000)), MAX_TRAIL_GAP_S);
  return { ...state, trail: [...trail, [event, gap, w, 1]], trailAt: now, trailPrevAt: state.trailAt };
}

/** The events the trail's last {@link MAX_TRAIL} − {@link TRAIL_GENERAL_MAX} places are kept for. */
export function isReservedTrailEvent(event: TrailEvent): boolean {
  return event.startsWith('!') || event === 'windowClosed' || event === 'canvasClosed';
}

/**
 * Take back the trail's last entry when it is `event` from `window` (an away
 * marker whose return came within {@link TRAIL_AWAY_MIN_MS}): a quick alt-tab
 * is not news. Anything recorded since leaves the entry where it is.
 */
export function retractTrail(state: DailyCounters, event: TrailEvent, window: number): DailyCounters {
  const trail = state.trail;
  const last = trail?.[trail.length - 1];
  if (!trail || !last || last[0] !== event || last[2] !== window) return state;
  if (last[3] > 1) return { ...state, trail: [...trail.slice(0, -1), [last[0], last[1], last[2], last[3] - 1]] };
  // The next gap counts from the entry before, as if the marker had never been added.
  return { ...state, trail: trail.slice(0, -1), trailAt: state.trailPrevAt, trailPrevAt: undefined };
}

/** The trail as sent: well-formed entries only, rebuilt value by value. */
function sentTrail(trail: unknown): TrailEntry[] {
  if (!Array.isArray(trail)) return [];
  const out: TrailEntry[] = [];
  for (const e of trail.slice(0, MAX_TRAIL)) {
    if (!Array.isArray(e) || e.length !== 4 || !isTrailEvent(e[0])) continue;
    out.push([e[0], clampCount(e[1], MAX_TRAIL_GAP_S), Math.max(1, clampCount(e[2], MAX_TRAIL_WINDOWS)), Math.max(1, clampCount(e[3], MAX_COUNTER))]);
  }
  return out;
}

function addOnce<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list : [...list, value];
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): Partial<Record<K, number>> {
  return { ...counts, [key]: Math.min((counts[key] ?? 0) + 1, MAX_COUNTER) };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Whether the finished day `state` should be sent on `today`. A day with no
 * activation, no canvas and nothing counted (a window left open overnight) is
 * not news, and a day older than the Worker accepts would only be refused.
 */
export function heartbeatDue(state: DailyCounters, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day)) return false;
  const age = daysBetween(state.day, today);
  if (!(age >= 1 && age <= MAX_HEARTBEAT_AGE_DAYS)) return false;
  // An activation that threw before it recorded its outcome is still sent (B4).
  if (state.activation === null && !((state.errors.activationFailed ?? 0) > 0)) return false;
  return (
    state.activations > 0 ||
    state.canvasOpens > 0 ||
    Object.keys(state.features).length > 0 ||
    Object.keys(state.errors).length > 0
  );
}

/**
 * The heartbeat body for a finished day. Rebuilt field by field from the
 * allowlists rather than spread from `state`, so a stray key in stored state —
 * from an older build, say — can never reach the wire.
 */
export function buildHeartbeat(state: DailyCounters, env: HeartbeatEnv): HeartbeatBody {
  const stamped = state.env;
  return {
    v: HEARTBEAT_VERSION,
    installId: env.installId,
    day: state.day,
    extVersion: extVersion(stamped?.extVersion ?? env.extVersion),
    vscodeMajor: vscodeMajor(stamped?.vscodeVersion ?? env.vscodeVersion),
    os: osBucket(env.platform),
    tenure: tenureBucket(daysBetween(env.firstSeenDay, state.day)),
    activation: pick(state.activation, ['project_found', 'no_project'], 'no_project'),
    hasSemanticDir: state.hasSemanticDir === true,
    domainCount: pick(state.domainCount, ['0', '1-3', '4-10', '10+'], '0'),
    activations: clampCount(state.activations, MAX_ACTIVATIONS),
    canvasOpens: clampCount(state.canvasOpens, MAX_CANVAS_OPENS),
    stages: (['logical', 'physical'] as const).filter(s => state.stages?.includes(s)),
    schemaFormats: (['v5', 'v4'] as const).filter(f => state.schemaFormats?.includes(f)),
    modelCount: pick(state.modelCount, TABLE_COUNT_ORDER, 'none'),
    manifest: pick(state.manifest, ['ok', 'missing', 'stale', 'unknown'], 'unknown'),
    catalog: state.catalog === true,
    features: allowedCounts(state.features, FEATURES),
    errors: allowedCounts(state.errors, ERROR_CODES),
    host: pick(stamped?.host ?? env.host, HOSTS, 'other'),
    remote: pick(stamped?.remote ?? env.remote, REMOTES, 'local'),
    dev: (stamped?.dev ?? env.dev) === true,
    assistants: ASSISTANTS.filter(a => state.assistants?.includes(a)),
    harnesses: HARNESSES.filter(h => state.harnesses?.includes(h)),
    activeDays28: recentDaysBucket(recentDaysCount(env.activeDays, state.day)),
    canvasDays28: recentDaysBucket(recentDaysCount(env.canvasDays, state.day)),
    firstCanvas: firstCanvasBucket(env.firstSeenDay, env.firstCanvasDay, state.day),
    ...(Array.isArray(state.physicalTools)
      ? { physicalTools: PHYSICAL_TOOLS.filter(t => state.physicalTools?.includes(t)) }
      : {}),
    ...(Array.isArray(state.platforms) ? { platforms: PLATFORMS.filter(p => state.platforms?.includes(p)) } : {}),
    ...(sentDiagrams(state.diagrams).length > 0 ? { diagrams: sentDiagrams(state.diagrams) } : {}),
    ...(Array.isArray(state.trail)
      ? { trail: sentTrail(state.trail), trailDropped: clampCount(state.trailDropped ?? 0, MAX_TRAIL_DROPPED) }
      : {}),
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampCount(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), max)) : 0;
}

function allowedCounts<K extends string>(
  counts: Partial<Record<K, number>> | undefined,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const n = clampCount(counts?.[key], MAX_COUNTER);
    if (n > 0) out[key] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2.0 delivery: same-day interim copies (B2), the size guard (B3), updates
// (B5) and time to the first draft and diagram (B15)
// ---------------------------------------------------------------------------

/** B2: at most this many interim copies of a day are sent that day. */
export const MAX_PROVISIONAL_SENDS = 3;

/**
 * Why an interim copy is being considered: an onboarding end-point (a draft
 * answered, the guide skipped or left, the first diagram with tables), a new
 * error code today, or the settle timer a couple of minutes after start.
 */
export type ProvisionalReason = 'onboarding' | 'error' | 'settle';

/**
 * The onboarding end-points (B2 trigger a): counting one of these on a day
 * that may send interim copies schedules one.
 */
export const PROVISIONAL_ONBOARDING_FEATURES: readonly TelemetryFeature[] = [
  'draftDiscarded',
  'draftClosed',
  'draftKept',
  'guideSkippedOnDraft',
  'guideSkippedOnCanvas',
  'guideLeftDraft',
  'draftRejectedFastDbt',
  'draftRejectedFastSqlDdl',
  'draftRejectedFastSemanticModel',
  'draftRejectedFastDbml',
];

/**
 * What an update from `before` to `after` (the same day) asks of the interim
 * sender: `error` when an error code appears for the first time today (any
 * tenure), `onboarding` when an end-point was counted or the day's first
 * diagram with tables opened, or nothing. The B19 catch-all (`loggedError*`)
 * never asks on its own: it also counts problems with the user's own files,
 * and a failure of ours records its own code beside it.
 */
export function provisionalTrigger(before: DailyCounters, after: DailyCounters): 'error' | 'onboarding' | undefined {
  if (before.day !== after.day) return undefined;
  for (const code of Object.keys(after.errors ?? {})) {
    if (code.startsWith('loggedError')) continue;
    if (!(code in (before.errors ?? {}))) return 'error';
  }
  for (const f of PROVISIONAL_ONBOARDING_FEATURES) {
    if ((after.features?.[f] ?? 0) > (before.features?.[f] ?? 0)) return 'onboarding';
  }
  if (before.modelCount === 'none' && after.modelCount !== 'none') return 'onboarding';
  return undefined;
}

export interface ProvisionalCheck {
  /** Today may send onboarding interim copies: the install's first week, and not an upgrade (B5). */
  trailDay: boolean;
  /** Interim copies already sent today. */
  sentToday: number;
  /** {@link heartbeatHash} of the last interim copy sent today. */
  lastHash?: string;
  /** {@link heartbeatHash} of the copy that would be sent now. */
  hash: string;
  reason: ProvisionalReason;
}

/**
 * Whether an interim copy of today's counters `state` should be sent now:
 * it is today's, fewer than {@link MAX_PROVISIONAL_SENDS} went today, it
 * differs from the last one, an error asked for it or today may send
 * onboarding copies, and something was counted. A day with no activation is
 * allowed only when activation itself failed (B4).
 */
export function provisionalDue(state: DailyCounters, today: string, o: ProvisionalCheck): boolean {
  if (state.day !== today) return false;
  if (!(o.sentToday < MAX_PROVISIONAL_SENDS)) return false;
  if (o.hash === o.lastHash) return false;
  if (o.reason !== 'error' && !o.trailDay) return false;
  if (state.activation === null && !((state.errors?.activationFailed ?? 0) > 0)) return false;
  return hasCounts(state);
}

/**
 * A short fingerprint of a body, `heartbeatProvisional` left out, so the same
 * counts are not sent twice in a day. FNV-1a over the JSON; it never leaves
 * the device.
 */
export function heartbeatHash(body: HeartbeatBody): string {
  const { heartbeatProvisional: _ignored, ...features } = body.features;
  const text = JSON.stringify({ ...body, features });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

/** `body` marked as an interim same-day copy. The stored counters never carry the key. */
export function provisionalBody(body: HeartbeatBody): HeartbeatBody {
  return { ...body, features: { ...body.features, heartbeatProvisional: 1 } };
}

/**
 * B3: the body size the extension keeps under, below the Worker's old
 * 16,384-byte cap, so a Worker not yet at 32,768 never refuses a whole day.
 */
export const HEARTBEAT_SOFT_LIMIT = 15000;

/** The UTF-8 size of `body` as posted. */
export function heartbeatBytes(body: HeartbeatBody): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

/** Never dropped by {@link trimHeartbeat}: they describe the send itself. */
const UNTRIMMED_FEATURES: ReadonlySet<string> = new Set(['heartbeatProvisional', 'heartbeatTrimmed']);

/**
 * `body` cut down to `limit` bytes, marked `heartbeatTrimmed`, or `body`
 * itself when it already fits. In order, until it fits: the trail (with
 * `trailDropped`: the Worker refuses one without the other), then feature
 * keys counted once, then the other feature keys, then error codes — each in
 * reverse list order, so the newest keys go first. It only removes data.
 */
export function trimHeartbeat(body: HeartbeatBody, limit: number = HEARTBEAT_SOFT_LIMIT): HeartbeatBody {
  if (heartbeatBytes(body) <= limit) return body;
  const { trail: _trail, trailDropped: _dropped, ...rest } = body;
  const out: HeartbeatBody = { ...rest, features: { ...body.features, heartbeatTrimmed: 1 }, errors: { ...body.errors } };
  let size = heartbeatBytes(out);
  if (size <= limit) return out;
  const drop = (counts: Record<string, number | undefined>, key: string): void => {
    if (size <= limit || counts[key] === undefined) return;
    delete counts[key];
    size = heartbeatBytes(out);
  };
  const features = out.features as Record<string, number | undefined>;
  const reversed = [...FEATURES].reverse().filter((f) => !UNTRIMMED_FEATURES.has(f));
  for (const f of reversed) if (features[f] === 1) drop(features, f);
  for (const f of reversed) drop(features, f);
  for (const e of [...ERROR_CODES].reverse()) drop(out.errors as Record<string, number | undefined>, e);
  return out;
}

/** B5: the update from `previous` to `current` changed the major version. */
export function isMajorUpdate(previous: string, current: string): boolean {
  const major = (v: string) => /^(\d+)\./.exec(v)?.[1];
  return major(previous) !== major(current);
}

/**
 * B15: the non-example draft sources. `trackedDraftPreview` counts one of
 * these with every draft it shows that is not an example (its
 * `DRAFT_SOURCE_FEATURES`; a test holds the two lists equal), so the first one
 * counted is the install's first real draft.
 */
export const FIRST_DRAFT_FEATURES: readonly TelemetryFeature[] = [
  'draftSourceSqlDdl',
  'draftSourceSemanticModel',
  'draftSourceDbml',
  'draftSourceDbt',
];

const TTF_FEATURES = {
  draft: ['ttfDraftUnder1m', 'ttfDraft1to5m', 'ttfDraft5to30m', 'ttfDraftOver30m', 'ttfDraftLaterDay'],
  diagram: ['ttfDiagramUnder1m', 'ttfDiagram1to5m', 'ttfDiagram5to30m', 'ttfDiagramOver30m', 'ttfDiagramLaterDay'],
} as const satisfies Record<string, readonly TelemetryFeature[]>;

/**
 * B15: the bucket for the time from the first run (`firstRunAt`, epoch ms,
 * kept on the device) to the first draft or diagram at `now`. Under 30
 * minutes by minutes; past that, `Over30m` on the same UTC day and `LaterDay`
 * after it. A clock that went backwards counts as under a minute.
 */
export function ttfFeature(kind: 'draft' | 'diagram', firstRunAt: number, now: number): TelemetryFeature {
  const [under1m, to5m, to30m, over30m, laterDay] = TTF_FEATURES[kind];
  const ms = now - firstRunAt;
  if (ms < 60_000) return under1m;
  if (ms < 5 * 60_000) return to5m;
  if (ms < 30 * 60_000) return to30m;
  return utcDay(new Date(firstRunAt)) === utcDay(new Date(now)) ? over30m : laterDay;
}
