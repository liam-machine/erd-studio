import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planRelationshipCommit, mergeDomainRelationships } from '../../src/services/libraryRelationships';
import { LogicalModelService } from '../../src/services/logicalModelService';

describe('scratch', () => {
  it('domain mode update drops unknown keys', () => {
    const raw = [{ fromModel: 'fct', fromColumn: 'c', toModel: 'dim', toColumn: 'c', cardinality: 'many-to-one', description: 'keep me', tests: ['x'] }];
    const p = planRelationshipCommit({ mode: 'domain', op: { kind: 'update', stored: raw[0] as any, cardinality: 'one-to-one' }, endpointModels: [], domainRelationships: raw as any });
    console.log(JSON.stringify(mergeDomainRelationships(raw, raw, p.domainRelationships)));
  });
  it('library mode update moves REL002 entry and drops keys/comments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rv5-'));
    const dir = path.join(root, '.erd-studio', 'logical-models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dim.yml'), `name: dim
columns:
  - name: c
    isPrimaryKey: true
relationships:
  # the order link, agreed with finance
  - fromColumn: c
    toModel: fct
    toColumn: c
    cardinality: one-to-many
    description: agreed with finance
`);
    fs.writeFileSync(path.join(dir, 'fct.yml'), `name: fct
columns:
  - name: c
`);
    const svc = new LogicalModelService(root);
    const dim = svc.getModel('dim')!;
    const fct = svc.getModel('fct')!;
    const p = planRelationshipCommit({ mode: 'library', op: { kind: 'update', stored: { fromModel: 'dim', fromColumn: 'c', toModel: 'fct', toColumn: 'c' }, drawn: { fromModel: 'fct', fromColumn: 'c', toModel: 'dim', toColumn: 'c' }, cardinality: 'many-to-one' }, endpointModels: [dim, fct], domainRelationships: [] });
    for (const m of p.changedModels) {
      const w = p.written?.where === 'library' && p.written.model === m.name ? [p.written.index] : undefined;
      console.log('-----', m.name, '\n' + svc.serializeModel(m, undefined, { relationshipTargets: w }));
    }
  });
});
