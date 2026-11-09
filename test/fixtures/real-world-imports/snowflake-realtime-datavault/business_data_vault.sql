-------------------------------------------------------------------------------
-- Building Business Data Vault
-------------------------------------------------------------------------------

USE SCHEMA l20_bdv;

CREATE OR REPLACE VIEW sat_customer_bv
AS
SELECT rsc.sha1_hub_customer,
    rsc.ldts,
    rsc.c_name,
    rsc.c_address,
    rsc.c_phone,
    rsc.c_acctbal,
    rsc.c_mktsegment,
    rsc.c_comment,
    rsc.nationcode,
    rsc.rscr,
    rrn.n_name nation_name,
    rrr.r_name region_name
FROM l10_rdv.sat_customer rsc
LEFT OUTER JOIN l10_rdv.ref_nation rrn
ON (rsc.nationcode = rrn.nationcode)
LEFT OUTER JOIN l10_rdv.ref_region rrr
ON (rrn.regioncode = rrr.regioncode);

-- SELECT * FROM L20_BDV.SAT_CUSTOMER_BV;

CREATE OR REPLACE TABLE sat_order_bv
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
    order_priority_bucket STRING,
    CONSTRAINT pk_sat_order PRIMARY KEY(sha1_hub_order, ldts),
    CONSTRAINT fk_sat_order FOREIGN KEY(sha1_hub_order) REFERENCES l10_rdv.hub_order
)
AS
SELECT sha1_hub_order,
    ldts,
    o_orderstatus,
    o_totalprice,
    o_orderdate,
    o_orderpriority,
    o_clerk,
    o_shippriority,
    o_comment,
    hash_diff,
    rscr,
    CASE WHEN o_orderpriority in ('2-HIGH', '1-URGENT') AND o_totalprice >= 200000 THEN 'Tier-1'
         WHEN o_orderpriority in ('3-Medium', '2-High', '1-Urgent') AND o_totalprice BETWEEN 150000 AND 200000 THEN 'Tier-2'
         ELSE 'Tier-3'
    END order_priority_bucket
FROM l10_rdv.sat_order;

-- SELECT * FROM sat_order_bv;

-- What we are going to do from processing/orchestration perspective is extending our order processing pipeline 
-- so that when the task populates a l10_rdv.sat_order this will generate a new stream of changes and these changes 
-- are going to be propagated by a dependent task to l20_bdv.sat_order_bv. This is super easy to do as tasks in 
-- Snowflake can be not only schedule-based but also start automatically once the parent task is completed.

CREATE OR REPLACE STREAM dv_lab.l10_rdv.sat_order_strm ON TABLE dv_lab.l10_rdv.sat_order;

ALTER TASK l10_rdv.order_strm_tsk SUSPEND;

CREATE OR REPLACE TASK l10_rdv.hub_order_strm_sat_order_bv_tsk
    WAREHOUSE = dv_rdv_wh
    AFTER l10_rdv.order_strm_tsk
AS
INSERT INTO l20_bdv.sat_order_bv
SELECT   
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
-- derived additional attributes
, CASE WHEN o_orderpriority IN ('2-HIGH', '1-URGENT')             AND o_totalprice >= 200000 THEN 'Tier-1'
       WHEN o_orderpriority IN ('3-MEDIUM', '2-HIGH', '1-URGENT') AND o_totalprice BETWEEN 150000 AND 200000 THEN 'Tier-2'  
       ELSE 'Tier-3'
  END order_priority_bucket
FROM sat_order_strm;

ALTER TASK l10_rdv.hub_order_strm_sat_order_bv_tsk RESUME;
ALTER TASK l10_rdv.order_strm_tsk RESUME;

-- LETS go back to staging area to process another slice of data to test the task.

USE SCHEMA l00_stg;

COPY INTO @orders_data 
FROM
(SELECT *
  FROM snowflake_sample_data.tpch_sf10.orders limit 1000
) 
INCLUDE_QUERY_ID=TRUE;

ALTER PIPE stg_orders_pp   REFRESH;

SELECT 'l00_stg.stg_orders', count(1) FROM l00_stg.stg_orders
UNION ALl
SELECT 'l00_stg.stg_orders_strm', count(1) FROM l00_stg.stg_orders_strm
UNION ALl
SELECT 'l10_rdv.sat_order', count(1) FROM l10_rdv.sat_order
UNION ALl
SELECT 'l10_rdv.sat_order_strm', count(1) FROM l10_rdv.sat_order_strm
UNION ALL
SELECT 'l20_bdv.sat_order_bv', count(1) FROM l20_bdv.sat_order_bv;
