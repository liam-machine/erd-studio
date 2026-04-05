/**
 * Worker thread for parsing dbt manifest.json.
 *
 * Receives a file path, reads and parses the JSON, extracts model/test data,
 * and posts the result back to the main thread. Uses JSON.parse (V8 native)
 * instead of stream-json for ~14x faster parsing of large manifests.
 */

import * as fs from 'fs';
import { parentPort } from 'worker_threads';
import { extractManifestData } from './manifestExtractor';
import type { ManifestWorkerError } from '../types/manifest';

parentPort!.once('message', (manifestPath: string) => {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = extractManifestData(parsed);
    parentPort!.postMessage(result);
  } catch (err) {
    const msg: ManifestWorkerError = {
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort!.postMessage(msg);
  }
});
