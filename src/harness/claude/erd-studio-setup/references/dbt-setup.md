# Setting up dbt

Everything here is optional for ERD Studio — it can read the `.sql` and `.yml` files on its own.
dbt adds the exact column lists (`dbt parse`) and real types (the catalog). Offer these steps,
explain them, and let the user choose. Every command is given for **macOS/Linux** and for
**Windows PowerShell**; pick the one that matches their machine and show only that.

When *you* run dbt from a virtual environment, call it by path from the project folder
(`.venv/bin/dbt parse`, or `.venv/Scripts/dbt.exe parse` on Windows — forward slashes, because
your shell may be Git Bash, where a backslash is an escape; PowerShell accepts them too). Each
command you run
starts a fresh shell, so "activate, then run" does not carry over. Activation is for the user's
own terminal.

## Contents
1. Which dbt is this?
2. Installing dbt
3. profiles.yml
4. Checking the connection
5. Manifest and catalog commands
6. Common errors

---

## 1. Which dbt is this?

`dbt --version` prints one of three shapes (doctor already classifies it as `dbt.flavour`):

| Output looks like | Flavour | What it means |
|---|---|---|
| `Core:` then `- installed: 1.9.4`, then a `Plugins:` list | `core-v1` | dbt Core, the open-source Python tool. The plugins are the adapters. |
| `dbt-fusion 2.0.0-…` or `dbt 2.x.y` | `fusion-v2` | dbt Fusion, the newer engine (a single program, not Python). |
| `dbt Cloud CLI - 0.40.14 (…)` | `cloud-cli` | The dbt platform CLI. Commands run on dbt's servers. |

## 2. Installing dbt

Ask which warehouse they use first — the adapter depends on it. If they do not know, or just want
to try things out, **DuckDB** needs no server or account.

### dbt Core (recommended for most people)

Needs a recent Python 3 (dbt 1.10 supports 3.9–3.13; check docs.getdbt.com if pip refuses).
Install into a virtual environment in the project folder:

macOS / Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install dbt-core dbt-duckdb        # swap dbt-duckdb for your adapter
dbt --version
```

Windows PowerShell:
```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1                       # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
python -m pip install --upgrade pip
python -m pip install dbt-core dbt-duckdb
dbt --version
```

With `uv` instead of pip (either OS): `uv venv` then `uv pip install dbt-core dbt-duckdb`.

Adapters: `dbt-duckdb`, `dbt-postgres`, `dbt-snowflake`, `dbt-bigquery`, `dbt-databricks`,
`dbt-redshift`. Since dbt 1.8 the adapter does not pull in dbt Core by itself, so install both.

Do not `pip install dbt` — that name is not dbt Core. Always name `dbt-core` and the adapter.

Suggest adding `.venv/` to `.gitignore` if it is not already there.

### dbt Fusion

A single program, installed per user rather than per project:

macOS / Linux:
```bash
curl -fsSL https://public.cdn.getdbt.com/fs/install/install.sh | sh -s -- --update
```

Windows PowerShell:
```powershell
irm https://public.cdn.getdbt.com/fs/install/install.ps1 | iex
```

Then open a new terminal and run `dbt --version`. The first real command downloads the database
driver for their warehouse, which needs internet access (see "Common errors" for proxies). Fusion
supports fewer warehouses than Core; if theirs is not supported, recommend Core. Installers change
— if a command here fails, point them to docs.getdbt.com and search "install Fusion".

### dbt Cloud CLI

Only for teams that run dbt on the dbt platform. It is installed with
`brew install dbt-labs/dbt/dbt` (macOS) or `winget install --id dbtLabs.dbt --exact` (Windows),
then signs in with a `dbt_cloud.yml` downloaded from the dbt platform (Account settings → Cloud
CLI) into `~/.dbt/`. The project's `dbt_project.yml` also needs a `dbt-cloud: project-id:` entry.
It does not use `profiles.yml`. Because it runs remotely, `target/manifest.json` may not appear
locally — ERD Studio then works from the project files alone.

## 3. profiles.yml

dbt looks for it in this order: the `DBT_PROFILES_DIR` folder, the project folder, then
`~/.dbt/profiles.yml` (`%USERPROFILE%\.dbt\profiles.yml` on Windows). Doctor's
`profiles.searched` lists where it looked.

The top-level name **must match** `profile:` in `dbt_project.yml`. Read that first and use it in
place of `my_profile` below.

**Never write a password or token into the file.** Use `env_var('NAME', 'placeholder')` — the
second argument is a default, so `dbt parse` works straight away (it never connects, so the values
do not need to be right, only present). The real values matter only for the catalog and
`dbt debug`.

To set the real values, the user sets them in their own terminal — `export DBT_PASSWORD=…`
(macOS/Linux) or `$env:DBT_PASSWORD = "…"` (PowerShell) — **before starting their AI
assistant**, then quits it and starts it again from that same terminal (`claude`, `codex`,
`gemini` or `copilot`; for an assistant inside VS Code, such as Copilot Chat or Cursor, start the
editor from that terminal with `code .` / `cursor .`). The commands you run do not see a variable
set in another terminal, or one set after the assistant started. Say this plainly, or the user
will set it, you will re-run, and get the same error.

Write it to `~/.dbt/profiles.yml` (create the folder if needed) unless the project already keeps
one in its own folder. If a `profiles.yml` already exists there, add the new profile to it rather
than replacing the file.

DuckDB (a local file, no account):
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: duckdb
      path: dev.duckdb
      threads: 4
```

Postgres:
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: postgres
      host: localhost
      port: 5432
      user: "{{ env_var('DBT_USER', 'placeholder') }}"
      password: "{{ env_var('DBT_PASSWORD', 'placeholder') }}"
      dbname: analytics
      schema: dbt_dev
      threads: 4
```

Snowflake (browser sign-in, no stored password):
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT', 'placeholder') }}"     # e.g. ab12345.ap-southeast-2
      user: "{{ env_var('SNOWFLAKE_USER', 'placeholder') }}"
      authenticator: externalbrowser
      role: TRANSFORMER
      warehouse: TRANSFORMING
      database: ANALYTICS
      schema: DBT_DEV
      threads: 4
```

BigQuery (uses `gcloud auth application-default login`):
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: bigquery
      method: oauth
      project: my-gcp-project
      dataset: dbt_dev
      threads: 4
```

Databricks:
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: databricks
      host: "{{ env_var('DATABRICKS_HOST', 'placeholder') }}"          # e.g. adb-123.azuredatabricks.net
      http_path: "{{ env_var('DATABRICKS_HTTP_PATH', 'placeholder') }}"
      token: "{{ env_var('DATABRICKS_TOKEN', 'placeholder') }}"
      catalog: main
      schema: dbt_dev
      threads: 4
```

Redshift:
```yaml
my_profile:
  target: dev
  outputs:
    dev:
      type: redshift
      host: "{{ env_var('REDSHIFT_HOST', 'placeholder') }}"
      port: 5439
      user: "{{ env_var('DBT_USER', 'placeholder') }}"
      password: "{{ env_var('DBT_PASSWORD', 'placeholder') }}"
      dbname: analytics
      schema: dbt_dev
      threads: 4
```

Field names differ between adapter versions. If `dbt debug` complains about a field, trust its
message over these templates.

## 4. Checking the connection

`dbt debug` checks the profile, the adapter and the connection, and prints `All checks passed!`
when everything works. It is the right command after writing a profile. It does connect to the
warehouse, so say so before running it.

## 5. Manifest and catalog commands

| Flavour | Manifest (no warehouse needed) | Catalog (connects to the warehouse) |
|---|---|---|
| Core 1.x | `dbt parse` | `dbt docs generate` |
| Fusion 2.x | `dbt parse` | `dbt compile --write-catalog` |
| Cloud CLI | `dbt parse` (runs remotely) | `dbt docs generate` (output may not land locally) |

Doctor's `dbt.commands` already has the right command for the installed flavour; prefer it.

Two things to explain about the catalog:
- It only contains tables that **exist in the warehouse** — models someone has built with
  `dbt run` or `dbt build`. Do not run those yourself; if the tables have never been built, the
  catalog will simply be thin, and that is fine.
- It is a snapshot. After changing models, `dbt parse` refreshes the manifest in seconds; the
  catalog only refreshes when the catalog command runs again.

If the project has a `packages.yml` or `dependencies.yml`, run `dbt deps` once first — it
downloads the packages the project uses.

## 6. Common errors

Quote the one matching line to the user, then explain and fix.

| Error line contains | Meaning | Fix |
|---|---|---|
| `Could not find profile named 'x'` | No profile with the name from `dbt_project.yml` | Create or rename it in `profiles.yml` (section 3) |
| `Could not find adapter type` / `No module named 'dbt.adapters.…'` | The adapter is not installed in the environment dbt runs from | `python -m pip install dbt-<adapter>` inside the same venv |
| `Env var required but not provided` | The profile uses `env_var()` with no default and the variable is not set where *you* run dbt | Add a default — `env_var('NAME', 'placeholder')` — which is all `dbt parse` needs; for the catalog, the user sets the real value and restarts their AI assistant from that terminal (section 3) |
| `dbt found N package(s) specified in packages.yml, but only M installed` / `Compilation Error` naming a package macro | Packages not downloaded | `dbt deps` |
| `command not found: dbt` / `'dbt' is not recognized` right after installing | The venv is not active in that terminal | Activate it, or run `.venv/bin/dbt` (`.venv/Scripts/dbt.exe` on Windows) |
| Fusion: a timeout or TLS error while downloading a driver | A corporate proxy or firewall blocks the download | Set `HTTPS_PROXY` to the company proxy and retry, ask IT to allow `public.cdn.getdbt.com`, or use dbt Core |
| Cloud CLI: `dbt_cloud.yml` not found / not authenticated | The Cloud CLI has no credentials | Download `dbt_cloud.yml` from the dbt platform into `~/.dbt/` (section 2) |
| Cloud CLI: `project-id` missing | `dbt_project.yml` lacks the `dbt-cloud:` block | Ask the user for their project ID (from the dbt platform URL) and add it |
| `Database Error` / `Could not connect` | Credentials or network | Run `dbt debug` and read its failing check; this only affects the catalog, so offer to carry on without it |

When none of these match, show the line, say you are not sure, and offer to carry on without the
file dbt failed to produce — the setup never depends on it.
