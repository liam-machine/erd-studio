# Common questions

Answers about [ERD Studio](../README.md): logical data modelling in Git, stored as DBML.

## Upgrading to 2.0

ERD Studio 2.0 starts every new project as DBML, an open format.

**Do I have to convert my project to DBML?** No. A YAML/JSON project from before 2.0 keeps working, and its new tables and diagrams are still written as YAML and JSON. Only a new project starts as DBML. **ERD Studio: Convert Project to DBML** is up to you: it shows every change before it writes anything.

**How do I go back?** Straight after converting, **Edit > Undo** (with the diagram Convert opens in front) puts every file back. After that, use Git: commit before you convert, and revert that commit to return. A converted project needs ERD Studio 2.0 or later.

**Can teammates on an older ERD Studio open it?** A YAML/JSON project, yes, as long as nobody converts it. A DBML project (a converted one, or a new one) needs ERD Studio 2.0 or later: an older version (the 1.9 pre-releases included) shows no diagrams and an empty Table Library. Agree on the version before you convert, and run **Set Up My AI Helper** again afterwards so your AI assistant writes DBML too.

## Everyday

**How do I add a table or a schema folder?** In a DBML project, right-click a layer or schema row in the Table Library and choose **New Table…** (the **+** on the row does the same), or right-click a layer row and choose **New Schema…**; both are in the Table Library's **…** menu and the Command Palette too. A new table goes into the layer and schema you picked, and a new schema folder is empty until you give it a table.

**Can two tables have the same name?** Yes, when they are in different schemas: `bqs.addresse` and `ccc.addresse` are two tables, each with its own columns and relationships, and **Import…** keeps both names. A diagram that shows both names each with its schema (`bqs.addresse`); an older ERD Studio asks you to update before it opens that diagram. Within one schema a name is used once, across every layer: a second file of the same schema and name shows as "(duplicate — ignored)" in the Table Library. A YAML/JSON project from before 2.0 keeps every name unique.

**How do I move a table to another schema or layer?** In a DBML project, right-click it in the Table Library, or its file in the Explorer, and choose **Move Table…**. Every diagram and relationships file that uses it follows in the same step, and **Edit > Undo** puts it all back. **Move Diagram to Layer…** does the same for a diagram. A YAML/JSON project has neither command: **Organise Table Library by Layer** moves each table file into the folder of the layer that uses it, and **Convert Project to DBML** brings both. In a DBML project you can also drag the file in the Explorer, or rename it there: ERD Studio offers to update every file that points at it (renaming a table file renames the table, since its file name is its name).

**Something is slow or not working. Where do I look?** Run **ERD Studio: Show Logs**. The **ERD Studio** channel in the Output view says what ERD Studio did and how long it took: opening each diagram, saving a moved table, each step of a conversion, and any file it could not read, with its line. **Send Feedback** can add the recent lines to your report if you tick **Include the recent ERD Studio log**; check them first, as they can name your tables.

More: [the file format reference](semantic-domain-json-reference.md) (including what an older project's files hold), [modelling patterns](modelling-patterns.md) and the [glossary](glossary.md).
