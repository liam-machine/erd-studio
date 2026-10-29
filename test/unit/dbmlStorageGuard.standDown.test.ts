/**
 * The stable DBML guard switches itself off on a core that reads DBML
 * (schema 7, ERD Studio 2.0). If a main → develop sync or the native DBML
 * merge keeps the guard by accident, 2.0 must still open its own projects
 * rather than tell its users to update to the version they are on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@erd-studio/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@erd-studio/core')>()),
  CURRENT_SCHEMA_VERSION: 7,
}));

import { detectDbmlStorage } from '../../src/services/dbmlStorageGuard';
import { makeDbmlProject } from './dbmlStorageGuard.fixture';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-standdown-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectDbmlStorage on a core that reads DBML', () => {
  it('finds nothing, even in a converted project', () => {
    makeDbmlProject(path.join(root, 'p'));
    expect(detectDbmlStorage(path.join(root, 'p', '.erd-studio'))).toBeNull();
  });
});
