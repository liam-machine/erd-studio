/**
 * Every text ERD Studio has shipped for the setup skill's dbt-scope
 * references: the files a dbt project installs and a root without
 * `dbt_project.yml` does not (`DBT_SCOPE_SETUP_PATHS` — the `dbtOnly` ones
 * and the dbt-path names of the renamed ones). These files carry no version
 * marker, so this list is how an install in a plain folder tells a copy it
 * wrote earlier (a v41 install, or one made while the folder held
 * `dbt_project.yml`) from a file the user wrote or edited: only an exact
 * shipped text is ever removed.
 *
 * Each entry is `shippedReferenceHash()` of one version of the file as a dbt
 * project installs it (the source with the scope markers taken out). When a
 * reference changes, add its new hash here — `test/unit/harnessShippedReferences.test.ts`
 * fails until the current text is listed, and prints the hash. Never remove one.
 *
 * vscode-free: bundled into both `dist/extension.js` and `dist/cli.js`.
 */

import { createHash } from 'crypto';

export const SHIPPED_SETUP_REFERENCE_HASHES: Readonly<Record<string, readonly string[]>> = {
  'references/dbt-explained.md': [
    '2ae779113e5aef27', '59013cfa11bea287', '6af9fccebed85150', '9ea8a4e22fb3f69c',
    'a31f1a76717525a4', 'd60e9ba4ee4464df',
  ],
  'references/dbt-setup.md': [
    '1ddf664049c560a8', '5636d2f1809f7416',
  ],
  'references/metadata.md': [
    '066bf80613dbbe3f', '10b03c963a0f9503', '3c48d758c966d1ee', 'b6545b0efb6f0b0a',
  ],
  'references/verify-and-fix.md': [
    '079fea5aac2f0725', '1b2b2e85eb66e4b6', '3405ecb7e3407a7f', '402bb7245e7ef93a',
    '45b3b5064a480aff', '49ffaad9ce28f61f', '4e11b6fa80d845e6', '50f113d77db866f9',
    '58891c5549c3d7b7', '669d02ab966cea71', '6dfa2c5813b4aba7', '7fb7a160b7f5fa56',
    '8731c782830541ff', 'a328ac92ba00de5b', 'b69c40cea41431ae', 'bcb876b3cb4b8643',
    'bdd6f7d3bad5d45e', 'bf76fcb2b486ff6d', 'd13a223fb2500ae2', 'd53f768d9b35c589',
    'daa2956f7eb81dce', 'fd8e6ad69bc4d999',
  ],
  'references/without-dbt.md': [
    '072b0cb4409383d6', '08b24e1f84dac86d', '1da4b0384298b129', '784d60e87f158d95',
    '97cdc2529ebd8275', 'bf86cce69c4ddc9c', 'c5981e31ad719b0d', 'ff29124b2e0588b9',
  ],
};

/** The hash a reference's text is listed under: SHA-256 (first 16 hex digits) of the text with CRLF line ends read as LF. */
export function shippedReferenceHash(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 16);
}

/** Whether `content` is a text ERD Studio shipped at skill-relative `relativePath` (in the default `.erd-studio` data folder). */
export function isShippedSetupReference(relativePath: string, content: string): boolean {
  return SHIPPED_SETUP_REFERENCE_HASHES[relativePath]?.includes(shippedReferenceHash(content)) === true;
}
