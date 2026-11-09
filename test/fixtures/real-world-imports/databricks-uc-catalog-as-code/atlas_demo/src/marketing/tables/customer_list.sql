CREATE TABLE marketing.customer_list (
  customer_id BIGINT COMMENT 'Customer',
  region STRING COMMENT 'Home region',
  first_seen TIMESTAMP COMMENT 'When the contact was created',
  loyalty_no STRING COMMENT 'Loyalty card, if issued',
  email_hash STRING COMMENT 'SHA-256 of the lower-cased email'
)
COMMENT 'Customers, for building audiences';
ALTER TABLE marketing.customer_list ALTER COLUMN email_hash SET TAGS ('pii' = 'hashed');
