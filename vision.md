# dbt Semantic Designer — Vision

## Overview

dbt Semantic Designer is a VS Code extension that brings visual, domain-driven design to dbt projects. It enables data teams to **visualize**, **design**, and **govern** foreign key relationships between dbt models within curated business domains.

## Core Philosophy

Data modeling should be **visual first**. Rather than managing relationships buried in YAML files and scattered tests, teams should see their data model as a living diagram that bridges the gap between:

- **Business understanding** (what domains exist, how they relate)
- **Technical implementation** (which models exist, what columns they have)
- **Governance** (approval workflows, build status, domain boundaries)

## Key Capabilities

### 1. Visual Domain Diagrams

Interactive React Flow-based diagrams showing:
- Models as nodes with columns listed
- FK relationships as edges with crow's foot cardinality notation
- Color-coded status (blue=built, orange=design, teal=approved)
- Layer organization (bronze → silver → gold → platinum)

### 2. Design-First Workflow

Plan before you build:
- Create design models representing future dbt models
- Define planned columns and relationships
- Approve designs for implementation
- Auto-reconcile when built models appear in manifest

### 3. Status Lifecycle

Models, columns, and relationships follow a progression:

```
design → approved → built
```

| Status | Description | Color |
|--------|-------------|-------|
| Design | Planned, not yet in dbt | Orange |
| Approved | Reviewed and ready for build | Teal |
| Built | Exists in dbt manifest | Blue |

### 4. Domain-Based Model Tagging

**Enable running dbt builds by semantic domain.**

When a model is added to a semantic domain, the extension automatically adds a `domain:{domain_name}` tag to the model's schema.yml file:

```yaml
# models/silver/dim_work_lot.yml
version: 2
models:
  - name: dim_work_lot
    config:
      tags:
        - silver
        - domain:work-lots
        - domain:bill
```

This enables powerful dbt selection:

```bash
# Build all models in the work-lots domain
dbt build --select tag:domain:work-lots

# Build all models in the bill domain
dbt build --select tag:domain:bill

# Test only work-lots domain models
dbt test --select tag:domain:work-lots
```

**Key behaviors:**
- Tags are added when a repo model joins a domain
- Tags are removed when a model leaves a domain
- Multiple domain tags are supported (model can belong to multiple domains)
- Design models are skipped (no schema.yml to modify)
- Existing tags (like `silver`) are preserved

### 5. Relationship Visualization

FK relationships displayed with:
- **Crow's foot notation** for cardinality (1:1, 1:N, N:M)
- **Solid lines** for built relationships (tests exist in manifest)
- **Dashed lines** for design relationships (planned, not yet tested)
- **Color coding** matching the model status

### 6. Approval Workflow

Governance through explicit approval:
- Models must be approved before their columns can be approved
- Relationships can only be approved when both connected models are built or approved
- Unapproving a model cascades to its columns and relationships

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                    │
│  ┌───────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │ ManifestService│  │SchemaTagService│  │ DomainService  │  │
│  │ (parse dbt)   │  │ (YAML tags)    │  │ (JSON domains) │  │
│  └───────────────┘  └────────────────┘  └────────────────┘  │
│                              │                               │
│                              ▼                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              SemanticEditorProvider                    │  │
│  │         (custom editor, message bridge)                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ postMessage
┌─────────────────────────────────────────────────────────────┐
│                     Webview (React/IIFE)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  React Flow │  │ DetailPanel │  │   Context Menus     │  │
│  │  (diagram)  │  │ (selection) │  │   (add/remove)      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Target Workflow

### For Data Engineers

1. **Create Domain** — Define a business domain (e.g., "work-lots", "billing")
2. **Add Built Models** — Import existing models from dbt manifest
3. **Design New Models** — Plan future models with columns
4. **Define Relationships** — Draw FK connections between models
5. **Approve for Build** — Mark designs as ready for implementation
6. **Build by Domain** — Run `dbt build --select tag:domain:{name}`

### For Analytics Engineers

1. **Explore Domains** — Understand the data model visually
2. **Find Relationships** — See how tables connect
3. **Plan Changes** — Add design models/columns before coding
4. **Review Approvals** — Validate planned changes before implementation

### For Data Governance

1. **Domain Boundaries** — Clear separation of business domains
2. **Approval Trail** — Track what's approved vs. still in design
3. **Selective Builds** — Build only what's needed for a domain
4. **Visual Documentation** — Self-documenting data model

## Future Roadmap

- [ ] Export diagrams as images for documentation
- [ ] Integration with dbt Cloud for manifest fetching
- [ ] Lineage view showing upstream/downstream models
- [ ] Test generation from relationship definitions
- [ ] GitHub Action for domain tagging on merge
- [ ] Multi-domain views (cross-domain relationships)
- [ ] Column-level lineage visualization

## Summary

dbt Semantic Designer bridges the gap between conceptual data modeling and dbt implementation. By making relationships visible, enabling design-first workflows, and providing domain-based tagging for selective builds, it helps data teams:

- **Communicate** — Visual diagrams everyone can understand
- **Plan** — Design before you build
- **Govern** — Approval workflows and domain boundaries
- **Execute** — Build exactly what you need with `dbt build --select tag:domain:*`
