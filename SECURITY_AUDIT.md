# Fredo Security Audit Report

**Repository:** `https://github.com/FredoAi/fredo/` (`C:\Code\fredo`)  
**Date:** 2026-10-22

---

## Executive Summary

Overall, **Fredo** has strong foundational security practices:
- GitHub Actions third-party steps are SHA-pinned across `.github/workflows/*.yml`.
- Local network receivers (OTLP `:4317`/`:4318`, `llama-server`, embedded PostgreSQL, and the debug MCP bridge) bind strictly to `127.0.0.1`.
- Database client and PostgreSQL supervisor credentials are stored in the OS keychain via the `keyring` crate rather than plaintext config files.
- Release builds are gated on a protected branch (`release/stable`) and published as draft releases.

However, several concrete vulnerabilities and discrepancies between the documented security model (`docs/SECURITY.md`) and the actual implementation were identified.

---

## High Severity Findings

### 1. SQL Injection in `application_store_query` (`order_by` parameter)
* **Location:**
  * `apps/tauri/src-tauri/src/infrastructure/storage/application_store.rs:564-567`
  * `apps/tauri/src-tauri/src/infrastructure/storage/application_store.rs:848-866`
* **Description:** `docs/SECURITY.md` states *"All SQL queries use parameterized statements — no string interpolation"*. However, `ApplicationStore::query` (exposed directly to the webview via the `application_store_query` Tauri command) interpolates `order_by` directly into the SQL string without validation or identifier quoting:
  ```rust
  if let Some(ob) = order_by {
      if !ob.is_empty() {
          sql.push_str(&format!(" ORDER BY {}", ob));
      }
  }
  ```
  Because the shared `EngineHandle` connects to the embedded PostgreSQL cluster as the **`postgres` superuser**, SQL injection in `ORDER BY` allows executing arbitrary SQL expressions and superuser functions (such as `pg_read_file`, `pg_ls_dir`, or subqueries across any table).
* **Additional Note:** In `ApplicationStore::validate_namespace` (`application_store.rs:184-198`), `full` is constructed from `sanitized` and then checked with `full.starts_with(&expected_prefix)`, which is a tautology (always `true`) and does not restrict `application_id` or `table_name` to `[a-zA-Z0-9_-]`.
* **Remediation:**
  * Validate `order_by` against the table's physical columns (`self.column_types_pg(&pg.pool, &full)`) and quote the column identifier using `quote_ident(col)` with an explicit `ASC`/`DESC` direction.
  * Also quote the validated column name in `validated_order_by` (`apps/tauri/src-tauri/src/infrastructure/application_data/commands.rs:349-353`) so camelCase columns work reliably in PostgreSQL.
  * Validate `application_id` and `table_name` against a strict identifier character set (`[a-zA-Z0-9_-]`).

---

### 2. SHA-256-Pinned PostgreSQL Archive Verification is Disconnected from Extraction
* **Location:**
  * `apps/tauri/src-tauri/src/applications/pg_supervisor/acquisition.rs:174-201`
  * `apps/tauri/src-tauri/src/applications/pg_supervisor/state.rs:518-525`
  * `apps/tauri/src-tauri/src/applications/pg_supervisor/runtime.rs:448-460`
* **Description:** `docs/SECURITY.md` states that in `runtime-download` mode, *"The PostgreSQL distribution is acquired through Fredo's SHA-256-pinned streaming engine... the distribution is never extracted from unverified bytes."*
  In the implementation:
  1. `acquire_pg_archive()` downloads and SHA-256-verifies `postgresql-18.6.0-x86_64-pc-windows-msvc.tar.gz` into `<install_dir>/archives/postgresql.tar.gz` and returns that `PathBuf`.
  2. `state.rs:521` **discards the returned path** and calls `runtime.setup()`, which delegates to `postgresql_embedded::PostgreSQL::setup()`.
  3. `postgresql_embedded` does not read `<install_dir>/archives/postgresql.tar.gz`, and `PgRuntime::assemble` (`runtime.rs:448`) does not set `settings.version` to `18.6.0`. Consequently, `postgresql_embedded` performs its own separate, unpinned network fetch and extraction from GitHub releases while the verified archive in `archives/postgresql.tar.gz` sits unused on disk.
* **Remediation:** Extract the verified `<install_dir>/archives/postgresql.tar.gz` directly into `install_dir` from Fredo's Rust code and set `settings.trust_installation_dir = true` (and pin `settings.version`), so `postgresql_embedded` never performs its own unverified network download.

---

### 3. Over-Privileged Webview Capabilities, Permissive CSP, and Arbitrary File/Binary Seams
* **Location:**
  * `apps/tauri/src-tauri/capabilities/default.json:7-19`
  * `apps/tauri/src-tauri/tauri.conf.json:25-28`
  * `apps/tauri/src-tauri/src/applications/terminal/commands.rs:1199-1225`, `1281-1288`
  * `apps/tauri/src-tauri/src/applications/doom/commands.rs:872-894`, `950-968`
  * `apps/tauri/src-tauri/src/applications/llm_server/commands.rs:295-331`, `361-377`
* **Description:** `docs/SECURITY.md` states *"The webview has no access to the filesystem, PTY, or IPC socket... A compromised webview still cannot read or write the filesystem directly."* Several configurations contradict this boundary:
  1. **Shell & MCP capabilities in production:** `capabilities/default.json` grants `"shell:allow-spawn"`, `"shell:allow-execute"`, and `"mcp-bridge:default"` to `"windows": ["main", "terminal", "doom", "app-*"]`.
  2. **Permissive CSP + Global Tauri:** `tauri.conf.json` sets `"withGlobalTauri": true` and includes `'unsafe-inline'` in `script-src`. Any XSS in any window immediately gets `window.__TAURI__` access.
  3. **Test override exposed in production IPC:** `spawn_terminal_session` (`terminal/commands.rs:1224`) accepts `test_override: Option<SpawnTestOverride>` over IPC in release builds, allowing the caller to pass any arbitrary executable path in `test_override.binary`.
  4. **Settings-driven binary execution & `.bat` write:** `save_setting` / `save_control_setting` allows writing arbitrary keys to `AppStore`. Setting `llama_server_path`, `llama_server_companion_dir`, `terminal_copilot_path`, or `terminal_pwsh_path` allows redirecting the binary spawned by `launch_llama_server` / `spawn_terminal_session` and writing `llama-server-launch.bat` to an arbitrary directory.
  5. **Arbitrary file overwrite via `export_doom_dataset`:** Both the Tauri command `export_doom_dataset` (`doom/commands.rs:950`) and the local IPC command `DoomExportDataset` (`ipc.rs:177`) accept an arbitrary absolute path or `../` traversal in `out: Option<String>` and overwrite the target file via `fs::rename` without a native `rfd` save dialog.
* **Remediation:**
  * Remove `'unsafe-inline'` from `script-src` in `tauri.conf.json` and set `"withGlobalTauri": false` (use ES module imports from `@tauri-apps/api`).
  * Remove `"shell:allow-spawn"`, `"shell:allow-execute"`, and `"mcp-bridge:default"` from the production `capabilities/default.json` (move `mcp-bridge:default` to a debug-only capability file).
  * Gate `test_override` in `spawn_terminal_session` (and all `FREDO_*_FORCE_*` / `FREDO_PG_PASSWORD_FILE` test seams) behind `#[cfg(debug_assertions)]` or a compile-time `test-seams` Cargo feature.
  * Restrict `export_doom_dataset`'s `out` parameter to stay within `<dataset_dir>/exports/` (reject absolute paths and `..` components) or require a native `rfd` dialog.

---

## Medium Severity Findings

### 4. Required CI Status Check (`validate.yml`) Passes on Cancelled or Skipped Jobs
* **Location:** `.github/workflows/validate.yml:109-120`
* **Description:** `validate` is the single required branch-protection status check for `main` and `release/stable`, but its check script only fails on literal `"failure"`:
  ```yaml
  if [ "${{ needs.ui-validate.result }}" = "failure" ] || [ "${{ needs.rust-validate.result }}" = "failure" ]; then
    exit 1
  fi
  ```
  If `ui-validate` or `rust-validate` is `cancelled` (e.g., due to a timeout or manual cancellation), or if the upstream `paths` job fails (causing both downstream jobs to be `skipped`), `validate` exits `0` ("All checks passed") and unlocks merging. Additionally, `validate.yml` and `validate-fast.yml` run `pnpm install` without `--frozen-lockfile`, and `apps/opencode-plugin/**` is missing from the `paths` filter in `validate.yml`.
* **Remediation:** List `paths` in `needs: [paths, ui-validate, rust-validate]`, require `needs.paths.result == 'success'`, and fail `validate` if either `ui-validate` or `rust-validate` is anything other than `success` or `skipped`. Add `--frozen-lockfile` to `pnpm install` and add `apps/opencode-plugin/**` to the `ui` path filter.

---

### 5. `db_client` Read-Only Mode Relies Only on Client-Side AST Parsing & Allows Superuser `COPY ... PROGRAM` Without Confirmation in Write Mode
* **Location:**
  * `apps/tauri/src-tauri/src/applications/db_client/query.rs:103-141`, `350-363`
  * `apps/tauri/src-tauri/src/applications/db_client/classify.rs:202-252`
* **Description:**
  1. **No database-level read-only enforcement:** When a connection is configured as `AccessMode::ReadOnly` (including the built-in `"Fredo"` connection which connects to the embedded cluster as the **`postgres` superuser**), `execute_one` only sets `SET statement_timeout = 30000`. It never executes `SET default_transaction_read_only = on` (or `BEGIN READ ONLY`). Any SQL statement starting with `SELECT` passes `classify_statement`, allowing mutating or administrative PostgreSQL functions (`SELECT pg_terminate_backend(...)`, `SELECT set_config(...)`, `SELECT lo_import(...)`, volatile functions, etc.) to run on a "read-only" connection.
  2. **`COPY` classified as `Write` instead of `Destructive`:** In `classify_keyword` (`classify.rs:242`), `COPY` is classified as `StatementClass::Write`, which does **not** require user confirmation (`confirmation_required` only gates `Destructive` and `Unknown`). On a superuser connection in `ReadWrite` mode, `COPY ... TO/FROM PROGRAM '...'` executes arbitrary OS commands and arbitrary file reads/writes without triggering the confirmation gate.
* **Remediation:**
  * In `execute_one` (`query.rs:351`), when `access_mode == AccessMode::ReadOnly`, execute `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` (or `SET default_transaction_read_only = on`) on the acquired connection before running `sqlx::raw_sql`.
  * Classify `COPY`, `GRANT`, `REVOKE`, `SECURITY`, and `ALTER` as `StatementClass::Destructive` so they always require confirmation in write mode.

---

### 6. Unpinned `npx -y` MCP Servers & Bypassable Subagent Bash Rules in `opencode.json`
* **Location:**
  * `opencode.json:235-333`, `367-439`, `602-630`
  * `.opencode/scripts/pipeline-state.rs:1484-1485`
* **Description:**
  1. **Unpinned `npx -y` execution:** `opencode.json` configures three MCP servers (`@chakra-ui/react-mcp`, `reactbits-dev-mcp-server`, `@hypothesi/tauri-mcp-server`) using `npx -y` with no version pin. Any upstream npm compromise of those packages will automatically execute arbitrary code on developer machines when OpenCode starts.
  2. **Subagent sandbox bypasses:** In `opencode.json`, the `tester` agent has `"edit": { ".opencode/tmp/**": "allow" }` and `"bash": { "powershell -File .opencode/tmp/*": "allow" }`, allowing it to write arbitrary PowerShell scripts into `.opencode/tmp/` and execute them, bypassing all `git`/`gh` deny rules. Similarly, `developer` and `self-improver` allow `node*` / `bun*` / `cargo*`, which can execute arbitrary subprocesses.
  3. **Prompt injection leak in `pipeline-state.rs`:** In `.opencode/scripts/pipeline-state.rs:1484-1485`, `flag_untrusted_comments` prints the first 80 characters of untrusted comments to stdout (`println!("GUARD.FIRED: ...: {}", snippet)`), which enters the calling agent's context window. Also, subagents have `"gh issue view*": "allow"` in `opencode.json`, which can read raw unpartitioned comments directly if called outside `pipeline-state.rs`.
* **Remediation:** Pin exact package versions in `opencode.json` (or install them as devDependencies in `pnpm-lock.yaml`), remove `"powershell -File .opencode/tmp/*": "allow"` from `tester`, and remove `snippet` from the `println!` in `flag_untrusted_comments`.

---

### 7. Azure DevOps PAT Stored in Base64 in `localStorage` and PostgreSQL `settings` Table
* **Location:** `apps/ui/src/shared/utils/patStorage.ts:19-28`, `53-57`
* **Description:** `docs/SECURITY.md` states *"No credentials or secrets are stored in the settings database. The one application that handles a user secret — the built-in SQL Studio client (`applications/db_client`) — stores the connection password in the OS keychain (`keyring`)."*
  However, `patStorage.ts` encodes the user's Azure DevOps Personal Access Token using `btoa(pat)` (Base64) and stores it under `Fredo_azdo_pat` in both `localStorage` and the PostgreSQL `settings` table via `settingsService.set()`.
* **Remediation:** Move `Fredo_azdo_pat` storage to the Rust `keyring` store (matching `db_client` and `pg_supervisor`) and remove it from `localStorage` and `settingsService`.

---

## Low Severity / Hardening Findings

### 8. OpenCode Plugin (`apps/opencode-plugin`) Telemetry Enable & Endpoint Validation
* **Location:** `apps/opencode-plugin/src/config.ts:66-68`, `90-91`
* **Description:**
  1. `hasNonEmptyEnv("OPENCODE_ENABLE_TELEMETRY")` uses `!!process.env[key]`, which evaluates to `true` even when a user sets `OPENCODE_ENABLE_TELEMETRY=0` or `OPENCODE_ENABLE_TELEMETRY=false` (contradicting the startup message in `src/index.ts:123` that checks for `'1'`).
  2. `endpoint` accepts any URL from plugin options or `OPENCODE_OTLP_ENDPOINT` without verifying that the host is loopback (`localhost`, `127.0.0.1`, `[::1]`). Since the plugin is installed globally at `~/.config/opencode/plugins/fredo.js`, opening a repository whose `opencode.json` sets plugin options could redirect telemetry externally.
* **Remediation:** Check `process.env["OPENCODE_ENABLE_TELEMETRY"] === "1" || process.env["OPENCODE_ENABLE_TELEMETRY"]?.toLowerCase() === "true"`, and validate that `config.endpoint` resolves to a loopback hostname before exporting telemetry.

### 9. Unbounded Line / Request Body Sizes on Local IPC Socket and OTLP HTTP Receiver
* **Location:**
  * `apps/tauri/src-tauri/src/infrastructure/ipc.rs:139-141`
  * `apps/tauri/src-tauri/src/infrastructure/otlp/http.rs:277-282`
* **Description:**
  * In `ipc.rs`, `BufReader::new(reader).lines().next_line().await` reads until `\n` with no upper bound on line length, allowing a malfunctioning or malicious local client to cause unbounded memory growth.
  * On Unix (`ipc.rs:104-119`), the socket at `/tmp/fredo-ipc.sock` is created in world-writable `/tmp` before `set_permissions(0o600)` runs (a brief TOCTOU window and `/tmp` symlink risk; prefer `$XDG_RUNTIME_DIR` or `~/.local/share/fredo/`).
* **Remediation:** Wrap the IPC reader with `AsyncReadExt::take()` (e.g., 8 MiB max per line) and on Unix place the socket inside a `0700` user-owned runtime directory.

### 10. Legacy `apps/code-sandbox` Subprocess Mode Bypasses Network Isolation & Argument Separator
* **Location:** `apps/code-sandbox/sandbox_service.py:120-153`, `296`, `347-351`
* **Description:** Although auxiliary, `apps/code-sandbox/sandbox_service.py` ignores the `network="none"` parameter in `run_code_subprocess` (running untrusted code directly inside the service container's namespace) and passes `libraries` to `pip install` / `npm install` without `--` (allowing flag injection if library names begin with `-`).
* **Remediation:** If `apps/code-sandbox` is no longer used (like `apps/tools-mcp_DEPRECATED`), remove or archive it; otherwise validate package names against a strict regex and pass `--` before `*libraries`.

### 11. `audit.yml` Ignores All Vulnerability Failures (`continue-on-error: true`)
* **Location:** `.github/workflows/audit.yml:29-37`
* **Description:** Both `cargo audit` and `pnpm audit` have `continue-on-error: true`, meaning even weekly scheduled runs always report green and never alert maintainers when new CVEs affect dependencies.
* **Remediation:** Remove `continue-on-error: true` on `schedule` runs (or fail on `--audit-level high`) so GitHub Actions notifies you when a dependency advisory is published.
