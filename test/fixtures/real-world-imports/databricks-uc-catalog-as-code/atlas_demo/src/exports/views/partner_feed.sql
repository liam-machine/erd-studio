CREATE VIEW exports.partner_feed
COMMENT 'One row per product and week: units and revenue, for the wholesale partner'
AS SELECT cal.week_start, f.sku, p.product_name, sum(f.quantity) AS units,
  sum(f.net_amount) AS revenue
FROM sales.order_facts f
JOIN ref.products p ON p.sku = f.sku
JOIN ref.calendar cal ON cal.day = f.order_date
GROUP BY cal.week_start, f.sku, p.product_name;
