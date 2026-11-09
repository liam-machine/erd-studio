CREATE TABLE core.customers (
  customer_id BIGINT NOT NULL COMMENT 'One id per person, from the CRM',
  contact_id BIGINT COMMENT 'CRM contact',
  web_account_id BIGINT COMMENT 'Web account, if linked',
  loyalty_no STRING COMMENT 'Loyalty card, if issued',
  region STRING COMMENT 'Home region',
  first_seen TIMESTAMP COMMENT 'Earliest of CRM creation and web signup',
  CONSTRAINT customers_pk PRIMARY KEY (customer_id)
)
COMMENT 'One row per customer, across channels';
ALTER TABLE core.customers SET TAGS ('certified' = 'true');
