-- fct_work_events model
{{ config(materialized='table') }}

select
    event_id,
    work_lot_id,
    event_date,
    amount
from {{ ref('stg_work_events') }}
