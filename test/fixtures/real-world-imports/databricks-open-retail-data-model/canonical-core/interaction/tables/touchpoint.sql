-- ============================================================
-- ORDM · Canonical Core · Interaction domain
-- Table: touchpoint
-- Layer: canonical core (silver / conformed fact, append-only)
-- Version: 0.5
-- Generated: 2026-07-27
-- LLM-generated: true (maintainer-reviewed before release)
-- Last reviewed: 2026-07-27
-- ============================================================
-- The conformed OMNICHANNEL customer-interaction fact: one row per observed direct
-- customer touch, ONLINE and OFFLINE, across the whole shopper journey — the time-series
-- event class of the two-class CDP shape (kept SEPARATE from the customer profile; event
-- history is never stored on the master). Digital touches (page_view, product_view, search,
-- add_to_cart, checkout_start, app_open, session_start/end) AND offline touches (store_visit,
-- call_center_contact, kiosk_session, offline_marketing_response, phone_activation) live in
-- ONE fact, unioned by an interaction_type + channel_code discriminator with nullable role
-- columns — the same pattern as commerce-media-networks media_event (impression/click/video)
-- and unified-customer-view campaign_touch (web/call_center/in_store).
--
-- Anonymous-first: keyed on a hashed device/cookie id (digital) that stitches to the golden
-- profile via customer.identity_link when resolved; offline touches are identity-first
-- (profile_id known, device_id_hash NULL). This is the un-scoped, profile-resolvable
-- behavioral substrate multiple outcomes consume — ACU behavioral traits, UCV segmentation/
-- activation, CMN attribution, agentic-commerce — so it is the SINGLE SOURCE OF TRUTH for the
-- raw OCCURRENCE of a customer touch. commerce-media-networks conversion_event is a
-- paid-attribution MEASUREMENT projection of the conversion-relevant subset, not a second
-- recorder of the occurrence (ADR 0029).
--
-- Streaming-ready: event_timestamp / ingest_timestamp / latency_seconds for freshness
-- monitoring and sessionization (matches the equipment_reading streaming block).
--
-- Grain: one row per interaction (touchpoint_id). Append-only fact (no SCD2). Only
-- pseudonymized identifiers (hashed device key); no raw PII. Consent posture carried per
-- touch as a point-in-time snapshot (governance evidence) — the granted/denied/unknown
-- domain of media_event/campaign_touch, NOT the customer.consent SCD2 lifecycle domain.
--
-- NOT in scope (different grain): anonymous AGGREGATE physical footfall (store-zone traffic
-- counts / dwell) stays in connected-store store_zone_interval — that is aggregate, not a
-- person-level touch.
-- ============================================================

CREATE TABLE IF NOT EXISTS ${catalog}.${interaction_schema}.touchpoint (
  touchpoint_sk         BIGINT GENERATED ALWAYS AS IDENTITY
                          COMMENT 'Surrogate key. Unique per interaction row.',
  touchpoint_id         STRING NOT NULL
                          COMMENT 'Durable natural/business key for the interaction, unique at row grain.',

  -- Actor: anonymous-first (hashed device key) for digital; identity-first for offline.
  device_id_hash        STRING COMMENT 'Hashed/tokenized device/cookie/app identifier — the anonymous digital actor key. Never a raw device id, cookie, or IP (PII, pseudonymized). NULL for offline touches (identity-first).',
  session_id            STRING COMMENT 'Session/visit grouping key for sessionization (degenerate attribute; vendor-neutral, no PII). NULL for touches with no session (e.g. a single call-center contact).',
  identity_link_sk      BIGINT COMMENT 'FK to customer.identity_link.identity_link_sk — the assertion that stitched this device/actor to a profile, if resolved.',
  identity_link_id      STRING COMMENT 'Durable identity-link business key.',
  profile_sk            BIGINT COMMENT 'FK to customer.profile.profile_sk (resolved as-of event_date), if the touch is stitched to a known customer.',
  profile_id            STRING COMMENT 'Durable customer business key (pseudonymous; NULL while the touch is anonymous). Resolved AT INGEST: this fact is append-only, so a touch that was anonymous when written stays profile_id=NULL even after the device is later stitched - late resolution is re-derived at query time by joining device_id_hash through customer.identity_link (touchpoint_resolved_rate is therefore an at-ingest rate, not lifetime).',

  -- What happened + on which channel (the omnichannel discriminator)
  interaction_type      STRING NOT NULL COMMENT 'The kind of touch. Digital: page_view, product_view, search, add_to_cart, remove_from_cart, cart_view, checkout_start, wishlist_add, app_open, session_start, session_end. Offline: store_visit, call_center_contact, kiosk_session, offline_marketing_response, phone_activation.',
  channel_code          STRING COMMENT 'Channel the touch occurred on (omnichannel discriminator). The coarse MEDIUM. Allowed values: web, mobile_app, in_store, kiosk, call_center, direct_mail, other.',
  source_application    STRING COMMENT 'The specific application / property / data stream the touch came from (degenerate attribute; vendor-neutral, no PII). The SOURCE that pairs with channel_code (the medium), mirroring how a CDP pairs channel with source/data-stream on each event. Allowed values: ios_app, android_app, web_desktop, web_mobile, loyalty_kiosk, in_store_pos, call_center_app, email_platform, other.',
  touch_origin          STRING COMMENT 'Whether the touch is customer-initiated or brand-initiated. Allowed values: inbound, outbound.',
  event_timestamp       TIMESTAMP NOT NULL COMMENT 'When the touch occurred at source (UTC, ISO 8601).',
  event_date            DATE NOT NULL COMMENT 'Business date of the touch (cluster key). This IS the date_key-role natural key (the same calendar-join role sales.date_key plays), joined to fiscal_calendar.date_key (ISO 8601); it is named event_date for event semantics (ADR 0011 permits role-named stems). Guarded by the touchpoint_calendar_coverage DQ check. No surrogate FK, matching the sales convention.',
  ingest_timestamp      TIMESTAMP COMMENT 'When this touch was ingested into the lakehouse (UTC, ISO 8601).',
  latency_seconds       INT COMMENT 'Seconds between event_timestamp and ingest_timestamp (freshness monitoring).',

  -- Context dimensions (conformed core; nullable _sk + durable _id, inbound only)
  product_sk            BIGINT COMMENT 'FK to product.product_sk (version as-of event_date) — set for product_view / cart touches.',
  product_id            STRING COMMENT 'Durable product business key.',
  store_sk              BIGINT COMMENT 'FK to store.store_sk — in-store / kiosk / store-visit context, or the fulfilling store.',
  store_id              STRING COMMENT 'Durable store business key.',

  -- Digital context (degenerate attributes; vendor-neutral, de-identified, no PII)
  page_type             STRING COMMENT 'Page/screen class for digital touches. Allowed values: home, category, product, search, cart, checkout, account, content, other.',
  -- SOURCE-CONTRACT PII POSTURE (mandate section 11): page_url / referrer_url / search_term_text
  -- are free-text fields that classically leak PII (self-searches for a name/email, PII-bearing
  -- URL query params). ORDM requires them de-identified AT INGEST; the model cannot enforce that
  -- structurally (they are not identifiers, so a dbx_pii_* tag + mask is awkward), so it is a
  -- SOURCE CONTRACT the producer must honor, not a guarantee this column makes. Adopters handling
  -- untrusted input should add a dbx_value_regex guard or a mask at the ingest boundary.
  page_url              STRING COMMENT 'De-identified/normalized page path (source contract: no PII, no PII-bearing query params). NULL for offline touches.',
  referrer_url          STRING COMMENT 'De-identified/normalized referrer path (source contract: no PII).',
  search_term_text      STRING COMMENT 'Shopper search query for search touches (degenerate attribute; vendor-neutral; source contract: de-identified, no PII - a shopper may type a name/email, so ingest must scrub).',
  dwell_seconds         INT COMMENT 'Engagement depth: seconds spent on the touch, if known. CROSS-MODAL by interaction_type - page dwell (digital), call duration (call_center), or visit length (store_visit) - so these are NOT the same unit of comparability. A consumer averaging dwell across interaction_type blends incomparable durations; restrict to one modality (e.g. digital page_view/product_view) for a comparable engagement metric. NULL if not captured.',

  -- Funnel-correlation keys (link browse -> cart -> checkout -> order; degenerate references)
  cart_id               STRING COMMENT 'Cart correlation key linking cart touches within a shopping journey (degenerate; no FK).',
  order_id              STRING COMMENT 'Order correlation key when a checkout touch converts (degenerate business key to the order; no surrogate FK, header-grain).',

  -- Optional monetary measure (e.g. cart value on a cart_view / checkout_start)
  event_value_amount    DECIMAL(18,2) COMMENT 'Monetary value the touch carries, if any (e.g. cart value), in the reporting/base currency.',
  currency_code         STRING COMMENT 'Reporting/base currency of event_value_amount, ISO 4217 alpha-3 (single-currency by construction).',

  -- Consent posture AS OBSERVED AT TOUCH TIME (governance evidence / snapshot) — same
  -- 3-value domain as media_event / campaign_touch, NOT the customer.consent SCD2 domain.
  consent_status        STRING COMMENT 'Consent state at touch time. Allowed values: granted, denied, unknown.',

  -- Audit / provenance (append-only fact block; all timestamps UTC)
  record_source         STRING    COMMENT 'Originating system of record (vendor-neutral label).',
  load_timestamp        TIMESTAMP COMMENT 'When this row was loaded into the canonical core (UTC, ISO 8601).',

  CONSTRAINT pk_touchpoint PRIMARY KEY (touchpoint_sk)
)
USING DELTA
-- Cluster on the always-populated filter columns: event_date (period-range pruning) +
-- interaction_type (type filter). profile_id is NULL-heavy pre-stitch so it earns no
-- skipping; order-independent under Liquid Clustering (standard section B).
CLUSTER BY (event_date, interaction_type)
TBLPROPERTIES (delta.enableDeletionVectors = true)
COMMENT 'ORDM canonical-core conformed omnichannel customer-interaction fact (append-only). The time-series touch class of the two-class CDP shape, online + offline, kept separate from the customer profile.';

-- Table classification (machine-checkable layer/role): TAGS-DATA-TYPE
ALTER TABLE ${catalog}.${interaction_schema}.touchpoint SET TAGS ('dbx_data_type' = 'transactional');

-- PII column classification (principle #11) — hashed actor identifier.
ALTER TABLE ${catalog}.${interaction_schema}.touchpoint ALTER COLUMN device_id_hash SET TAGS ('dbx_pii_identifier' = 'true');
