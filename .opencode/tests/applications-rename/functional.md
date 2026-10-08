# Applications Rename — Functional

> Durable functional suite for the cross-cutting **rename of the Fredo app concept from
> "feature" to "application"** across code, UI, CLI, and docs (backlog #2956). Seeded at triage;
> one `- [ ]` case per requirement. Requirements map 1:1 to the Architect's EARS **R-1..R-5**
> (AC1..AC5) in `.opencode/tmp/2956/triage.md` `## Software Architect`.
>
> **Verification policy: LIVE.** AC1 (rendered labels/aria), AC3 (`fredo open-app` end-to-end)
> and AC4 (existing-PG-DB round trip) are not statically certifiable. Every live row's Evidence
> MUST reference `telemetry_spans` (an OTLP-ingested live receipt) and/or a rendered-webview
> receipt; a static-only PASS is a FALSE PASS. `fredo emit` routes to the RTDB row pipeline and
> writes NO spans (G-256) — name a live OTLP-ingested action for the span receipt.
>
> **Binding names (G-255, Architect):** `FredoApplicationClass`; `registerApplication`/
> `getApplications`/`dedupeByApplicationId`; dirs `apps/ui/src/applications/`,
> `apps/tauri/src-tauri/src/applications/`, `infrastructure/application_data/`;
> `applicationStore.ts`; commands `application_data_*` / `application_store_*`; wire
> `applicationBatch` / `applicationId`; user-facing term **"Applications"**.
>
> **Frozen on-disk literals (NO-MIGRATE, AC4):** `feature_data_tables`, `feature_data_tombstones`,
> `feature_terminal_sessions`, prefix `feature_{sanitizedId}_{table}`, column `feature_id`.
>
> **Retained different-sense allowlist (AC1):** Optimizely display name `'Feature Flags'` +
> feature-flag copy; Azure DevOps work-item type `'Feature'`; MIME `application/json`; Cargo/build
> `feature=` / `#[cfg(feature=…)]`; `.opencode/**` + `docs/agentic-pipeline/**` pipeline-meta sense;
> generic English "a feature of X".

## R-1 (AC1) — user-facing consistency: rendered labels/aria/copy

- [ ] **F-1 (R-1/AC1, LIVE) — launcher rendered copy + accessible names.**
  On the running `spec/2956` app, open the engaged launcher (focus `input[role="searchbox"]` or
  enter a query) and `tauri_webview_dom_snapshot(type="accessibility")` the surface.
  **Expected:** the grid heading and `aria-label` read **"Applications"** (short form "App(s)"
  allowed — NOT "Feature"); every tile's accessible name equals its display name; ZERO user-facing
  node uses "feature" for the concept. Reference: `LauncherAppGrid.tsx` `role="grid"`/`aria-label`.
  **Edge:** empty grid shows the empty state (`No apps available`) with the new copy; the Settings
  tile + open-apps row (`| OPEN APPS`) still render; the Optimizely tile still reads
  **"Feature Flags"** (retained).

- [ ] **F-2 (R-1/AC1, LIVE) — hotkey / Settings / Dev Mode copy.**
  Open the hotkey tier label (cheat sheet + discovery + which-key), Settings' auto-discovered
  group header, and the Dev Mode data tab.
  **Expected:** the app-scoped hotkey tier label reads **"Application"** (never "Feature"); the
  Settings group reads **"Applications"**; the Dev Mode tab reads **"Application Data"**; the
  `'Feature wins here'` string no longer occurs for the concept. Reference:
  `CheatSheetOverlay.tsx`, `KeysDiscovery.tsx`, `WhichKeyOverlay.tsx`, `HotkeysSettings.tsx`,
  `DevMode.tsx`.
  **Edge:** retained different-sense strings stay byte-identical (Optimizely `'Feature Flags'`;
  ADO work-item type `'Feature'`); a light/dark theme swap does not restore old copy.

## R-1/R-2 — residual grep gate (zero un-allowlisted feature-sense occurrences)

- [ ] **F-3 (R-1/R-2, STATIC, deterministic) — residual grep gate.**
  Run the rename gate over the renamed surfaces — `apps/ui/src/applications/**`,
  `apps/ui/src/shared/**`, `apps/tauri/src-tauri/src/applications/**`,
  `apps/tauri/src-tauri/src/infrastructure/**`, and `docs/**` — for `feature`-sense identifiers and
  user-facing copy. `.opencode/**` is dot-prefixed and is SKIPPED by glob/ripgrep, so the gate must
  use explicit paths where it must inspect pipeline-meta (none — that class is OUT).
  **Expected:** ZERO un-allowlisted occurrences of the concept spelled `feature` in the renamed
  source/copy; only frozen on-disk literals + retained different-sense classes survive. **FAIL** =
  any stale identifier/dir/import or user-facing "feature" for the concept.
  **Allowlist (frozen):** `feature_data_tables`, `feature_data_tombstones`,
  `feature_terminal_sessions`, `feature_id`, `feature_{sanitizedId}_{table}`;
  `'Feature Flags'` (Optimizely), ADO `'Feature'` work-item type, `application/json`, Cargo
  `feature=`/`doom-stub`, `.opencode/**`, `docs/agentic-pipeline/**`, generic English.
  **Edge (G-300):** a synthetic un-allowlisted token (`feature_zzz_probe`) injected into a scratch
  file under `.opencode/tmp/2956/` must be FLAGGED by the gate as a self-test of the deny rule —
  this is a unit pin on the gate; the gate's product assertion is static and NON-AC.

## R-2 (AC2) — build/typecheck/tests green on the full diff (CI parity)

- [ ] **F-4 (R-2/AC2, STATIC/CI parity) — full-diff gates.**
  On the spec branch, run the `.github/workflows/validate.yml` command set on the full diff:
  `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`;
  `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings`;
  `pnpm --filter @fredo/ui typecheck`; `pnpm --filter @fredo/ui build`;
  `pnpm --filter @fredo/ui test:run`; `pnpm --filter @fredo/tauri build:webview`.
  **Expected:** all green — zero TS errors, `cargo check` zero warnings, clippy `-D warnings` clean,
  vitest green, served-entry webview build succeeds. The `ui-validate` + `rust-validate` jobs of
  `validate.yml` (the single required `validate` check) pass.
  **Edge (G-251):** the served-entry build (`apps/tauri` index.html → `src/main.tsx`) must pass —
  the library-only `@fredo/ui build` cannot see a served-entry import break. Also run
  `cargo nextest run --locked` (rust-validate leg).

## R-2/R-3 (AC2/AC3) — data layer + wire discriminator lockstep (LIVE)

- [ ] **F-5 (R-2/R-3, LIVE) — renamed Tauri commands + `applicationBatch` discriminator.**
  With the app running, drive a live OTLP-ingested action (a real agent session, NOT `fredo emit`)
  so rows flow; invoke the data layer; capture IPC with `tauri_ipc_monitor` /
  `tauri_ipc_get_captured`.
  **Expected:** `application_data_read|watch|unwatch|write|delete|declare` and
  `application_store_*` are registered in `lib.rs` and invoked successfully under the application
  vocabulary (same arg/result shapes); the wire discriminator is `applicationBatch` (field
  `applicationId`), consumed by the frontend before RTDB validators; rows still reach Mission
  Monitor; NO `featureBatch` is emitted or accepted. Behavior is byte-for-byte equivalent apart
  from the names (spread-merge / seq-guard / epoch semantics unchanged).
  **Edge:** a stale `featureBatch` payload is not recognized (negative); envelope shape unchanged
  (only the discriminator + id field renamed).
  **Required data:** a live OTLP-ingested session + `telemetry_spans` query at the same instant.

## R-3 (AC3) — `fredo open-app` end-to-end (LIVE)

- [ ] **F-6 (R-3/AC3, LIVE) — CLI open + help + reconciled vocabulary.**
  With the app running, run `fredo open-app mission-monitor`, `fredo open-app "Mission Monitor"`,
  and `fredo open-app --help`; then `dev-env -Action Down` and run it again. Record raw exit codes,
  stdout/stderr, and the window list.
  **Expected:** exit 0 and the SAME window opens as the launcher tile (no duplicate opener, no
  duplicated command); the new window's identity matches the tile-opened surface; `--help`
  describes the identity as an **application's** id/display name; the pre-existing `open-app`
  verb + `app-open-request` event are RETAINED (reconciled, not duplicated); exit **2** app-down;
  exit **1** unknown identity with a readable message and zero windows.
  **Edge:** case variants; surrounding whitespace; `""`/missing arg; unknown id; re-invoke focuses
  the existing window; app killed mid-call.

## R-4 (AC4) — existing pre-rename PG database round trip (LIVE, NO-MIGRATE)

- [ ] **F-7 (R-4/AC4, LIVE) — pre-rename DB read/write round trip.**
  Boot the renamed app against a **pre-rename** PostgreSQL data dir (materialised via the in-repo
  lever below), open a declared app table, read its rows, write a row, and re-read it.
  **Expected:** the frozen on-disk identifiers (`feature_data_tables`, `feature_data_tombstones`,
  `feature_terminal_sessions`, `feature_{sanitizedId}_{table}`, column `feature_id`) still resolve;
  the declared rows read back intact; the write + re-read round-trips with NO data loss and no
  broken persisted state; the exact literals are pinned by a unit test so a future rename cannot
  silently diverge. NO destructive PG migration is performed.
  **In-repo lever:** copy a pre-rename data dir to
  `.opencode/tmp/2956/pgdata-prerename/` and point the managed server at it via the shipped seam
  `FREDO_PG_DATA_DIR` (`apps/tauri/src-tauri/src/features/pg_supervisor/mod.rs:65`); start/stop via
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2956` / `-Action Down` (G-263,
  never a bare `postgres`/`pg_ctl`).
  **Pre-authorized fallback (if no live BEFORE cycle is available):** materialise an existing DB
  whose schema carries the frozen literals from the committed migration fixtures
  (`tests/support/migration_fixture.rs:114,123`; `tests/postgres_migration.rs:292,796`) + the
  committed DDL, then boot the renamed app against it and perform the real round trip. Frozen-literal
  assertions ALONE are NOT a PASS — the round trip must be real.
  **Edge:** a declared table with a tombstone; the per-app prefix generator stays byte-identical
  (`feature_mission_monitor_sessions`); metadata column `feature_id` present.

## R-1 + R-2 (MANDATORY human directive) — Mission Monitor end-to-end

- [ ] **F-8 (R-1+R-2, LIVE, MANDATORY) — Mission Monitor on the PostgreSQL-default boot.**
  Boot the app with the **PostgreSQL-default** engine; drive a live OTLP-ingested agent session
  (prefer over `fredo emit`); open Mission Monitor; snapshot the DOM + screenshot; run a
  `telemetry_spans` query at the SAME instant.
  **Expected:** Mission Monitor still renders the live session(s) and their chat/tools/tokens from
  the store; the renamed user-facing surfaces read "applications"; the rendered data equals the
  same-instant `telemetry_spans`/row columns. This substantiates AC1 + AC2 (no behavior change)
  under the live policy. A static-only receipt = FALSE PASS.
  **Edge:** provider split (opencode + copilot) rendered as distinct entries; empty store; the
  launcher grid + hotkey tier + Dev Mode tab simultaneously show the new copy.

## R-5 (AC5) — docs + ownership

- [ ] **F-9 (R-5/AC5, STATIC) — docs consistency + human touchpoints.**
  Grep `docs/**` for the concept; inspect `AGENTS.md` + `opencode.json`.
  **Expected:** `docs/` is internally consistent (no user-facing "feature" for the concept);
  `AGENTS.md` + `opencode.json` are LISTED as required human touchpoints and are NOT edited by the
  pipeline (`git diff` on both is empty). The stale `docs/app-icons.md` reference is absent (the
  file does not exist).
  **Edge:** retained different-sense docs (Optimizely feature-flag copy, ADO work-item-type text)
  are byte-unchanged; `docs/agentic-pipeline/**` pipeline-meta is untouched.

## Suite-level pass/fail

PASS = F-1..F-9 all green under the live policy (F-5, F-6, F-7, F-8 carry live + `telemetry_spans`
Evidence). Any un-allowlisted feature-sense occurrence, any red CI-parity gate, any `featureBatch`
on the wire, a broken `fredo open-app`, data loss against the frozen schema, or an unchanged
Mission Monitor while rows exist = **FAIL**.
