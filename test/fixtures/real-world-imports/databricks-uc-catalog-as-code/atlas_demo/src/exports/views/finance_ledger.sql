CREATE VIEW exports.finance_ledger
COMMENT 'One row per month and channel, for the ledger upload'
AS SELECT mc.month_start, mc.channel, mc.net_revenue
FROM finance.monthly_close mc;
