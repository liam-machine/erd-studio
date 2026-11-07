-- dim_region model
-- Deliberately has NO schema .yml and NO manifest node: this is the fixture's
-- only "source file only" model, exercising existence-from-the-filesystem.
{{ config(materialized='table') }}

select
    region_id,
    region_name
from {{ ref('stg_regions') }}
