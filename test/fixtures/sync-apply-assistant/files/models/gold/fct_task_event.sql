-- fct_task_event model
{{ config(materialized='table') }}

select
    event_id,
    task_id,
    event_date,
    amount,
    customer_key,
    project_key
from {{ ref('stg_task_events') }}
