CREATE VIEW sales.top_products
COMMENT 'One row per product: revenue over the last 90 days, stores only'
AS SELECT p.category, d.sku, sum(d.revenue) AS revenue_90d
FROM sales.daily_sales d
JOIN ref.products p ON p.sku = d.sku
WHERE d.sale_date >= date_sub(current_date(), 90)
GROUP BY p.category, d.sku;
