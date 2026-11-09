---------------------------------------------------------------------------------
-- setting up Raw Data Vault i.e. rdv
---------------------------------------------------------------------------------
USE DATABASE dv_lab;
USE SCHEMA l10_rdv;

--hubs

CREATE OR REPLACE TABLE hub_customer
(
    sha1_hub_customer BINARY NOT NULL,
    c_custkey NUMBER NOT NULL,
    ldts TIMESTAMP NOT NULL,
    rscr STRING NOT NULL,
    CONSTRAINT pk_hub_customer PRIMARY KEY(sha1_hub_customer)
);

CREATE OR REPLACE TABLE hub_order
(
    sha1_hub_order BINARY NOT NULL,
    o_orderkey NUMBER NOT NULL,
    ldts TIMESTAMP NOT NULL,
    rscr STRING NOT NULL,
    CONSTRAINT pk_hub_order PRIMARY KEY(sha1_hub_order)
);

--sats

CREATE OR REPLACE TABLE sat_customer
(
    sha1_hub_customer BINARY NOT NULL,
    ldts TIMESTAMP NOT NULL,
    c_name STRING,
    c_address STRING,
    c_phone STRING,
    c_acctbal NUMBER,
    c_mktsegment STRING,
    c_comment STRING,
    nationcode NUMBER,
    hash_diff BINARY NOT NULL,
    rscr STRING NOT NULL,
    CONSTRAINT pk_sat_customer PRIMARY KEY(sha1_hub_customer, ldts),
    CONSTRAINT fk_sat_customer FOREIGN KEY(sha1_hub_customer) REFERENCES hub_customer
);

CREATE OR REPLACE TABLE sat_order
(
    sha1_hub_order BINARY NOT NULL,
    ldts TIMESTAMP NOT NULL,
    o_orderstatus STRING,
    o_totalprice NUMBER,
    o_orderdate DATE,
    o_orderpriority STRING,
    o_clerk STRING,
    o_shippriority NUMBER,
    o_comment STRING,
    hash_diff BINARY NOT NULL,
    rscr STRING NOT NULL,
    CONSTRAINT pk_sat_order PRIMARY KEY(sha1_hub_order, ldts),
    CONSTRAINT fk_sat_order FOREIGN KEY(sha1_hub_order) REFERENCES hub_order
);

--links

CREATE OR REPLACE TABLE lnk_customer_order
(
    sha1_lnk_customer_order BINARY NOT NULL,
    sha1_hub_customer BINARY,
    sha1_hub_order BINARY,
    ldts TIMESTAMP NOT NULL,
    rscr STRING NOT NULL,
    CONSTRAINT pk_lnk_customer_order PRIMARY KEY(sha1_lnk_customer_order),
    CONSTRAINT fk1_lnk_customer_order FOREIGN KEY(sha1_hub_customer) REFERENCES hub_customer,
    CONSTRAINT fk2_lnk_customer_order FOREIGN KEY(sha1_hub_order) REFERENCES hub_order
);

-- ref data

CREATE OR REPLACE TABLE ref_region
(
    regioncode NUMBER,
    ldts TIMESTAMP,
    rscr STRING NOT NULL,
    r_name STRING,
    r_comment STRING,
    CONSTRAINT pk_ref_region PRIMARY KEY(regioncode)
)
AS
SELECT r_regionkey,
    ldts,
    rscr,
    r_name,
    r_comment
FROM l00_stg.stg_region;

 -- SELECT * FROM DV_LAB.L10_RDV.REF_REGION;

 CREATE OR REPLACE TABLE ref_nation
 (
    nationcode NUMBER,
    regioncode NUMBER,
    ldts TIMESTAMP,
    rscr STRING NOT NULL,
    n_name STRING,
    n_comment STRING,
    CONSTRAINT pk_ref_nation PRIMARY KEY(nationcode),
    CONSTRAINT fk_ref_region FOREIGN KEY(regioncode) REFERENCES ref_region(regioncode)
 )
 AS
 SELECT n_nationkey,
    n_regionkey,
    ldts,
    rscr,
    n_name,
    n_comment
FROM l00_stg.stg_nation;

-- SELECT * FROM DV_LAB.L10_RDV.REF_NATION;

-- tasks

CREATE OR REPLACE TASK customer_strm_tsk
    WAREHOUSE = dv_rdv_wh
    SCHEDULE = '1 minute'
WHEN 
    SYSTEM$STREAM_HAS_DATA('DV_LAB.L00_STG.STG_CUSTOMER_STRM')
AS
INSERT ALL
WHEN (SELECT COUNT(1) FROM hub_customer tgt
        WHERE tgt.sha1_hub_customer = src_sha1_hub_customer) = 0
THEN INTO hub_customer
(
    sha1_hub_customer,
    c_custkey,
    ldts,
    rscr
)
VALUES
(
    src_sha1_hub_customer,
    src_c_custkey,
    src_ldts,
    src_rscr
)
WHEN (SELECT COUNT(1) FROM sat_customer tgt
        WHERE tgt.sha1_hub_customer = src_sha1_hub_customer
        AND tgt.hash_diff = src_customer_hash_diff) = 0
THEN INTO sat_customer
(
    sha1_hub_customer,
    ldts,
    c_name,
    c_address,
    c_phone,
    c_acctbal,
    c_mktsegment,
    c_comment,
    nationcode,
    hash_diff,
    rscr
)
VALUES
(
    src_sha1_hub_customer,
    src_ldts,
    src_c_name,
    src_c_address,
    src_c_phone,
    src_c_acctbal,
    src_c_mktsegment,
    src_c_comment,
    src_nationcode,
    src_customer_hash_diff,
    src_rscr
)
SELECT
    sha1_hub_customer      src_sha1_hub_customer
     , c_custkey           src_c_custkey
     , c_name              src_c_name
     , c_address           src_c_address
     , c_nationcode        src_nationcode
     , c_phone             src_c_phone
     , c_acctbal           src_c_acctbal
     , c_mktsegment        src_c_mktsegment
     , c_comment           src_c_comment    
     , customer_hash_diff  src_customer_hash_diff
     , ldts                src_ldts
     , rscr                src_rscr
FROM l00_stg.stg_customer_strm_outbound src ;

CREATE OR REPLACE TASK order_strm_tsk
  WAREHOUSE = dv_rdv_wh
  SCHEDULE = '1 minute'
WHEN
  SYSTEM$STREAM_HAS_DATA('L00_STG.STG_ORDERS_STRM')
AS 
INSERT ALL
WHEN (SELECT COUNT(1) FROM hub_order tgt WHERE tgt.sha1_hub_order = src_sha1_hub_order) = 0
THEN INTO hub_order  
( sha1_hub_order
, o_orderkey
, ldts
, rscr
)  
VALUES 
( src_sha1_hub_order
, src_o_orderkey
, src_ldts
, src_rscr
)  
WHEN (SELECT COUNT(1) FROM sat_order tgt WHERE tgt.sha1_hub_order = src_sha1_hub_order AND tgt.hash_diff = src_order_hash_diff) = 0
THEN INTO sat_order  
(
  sha1_hub_order  
, ldts              
, o_orderstatus  
, o_totalprice   
, o_orderdate    
, o_orderpriority
, o_clerk        
, o_shippriority 
, o_comment              
, hash_diff         
, rscr              
)  
VALUES 
(
  src_sha1_hub_order  
, src_ldts              
, src_o_orderstatus  
, src_o_totalprice   
, src_o_orderdate    
, src_o_orderpriority
, src_o_clerk        
, src_o_shippriority 
, src_o_comment      
, src_order_hash_diff         
, src_rscr              
)
WHEN (SELECT COUNT(1) FROM lnk_customer_order tgt WHERE tgt.sha1_lnk_customer_order = src_sha1_lnk_customer_order) = 0
THEN INTO lnk_customer_order  
(
  sha1_lnk_customer_order  
, sha1_hub_customer              
, sha1_hub_order  
, ldts
, rscr              
)  
VALUES 
(
  src_sha1_lnk_customer_order
, src_sha1_hub_customer
, src_sha1_hub_order  
, src_ldts              
, src_rscr              
)
SELECT sha1_hub_order          src_sha1_hub_order
     , sha1_lnk_customer_order src_sha1_lnk_customer_order
     , sha1_hub_customer       src_sha1_hub_customer
     , o_orderkey              src_o_orderkey
     , o_orderstatus           src_o_orderstatus  
     , o_totalprice            src_o_totalprice   
     , o_orderdate             src_o_orderdate    
     , o_orderpriority         src_o_orderpriority
     , o_clerk                 src_o_clerk        
     , o_shippriority          src_o_shippriority 
     , o_comment               src_o_comment      
     , order_hash_diff         src_order_hash_diff
     , ldts                    src_ldts
     , rscr                    src_rscr
  FROM l00_stg.stg_order_strm_outbound src;

ALTER TASK dv_lab.l10_rdv.customer_strm_tsk RESUME;
ALTER TASK dv_lab.l10_rdv.order_strm_tsk RESUME;

-- once tasks are created successfully and RESUMEd, lets have a look at task execution history
SELECT *
    FROM table(information_schema.task_history())
    ORDER BY scheduled_time DESC;


SELECT 'hub_customer', count(1) FROM hub_customer
UNION ALL
SELECT 'hub_order', count(1) FROM hub_order
UNION ALL
SELECT 'sat_customer', count(1) FROM sat_customer
UNION ALL
SELECT 'sat_order', count(1) FROM sat_order
UNION ALL
SELECT 'lnk_customer_order', count(1) FROM lnk_customer_order
UNION ALL
SELECT 'l00_stg.stg_customer_strm_outbound', count(1) FROM l00_stg.stg_customer_strm_outbound
UNION ALL
SELECT 'l00_stg.stg_order_strm_outbound', count(1) FROM l00_stg.stg_order_strm_outbound;