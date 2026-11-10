/**
 * The three `@dbml/parse` releases the DBML storage readers are held to,
 * passed through each reader's optional `parser` argument: 9.1.1 and 10.3.1
 * through the `dbml-parse-v9` / `dbml-parse-v10` aliases, and the pinned
 * 11.0.0 itself. A test that asserts an error code uses the pin only, since
 * 9.1.1 numbers its codes differently. Shared helpers, not a test file.
 */
import * as DbmlParse from '@dbml/parse';
import * as DbmlParseV9 from 'dbml-parse-v9';
import * as DbmlParseV10 from 'dbml-parse-v10';
import type { DbmlParserModule } from '../src/dbml/parserModule';

export const PARSER_V9 = DbmlParseV9 as unknown as DbmlParserModule;
export const PARSER_V10 = DbmlParseV10 as unknown as DbmlParserModule;
export const PARSER_PINNED = DbmlParse as unknown as DbmlParserModule;

/** `[label, parser]` for each release, oldest first. */
export const STORAGE_PARSERS: ReadonlyArray<readonly [string, DbmlParserModule]> = [
  ['9.1.1', PARSER_V9],
  ['10.3.1', PARSER_V10],
  ['11.0.0', PARSER_PINNED],
];
