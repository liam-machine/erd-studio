/**
 * The extension modules that send something off the machine, shared by the
 * boundary tests that keep names, paths, log lines and sample values out of
 * them (`loggerBoundary.test.ts`, `sampleDataBoundary.test.ts`). Not a test
 * file. Paths are relative to the repository root.
 */

/** The extension's telemetry modules: the heartbeat, its payload, the known-fixes check and the relationship survey. */
export const TELEMETRY_MODULES: readonly string[] = [
  'src/services/telemetryService.ts',
  'src/services/telemetryPayload.ts',
  'src/services/knownFixes.ts',
  'src/services/knownFixesService.ts',
  'src/services/relationshipHealth.ts',
  'src/services/physicalTooling.ts',
];

/** The only modules that may read the ERD Studio log's buffer: Send Feedback's opt-in path, and the logger itself. */
export const FEEDBACK_LOG_READERS: readonly string[] = ['src/services/feedbackService.ts', 'src/services/logger.ts'];
