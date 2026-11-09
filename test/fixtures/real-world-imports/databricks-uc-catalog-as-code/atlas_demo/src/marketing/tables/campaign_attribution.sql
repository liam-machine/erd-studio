CREATE TABLE marketing.campaign_attribution (
  campaign_code STRING NOT NULL COMMENT 'Campaign credited',
  order_key STRING NOT NULL COMMENT 'Order credited to it',
  attributed_revenue DECIMAL(12,2) COMMENT 'Net amount of the order',
  CONSTRAINT attribution_pk PRIMARY KEY (campaign_code, order_key)
)
COMMENT 'One row per campaign and order it is credited with';
