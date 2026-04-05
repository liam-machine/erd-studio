-- dim_work_lot model
{{ config(materialized='table') }}

select
    work_lot_id,
    project_id,
    name,
    cast(status as STRING) as status
from {{ ref('stg_work_lots') }}
