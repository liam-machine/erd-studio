-- dim_work_lot model
{{ config(materialized='table') }}

select
    work_lot_id,
    project_id,
    name,
    status
from {{ ref('stg_work_lots') }}
