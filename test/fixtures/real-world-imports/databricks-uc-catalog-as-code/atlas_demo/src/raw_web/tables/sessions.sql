CREATE TABLE raw_web.sessions (
  session_id STRING NOT NULL COMMENT 'Browser session',
  account_id BIGINT COMMENT 'Signed-in account, if any',
  started_at TIMESTAMP COMMENT 'First page view',
  campaign_code STRING COMMENT 'utm_campaign of the landing page',
  landing_page STRING COMMENT 'Path of the first page',
  CONSTRAINT sessions_pk PRIMARY KEY (session_id)
)
COMMENT 'One row per browsing session';
