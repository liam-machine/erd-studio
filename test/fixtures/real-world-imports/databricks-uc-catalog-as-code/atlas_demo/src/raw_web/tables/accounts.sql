CREATE TABLE raw_web.accounts (
  account_id BIGINT NOT NULL COMMENT 'Web account number',
  email_hash STRING COMMENT 'SHA-256 of the lower-cased email',
  signup_at TIMESTAMP COMMENT 'When the account was opened',
  country STRING COMMENT 'Country given at signup',
  CONSTRAINT accounts_pk PRIMARY KEY (account_id)
)
COMMENT 'One row per web account';
ALTER TABLE raw_web.accounts ALTER COLUMN email_hash SET TAGS ('pii' = 'hashed');
