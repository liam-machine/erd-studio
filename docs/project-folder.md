# Choosing the project folder

ERD Studio keeps your data model in a `.erd-studio` folder inside the project it has open. Most of the time there is nothing to choose: open a folder in VS Code and ERD Studio uses it. If that folder (or one up to three folders below it) is a dbt project, ERD Studio also reads dbt for the Physical stage.

Opening a folder without dbt writes nothing (apart from renaming a folder called `erd-studio/`, from an old release, to `.erd-studio/`). In a dbt project that has diagrams, ERD Studio also keeps the dbt `selectors.yml` up to date. ERD Studio creates `.erd-studio/` only when you ask for something that needs it, such as **New Diagram** or **Import DBML…**.

## Which folder ERD Studio opens

ERD Studio looks for its project in this order and uses the first it finds:

1. the folder in the `erdStudio.projectPath` setting;
2. the dbt project you picked with **ERD Studio: Select dbt Project…**;
3. a dbt project in the workspace (one that already has an `.erd-studio` folder first);
4. a workspace folder that already has an `.erd-studio` folder;
5. the first workspace folder.

So a dbt project anywhere in the workspace wins over a plain folder that holds a design. To keep the design in a folder without dbt in that case, set `erdStudio.projectPath`. With no folder open at all, ERD Studio asks you to open one.

ERD Studio decides whether the folder is a dbt project when the window opens. If you add a `dbt_project.yml` to a folder it already has open, run **Developer: Reload Window** to get the Physical tab and **⊕ Diff**.

## Keeping the data model in another folder

Set `erdStudio.projectPath` to the folder you want, and ERD Studio keeps its `.erd-studio` data there, whether or not the folder has a `dbt_project.yml`. Without a dbt project there is nothing to compare against, so the canvas shows only your logical design (no Physical tab) and nothing needs installing or running. When the setting is empty, ERD Studio picks a folder as described above.

## More than one dbt project in a workspace

A VS Code window shows one dbt project at a time. In a multi-root workspace or a monorepo, ERD Studio opens the project that already has an `.erd-studio` folder, and falls back to the first dbt project it finds. When there's more than one, the first row of the ERD Studio sidebar shows which project is open.

To choose another project, click that row, or run **ERD Studio: Select dbt Project…**. VS Code then reloads the window to open the project you picked. Your choice is saved for that workspace on your machine only, so it never ends up in a settings file your team commits. **Auto-detect**, at the top of the list, clears your choice.

To choose the project for everyone who opens the workspace, set `erdStudio.projectPath` in the workspace settings. That is the `settings` block of the `.code-workspace` file, or `.vscode/settings.json` for a single folder. Use a relative path so the setting works on every machine. ERD Studio tries it against each workspace folder in turn, so in a multi-root workspace whose folders sit side by side, `../datamodels` points at the `datamodels` folder. The setting takes priority over the picker. In a multi-root workspace ERD Studio reads it from the workspace level only: a value in one folder's own `.vscode/settings.json` is ignored.

## A diagram from another project

If you open a diagram that belongs to a different dbt project than the one ERD Studio has open, ERD Studio doesn't draw it against the wrong project's data. It offers to switch projects instead.
