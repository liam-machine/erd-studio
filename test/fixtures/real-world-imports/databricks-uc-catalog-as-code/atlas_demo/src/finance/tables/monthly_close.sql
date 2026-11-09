CREATE TABLE finance.monthly_close (
  month_start DATE NOT NULL COMMENT 'First day of the month',
  channel STRING NOT NULL COMMENT 'web or store',
  net_revenue DECIMAL(16,2) COMMENT 'Recognized revenue',
  CONSTRAINT monthly_close_pk PRIMARY KEY (month_start, channel)
)
COMMENT 'One row per month and channel, as closed';
