# telemetry-domain-crate — Regression Baseline

> The "must not change" baseline for the Agent Telemetry domain crate extraction. Run on every
> testing phase that touches the classifier, `attrs`, `rows`, `merge`, the wire vocabulary
> (`comm::event` / `telemetry_domain::event`), the canonical backfill, `Cargo.lock`, or the
> workspace shape.
>
> **Evidence policy: LIVE for the consumer legs.** R-10 (Mission Monitor renders a real session) and
> R-12 (the row pipeline still lands live) require a live read. The structural invariants
> (R-1…R-9, R-11, R-13) are static/unit receipts and name their instrument.
>
> **Persisted by the tester in round 1 (G-521)** — the `planning → implementation` persist was a
> silent no-op because the folder did not exist.

## Must NOT change (regression invariants)

- [ ] **R-1 — Cost never double-counts.** `promptTokens` / `cacheReadTokens` stay PER-TURN DELTAS
  against the session-cumulative `last_request_input` / `last_request_cache_read` baselines, clamped
  ≥ 0, with baseline reset on compaction and out-of-order, and cache-read NEVER falling back to the
  raw session-cumulative value. A row whose token values equal the session-cumulative input is a
  FAIL. **Instrument:** the moved per-turn delta unit tests + F-4's value comparison. Edge: multi-turn
  session; a replayed Init; a compaction mid-session.
- [ ] **R-2 — The user's words are never overwritten.** `MergeRule::KeepFirst` keeps the existing
  non-`None` value; `KeepFirstAttributed` allows exactly one resolved-value upgrade; `LastNonZero`
  refuses a zero-delta wipe. The merge tables stay **total** — exactly one rule per canonical field,
  order preserved. **Instrument:** the moved `merge.rs` totality tests (26 `#[test]`s at the pin) +
  F-9. **Mutation that must redden it:** change `userMessage`'s rule to `LastNonZero` → a
  user-message overwrite test reddens.
- [ ] **R-3 — A subagent's work never vanishes from its parent's timeline.** The re-key still **copies**
  child rows under the parent key carrying `parentSessionId` + `compositedChildSessionId`; a re-key
  NEVER emits `kind: remove` (retention eviction is the ONLY remove producer); the `build`/`plan`
  internal-agent exclusion is intact (`INTERNAL_TOOL_EXECUTION_AGENTS = ["build","plan"]`). The
  first-wins stamp rule survives. **Instrument:** the moved relationship/re-key unit tests + the
  `removal`-producer search. Edge: a replayed Init after a re-key; a multi-hop re-key (L1→L2→L3).
- [ ] **R-4 — Row shapes and serialized output are untouched.** `CHAT_FIELDS` 18 /
  `TOOL_USE_FIELDS` 16 / `AGENT_SESSION_FIELDS` 13, with `provider` last; the physical column counts
  still assert 18/16/13; `RowState`'s PascalCase serde and the row structs' camelCase field names are
  unchanged; `query/schema.rs`'s schema-vs-const pins and a sample row's serde shape stay green.
  **Instrument:** `store.rs` + `query/schema.rs` pins + F-9. **Mutation that must redden it:** rename
  a serialized field or reorder a `*_FIELDS` table → the schema pin reddens.
- [ ] **R-5 — Correlation caps and eviction are unchanged.** `MAP_CAPACITY` = 10 000; all correlation
  /relationship maps keep oldest-first eviction at every write site. **Instrument:** the constant +
  the eviction unit tests. **Mutation that must redden it:** raise or lower the cap, or swap the
  eviction order → FAIL.
- [ ] **R-6 — NFR-6: ONE extraction path.** `attrs` + the vocabulary live in the crate exactly once;
  the live classifier and `rtdb/backfill.rs` both import them from the crate; **no converter layer**
  exists, so there is nothing that can drift. A crate-owned duplicate enum plus an edge converter is
  a NFR-6 regression. **Instrument:** F-8's single-definition search + `backfill.rs`'s import block
  (`:84-97` imports `telemetry_domain::attrs::{…}`, `telemetry_domain::event::Transport`,
  `telemetry_domain::rows::RowKind`, `telemetry_domain::classifier::{…}` — round 1 read it).
- [ ] **R-7 — Query language and subscription contract unchanged.** Every pre-existing query validates
  and returns the same result; hard-named validation errors unchanged; replay register-before-snapshot
  and the `replayCompleteQueryId` settle marker unchanged; `provider` remains selectable/filterable on
  all three row kinds. **Instrument:** the realtime-data R-3/R-4 legs + a live IPC read.
- [ ] **R-8 — Row-store merge semantics on the frontend unchanged.** `insert` spread-merges (init-time
  fields survive), `update` is `{ ...row, ...patch }` with seq-guarded stale drops, `remove` only from
  retention eviction. **Instrument:** the realtime-data R-2 leg; console clean after subscription
  start/stop (no `Maximum update depth exceeded`, #523).
- [ ] **R-9 — No contract-trust regression.** No `??` fallback chains, no multi-path extraction, no
  text filtering, no v1 hydration reintroduced (#568 cleanup not regressed). Once the row store
  guarantees a field, consumers read it directly. **Instrument:** a search for `??` chains over the
  consumer paths + the row-shape diff.
- [ ] **R-10 — The consumer still renders.** Mission Monitor opens, lists sessions, and renders a real
  session's chat nodes from the moved crate's rows with **no** delivery-path change. LIVE. **Mutation
  that must redden it:** a mis-mapped `RowKind`/`RowUpsert` conversion at the boundary → rows land
  under the wrong table/kind and the graph loses nodes.
- [ ] **R-11 — The canonical backfill still re-derives identically.** The startup provider
  re-derivation and the canonical backfill produce byte-equal rows against the live path (one shared
  rule). Edge: a store that already latched `rtdb.backfill.provider.completed`; a store with no
  `telemetry_spans` table (leaves the marker UNSET, never a false "done").
- [ ] **R-12 — The row pipeline still lands live.** An agent turn still persists `telemetry_spans` AND
  the chat row still reaches the webview — F-13 is this invariant's primary receipt; a PASS here
  without F-13 is a static-only PASS and is rejected.
- [ ] **R-13 — The workspace is additive.** `apps/tauri/src-tauri` becomes a workspace with
  `crates/telemetry-domain` as a member; the `fredo` package's own identity (`[package] name =
  "fredo"`, `[lib] name = "fredo_lib"`, the `fredo` binary) is unchanged; no member besides the app
  and the crate appears; the two `_bundle`-style resource trees and `build.rs`'s
  `command_manifest` include are untouched. **Mutation that must redden it:** rename the lib target,
  or make the app a non-root member in a way that breaks the `--manifest-path
  apps/tauri/src-tauri/Cargo.toml` invocation every CI step uses → FAIL.

## Overlapping prior-feature suites (run their untouched legs)

- `.opencode/tests/rtdb-provider-attribution/regression.md` **R-1** (merge semantics/totality),
  **R-3** (single shared extract rule — NFR-6), **R-5** (existing ingest projections unchanged),
  **R-6** (no contract-trust regression) — the closest overlap; this spec moves the very files those
  rows pin.
- `.opencode/tests/realtime-data/regression.md` **R-1** (RTDB row pipeline untouched), **R-2**
  (row-store merge semantics), **R-3** (subscription contract), **R-4** (no contract-trust
  regression).
- `.opencode/tests/otlp-genai/regression.md` **R-2/R-12/R-20** (extraction priorities),
  **R-13/R-21** (`EventState`/`completeWhen` alignment — the enum this spec moves),
  **R-17** (Transport enum wire names), **R-18/R-19** (renamed-key + flat fallbacks).
- `.opencode/tests/copilot-capture/functional.md` **F-4** (the turn-split merge contract this
  suite's F-6(c) reuses) and **F-8** (determinism / no duplicate row per composite key).
- `.opencode/tests/mission-monitor/regression.md` — the consumer's invariants (no visual redesign,
  ingest unchanged, compositing, deletion tombstones, latency budgets).
- `.opencode/tests/event-persistence/` — persisted-delivery behavior the row store builds on.
- `.opencode/tests/ci-pipeline/regression.md` **R-5** (a lockfile change invalidates the cache —
  expected, not a regression) — relevant to F-10/N-3.

## Round notes

> (Tester appends per-round results here — FAIL rows keep `- [ ]` with expected-vs-actual + repro;
> promoted exploratory probes go to `functional.md` as a new `F-` row keeping the origin note.)

### Round 1 (2026-11-28) — `spec/3201` @ `64e575d`, env port 65067

**Executed, green:** `cargo nextest run -p telemetry-domain` → **79 passed, 0 skipped**
(26 merge totality tests included: `chat_apply_covers_every_field`,
`tool_apply_covers_every_field`, `session_apply_covers_every_field`,
`merge_tables_are_total_and_duplicate_free`, `rule_of_resolves_every_declared_field_and_none_outside`,
… the full list is in the posted `## Tests Runs`). `cargo check --locked` → EXIT 0, zero warnings.
`cargo clippy --locked -- -D warnings` → EXIT 0. `cargo nextest --no-run` (all targets, all 13
binaries) → EXIT 0.

**R-6 verified structurally:** `rtdb/backfill.rs:84-97` imports `telemetry_domain::attrs::{…}`,
`telemetry_domain::event::Transport`, `telemetry_domain::rows::RowKind`,
`telemetry_domain::classifier::{…}` — one shared rule, no converter.

**NOT verified in round 1 (see the verdict's per-row dispositions):** R-1/R-3 via the moved unit
tests is **indirect** — the crate ships no classifier-level test at all (see F-4), so R-1/R-3 rest on
`merge.rs`'s totality/vacuity suite rather than an end-to-end classification. R-10/R-12 are F-13's
leg and were not driven to a delivered chat row. R-11 was not exercised.
