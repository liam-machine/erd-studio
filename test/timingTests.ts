/**
 * The test files that assert a wall-clock budget on CPU work: "under N ms",
 * a frame budget, linear growth measured by time (`timeRatio`), or the
 * longest stall of the event loop. Another file running beside them on the
 * same cores slows them (and can fail them) without any regression, so CI
 * runs them in their own job, one file at a time (`test-timing` in
 * `.github/workflows/ci.yml`), and leaves them out of the four shards.
 *
 * `vitest.config.ts` reads `ERD_TEST_SET`:
 * - unset: every test file, as always (`npm run test`, local runs, deploy.yml,
 *   publish-packages.yml, prerelease.yml);
 * - `main`: every test file except these (the CI shards);
 * - `timing`: only these, with no file parallelism (the CI timing job).
 *
 * Add a file here when it asserts how long CPU work takes. A wall-clock bound
 * that only proves a timer fired or was skipped (`waitMs`, a settle delay, a
 * retry backoff), with the work itself trivial, does not belong here.
 * `test/unit/timingTests.test.ts` checks every entry exists and that CI runs
 * both sets.
 */
export const TIMING_TEST_FILES: readonly string[] = [
  'packages/core/test/unit/dbmlFormat.test.ts',
  'packages/core/test/unit/dbmlReadRelationships.test.ts',
  'packages/core/test/unit/erdLayoutDbml.test.ts',
  'packages/core/test/unit/loadDisplayDomain.test.ts',
  'packages/core/test/unit/logicalModel.test.ts',
  'packages/renderer/test/unit/edgeRouting.orthogonalAvoid.test.ts',
  'packages/renderer/test/unit/edgeRouting.render.test.ts',
  'packages/renderer/test/unit/edgeRouting.tunnels.test.ts',
  'test/unit/dbml-dbt-ui.edgecases.test.ts',
  'test/unit/dbmlPerformance.test.ts',
  'test/unit/dbmlRelationshipsIndex.test.ts',
  'test/unit/dbtImportEdgeCases.test.ts',
  'test/unit/elkLayoutPartitionCycle.test.ts',
  'test/unit/generated/dbmlImport.property.test.ts',
  'test/unit/generated/semanticModel.property.test.ts',
  'test/unit/generated/sqlImport.property.test.ts',
  'test/unit/gitIndex.test.ts',
  'test/unit/importOutcomeTelemetry.adversarial.test.ts',
  'test/unit/importReport.adversarial.test.ts',
  'test/unit/largeLibraryScaling.test.ts',
  'test/unit/libraryWarmUp.test.ts',
  'test/unit/logicalModelService.test.ts',
  'test/unit/powerbi.edgecases.test.ts',
  'test/unit/relationshipHealth.test.ts',
  'test/unit/relationshipSuggestionReview.test.ts',
  'test/unit/relationshipSuggestions.measure.test.ts',
  'test/unit/schemaScopedLibrary.budget.test.ts',
  'test/unit/semanticModelImport.breaks.test.ts',
  'test/unit/sql.edgecases.test.ts',
  'test/unit/sqlDdlIsolation.test.ts',
  'test/unit/sqlDdlPartitions.test.ts',
  'test/unit/sqlImportPerformance.test.ts',
];

/** The values `ERD_TEST_SET` may take; unset runs every file. */
export const TEST_SETS = ['main', 'timing'] as const;
export type TestSet = (typeof TEST_SETS)[number];
