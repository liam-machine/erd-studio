-- ============================================================
-- ORDM · Canonical Core · Marketing domain
-- Table: promotion
-- Layer: canonical core (silver / conformed dimension)
-- Version: 0.5
-- Generated: 2026-06-09
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-06-09
-- ============================================================
-- Trade-promotion dimension (SCD2, matching the repo's other dims). One
-- structured row per promotion version: mechanics, funding, planned lift
-- and trade spend, and the dates / fiscal weeks it ran. Retail-week logic
-- (fiscal_week_start/end) references the NRF 4-5-4 fiscal calendar.
--
-- A reserved "no promotion" member (promo_id = 'NO_PROMO') exists so the
-- sales fact can attribute non-promoted rows to a real surrogate.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${marketing_schema}.promotion (
  promo_sk              BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per SCD2 version; the join/FK target.',
  promo_id              STRING NOT NULL
                          COMMENT 'Durable natural/business key for the promotion. The reserved value NO_PROMO marks the no-promotion member.',

  promo_name            STRING COMMENT 'Human-readable promotion name.',
  promo_type            STRING COMMENT 'Promotion mechanic. Allowed values: TPR, FEATURE, DISPLAY, FEATURE_AND_DISPLAY, BOGO, COUPON, BUNDLE. NULL only for the NO_PROMO member.',
  funding_type          STRING COMMENT 'How the promotion is funded. Allowed values: OFF_INVOICE, BILL_BACK, SCAN_DOWN, LUMP_SUM. NULL only for the NO_PROMO member.',
  funded_by             STRING COMMENT 'Who funds the promotion. Allowed values: SUPPLIER, RETAILER, SHARED. NULL only for the NO_PROMO member.',
  supplier_share_pct    DECIMAL(5,2) COMMENT 'Percent of trade spend funded by the supplier (0-100). Required when funded_by <> RETAILER.',

  start_date            DATE COMMENT 'Promotion start date, inclusive (ISO 8601).',
  end_date              DATE COMMENT 'Promotion end date, inclusive (ISO 8601).',
  fiscal_week_start     INT  COMMENT 'Fiscal week id (fiscal_calendar.fiscal_week_id) containing start_date.',
  fiscal_week_end       INT  COMMENT 'Fiscal week id (fiscal_calendar.fiscal_week_id) containing end_date.',

  planned_discount_pct  DECIMAL(5,2)  COMMENT 'Planned price discount percent (0-100).',
  planned_lift_pct      DECIMAL(6,2)  COMMENT 'Planned incremental unit lift percent over baseline.',
  planned_trade_spend   DECIMAL(18,2) COMMENT 'Planned total trade spend for the promotion, in the reporting/base currency (single-currency by construction).',

  -- SCD2 versioning (principle #8)
  effective_from_date   DATE    NOT NULL COMMENT 'SCD2: inclusive start date this version became effective.',
  effective_to_date     DATE             COMMENT 'SCD2: exclusive end date; NULL for the current version.',
  is_current          BOOLEAN NOT NULL COMMENT 'SCD2: TRUE for the currently active version.',

  -- Audit / provenance (standard block; all timestamps UTC)
  created_timestamp        TIMESTAMP COMMENT 'When the record was created in the source system (UTC, ISO 8601).',
  source_updated_timestamp TIMESTAMP COMMENT 'When the record was last modified in the source system (UTC, ISO 8601).',
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_promotion PRIMARY KEY (promo_sk)
)
USING DELTA
CLUSTER BY (promo_sk)
-- Deletion vectors speed row-level MERGE/UPDATE (SCD2 version closes, corrections).
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'Trade-promotion dimension (SCD2) for the Promote with Purpose outcome package.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${marketing_schema}.promotion SET TAGS ('dbx_data_type' = 'master');
