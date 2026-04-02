-- fct_sale model
{{ config(materialized='table') }}

select
    sale_id,
    project_id,
    amount
from {{ ref('stg_sales') }}
