-- dim_task model
{{ config(materialized='table') }}

select
    task_id,
    project_id,
    name,
    cast(status as STRING) as status
from {{ ref('stg_tasks') }}
