-- dim_project model
{{ config(materialized='table') }}

select
    project_id,
    project_name,
    project_code,
    parent_project_key
from {{ ref('stg_projects') }}
