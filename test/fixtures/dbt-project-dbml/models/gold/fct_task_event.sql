-- fct_task_event model
{{ config(materialized='table') }}

select
    event_id,
    task_id,
    event_date,
    amount
from {{ ref('stg_task_events') }}
