// The first minute in a repository full of SQL that only looks like a data
// model, realistic (every VS Code prompt on, ERD Studio installed as from the
// Marketplace). It holds dbt macros outside any dbt project (one with a
// `create table … (` column list in its Jinja), a CREATE TABLE … AS SELECT
// in analyses/, and a DBML file that ERD Studio itself exported, but no real
// table definitions. ERD Studio activates (it has .sql and .dbml files) and
// its look takes none of them (`isSqlScriptTaken`: never a macro or a CTAS;
// never its own export), so nothing pops up: no "found CREATE TABLE
// scripts", no "found a DBML file". One click on the ERD Studio icon shows
// the example draft, as in an empty folder, and what to do instead is its
// Import Your Data Model…: the import guide, with no "Found in this
// folder" card (nothing here is a model to bring in) and a card per place a
// model can come from. Nothing unasked in the first minute.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, nothingPopsUp, quietFirstMinute } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const GUIDE_TAB = 'Import Your Data Model';
const FILES = {
  'README.md': '# Warehouse utilities\n\nShared dbt macros, ad-hoc analyses and the exported model.\n',
  // dbt macros, with no dbt_project.yml anywhere: Jinja that writes tables, not tables.
  'macros/materializations.sql': `{% macro create_table_as(temporary, relation, sql) -%}
  create or replace table {{ relation }}
  as (
    {{ sql }}
  );
{%- endmacro %}
`,
  'macros/audit.sql': `{% macro create_audit_table(relation) %}
  create table if not exists {{ relation }} (
    run_id      varchar(64),
    started_at  timestamp,
    rows_loaded integer
  );
{% endmacro %}
`,
  // A one-off backfill: CREATE TABLE … AS SELECT, a query, not a definition.
  'analyses/backfill_customers.sql': `create table tmp_customer_backfill as (
  select customer_id, min(ordered_at) as first_order_at
  from analytics.fct_order
  group by customer_id
);
`,
  // ERD Studio's own DBML export (its header line): already a diagram somewhere, not a source.
  'docs/warehouse.dbml': `// erd-studio dbml-export v2 (DBML 9.1+)
Table dim_customer {
  customer_id int [pk]
  name varchar
}

Table fct_order {
  order_id int [pk]
  customer_id int
}

Ref: fct_order.customer_id > dim_customer.customer_id
`,
};

export default story({
  id: 'not-fooled-by-lookalikes',
  title: 'The first minute, in a repository of SQL lookalikes',
  persona: 'As an engineer whose repository has dbt macros, analyses and an exported diagram, but no table definitions',
  want: 'I want ERD Studio not to mistake them for a data model',
  soThat: 'so that it never offers an import that cannot work',
  workspace: {
    name: 'warehouse-utils',
    fill: (dir) => {
      for (const [rel, text] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
    },
  },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'warehouse-utils', {
      caption: 'Given my repository: dbt macros, a CREATE TABLE AS query and an exported DBML file, but no table definitions',
      say: 'Given my repository. It has dbt macros, a create table as select query, and a DBML file ERD Studio exported. But no table definitions.',
    });
    await installStep(s);
    await nothingPopsUp(s, { caption: 'Nothing pops up: none of it is offered as a data model to import' });

    let draft;
    await s.step('One click on the ERD Studio icon: the example, not a draft of my lookalikes', async () => {
      s.noise.expect(/^Example: /, { kind: 'tab', why: 'the ERD Studio icon' });
      await s.oneClick(() => s.ui.openSidebar('ERD Studio'));
      draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.primary, ['New Diagram…']);
      s.expect(draft.buttons.includes('Import Your Data Model…'), `the draft should offer Import Your Data Model…: ${draft.buttons.join(', ')}`);
      const tabs = (await s.ui.tabs()).map((t) => t.label);
      s.expect(!tabs.some((t) => t.startsWith('Draft: ')), `no draft of the lookalikes: ${tabs.join(', ')}`);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.button('Import Your Data Model…'));
      await s.pause(2000);
      await s.wb.unhighlight();
    }, { say: 'One click on the ERD Studio icon. It shows the example, not a draft of my lookalikes, and offers to bring my real model in.' });

    await s.step('"Import Your Data Model…" tells me where to get a real one, and finds nothing here', async () => {
      s.noise.expect(GUIDE_TAB, { kind: 'tab', why: 'Import Your Data Model…' });
      await draft.page.click(DRAFT.button('Import Your Data Model…'));
      draft.page.close();
      await s.ui.waitForActiveTab(GUIDE_TAB);
      const guide = await s.webview();
      await guide.waitFor(`doc.querySelector('.ig__heading')?.textContent.trim() === 'Import Your Data Model'`, { what: 'the guide' });
      const cards = await guide.ev(`[...doc.querySelectorAll('.ig-card')].map(c => c.dataset.card)`);
      // No "Found in this folder" card (no macro, CTAS or export is offered), and no dbt card (no dbt project).
      s.expect(!cards.includes('found'), `the guide should have no "Found in this folder" card: ${cards.join(', ')}`);
      s.expect(!cards.includes('dbt'), `the guide should have no dbt card outside a dbt project: ${cards.join(', ')}`);
      s.expect(cards.includes('databricks') && cards.includes('postgres') && cards.includes('dbml'), `the guide's cards: ${cards.join(', ')}`);
      s.expectNoFile('.erd-studio');
      await guide.highlight(`doc.querySelector('.ig__cards')`);
      await s.pause(2500);
      await s.wb.unhighlight();
      guide.close();
    }, { say: 'Import Your Data Model shows how to export a real model from each place it can live. It found nothing to import here.' });

    await quietFirstMinute(s, { max: 0 });
  },
});
