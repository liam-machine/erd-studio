-- ============================================================
-- ORDM · Canonical Core · Interaction domain · relationships & constraints
-- Version: 0.5 · Generated: 2026-07-27 · LLM-generated: true · Reviewed: 2026-07-27
-- ============================================================
-- Informational foreign keys (single-column, on the parent _sk primary key, NORELY by
-- default) + enum CHECK constraints. CHECKs are added via ALTER (NO-INLINE-CHECK): Databricks
-- supports only PRIMARY KEY / FOREIGN KEY inline. All FKs point OUTWARD/UPWARD to conformed
-- dims and the customer master (inbound to those tables) — LAYER-INTEGRITY preserved; nothing
-- in canonical core FKs into touchpoint. event_date is a natural date key to
-- fiscal_calendar.date_key (the sales.date_key convention) and carries no minted surrogate,
-- so it is not declared as a UC FK, same as sales.
-- ============================================================

-- ---------- touchpoint FKs (informational, NORELY) ----------
ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT fk_touchpoint_identity_link
  FOREIGN KEY (identity_link_sk) REFERENCES ${catalog}.${customer_schema}.identity_link (identity_link_sk);

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT fk_touchpoint_profile
  FOREIGN KEY (profile_sk) REFERENCES ${catalog}.${customer_schema}.profile (profile_sk);

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT fk_touchpoint_product
  FOREIGN KEY (product_sk) REFERENCES ${catalog}.${product_schema}.product (product_sk);

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT fk_touchpoint_store
  FOREIGN KEY (store_sk) REFERENCES ${catalog}.${store_schema}.store (store_sk);

-- ---------- touchpoint enum CHECKs ----------
ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_interaction_type
  CHECK (interaction_type IN ('page_view', 'product_view', 'search', 'add_to_cart',
    'remove_from_cart', 'cart_view', 'checkout_start', 'wishlist_add', 'app_open',
    'session_start', 'session_end', 'store_visit', 'call_center_contact', 'kiosk_session',
    'offline_marketing_response', 'phone_activation'));

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_channel
  CHECK (channel_code IS NULL OR channel_code IN ('web', 'mobile_app', 'in_store', 'kiosk',
    'call_center', 'direct_mail', 'other'));

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_source_application
  CHECK (source_application IS NULL OR source_application IN ('ios_app', 'android_app',
    'web_desktop', 'web_mobile', 'loyalty_kiosk', 'in_store_pos', 'call_center_app',
    'email_platform', 'other'));

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_origin
  CHECK (touch_origin IS NULL OR touch_origin IN ('inbound', 'outbound'));

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_page_type
  CHECK (page_type IS NULL OR page_type IN ('home', 'category', 'product', 'search', 'cart',
    'checkout', 'account', 'content', 'other'));

ALTER TABLE ${catalog}.${interaction_schema}.touchpoint
  ADD CONSTRAINT chk_touchpoint_consent
  CHECK (consent_status IS NULL OR consent_status IN ('granted', 'denied', 'unknown'));
