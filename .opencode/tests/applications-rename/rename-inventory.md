# ST-1 — Phase-0 rename inventory + names freeze (#2956)

> Deliverable for sub-task **ST-1** of #2956 ("Rename features to applications across code,
> UI, CLI, and docs"). This is a **measurement + freeze** artifact: no product code is changed.
> It sizes the rename and records the retained classes that the residual grep gate
> (`.opencode/tests/applications-rename/grep-allowlist.txt`, consumed by ST-6 / QA-3) must
> skip so that "zero feature-sense occurrences" is machine-checkable.
>
> Authority: the `## Triage Plan` on #2956 — Software Architect `#### Binding IN / OUT scope
> table`, the `Binding names block (G-255)`, and binding adjudication 1 (NO-MIGRATE).

## Method

- Worktree `.worktrees/2956-a`, detached at `origin/spec/2956` (tip `30f9fc1`).
- A one-off Node scanner (`node`, not committed) walked the whole worktree, skipping
  `node_modules`, `target`, `dist`, `.git`, `.worktrees`, `build`, `coverage` and compiled
  assets, and counted every case-sensitive-plus-capital `[Ff]eature` occurrence per
  file / bucket, plus a histogram of identifier-like tokens and an evidence scan for the
  allowlist literals. Reproducible: any recursive `[Ff]eature` count over the same tree.

## Headline totals

| Metric | Value |
|---|---|
| Files scanned | 1,329 |
| Files containing `feature`/`Feature` | 579 |
| Total occurrences | **7,545** |
| Distinct identifier-like tokens | ~170 |

## Occurrences by bucket

| Bucket | Verdict (plan) | Occurrences |
|---|---|---|
| `apps/ui/src/features/**` | IN | 1,890 |
| `apps/ui/src/shared/**` | IN | 1,329 |
| `.opencode/tests/**` | OUT (pipeline meta; durable suites) | 1,292 |
| `apps/tauri/src-tauri/src/infrastructure/feature_data/**` | IN | 698 |
| `docs/agentic-pipeline/**` | OUT (pipeline meta) | 468 |
| `docs/archive/**` | OUT (archive) | 309 |
| `docs/**` (product) | IN | 296 |
| `apps/tauri/src-tauri/src/**` other (`lib.rs`) | IN | 224 |
| `.opencode/**` other (scripts/skills) | OUT (pipeline meta) | 186 |
| `apps/tauri/src-tauri/src/features/**` | IN | 167 |
| `apps/tauri/src-tauri/tests/**` | RETAIN (frozen-literal fixtures) | 154 |
| `apps/tauri/src-tauri/src/infrastructure/**` rest | MIX (mostly OUT) | 112 |
| `spikes/**` | OUT (non-product) | 95 |
| `research/**` | OUT (non-product) | 88 |
| `apps/ui/src/**` other (`index.ts`, app/) | IN | 80 |
| `apps/tauri/src-tauri/src/infrastructure/storage/feature_store.rs` | IN | 69 |
| `apps/tools-mcp_DEPRECATED/**` | OUT (Optimizely domain) | 35 |
| `apps/tauri/**` other | mixed | 33 |
| `.github/**` | OUT | 5 |
| `CONTRIBUTING.md` | OUT | 6 |
| `README.md` | OUT | 3 |
| `AGENTS.md` (human-owned) | RETAIN | 2 |
| `opencode.json` (human-owned) | RETAIN | 2 |
| `scripts/**` | OUT | 2 |

**IN-scope product surface** (excluding `.opencode/**`, `docs/agentic-pipeline/**`,
`docs/archive/**`, spikes/research, tools-mcp, tests fixtures) is roughly **4,700 occurrences
across ~300 files** — dominated by the frontend tree (3,299) and the Rust data layer (767).

## In-scope occurrences by directory (rename sizing)

### Frontend `apps/ui/src` (IN)

| Directory | Occurrences |
|---|---|
| `shared/hotkeys/` | 559 |
| `features/home/` | 496 |
| `features/settings-app/` | 376 |
| `features/mission-monitor/` | 307 |
| `shared/feature-data/` | 296 |
| `shared/window-system/` | 164 |
| `features/dev-mode/` | 106 |
| `features/app-window/` | 88 |
| `shared/classes/` | 83 |
| `shared/hooks/` | 71 |
| `features/my-workitems/` | 72 |
| `features/database-client/` | 68 |
| `features/optimizely/` | 62 |
| `features/__tests__/` | 54 |
| `shared/contexts/` | 48 |
| `shared/lib/` | 45 |
| `features/diagram/` | 39 |
| `shared/utils/` | 22 |
| `features/query-viewer/` | 21 |
| `features/stepper-probe/` | 20 |
| `features/terminal/` | 19 |
| `features/theming/` | 17 |
| `features/browser-preview/`, `docs-viewer/`, `github-viewer/` | 15 each |
| `features/setup/` | 14 |
| `features/model-storage/` | 13 |
| `features/doom/` | 10 |
| `shared/components/`, `shared/stores/` | 7 each |
| `features/settings/` | 6 |
| `features/ingest/` | 5 |
| `shared/doom-mode/` | 3 |

### Rust `apps/tauri/src-tauri/src` (IN)

| Directory / file | Occurrences |
|---|---|
| `lib.rs` (composition root) | 216 |
| `infrastructure/feature_data/commands.rs` | 176 |
| `infrastructure/feature_data/registry.rs` | 116 |
| `infrastructure/feature_data/declaration.rs` | 102 |
| `infrastructure/feature_data/store.rs` | 73 |
| `infrastructure/storage/feature_store.rs` | 69 |
| `infrastructure/feature_data/watch.rs` | 56 |
| `infrastructure/feature_data/projection.rs` | 53 |
| `features/terminal/` | 87 |
| `infrastructure/feature_data/envelope.rs` | 45 |
| `infrastructure/feature_data/lifecycle.rs` | 38 |
| `infrastructure/feature_data/backfill.rs` | 36 |
| `features/pg_supervisor/` | 24 |
| `features/db_client/` | 15 |
| `features/doom/` | 15 |
| `features/llm_server/` | 15 |
| `features/setup/` | 5 |
| `features/telemetry/` | 4 |
| `features/settings/` | 2 |

### Docs (IN) vs pipeline meta (OUT)

| Area | Occurrences |
|---|---|
| `docs/ARCHITECTURE.md` | 186 |
| `docs/FAQ.md` | 53 |
| `docs/SECURITY.md` | (part of 296 product total) |
| `docs/agentic-pipeline/**` (OUT) | 468 |
| `docs/archive/**` (OUT) | 309 |

## Top files by occurrences (whole repo)

`lib.rs` 216 · `docs/ARCHITECTURE.md` 186 · `docs/agentic-pipeline/playbooks/references.md` 179 ·
`feature_data/commands.rs` 176 · `shared/hotkeys/contexts.ts` 130 · `features/home/components/Home.tsx` 124 ·
`docs/archive/.../FEATURE_CLASS_GUIDE.md` 119 · `feature_data/registry.rs` 116 ·
`.opencode/scripts/pipeline-state.rs` 103 · `feature_data/declaration.rs` 102 ·
`shared/feature-data/store.ts` 102 · `features/settings-app/.../HotkeysSettings.tsx` 92 ·
`shared/feature-data/client.ts` 83 · `shared/hotkeys/registry.ts` 77 ·
`infrastructure/storage/feature_store.rs` 69 · `shared/hooks/useFeatureData.ts` 67.

## Top IN-scope identifier tokens (rename targets)

`FredoFeatureClass` 218 · `onOpenFeature` 94 · `openFeature` 78 · `registerFeature` 65 ·
`openFeatureWindow` 55 · `getFeatures` 48 · `dedupeByFeatureId` 40 · `registerFeatureHotkeys` 39 ·
`focusedFeatureId` 31 · `useFeatureWatch` 25 · `showableFeatures` 25 · `getFeatureEpoch` 23 ·
`applyFeatureNotification` 21 · `settingsFeature` 20 · `allFeatures` 19 · `FeatureDeliveryBatch` /
`featureBatch` (20 files) · `feature_data_*` / `feature_store_*` commands · `FeatureStore` /
`FeatureDataStore`.

## Allowlist class evidence (for `grep-allowlist.txt`)

| Class | Literal(s) | Evidence (files / key lines) |
|---|---|---|
| A frozen DDL tables | `feature_data_tables`, `feature_data_tombstones` | `infrastructure/feature_data/store.rs:30,39` (DDL); 22 / 12 files |
| A frozen terminal table | `feature_terminal_sessions` | `features/terminal/persistence.rs:4,20`; 10 files |
| A frozen column | `feature_id` | metadata column, used across the data layer (store/registry/projection/commands); 19 files |
| A frozen prefix | `feature_{}_{}` / `feature_{}_` / `feature_{featureId}_{tableName}` / `feature_<sanitized featureId>_<table>` | `infrastructure/storage/feature_store.rs:193-204`; `docs/ARCHITECTURE.md:116,319`, `docs/FAQ.md:208`, `docs/SECURITY.md:212` |
| B Optimizely | `Feature Flags`, `OptimizelyFlag` | `features/optimizely/OptimizelyFeature.tsx:17`; `OptimizelyFlagsPanel.tsx`; tools-mcp optimizely |
| B ADO work-item type | `'Feature'` in the type union + create-form option | `shared/utils/azdoApi.ts:363`, `features/my-workitems/types.ts:76`, `CreateWorkItemForm.tsx:256` |
| B MIME | `application/json` | 33 files repo-wide (unaffected by a `feature` rename; listed to pin the class) |
| B Cargo/build | `#[cfg(feature = …)]`, `required-features`, `feature = [`, `bundled`, `doom-stub` | `Cargo.toml`, `features/pg_supervisor/acquisition.rs`, `bin/doom_stub.rs`, `features/doom/*` |
| B pipeline meta | `.opencode/**`, `docs/agentic-pipeline/**` | whole trees (OUT) |
| B generic English | `a feature of`, `features of` | `docs/agentic-pipeline/**`, prose |
| C already-app-named | `AppStore`, `app_open`, `appWindows`, `appPresentationStore`, `app_window_presentation`, `app-<id>`, `?view=app&id=`, `fredo open-app`, `app-open-request`, `>Apps<`, `Open apps`, `No apps available` | `infrastructure/app_open.rs`, `shared/window-system/appWindows.ts`, `shared/window-system/appPresentationStore.ts`, `infrastructure/app_window.rs`, `docs/ARCHITECTURE.md` |

### Critical: the per-app prefix must NOT be allowlisted as a blanket `feature_`

The QA-3 gate self-test injects `feature_zzz_probe` and it MUST be flagged. Therefore the
allowlist pins only the exact frozen format-string/comment spellings and **no generic
`feature_<word>` pattern**.

## Scope notes / risks for downstream sub-tasks

1. **`feature_id` is both a frozen column and a source identifier.** The snake_case `feature_id`
   is the on-disk metadata column (retained, Class A); the camelCase `featureId` **request
   argument / wire field** renames to `applicationId` (ST-3/ST-4). The gate must not let the
   Class A `feature_id` pin mask a stale `featureId`; the binding names block is explicit that
   only request args rename.
2. **Optimizely directory is not path-allowlisted wholesale.** Its domain copy (`'Feature Flags'`)
   and `OptimizelyFlag` are retained, but its app-concept imports (`registerFeature`,
   `FredoFeatureClass`) still rename when the directory moves under `applications/`. Path-scoping
   the whole directory would mask a genuine regression (E-5 probes exactly this).
3. **Class C entries are mostly inert for a `feature` grep** (they contain no `feature`
   substring) — they are listed to pin the binding no-second-churn decision for ST-2/ST-4/ST-6.
4. **Out-of-gate-scope but high-count trees**: `.opencode/tests/**` (1,292), `docs/agentic-pipeline/**`
   (468), `docs/archive/**` (309) are pipeline-meta/archive and are NOT in the QA-3 scan scope;
   they are recorded for completeness only.
5. **Human-owned files**: `AGENTS.md` (2) and `opencode.json` (2) are inventoried but must NOT be
   pipeline-edited (AC5) — they are required human touchpoints (ST-6 lists them).
6. **`docs/app-icons.md` does not exist** (confirmed) — the backlog's "geometric features" OUT class
   is stale; nothing to retain.

## Residual grep gate (ST-6 deliverable)

`residual-grep-gate.js` (Node — the same toolchain this suite's Phase-0 scanner used) consumes this
directory's `grep-allowlist.txt` and FAILS (exit 1) on any un-allowlisted `[Ff]eature` occurrence
over the renamed product/copy surfaces:

`apps/ui/src/applications/**`, `apps/ui/src/shared/**`,
`apps/tauri/src-tauri/src/applications/**`, `apps/tauri/src-tauri/src/infrastructure/**`, `docs/**`.

- **Run:** `node .opencode/tests/applications-rename/residual-grep-gate.js`
  (`--json` / `--summary` / `--tokens` for machine-readable output).
- **Self-test (G-300):** `node .opencode/tests/applications-rename/residual-grep-gate.js --selftest`
  injects a `feature_zzz_probe` token under `.opencode/tmp/2956/` and asserts it is flagged — the
  allowlist deliberately has no blanket `feature_` entry.
- **Scoped rules:** an `in:<glob> lit:<text>` / `in:<glob> re:<regex>` entry applies a retained
  `lit:`/`re:` rule ONLY to matching paths. ST-2/ST-3 intentionally retained the app-concept
  identifier spelling in code (component/local names, `<Name>Feature` components, metadata
  fields, test fixtures) — see the Class D entries — and `featureId` metadata is scoped so a
  stale `featureId` invoke arg in the wire-contract files
  (`shared/lib/applicationStore.ts`, `shared/application-data/**`, `application_store.rs`,
  `application_data/**`) is still flagged.
