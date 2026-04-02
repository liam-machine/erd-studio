# Build Notes for ERD Studio — Design Proposal

## The Problem

We want a way to capture **build notes** on the canvas — the "why" behind design decisions — so that when you (or Claude) design a model, the reasoning is visible and discoverable without digging through commit history or asking someone.

### What Already Exists

| Field | Purpose |
|-------|---------|
| `description` | What the model *is* |
| `rationale` (6 sub-fields) | Structured design reasoning (purpose, design, grain choice, etc.) |
| `grain` | Row-level uniqueness statement |
| `column.description` | Per-column documentation |

The `rationale` fields partially cover this, but they're buried in the detail panel (invisible on the canvas) and locked into rigid sub-fields that don't suit free-form build notes.

---

## Options

### Option 1: Free-form Canvas Annotations (Post-it Notes)

Standalone floating nodes on the canvas, optionally linked to a model via a dashed edge.

**How it works:**
- New `annotations` array in the domain file: `{ id, text, position, linkedModel? }`
- New React Flow node type rendered as a sticky note
- Draggable, editable inline on canvas

| Pros | Cons |
|------|------|
| Visual and discoverable | Drift away from nodes, clutter the canvas |
| Can annotate relationships or areas, not just models | Auto-layout (ELK) doesn't know about them |
| Feels like the "post-it" mental model | Large implementation surface (~15 files) |
| | No structural link enforcement to nodes |

**Verdict:** Gives the most freedom but introduces the most mess. Annotations would need their own position management separate from ELK layout, and there's nothing stopping them from becoming orphaned clutter.

---

### Option 2: Model-level "Notes" Field (Detail Panel Only)

Add a free-form `notes` field to each model, editable in the detail panel. Show a small badge on the node when notes exist.

**How it works:**
- New `notes` field on the model (like `description`)
- Editable in the detail panel via a `NotesEditor` component
- Small indicator icon on the node header when notes are present

| Pros | Cons |
|------|------|
| Minimal change, follows existing patterns | Not visible on canvas without clicking the node |
| Structurally linked to the model | Doesn't satisfy the "visible next to the node" need |
| Works with undo/redo, file formats, stage switching | Another text field in an already-long detail panel |

**Verdict:** Clean and simple, but doesn't solve the visibility problem — you'd still have to click each node to read its notes.

---

### Option 3: Expandable Notes Section on the Node ★ Recommended

Add a collapsible notes strip at the bottom of each model node. Collapsed by default (shows a small icon). Click to expand and see a 2-3 line preview. Full editing in the detail panel.

**How it works:**
- New `notes` field on the model
- Graph transformer passes notes to the node component
- Node renders: collapsed = subtle icon; expanded = truncated text preview
- Full editing happens in the detail panel (keeps the node clean)
- Expand/collapse state works like column expansion does today

| Pros | Cons |
|------|------|
| **Directly linked to the node** — can't drift or orphan | Nodes get taller when expanded (but only on demand) |
| Visible on canvas without opening the detail panel | Can only annotate models, not relationships or empty areas |
| Collapsed by default = no clutter | Long notes truncated on node; full text in panel |
| Consistent with existing column expansion UX | |
| Modest implementation (~10 files) | |

**Verdict:** Best balance of visibility and cleanliness. Notes live *on* the model structurally, are visible at a glance when you want them, and invisible when you don't.

---

### Option 4: Enhance Existing Rationale with Notes + Popover

Add a free-form `notes` sub-field to the existing rationale object. Make the existing rationale badge on the node clickable — hover/click shows a popover with the notes.

**How it works:**
- Add `notes` to the existing `Rationale` interface
- The `hasRationale` indicator already appears on nodes — make it interactive
- Hover or click the badge → popover shows the free-form notes

| Pros | Cons |
|------|------|
| Smallest possible change (~6 files) | Conflates "build notes" with "design rationale" |
| Reuses the existing rationale pipeline end-to-end | Popover is transient — disappears when you move away |
| No new message types needed | Rationale section already has 6 fields; risks overwhelm |

**Verdict:** Lightweight but compromises on both visibility (popover is transient) and conceptual clarity (notes ≠ rationale).

---

## Recommendation

**Option 3 — Expandable Notes on the Node** is the best fit because:

1. **No mess.** Notes are a field on the model, not floating objects. They can't drift, orphan, or clutter. They survive auto-layout, stage switching, and file format changes.

2. **Visible when you want, hidden when you don't.** The collapsed icon + expandable preview gives at-a-glance context without making the canvas noisy. Same UX pattern as column expansion, which already works well.

3. **Right-sized complexity.** Canvas annotations (Option 1) would be a large feature with layout complications. Option 3 slots into the existing model → transformer → node pipeline with minimal additions.

### What it would look like

```
┌─────────────────────────────┐
│  dim_customer        silver │  ← normal node header
├─────────────────────────────┤
│  customer_key     PK  INT  │
│  first_name           STR  │
│  last_name            STR  │
│  email                STR  │
├─────────────────────────────┤
│  📝 Designed as Type 2 SCD │  ← expanded notes strip
│     to track address chan…  │
│                      4 cols │
└─────────────────────────────┘
```

When collapsed, just a small `📝` icon in the footer. When no notes exist, nothing shows.
