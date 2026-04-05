# Vision: AI-Assisted Data Engineering

> A workflow where Claude designs the data model, humans review and refine across progressive stages, then Claude builds the implementation. From KPI request to Power BI report.

## The Problem

Building analytics involves multiple handoffs between business requirements, data modeling, dbt development, and BI reporting. Each handoff creates friction, delays, and opportunities for miscommunication.

## The Solution

An AI-assisted workflow with **visual stage-based review** at critical decision points:

```
User Request --> AI Design --> Human Review (Stage Comparison) --> AI Build --> Delivered Report
```

ERD Studio serves as the **visual review surface** where data engineers inspect AI-proposed designs across three progressive stages -- Conceptual, Logical, and Physical -- before committing to implementation.

## Workflow Steps

### 1. User Requests a KPI Report
**Actor:** User --> Claude
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

The design is written to a `.json` file in `erd-studio/logical/`.

### 3. Data Engineer Reviews in VS Code
**Actor:** Human
**Tool:** ERD Studio

The semantic domain opens in the extension. The engineer can:
- Visually inspect the proposed schema in the **Logical** stage (blue)
- Switch to the **Physical** stage (green) to see what is already built in the dbt manifest
- Compare Logical against Physical to identify what is designed but not yet built, and what exists in dbt but is missing from the design
- Add, remove, or modify columns
- Adjust relationship cardinalities
- Identify missing dimensions or incorrect grain

The three stages provide progressive refinement:
- **Conceptual** (violet) -- high-level entity sketches and business intent
- **Logical** (blue) -- fully specified models, columns, types, and relationships
- **Physical** (green) -- the current state of the dbt manifest

### 4. Engineer Compares Stages
**Actor:** Human
**Tool:** Discrepancy Overlay

Before proceeding, the engineer uses cross-stage comparison to verify:
- All required dimensions are present in the Logical design
- Column types and names align between Logical and Physical
- Extra columns in Physical that are not in the Logical design are identified
- Missing columns that exist in the Logical design but not yet in Physical are highlighted
- Relationship cardinalities are consistent across stages

The discrepancy overlay surfaces type mismatches, missing columns, and extra columns at a glance.

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
AI handles the repetitive work (boilerplate YAML, SQL patterns, BI configuration). Humans make decisions at stage transitions where domain expertise matters.

### Visual Verification
The semantic designer provides a visual representation that is easier to review than raw JSON. Relationships, cardinalities, and stage context are immediately apparent.

### Stage-Based Progression
The three-stage architecture (Conceptual, Logical, Physical) mirrors the natural progression of data modeling. Each stage has a clear purpose, and cross-stage comparison reveals gaps and discrepancies without requiring a separate approval workflow.

### Reversible by Default
All changes go through VS Code's undo/redo system. Design models can be modified freely. Nothing is permanent until `dbt build` runs.

### Progressive Enhancement
The extension starts with stage visualization and comparison, then adds YAML generation, then enables AI-assisted design. Each phase builds on the previous.

## Implementation Phases

| Phase | Status | Capability |
|-------|--------|------------|
| **1. Three-Stage Architecture** | Done | Conceptual, Logical, Physical views with stage switching |
| **2. Cross-Stage Comparison** | Done | Discrepancy overlay showing extra/missing columns, type mismatches |
| **3. YAML Generation** | Planned | Export logical designs to dbt schema files |
| **4. Claude Integration** | Planned | AI proposes designs from KPI requirements |
| **5. Power BI Integration** | Planned | AI configures relationships and reports |

## See Also

- [vision-workflow.html](../vision-workflow.html) -- Interactive visualization of this workflow
- [README.md](../README.md) -- Extension usage documentation
