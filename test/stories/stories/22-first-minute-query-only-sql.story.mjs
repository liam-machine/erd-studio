// The first 60 seconds in a repository of SQL that holds queries only (an
// analytics repo: SELECTs, CTEs, an INSERT … SELECT, no CREATE TABLE),
// realistic: every VS Code prompt on, ERD Studio installed in the window as
// from the Marketplace. ERD Studio activates on install (workspaceContains
// *.sql) but its look finds no table definitions, so nothing pops up: no
// "found CREATE TABLE scripts" offer for files that are not a model. One
// click on the ERD Studio icon shows the example draft (as in an empty
// folder). Nothing may interrupt in the first minute.

import fs from 'node:fs';
import path from 'node:path';

import { DRAFT, waitForDraft } from '../lib/draft.mjs';
import { givenVSCode, installStep, nothingPopsUp, quietFirstMinute } from '../lib/firstMinute.mjs';
import { story } from '../lib/story.mjs';

const QUERIES = {
  'reports/monthly_revenue.sql': `-- Revenue by month, for the finance dashboard.
SELECT date_trunc('month', o.ordered_at) AS month, SUM(l.amount) AS revenue
FROM sales.orders o
JOIN sales.order_lines l ON l.order_id = o.order_id
GROUP BY 1
ORDER BY 1;
`,
  'reports/top_customers.sql': `WITH spend AS (
  SELECT customer_id, SUM(amount) AS total
  FROM sales.order_lines
  GROUP BY customer_id
)
SELECT c.name, s.total
FROM spend s
JOIN sales.customers c ON c.customer_id = s.customer_id
ORDER BY s.total DESC
LIMIT 20;
`,
  'jobs/refresh_daily_sales.sql': `DELETE FROM mart.daily_sales WHERE sale_date = CURRENT_DATE - 1;
INSERT INTO mart.daily_sales (sale_date, revenue)
SELECT CAST(ordered_at AS DATE), SUM(amount)
FROM sales.order_lines
WHERE CAST(ordered_at AS DATE) = CURRENT_DATE - 1
GROUP BY 1;
`,
};

export default story({
  id: 'first-minute-query-only-sql',
  title: 'The first minute, in a repository of SQL queries',
  persona: 'As an analyst whose repository holds SQL queries, not table definitions',
  want: 'I want ERD Studio to leave my queries alone',
  soThat: 'so that it never offers to turn reports into a data model',
  workspace: {
    name: 'analytics-queries',
    fill: (dir) => {
      for (const [rel, text] of Object.entries(QUERIES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
    },
  },
  realistic: true,
  steps: async (s) => {
    await givenVSCode(s, 'analytics-queries', { caption: 'Given VS Code as I use it, with my folder of SQL queries open' });
    await installStep(s);
    await nothingPopsUp(s, { caption: 'Nothing pops up: my queries are not a data model' });

    await s.step('One click on the ERD Studio icon: a finished example, as a draft', async () => {
      s.noise.expect(/^Example: /, { kind: 'tab', why: 'the ERD Studio icon' });
      await s.oneClick(() => s.ui.openSidebar('ERD Studio'));
      const draft = await waitForDraft(s, 'Example: Coffee shop');
      s.assert.deepEqual(draft.primary, ['New Diagram…']);
      s.expectNoFile('.erd-studio');
      await draft.page.highlight(DRAFT.banner);
      await s.pause(2500);
      await s.wb.unhighlight();
      draft.page.close();
    }, { say: 'One click on the ERD Studio icon: a finished example opens, as a draft. Nothing is saved.' });

    await quietFirstMinute(s, { max: 0 });
  },
});
