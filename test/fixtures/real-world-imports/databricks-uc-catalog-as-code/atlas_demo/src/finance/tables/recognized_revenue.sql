CREATE TABLE finance.recognized_revenue (
  order_ref STRING NOT NULL COMMENT 'Order number as finance writes it: W<id> or P<id>',
  channel STRING COMMENT 'web or store',
  recognized_on DATE COMMENT 'Day the revenue is booked',
  gross DECIMAL(14,2) COMMENT 'Amount charged',
  tax DECIMAL(14,2) COMMENT 'Tax collected',
  refunded DECIMAL(14,2) COMMENT 'Refunds against the order',
  net_revenue DECIMAL(14,2) COMMENT 'Gross less tax and refunds',
  CONSTRAINT recognized_pk PRIMARY KEY (order_ref)
)
COMMENT 'One row per paid order';
ALTER TABLE finance.recognized_revenue SET TAGS ('certified' = 'true');
