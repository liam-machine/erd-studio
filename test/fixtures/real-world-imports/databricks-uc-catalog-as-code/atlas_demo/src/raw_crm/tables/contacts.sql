CREATE TABLE raw_crm.contacts (
  contact_id BIGINT NOT NULL COMMENT 'CRM contact number',
  loyalty_no STRING COMMENT 'Loyalty card, if issued',
  web_account_id BIGINT COMMENT 'Linked web account, if any',
  full_name STRING COMMENT 'Name as entered',
  email_hash STRING COMMENT 'SHA-256 of the lower-cased email',
  region STRING COMMENT 'Home region',
  created_at TIMESTAMP COMMENT 'When the contact was created',
  CONSTRAINT contacts_pk PRIMARY KEY (contact_id)
)
COMMENT 'One row per CRM contact';
ALTER TABLE raw_crm.contacts ALTER COLUMN full_name SET TAGS ('pii' = 'name');
ALTER TABLE raw_crm.contacts ALTER COLUMN email_hash SET TAGS ('pii' = 'hashed');
