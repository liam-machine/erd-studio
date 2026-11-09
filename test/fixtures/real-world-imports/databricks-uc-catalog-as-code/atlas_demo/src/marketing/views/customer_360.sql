CREATE VIEW marketing.customer_360
COMMENT 'One row per customer: region, lifetime revenue and last active month'
AS SELECT c.customer_id, c.region, c.first_seen,
  sum(m.revenue) AS lifetime_revenue, max(m.month_start) AS last_active_month
FROM core.customers c
LEFT JOIN sales.customer_monthly m ON m.customer_id = c.customer_id
GROUP BY c.customer_id, c.region, c.first_seen;
