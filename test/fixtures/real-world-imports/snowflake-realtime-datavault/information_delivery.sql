------------------------------------------------------
-- RDV curr view
------------------------------------------------------

USE DATABASE DV_LAB;

USE SCHEMA l10_rdv;

CREATE VIEW sat_customer_curr_view
AS
SELECT *
FROM sat_customer
QUALIFY LEAD(ldts) OVER (PARTITION BY sha1_hub_customer ORDER BY ldts) IS NULL;

-- SELECT * FROM SAT_CUSTOMER_CURR_VIEW;

CREATE OR REPLACE VIEW sat_order_curr_view
AS
SELECT *
FROM sat_order
QUALIFY LEAD(ldts) OVER(PARTITION BY sha1_hub_order ORDER BY ldts) IS NULL;

-- SELECT * FROM SAT_ORDER_CURR_VIEW;

------------------------------------------------------------------------------------
-- BDV curr views
------------------------------------------------------------------------------------

USE SCHEMA l20_bdv;

CREATE VIEW sat_order_bv_curr_vw
AS
SELECT  *
FROM    sat_order_bv
QUALIFY LEAD(ldts) OVER (PARTITION BY sha1_hub_order ORDER BY ldts) IS NULL;

-- SELECT * FROM sat_order_bv_curr_vw;

CREATE VIEW sat_customer_bv_curr_vw
AS
SELECT  *
FROM    sat_customer_bv
QUALIFY LEAD(ldts) OVER (PARTITION BY sha1_hub_customer ORDER BY ldts) IS NULL;

-- SELECT * FROM sat_customer_bv_curr_vw;

USE SCHEMA l30_id;

-- DIM TYPE 1
CREATE OR REPLACE VIEW dim1_customer 
AS 
SELECT hub.sha1_hub_customer                      AS dim_customer_key
     , sat.ldts                                   AS effective_dts
     , hub.c_custkey                              AS customer_id
     , sat.rscr                                   AS record_source
     , sat.*     
  FROM l10_rdv.hub_customer                       hub
     , l20_bdv.sat_customer_bv_curr_vw            sat
 WHERE hub.sha1_hub_customer                      = sat.sha1_hub_customer;

-- DIM TYPE 1
CREATE OR REPLACE VIEW dim1_order
AS 
SELECT hub.sha1_hub_order                         AS dim_order_key
     , sat.ldts                                   AS effective_dts
     , hub.o_orderkey                             AS order_id
     , sat.rscr                                   AS record_source
     , sat.*
  FROM l10_rdv.hub_order                          hub
     , l20_bdv.sat_order_bv_curr_vw               sat
 WHERE hub.sha1_hub_order                         = sat.sha1_hub_order;

-- FACT table

CREATE OR REPLACE VIEW fct_customer_order
AS
SELECT lnk.ldts                                   AS effective_dts     
     , lnk.rscr                                   AS record_source
     , lnk.sha1_hub_customer                      AS dim_customer_key
     , lnk.sha1_hub_order                         AS dim_order_key
-- this is a factless fact, but here you can add any measures, calculated or derived
  FROM l10_rdv.lnk_customer_order                 lnk;  


USE SCHEMA l00_stg;

COPY INTO @customer_data 
FROM
(SELECT object_construct(*)
  FROM snowflake_sample_data.tpch_sf10.customer
  -- removed LIMIT 10
) 
INCLUDE_QUERY_ID=TRUE;

ALTER PIPE stg_customer_pp   REFRESH;

USE SCHEMA l30_id;

SELECT COUNT(1) FROM dim1_customer;


SELECT dc.nation_name
     , dc.region_name
     , do.order_priority_bucket
     , COUNT(1)                                   cnt_orders
  FROM fct_customer_order                         fct
     , dim1_customer                              dc
     , dim1_order                                 do
 WHERE fct.dim_customer_key                       = dc.dim_customer_key
   AND fct.dim_order_key                          = do.dim_order_key
GROUP BY 1,2,3;