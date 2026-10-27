# Using ERD Studio with dbt

ERD Studio is a logical modelling tool first: your design lives in `.erd-studio/` whether or not you use dbt. When the folder you open has a `dbt_project.yml` (or a dbt project up to three folders below it), ERD Studio also reads the dbt project and adds three things:

- **Draw from dbt**, which turns your existing dbt models into a first diagram;
- a read-only **Physical** stage, drawn in green, showing what your dbt project has. The canvas then has two tabs, **Logical** (your design) · **Physical** (read from dbt);
- the **⊕ Diff** overlay, which shows where your design and dbt disagree.

In a folder without dbt the canvas shows only your logical design: there is no Physical tab, no **⊕ Diff** and nothing to install or run. Started your design in a folder without dbt? Move its `.erd-studio` folder into the dbt project, then open that folder to compare your design with what dbt built.

<table align="center"><tr>
<td width="300"><a href="https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/how-it-works.mp4"><img src="https://raw.githubusercontent.com/liam-machine/erd-studio/main/docs/assets/how-it-works-play.jpg" width="300" alt="Play the How ERD Studio works video (1:42): why the logical data model belongs in the repo, the YAML and JSON files behind the canvas, Logical versus Physical, and how Compare lights up every mismatch before it ships." /></a></td>
<td><strong>The technical tour (1:42).</strong> Why the design belongs next to the SQL, the two kinds of file behind every diagram, how the Logical design and the Physical view of your dbt project are compared, and why your AI assistant writes better dbt when it can read the data model first.</td>
</tr></table>

<!-- TODO: re-shoot readme-workflow.png with the new file naming: its Explorer shows .erd-studio/logical-models/ and the diff is logical-models/fct_order.yml, but a new project now writes .erd-studio/tables/. -->
![Your data model lives in the repo; the canvas is a view over it. Left: the VS Code Explorer for a dbt project. Its .erd-studio folder, marked design, holds one YAML per table and one JSON per subject area, next to the models and target folders, marked code and warehouse, where fct_order.sql is modified. The design files render and save as the ERD Studio Logical canvas, in blue: dim_customer joined one to many to fct_order, which has order_total. The dbt project derives the read-only Physical canvas, in green, never written to disk. Comparing the two finds two differences: order_amt is highlighted as only in the warehouse and order_total struck through as logical only, because the column was renamed in the SQL but not the design. The fix is a one-line change to fct_order.yml in the same pull request.](https://raw.githubusercontent.com/liam-machine/erd-studio/main/media/readme-workflow.png)

## Your first diagram from dbt, no AI needed

1. Open your dbt project in VS Code. On a first install the **Get started with ERD Studio** walkthrough opens and takes you through the next steps.
2. Run **Draw from dbt**, from the walkthrough or the Command Palette (**ERD Studio: Draw from dbt…**). ERD Studio copies your dbt models' columns and relationship tests into a logical draft and opens it, laid out automatically.
3. Edit the draft on the canvas, and switch between **Logical** and **Physical** to compare your design with what dbt has.

The draft is a starting point for your design: it is saved as ordinary ERD Studio files you can change, and the Physical stage is still read from dbt every time, never saved. An empty diagram offers an **Add tables from dbt** button that does the same for one diagram (the commands call a diagram a *subject area*), and the **ERD** count in the status bar (for example **ERD 3**) takes you back to your diagrams at any time. Rather start blank? **ERD Studio: New Subject Area** (the sidebar's **New Diagram**) and **Import DBML…** work in a dbt project too.

**Prefer to watch first?** The [getting-started video](https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/docs/assets/getting-started.mp4) (1:00) shows these three steps. The **Welcome** tab has the same video and a short checklist. Open it any time with **Get started** in the ERD Studio sidebar (or its ▶ button), or **ERD Studio: Watch Getting Started Video**.

## No dbt project yet? Try the sample

The [ERD Studio sample project](https://github.com/liam-machine/erd-studio-sample) is a small Kimball-style dbt project with fake coffee-shop data (DuckDB, no account needed). It ships its dbt artifacts, so both the Logical and Physical stages work without installing dbt. Run **ERD Studio: Try the Sample Project** (also on the Welcome tab) and VS Code clones it to a folder you choose and offers to open it, or use **Code → Download ZIP** on GitHub and open the unzipped folder.

## What the Physical stage reads

The Physical stage has no file of its own. It reads three files, and only the first is required:

- your **schema YAMLs**, always on disk, so the stage works before you have ever run dbt;
- **`manifest.json`**, written by `dbt compile`, `dbt run` or `dbt build`;
- **`catalog.json`**, written by `dbt docs generate`: the only one of the three that has seen your warehouse.

Each table shows where its shape came from, so a `varchar` on the canvas is never a guess: types are read from the warehouse when the catalog is there, otherwise from the `data_type:` you wrote, otherwise left blank rather than invented. A greyed-out table means it is genuinely not in your dbt project, not that you have not run dbt lately. The edges are the tests you already run (`relationships` for the links, `unique` for the cardinality), so the canvas shows what dbt enforces rather than a second copy that can drift. Nothing is ever written to disk.

## Compare and sync

Click **⊕ Diff** on the toolbar to compare your design with dbt. Missing columns, type differences and relationship mismatches appear on the canvas. From the comparison you can generate a sync plan for your AI assistant to apply only the changes you choose. The [AI assistants](ai-assistants.md) page has the guided setup that builds and checks the design against dbt for you.

## Run a whole diagram together

ERD Studio keeps a dbt selector for each diagram in `selectors.yml`, so you can build every dbt model in a diagram with one command, for example `dbt build --selector domain_silver_customer_360`. Run **ERD Studio: Regenerate dbt selectors.yml** to refresh them. ERD Studio only touches the `domain_*` selectors it manages; everything else in the file is left alone.

## More than one dbt project

See [Choosing the project folder](project-folder.md).

## Other stacks

dbt is the only physical source ERD Studio reads today. If you model somewhere else, [contribute an integration or propose one](https://github.com/liam-machine/erd-studio/issues). Your logical table files stay exactly as they are as support grows, and [DBML export](leaving-erd-studio.md) works with any stack.
