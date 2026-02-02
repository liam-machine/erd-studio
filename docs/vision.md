# Vision: AI-Assisted Data Engineering

> A workflow where Claude designs the data model, humans review and refine, then Claude builds the implementation. From KPI request to Power BI report.

## The Problem

Building analytics involves multiple handoffs between business requirements, data modeling, dbt development, and BI reporting. Each handoff creates friction, delays, and opportunities for miscommunication.

## The Solution

An AI-assisted workflow with **human checkpoints** at critical decision points:

```
User Request → AI Design → Human Review → AI Build → Delivered Report
```

The dbt Semantic Designer serves as the **visual checkpoint** where data engineers validate AI-proposed designs before committing to implementation.

## Workflow Steps

### 1. User Requests a KPI Report
**Actor:** User → Claude
**Tool:** Claude Code

The data engineer describes the business requirement in natural language:

> "Build me a report with KPI: Revenue per Customer, broken down by region and product category"

Claude understands the KPI, identifies required dimensions, and determines data sources.

### 2. Claude Designs the Semantic Model
**Actor:** Claude
**Tool:** Semantic Domain JSON

Claude generates a complete semantic domain:
- Dimension tables (customer, product, region, time)
- Fact tables (orders)
- Relationships with cardinalities
- Column definitions with data types

The design is written to a `.json` file in `models/semantic/`.

### 3. Data Engineer Reviews in VS Code
**Actor:** Human
**Tool:** dbt Semantic Designer

The semantic domain opens in the extension. The engineer can:
- Visually inspect the proposed schema
- Add, remove, or modify columns
- Adjust relationship cardinalities
- Identify missing dimensions or incorrect grain

Design models appear in **orange**. Built models (already in manifest) appear in **blue**.

### 4. Engineer Approves the Design
**Actor:** Human
**Tool:** Approval Checkpoint

Before proceeding, the engineer confirms:
- [ ] All required dimensions included
- [ ] Fact table grain is correct
- [ ] Relationship cardinalities verified
- [ ] KPI can be calculated from this model

Approval triggers Claude to proceed with implementation.

### 5. Claude Builds the dbt Models
**Actor:** Claude
**Tool:** dbt YAML + SQL

Claude generates:
- **Schema files** (`.yml`) with column descriptions and tests
- **SQL models** with transformation logic
- **Relationship tests** to enforce FK integrity

Runs `dbt build` to materialize the models.

### 6. Claude Creates the Power BI Report
**Actor:** Claude
**Tool:** Power BI

With dbt models built, Claude:
- Configures Power BI relationships matching the semantic model
- Creates measures for the requested KPIs
- Builds visualizations (cards, charts, tables)
- Publishes the report for review

## Design Principles

### Human-in-the-Loop
AI handles the repetitive work (boilerplate YAML, SQL patterns, BI configuration). Humans make decisions at checkpoints where domain expertise matters.

### Visual Verification
The semantic designer provides a visual representation that's easier to review than raw JSON. Relationships, cardinalities, and model status are immediately apparent.

### Reversible by Default
All changes go through VS Code's undo/redo system. Design models can be modified freely. Nothing is permanent until `dbt build` runs.

### Progressive Enhancement
The extension starts as read-only visualization, adds design capabilities, then enables AI-assisted generation. Each phase builds on the previous.

## Implementation Phases

| Phase | Status | Capability |
|-------|--------|------------|
| **1. Visualization** | ✅ Done | View models and relationships |
| **2. Design Mode** | ✅ Done | Create design models, planned columns |
| **3. YAML Generation** | Planned | Export designs to dbt schema files |
| **4. Claude Integration** | Planned | AI proposes designs from KPI requirements |
| **5. Power BI Integration** | Planned | AI configures relationships and reports |

## See Also

- [vision-workflow.html](../vision-workflow.html) — Interactive visualization of this workflow
- [README.md](../README.md) — Extension usage documentation
