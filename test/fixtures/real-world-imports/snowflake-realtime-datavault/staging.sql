-------------------------------------------------------------
-- setting up the staging area
-------------------------------------------------------------

USE SCHEMA l00_stg;

CREATE OR REPLACE TABLE stg_nation
AS
SELECT src.*,
    CURRENT_TIMESTAMP() ldts,
    'Static Reference Data' rscr
FROM snowflake_sample_data.tpch_sf10.nation src;

SELECT * FROM DV_LAB.L00_STG.STG_NATION LIMIT 10;

CREATE OR REPLACE TABLE stg_region
AS
SELECT src.*,
    CURRENT_TIMESTAMP() ldts,
    'Static Reference Data' rscr
FROM snowflake_sample_data.tpch_sf10.region src;

SELECT * FROM DV_LAB.L00_STG.STG_REGION LIMIT 10;

CREATE OR REPLACE TABLE stg_customer
(
    raw_json VARIANT,
    filename STRING NOT NULL,
    file_row_seq NUMBER NOT NULL,
    ldts STRING NOT NULL,
    rscr STRING NOT NULL
);

SELECT * FROM DV_LAB.L00_STG.STG_CUSTOMER LIMIT 10;

CREATE OR REPLACE TABLE stg_orders
(
    o_orderkey NUMBER,
    o_custkey NUMBER,
    o_orderstatus STRING,
    o_totalprice NUMBER,
    o_orderdate DATE,
    o_orderpriority STRING,
    o_clerk STRING,
    o_shippriority NUMBER,
    o_comment STRING,
    filename STRING NOT NULL,
    file_row_seq NUMBER NOT NULL,
    ldts STRING NOT NULL,
    rscr STRING NOT NULL
);

SELECT * FROM DV_LAB.L00_STG.STG_ORDERS LIMIT 10;

CREATE OR REPLACE STREAM stg_customer_strm ON TABLE stg_customer;
CREATE OR REPLACE STREAM stg_orders_strm ON TABLE stg_orders;

CREATE OR REPLACE STAGE customer_data FILE_FORMAT = (TYPE = JSON);
CREATE OR REPLACE STAGE orders_data FILE_FORMAT = (TYPE = CSV);


COPY INTO @customer_data
FROM
(
    SELECT object_construct(*)
    FROM snowflake_sample_data.tpch_sf10.customer limit 10
)
INCLUDE_QUERY_ID = TRUE;

COPY INTO @orders_data
FROM
(
    SELECT *
    FROM snowflake_sample_data.tpch_sf10.orders limit 1000
)
INCLUDE_QUERY_ID = TRUE;

list @customer_data;
SELECT METADATA$FILENAME, $1 FROM @customer_data;


CREATE OR REPLACE PIPE stg_orders_pp
AS
COPY INTO stg_orders
FROM
(
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
        metadata$filename,
        metadata$file_row_number,
        CURRENT_TIMESTAMP(),
        'Orders System'
    FROM @orders_data
);

CREATE OR REPLACE PIPE stg_customer_pp
AS
COPY INTO stg_customer
FROM
(
    SELECT $1,
        metadata$filename,
        metadata$file_row_number,
        CURRENT_TIMESTAMP(),
        'Customers System'
    FROM @customer_data
);

ALTER PIPE stg_customer_pp REFRESH;
ALTER PIPE stg_orders_pp REFRESH;

SELECT 'stg_customer', count(1) FROM stg_customer
UNION ALL
SELECT 'stg_orders', count(1) FROM stg_orders
UNION ALL
SELECT 'stg_orders_strm', count(1) FROM stg_orders_strm
UNION ALL
SELECT 'stg_customer_strm', count(1) FROM stg_customer_strm
;

CREATE OR REPLACE VIEW stg_customer_strm_outbound AS
SELECT src.*
    , raw_json:C_CUSTKEY::NUMBER    c_custkey
    , raw_json:C_NAME::STRING       c_name
    , raw_json:C_ADDRESS::STRING    c_address
    , raw_json:C_NATIONKEY::NUMBER  c_nationcode
    , raw_json:C_PHONE::STRING      c_phone
    , raw_json:C_ACCTBAL:NUMBER     c_acctbal
    , raw_json:C_MKTSEGMENT::STRING c_mktsegment
    , raw_json:C_COMMNET::STRING    c_comment
    , SHA1_BINARY(UPPER(TRIM(c_custkey))) sha1_hub_customer
    , SHA1_BINARY(UPPER(ARRAY_TO_STRING(ARRAY_CONSTRUCT( 
                                              NVL(TRIM(c_name)       ,'-1')
                                            , NVL(TRIM(c_address)    ,'-1')              
                                            , NVL(TRIM(c_nationcode) ,'-1')                 
                                            , NVL(TRIM(c_phone)      ,'-1')            
                                            , NVL(TRIM(c_acctbal)    ,'-1')               
                                            , NVL(TRIM(c_mktsegment) ,'-1')                 
                                            , NVL(TRIM(c_comment)    ,'-1')               
                                            ), '^')))  AS customer_hash_diff
FROM stg_customer_strm src;

SELECT * FROM DV_LAB.L00_STG.STG_CUSTOMER_STRM_OUTBOUND;

CREATE OR REPLACE VIEW stg_order_strm_outbound AS 
SELECT src.*
     , SHA1_BINARY(UPPER(TRIM(o_orderkey)))             sha1_hub_order
     , SHA1_BINARY(UPPER(TRIM(o_custkey)))              sha1_hub_customer  
     , SHA1_BINARY(UPPER(ARRAY_TO_STRING(ARRAY_CONSTRUCT( NVL(TRIM(o_orderkey)       ,'-1')
                                                        , NVL(TRIM(o_custkey)        ,'-1')
                                                        ), '^')))  AS sha1_lnk_customer_order             
     , SHA1_BINARY(UPPER(ARRAY_TO_STRING(ARRAY_CONSTRUCT( NVL(TRIM(o_orderstatus)    , '-1')         
                                                        , NVL(TRIM(o_totalprice)     , '-1')        
                                                        , NVL(TRIM(o_orderdate)      , '-1')       
                                                        , NVL(TRIM(o_orderpriority)  , '-1')           
                                                        , NVL(TRIM(o_clerk)          , '-1')    
                                                        , NVL(TRIM(o_shippriority)   , '-1')          
                                                        , NVL(TRIM(o_comment)        , '-1')      
                                                        ), '^')))  AS order_hash_diff     
  FROM stg_orders_strm src
;

SELECT * FROM DV_LAB.L00_STG.STG_ORDER_STRM_OUTBOUND;