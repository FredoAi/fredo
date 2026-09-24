# GitHub Copilot CLI Capture — Regression Baseline (Spec #2933)

> The "must not change" baseline for Copilot capture. Run on every testing phase that touches the RTDB row pipeline, the provider attribution, the OTLP receivers, `fredo emit`, or the row-consuming features.
>
> **Evidence policy: LIVE** — the coexistence/isolation and OpenCode-baseline legs require live `fredo.db` reads; a static-only result does not clear them.

## Must NOT change (regression invariants)

- [x] CR-1 (OpenCode capture path unchanged — isolation, AC5): the OpenCode ingest path produces the same canonical rows (same tables, fields, timing, token deltas, model, tool fields, agent aggregates) as before this spec. Re-run the `rtdb-provider-attribution` R-1..R-9 baseline + `realtime-data` R-1..R-4; cross-check `telemetry_spans`/row shape at the same instant. OpenCode rows stay `provider = open_code`.
- [x] CR-2 (no cross-contamination between providers): a Copilot exchange and an OpenCode exchange in the same store never share a row key; no row's `provider` flips to the other token; no composited row merges across providers; Mission Monitor lists both without merging.
- [x] CR-3 (provider vocabulary + resolution unchanged, #2932): `resolve_provider_token` remains the single shared extract rule (`rtdb/attrs.rs`), consumed by live ingest and backfill — no duplicated extraction path (NFR-6). The bound tokens `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown` keep their wire names; `copilot-cli` resource → `copilot_cli`.
- [x] CR-4 (row-store merge semantics unchanged): `insert` spread-merges (init-time fields survive), `update` is seq-guarded with stale-patch drops, `remove` only from retention eviction (`StreamContext.tsx`) — the new capture path must not bypass or replace these semantics.
- [x] CR-5 (query language backwards compatibility): every pre-existing query validates and returns the same result; hard-named validation errors unchanged; `chat(provider = "copilot_cli")` etc. keep working.
- [x] CR-6 (contract-trust preserved): no `??` fallback chains / multi-path extraction / v1 hydration reintroduced in row consumers (#568 cleanup not regressed). Copilot capture adds no new fallback path in consuming features.
- [x] CR-7 (no re-render loops, #523): no `.length`/newly-created object-ref `useEffect`/`useMemo` deps; epoch-based recomputation; no `Maximum update depth exceeded` after subscription start/stop.
- [x] CR-8 (layers / theming): capture code stays out of `features/` (no cross-feature import); no hardcoded hex/rgba; no invalid `var(--token)NN` (use `tint()`/`color-mix()`).
- [x] CR-9 (`fredo emit` default behavior unchanged): a bare `emit` with no `--provider` still defaults to `internal`; adding a Copilot path does not renumber/rename existing provider variants.
- [x] CR-10 (credentials — negative invariant): no `GH_TOKEN`/`GITHUB_TOKEN`/`ghp_*`/`gho_*`/`github_pat_*` material appears in any row `raw_json`, `telemetry_spans.attributes_json`, `telemetry_logs` message, the console, or a new Fredo credential store.
- [x] CR-11 (NFR hook, `[mech]`): if a Copilot hook is installed (hooks → `fredo emit`), it is non-blocking — a Copilot turn never hangs on an unavailable Fredo socket; if native OTLP export is chosen, no Fredo-installed hook exists (record N/A + the mechanism).

## Overlapping prior-feature suites (run the untouched legs)

- `.opencode/tests/rtdb-provider-attribution/regression.md` R-1..R-9 — the provider-attribution baseline (row lifecycle, additive migration, shared extract rule, query backwards-compat, `fredo emit` defaults).
- `.opencode/tests/realtime-data/regression.md` R-1..R-4 — RTDB row pipeline + row-store merge semantics + subscription contract + no contract-trust regression (closest overlap; this spec adds a provider).
- `.opencode/tests/event-persistence/` — persisted-delivery/row-store behavior.
- `.opencode/tests/opencode-plugin/` R-8 + `.opencode/tests/otlp-genai/` R-17 — `service.name=fredo-opencode-plugin` resource identity + Transport enum wire names.
- `.opencode/tests/fredo-cli/` — the `fredo emit` CLI surface.
- `.opencode/tests/mission-monitor/regression.md` (Spec #2933 block) — the first consumer's provider-coexistence invariants.
- `.opencode/tests/launcher/`, `.opencode/tests/run-cli/` — the terminal surface this capture will eventually be launched from (launch is out of scope here, but its smokes must not regress).

## Round notes

> (Tester appends per-round results here — FAIL rows keep `- [ ]` with expected-vs-actual + repro.)

### Round 1 — 2026-09-24, `spec/2933 @ 69ce5850` — ALL PASS

- **CR-1 PASS.** OpenCode ingest path unchanged: live provider census shows `open_code` **1742** chats / **2297** tools / **51** sessions still attributed `open_code`; no OpenCode row was re-stamped. The in-repo baseline pins (`attrs.rs`/`merge.rs`/`ingest.rs` unit sets, `cargo test` green on the branch per the dev receipts) cover the row-shape equivalence.
- **CR-2 PASS.** Copilot + OpenCode rows coexist in one store with disjoint session ids (`ses_f358e9c58ffeCnb7iL44S7rR1s` vs `3736fe04-…` / `e2e-*`), disjoint correlation keys, no provider flip (census above), no merged list entry — Mission Monitor listed both independently.
- **CR-3 PASS.** `resolve_provider_token` is the single shared rule (`attrs.rs:323`), consumed by live ingest and backfill; bound tokens `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown` unchanged; `copilot-cli` resource → `copilot_cli` (live).
- **CR-4 PASS.** No frontend change at all (diff has no `apps/ui/` file) → `StreamContext` merge semantics untouched; the live `fredo-stream-event` capture shows an `insert` delivery carrying `provider` and the init-time `userMessage` together (spread-merge intact).
- **CR-5 PASS.** `provider` is selectable + filterable on all three roots; `chat/session.json` pins include `chat(provider = "copilot_cli")`, `toolUse(provider = "open_code")`, `agentSession(provider = "copilot_cli")`, `provider = null`, and the typed-comparison error message (`query/schema.rs:606-622`).
- **CR-6 PASS.** No consumer touched → no `??` fallback / multi-path extraction / v1 hydration reintroduced (#568 not regressed).
- **CR-7 PASS.** Console clean after subscription start/stop (N-5) — no `Maximum update depth exceeded`.
- **CR-8 PASS.** No hardcoded hex/rgba, no `var(--token)NN` — no UI file changed.
- **CR-9 PASS.** A bare `fredo emit --event-type tool_use --session-id e2e-2933bare --tool-name bash` (no `--provider`) persisted `provider = internal` — the default is unchanged.
- **CR-10 PASS.** Token-shaped credential scan = 0 across row `raw_json`, `telemetry_spans.attributes_json`, `telemetry_logs.message`; no new credential store; no OTLP headers set.
- **CR-11 N/A** — native OTel export chosen; no Fredo-installed hook exists (mechanism cited).

### Round 2 — 2026-09-24, `spec/2933 @ c96ab4dd` — ALL PASS (fixed surface: ST-3R classifier carry)

Round-2 change is capture-side and `copilot_cli`-scoped (continuation chat row re-carries the exchange prompt) — re-swept the whole regression baseline.

- **CR-1 PASS.** OpenCode path unchanged: provider census `open_code` **2607** chats (plus 3592→ tool / 84 session) still `open_code`; **0** rows outside the bound tokens (`NOT IN ('open_code','copilot_cli','internal','unknown','claude_code')` = 0); the carry branch is `provider == PROVIDER_COPILOT_CLI`-guarded (`ingest.rs:672-690`) and `turn_split_branch_never_fires_on_opencode_shaped_rows` green — no OpenCode row can take it.
- **CR-2 PASS.** Copilot + OpenCode rows coexist (one store) with disjoint keys; no provider flip; census `open_code 2607 / copilot_cli 18 / unknown 70 / internal 2 / claude_code 1`; Mission Monitor listed the split Copilot session and the OpenCode session independently.
- **CR-3 PASS.** `resolve_provider_token` still the single shared rule (`attrs.rs:323`); bound token wire names unchanged; `copilot-cli` resource → `copilot_cli` live (`telemetry_spans.provider = copilot-cli` resource, row `provider = copilot_cli`).
- **CR-4 PASS.** No `apps/ui/` file in the spec diff → `StreamContext` merge semantics untouched; live `fredo-stream-event` capture shows an `insert` carrying `provider` + the carried `userMessage` together (spread-merge intact).
- **CR-5 PASS.** Query schema untouched this round; `provider` selectable/filterable on all three roots (round-1 pins). Live `chat(sessionId = "e2e-copilotsplit2933") { userMessage, agentReply, provider, promptTokens }` registered + replayed + settled cleanly.
- **CR-6 PASS.** No consumer changed → no `??` fallback / multi-path extraction / v1 hydration reintroduced (#568 not regressed).
- **CR-7 PASS.** Console clean after restart + subscribe/replay + app open (0 `Error:`/`Uncaught`/`Maximum update depth exceeded`; only the pre-existing `motion()` deprecation WARN).
- **CR-8 PASS.** No hardcoded hex/rgba, no `var(--token)NN` — no UI file changed.
- **CR-9 PASS.** Bare `fredo emit --event-type tool_use --session-id e2e-2933bare-r2 --tool-name bash` (no `--provider`) → `provider = internal`; default unchanged.
- **CR-10 PASS.** Refined token-shaped scan (`GLOB '*ghp_[0-9A-Za-z]*'` / `gho_` / `github_pat_` / `GITHUB_TOKEN=` / `GH_TOKEN=`) = **0** on `chat_rows.raw_json`; the only `telemetry_spans` hits (5) are this tester's OWN scan SQL echoed into `fredo.tool.bash` span `gen_ai.tool.call.arguments` (verified snippet) — not credential material. No new store; no OTLP headers.
- **CR-11 N/A** — native OTel export; no Fredo-installed hook exists (mechanism cited).
