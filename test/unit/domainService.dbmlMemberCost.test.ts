/**
 * What reading a DBML diagram costs the library: its members' layers (for
 * the canvas badge) come from one listing of the table files per read, not
 * one per member, on a copy of the `dbml-native` fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';

const NATIVE = path.resolve(__dirname, '../..', 'test', 'fixtures', 'dbml-native');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-member-cost-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reading a DBML diagram', () => {
  it('lists the library once per read, however many members, and still finds each member\'s layer', () => {
    const layers = new LayerService(root, '.erd-studio');
    const service = new SubjectAreaService(layers);
    const tables = new TableLibraryService(root, '.erd-studio');
    service.setTableLibraryService(tables);
    const diagram = path.join(root, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');

    const listing = vi.spyOn(tables, 'listTableFiles');
    const area = service.getSubjectArea(diagram);
    const members = (area.logical.models ?? []).length;
    expect(members).toBeGreaterThan(2);
    expect(listing.mock.calls.length).toBeLessThanOrEqual(1);

    const memberLayers = service.dbmlMemberLayers(diagram)!;
    expect(memberLayers.size).toBeGreaterThan(0);
    expect(memberLayers.get('fct_order')).toBe('gold');
    expect([...memberLayers.values()].every((l) => typeof l === 'string' && l !== '')).toBe(true);
  });
});
