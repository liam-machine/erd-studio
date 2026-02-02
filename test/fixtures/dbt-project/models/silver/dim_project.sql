-- dim_project model
{{ config(materialized='table') }}

select
    project_id,
    project_name
from {{ ref('stg_projects') }}
