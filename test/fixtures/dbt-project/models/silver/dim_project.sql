-- dim_project model
{{ config(materialized='table') }}

select
    project_id,
    project_name,
    project_code
from {{ ref('stg_projects') }}
