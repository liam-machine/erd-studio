/*
#######################################################################
# NOTES ON OPTIMIZING QUERIES
######################################################################### 

JOIN KEYS:
1. Blocks and Transactions:
Use `block_hash` (not `block_timestamp`) for joins:
- block_hash is a unique key and provides a direct path for joining. 
- block_timestamp is non-unique and primarily for partition pruning.
- Joins on unique keys are usually faster and more straightforward for the optimizer.

2. Transactions and Receipts / Logs / Function Calls / Errors / Transaction Access Lists
Use `transaction_hash` 
- always preferred over (block_timestamp, transaction_index) because it’s a global unique identifier. 
- (block_timestamp, transaction_index) might force the query engine to scan more data, as it can’t prune as efficiently.


3. Logs and Decoded Events
Use Use (block_hash, log_index) or (transaction_hash, log_index)
- whichever key pair you standardized on as the primary key in both tables. Consistency is key.
- In practice, transaction_hash + log_index also works, but since log_index is unique at the block level, 
- (block_hash, log_index) is a clean unique pair. Either approach is fine as long as it’s consistent across tables.


*/

/* #######################################################################
# ARCHIVE OLD TABLES
######################################################################### */

-- ALTER TABLE shibarium.blocks
-- RENAME TO x_blocks;

-- ALTER TABLE shibarium.decoded_errors
-- RENAME TO x_decoded_errors;

-- ALTER TABLE shibarium.decoded_events
-- RENAME TO x_decoded_events;

-- ALTER TABLE shibarium.decoded_function_calls
-- RENAME TO x_decoded_function_calls;

-- ALTER TABLE shibarium.logs
-- RENAME TO x_logs;

-- ALTER TABLE shibarium.receipts
-- RENAME TO x_receipts;

-- ALTER TABLE shibarium.transaction_access_lists
-- RENAME TO x_transaction_access_lists;

-- ALTER TABLE shibarium.transactions
-- RENAME TO x_transactions;


/* #######################################################################
# RESET BY DELETING NEW TABLES
######################################################################### */

-- DROP TABLE `knine-1.shibarium.blocks`;
-- DROP TABLE `knine-1.shibarium.transactions`;
-- DROP TABLE `knine-1.shibarium.receipts`;
-- DROP TABLE `knine-1.shibarium.function_calls`;
-- DROP TABLE `knine-1.shibarium.logs`;
-- DROP TABLE `knine-1.shibarium.decoded_events`;
-- DROP TABLE `knine-1.shibarium.errors`;
-- DROP TABLE `knine-1.shibarium.transaction_access_lists`;



/* #######################################################################
# CREATE NEW TABLES
######################################################################### */

-------------------------------------
-- BLOCKS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.blocks` (
  block_hash         STRING        OPTIONS(description="Hash of the block."),
  block_number       INTEGER       OPTIONS(description="Number of the block."),
  block_timestamp    TIMESTAMP     OPTIONS(description="Timestamp when the block was added to the blockchain."),
  parent_hash        STRING        OPTIONS(description="Hash of the parent block."),
  size               INTEGER       OPTIONS(description="Size of the block in bytes."),
  extra_data         STRING        OPTIONS(description="Extra data of this block."),
  gas_limit          INTEGER       OPTIONS(description="Maximum gas allowed in this block."),
  gas_used           INTEGER       OPTIONS(description="Total gas used by all transactions in this block."),
  base_fee_per_gas   INTEGER       OPTIONS(description="Base fee per gas for this block."),
  mix_hash           STRING        OPTIONS(description="Mix hash for the proof of work."),
  nonce              BIGNUMERIC    OPTIONS(description="Nonce of the block."),
  difficulty         STRUCT<
    string_value     STRING        OPTIONS(description="Difficulty for this block (string representation)."),
    bignumeric_value BIGNUMERIC    OPTIONS(description="Difficulty for this block (bignumeric representation).")
  >                                OPTIONS(description="Difficulty for this block."),
  total_difficulty   STRUCT<
    string_value     STRING        OPTIONS(description="Accumulated difficulty of the chain until this block (string representation)."),
    bignumeric_value BIGNUMERIC    OPTIONS(description="Accumulated difficulty of the chain until this block (bignumeric representation).")
  >                                OPTIONS(description="Accumulated difficulty of the chain until this block."),
  miner              STRING        OPTIONS(description="Address of the miner."),
  uncles_sha3        STRING        OPTIONS(description="SHA3 of the uncles data in the block."),
  uncles             ARRAY<STRING> OPTIONS(description="List of uncle block hashes."),
  transactions_root  STRING        OPTIONS(description="Root of the transaction trie of the block."),
  receipts_root      STRING        OPTIONS(description="Root of the receipts trie of the block."),
  state_root         STRING        OPTIONS(description="Root of the final state trie of the block."),
  logs_bloom         STRING        OPTIONS(description="Bloom filter for the logs of the block."),
  transaction_count  INTEGER       OPTIONS(description="Number of transactions in the block.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY block_number
OPTIONS(
  description="Table containing 'block' data for the Shibarium blockchain."
);


-------------------------------------
-- TRANSACTIONS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.transactions` (
  block_hash                 STRING        OPTIONS(description="Hash of the block in which this transaction was located."),
  block_timestamp            TIMESTAMP     OPTIONS(description="Unix timestamp when the transaction was added to the blockchain."),
  transaction_hash           STRING        OPTIONS(description="Hash of the transaction."),
  transaction_index          INTEGER       OPTIONS(description="The transaction's index position in the block."),
  nonce                      BIGNUMERIC    OPTIONS(description="Number of transactions made by the sender prior to this one."),
  from_address               STRING        OPTIONS(description="Address of the sender."),
  to_address                 STRING        OPTIONS(description="Address of the receiver."),
  value                      STRUCT<
    string_value             STRING        OPTIONS(description="Value transferred in Wei as a string."),
    bignumeric_value         BIGNUMERIC    OPTIONS(description="Value transferred in Wei as a bignumeric.")
  >                                        OPTIONS(description="Value transferred in Wei."),
  input                      STRING        OPTIONS(description="Data sent along with the transaction, with a maximum size of 32 bytes."),
  gas                        INTEGER       OPTIONS(description="Quantity of gas units provided by the sender."),
  gas_price                  STRUCT<
    string_value             STRING        OPTIONS(description="Price per gas unit provided by the sender in Wei as a string."),
    bignumeric_value         BIGNUMERIC    OPTIONS(description="Price per gas unit provided by the sender in Wei as a bignumeric.")
  >                                        OPTIONS(description="Price per gas unit provided by the sender in Wei."),
  max_fee_per_gas            INTEGER       OPTIONS(description="Maximum fee per unit of gas for this transaction."),
  max_priority_fee_per_gas   INTEGER       OPTIONS(description="Maximum priority fee per unit of gas for this transaction."),
  transaction_type           INTEGER       OPTIONS(description="Type of the transaction."),
  r                          STRUCT<
    string_value             STRING        OPTIONS(description="ECDSA signature r value as a string."),
    bignumeric_value         BIGNUMERIC    OPTIONS(description="ECDSA signature r value as a bignumeric.")
  >                                        OPTIONS(description="ECDSA signature r."),
  s                          STRUCT<
    string_value             STRING        OPTIONS(description="ECDSA signature s value as a string."),
    bignumeric_value         BIGNUMERIC    OPTIONS(description="ECDSA signature s value as a bignumeric.")
  >                                        OPTIONS(description="ECDSA signature s."),
  v                          STRUCT<
    string_value             STRING        OPTIONS(description="ECDSA signature v value as a string."),
    bignumeric_value         BIGNUMERIC    OPTIONS(description="ECDSA signature v value as a bignumeric.")
  >                                        OPTIONS(description="ECDSA signature v.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY to_address, transaction_index
OPTIONS(
  description="Table containing transactions from the Shibarium blockchain."
);


-------------------------------------
-- RECEIPTS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.receipts` (
  block_hash          STRING    OPTIONS(description="Hash of the block in which this transaction was located."),
  block_timestamp     TIMESTAMP OPTIONS(description="Unix timestamp when the transaction was added to the blockchain."),
  transaction_hash    STRING    OPTIONS(description="Hash of the transaction."),
  transaction_index   INTEGER   OPTIONS(description="The transaction's index position in the block."),
  from_address        STRING    OPTIONS(description="Address of the sender."),
  to_address          STRING    OPTIONS(description="Address of the receiver."),
  contract_address    STRING    OPTIONS(description="Hexadecimal-encoded address of new contract or absent if no contract was created."),
  cumulative_gas_used INTEGER   OPTIONS(description="Gas used by this and all preceding transactions in the block."),
  gas_used            INTEGER   OPTIONS(description="Gas used by this transaction alone."),
  effective_gas_price INTEGER   OPTIONS(description="Actual value per gas deducted from the sender's account."),
  root                STRING    OPTIONS(description="Post-transaction state root."),
  status              INTEGER   OPTIONS(description="Either 1 (success) or 0 (failure)."),
  log_count           INTEGER   OPTIONS(description="Number of logs in the transaction.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY to_address, transaction_index
OPTIONS(
  description="Table containing transaction receipts from Shibarium transactions."
);


-------------------------------------
-- FUNCTION CALLS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.function_calls` (
  block_hash          STRING    OPTIONS(description="Hash of the block in which this transaction was located."),
  block_timestamp     TIMESTAMP OPTIONS(description="Unix timestamp when the transaction was added to the blockchain."),
  transaction_hash    STRING    OPTIONS(description="Hash of the transaction."),
  function_name       STRING    OPTIONS(description="Function/method name, decoded from function selector."),
  function_selector   STRING    OPTIONS(description="The 4-byte function selector. (First 8 hex characters of transaction input.)"),
  function_signature  STRING    OPTIONS(description="The 4-byte decoded function selector with method name and parameters types."),
  function_args       STRING    OPTIONS(description="Decoded function arguments serialized as a JSON array."),
  function_args_full  STRING    OPTIONS(description="Serialized JSON object defining the name, type, and value of arguments passed to a function call, as a string.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY function_name
OPTIONS(
  description="Table containing decoded function calls from Shibarium transactions. For transactions calling smart contract functions, the transaction input data is parsed to give a 4-byte function selector. For known function selectors, decoded function/method names, and decoded arguments are provided. Decoding was done using custom data, and the etherface.io and 4byte.directory APIs."
);


-------------------------------------
-- LOGS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.logs` (
  block_hash          STRING        OPTIONS(description="Hash of the block this log was created from."),
  block_number        INTEGER       OPTIONS(description="Number of the block this log was created from."),
  block_timestamp     TIMESTAMP     OPTIONS(description="Unix timestamp when the log was added to the blockchain."),
  transaction_hash    STRING        OPTIONS(description="Hash of the transaction this log was created from."),
  transaction_index   INTEGER       OPTIONS(description="The transaction's index position in the block."),
  log_index           INTEGER       OPTIONS(description="The log's index position in the block."),
  address             STRING        OPTIONS(description="Address from which this log originated."),
  data                STRING        OPTIONS(description="Contains one or more 32-byte non-indexed arguments of the log."),
  topics              ARRAY<STRING> OPTIONS(description="Array of 0 to 4 32-byte hex of indexed log arguments."),
  removed             BOOLEAN       OPTIONS(description="Whether or not the log was orphaned off the main chain.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY address, log_index
OPTIONS(
  description="Table containing logs from Shibarium transactions."
);


-------------------------------------
-- DECODED EVENTS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.decoded_events` (
  block_hash         STRING    OPTIONS(description="Hash of the block this event was emitted on."),
  block_timestamp    TIMESTAMP OPTIONS(description="Unix timestamp when the block was added to the blockchain."),
  transaction_hash   STRING    OPTIONS(description="Hash of the transaction this event was emitted on."),
  log_index          INTEGER   OPTIONS(description="The event's index position in the transaction."),
  address            STRING    OPTIONS(description="Address from which this event originated."),
  event_name         STRING    OPTIONS(description="Name of a custom event, decoded from topic0."),
  event_signature    STRING    OPTIONS(description="Decoded event signature, including name and parameter types."),
  event_hash         STRING    OPTIONS(description="Keccak hash of the event signature."),
  args               STRING    OPTIONS(description="Decoded event arguments serialized as a JSON array.")
)
PARTITION BY DATE(block_timestamp)
CLUSTER BY event_name, address, log_index
OPTIONS(
  description="Table containing decoded events from Shibarium transaction logs. Decoded using custom data, and the etherface.io and 4byte.directory APIs."
);

-------------------------------------
-- ERRORS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.errors` (
  block_hash         STRING    OPTIONS(description="Hash of the block in which this transaction was located."),
  block_timestamp    TIMESTAMP OPTIONS(description="Unix timestamp when the transaction was added to the blockchain."),
  transaction_hash   STRING    OPTIONS(description="Hash of the failed transaction."),
  error              STRING    OPTIONS(description="Decoded revert string or custom error."),
  error_hash         STRING    OPTIONS(description="The error hash.")
)
PARTITION BY DATE(block_timestamp)
OPTIONS(
  description="Table containing decoded errors and revert messages, for failed Shibarium transactions. Decoded using the etherface.io API."
);


-------------------------------------
-- TRANSACTION ACCESS LISTS
-------------------------------------

CREATE TABLE IF NOT EXISTS `knine-1.shibarium.transaction_access_lists` (
  block_hash          STRING        OPTIONS(description="Hash of the block in which this transaction was located."),
  block_timestamp     TIMESTAMP     OPTIONS(description="Unix timestamp when the transaction was added to the blockchain."),
  transaction_hash    STRING        OPTIONS(description="Hash of the transaction."),
  access_list         ARRAY<STRUCT<
    address           STRING        OPTIONS(description="Address that a particular transaction will access."),
    storage_keys      ARRAY<STRING> OPTIONS(description="List of storage keys a particular transaction will access.")
  >>                                OPTIONS(description="List of addresses and storage keys that the transaction plans to access and has pre-paid gas for.")
)
PARTITION BY DATE(block_timestamp)
OPTIONS(
  description="Table containing transaction access list update data for Shibarium transactions."
);





/* #######################################################################
# SETUP CONSTRAINTS
######################################################################### */

-------------------------------------
-- PRIMARY KEYS
-------------------------------------

ALTER TABLE `knine-1.shibarium.blocks`
ADD PRIMARY KEY (block_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.transactions`
ADD PRIMARY KEY (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.receipts`
ADD PRIMARY KEY (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.function_calls`
ADD PRIMARY KEY (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.logs`
ADD PRIMARY KEY (block_hash, log_index) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.decoded_events`
ADD PRIMARY KEY (block_hash, log_index) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.errors`
ADD PRIMARY KEY (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.transaction_access_lists`
ADD PRIMARY KEY (transaction_hash) NOT ENFORCED;



-------------------------------------
-- FOREIGN KEYS
-------------------------------------

ALTER TABLE `knine-1.shibarium.transactions`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.function_calls` (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.receipts`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.function_calls` (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.function_calls`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.transaction_access_lists`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.errors`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.logs`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (block_hash, log_index) REFERENCES `knine-1.shibarium.decoded_events` (block_hash, log_index) NOT ENFORCED;

ALTER TABLE `knine-1.shibarium.decoded_events`
ADD FOREIGN KEY (block_hash) REFERENCES `knine-1.shibarium.blocks` (block_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.transactions` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (transaction_hash) REFERENCES `knine-1.shibarium.receipts` (transaction_hash) NOT ENFORCED,
ADD FOREIGN KEY (block_hash, log_index) REFERENCES `knine-1.shibarium.logs` (block_hash, log_index) NOT ENFORCED;


/* #######################################################################
# RESTORE DATA FROM OLD TABLES
######################################################################### */

-- INSERT INTO `knine-1.shibarium.blocks`
-- SELECT DISTINCT
--   block_hash,
--   block_number,
--   block_timestamp,
--   parent_hash,
--   size,
--   extra_data,
--   gas_limit,
--   gas_used,
--   base_fee_per_gas,
--   mix_hash,
--   nonce,
--   difficulty,
--   total_difficulty,
--   miner,
--   uncles_sha3,
--   uncles,
--   transactions_root,
--   receipts_root,
--   state_root,
--   logs_bloom,
--   transaction_count
-- FROM `knine-1.shibarium.x_blocks`;


-- INSERT INTO `knine-1.shibarium.transactions`
-- SELECT DISTINCT
--   block_hash,
--   block_timestamp,
--   transaction_hash,
--   transaction_index,
--   nonce,
--   from_address,
--   to_address,
--   value,
--   input,
--   gas,
--   gas_price,
--   max_fee_per_gas,
--   max_priority_fee_per_gas,
--   transaction_type,
--   r,
--   s,
--   v
-- FROM `knine-1.shibarium.x_transactions`;


-- INSERT INTO `knine-1.shibarium.receipts`
-- SELECT DISTINCT
--   block_hash,
--   block_timestamp,
--   transaction_hash,
--   transaction_index,
--   from_address,
--   to_address,
--   contract_address,
--   cumulative_gas_used,
--   gas_used,
--   effective_gas_price,
--   root,
--   status
-- FROM `knine-1.shibarium.x_receipts`;


-- INSERT INTO `knine-1.shibarium.function_calls`
-- SELECT DISTINCT
--   block_hash,
--   block_timestamp,
--   transaction_hash,
--   function_name,
--   function_selector,
--   function_signature,
--   function_args,
--   function_args_full
-- FROM `knine-1.shibarium.x_decoded_function_calls`;


-- INSERT INTO `knine-1.shibarium.logs`
-- SELECT DISTINCT
--   block_hash,
--   block_number,
--   block_timestamp,
--   transaction_hash,
--   transaction_index,
--   log_index,
--   address,
--   data,
--   topics,
--   removed
-- FROM `knine-1.shibarium.x_logs`;


-- INSERT INTO `knine-1.shibarium.decoded_events`
-- SELECT DISTINCT
--   block_hash,
--   block_timestamp,
--   transaction_hash,
--   log_index,
--   address,
--   event_name,
--   event_signature,
--   event_hash,
--   TO_JSON_STRING(args) AS args
-- FROM `knine-1.shibarium.x_decoded_events`;


-- INSERT INTO `knine-1.shibarium.errors`
-- SELECT DISTINCT
--   block_hash,
--   block_timestamp,
--   transaction_hash,
--   error,
--   error_hash
-- FROM `knine-1.shibarium.x_decoded_errors`;

/* #######################################################################
# MATERIALIZE VIEWS FOR PREVIOUSLY DECODED INFORMATION
######################################################################### */

CREATE MATERIALIZED VIEW IF NOT EXISTS `knine-1.shibarium.mv_decoded_events` AS
SELECT DISTINCT
  event_hash,
  event_name,
  event_signature
FROM `knine-1.shibarium.decoded_events`
WHERE event_hash IS NOT NULL
  -- AND event_signature IS NOT NULL
;

CREATE MATERIALIZED VIEW IF NOT EXISTS `knine-1.shibarium.mv_decoded_functions` AS
SELECT DISTINCT
  function_selector,
  function_signature,
  function_name
FROM `knine-1.shibarium.function_calls`
WHERE function_selector IS NOT NULL
  -- AND function_signature IS NOT NULL
;

CREATE MATERIALIZED VIEW IF NOT EXISTS `knine-1.shibarium.mv_decoded_errors` AS
SELECT DISTINCT
  error_hash,
  error
FROM `knine-1.shibarium.errors`
WHERE error_hash IS NOT NULL
  -- AND error IS NOT NULL
;

/* #######################################################################
# SEARCH INDEXES 
######################################################################### */
-- for quick searches on hashes and addresses

-------------------------------------
-- VIEW SEARCH INDEXES
-------------------------------------
SELECT table_name, index_name, ddl, coverage_percentage, analyzer
FROM `knine-1.shibarium.INFORMATION_SCHEMA.SEARCH_INDEXES`
WHERE index_status = 'ACTIVE';

-------------------------------------
-- CREATE SEARCH INDEXES
-------------------------------------
CREATE SEARCH INDEX blocks_index ON `knine-1.shibarium.blocks` (block_hash);

CREATE SEARCH INDEX transactions_index ON `knine-1.shibarium.transactions` (block_hash, transaction_hash, from_address, to_address);
CREATE SEARCH INDEX receipts_index ON `knine-1.shibarium.receipts` (block_hash, transaction_hash, from_address, to_address);
CREATE SEARCH INDEX function_calls_index ON `knine-1.shibarium.function_calls` (block_hash, transaction_hash, function_name, function_selector, function_signature);

CREATE SEARCH INDEX logs_index ON `knine-1.shibarium.logs` (block_hash, transaction_hash, address);
CREATE SEARCH INDEX decoded_events_index ON `knine-1.shibarium.decoded_events` (block_hash, transaction_hash, address, event_name, event_signature);

CREATE SEARCH INDEX errors_index ON `knine-1.shibarium.errors` (block_hash, transaction_hash);
CREATE SEARCH INDEX transaction_access_lists_index ON `knine-1.shibarium.transaction_access_lists` (block_hash, transaction_hash);


-------------------------------------
-- DROP SEARCH INDEXES
-------------------------------------

DROP SEARCH INDEX blocks_index ON `knine-1.shibarium.blocks`;
DROP SEARCH INDEX transactions_index ON `knine-1.shibarium.transactions`;
DROP SEARCH INDEX receipts_index ON `knine-1.shibarium.receipts`;
DROP SEARCH INDEX function_calls_index ON `knine-1.shibarium.function_calls`;
DROP SEARCH INDEX logs_index ON `knine-1.shibarium.logs`;
DROP SEARCH INDEX decoded_events_index ON `knine-1.shibarium.decoded_events`;
DROP SEARCH INDEX errors_index ON `knine-1.shibarium.errors`;
DROP SEARCH INDEX transaction_access_lists_index ON `knine-1.shibarium.transaction_access_lists`;
