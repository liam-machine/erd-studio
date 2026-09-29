import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import { describeModelFileError } from '../../src/services/logicalModelService';

/** The first error the `yaml` library reports for `text`, as the model reader would throw it. */
function yamlError(text: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true });
  expect(doc.errors.length).toBeGreaterThan(0);
  return doc.errors[0];
}

describe('describeModelFileError', () => {
  it.each([
    ['TAB_AS_INDENT', 'name: m\ncolumns:\n\t- name: a\n', 'yamlIndent'],
    ['DUPLICATE_KEY', 'name: m\nname: n\n', 'yamlDuplicateKey'],
    ['MULTIPLE_DOCS', 'name: m\n---\nname: n\n', 'yamlStructure'],
    ['BAD_SCALAR_START', 'name: m\ndescription: `order_id` is the key\n', 'yamlScalar'],
    ['BLOCK_AS_IMPLICIT_KEY', 'name: m\ndescription: Status: one of a, b\n', 'yamlScalar'],
  ])('%s → %s', (code, text, kind) => {
    const e = describeModelFileError('m', '/p/m.yml', yamlError(text));
    expect(e).toMatchObject({ name: 'm', filePath: '/p/m.yml', code, kind });
    expect(e.line).toBeGreaterThanOrEqual(2);
    expect(e.column).toBeGreaterThanOrEqual(1);
  });

  it('a Node fs error is a read failure, with no code or position', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/p/m.yml'"), { code: 'EACCES' });
    const e = describeModelFileError('m', '/p/m.yml', err);
    expect(e.kind).toBe('read');
    expect(e.code).toBeUndefined();
    expect(e.line).toBeUndefined();
  });

  it('an error with no code is yamlOther', () => {
    expect(describeModelFileError('m', '/p/m.yml', new Error('boom')).kind).toBe('yamlOther');
  });
});
