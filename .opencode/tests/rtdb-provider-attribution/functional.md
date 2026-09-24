# RTDB Provider Attribution — Functional Test Cases (Spec #2932)

> Durable functional suite (feature domain `rtdb-provider-attribution`) — provider attribution on the canonical RTDB rows (`chat_rows` / `tool_use_rows` / `agent_session_rows` in `fredo.db`). One `- [ ]` case per requirement; the `(Arch Rx)` tag maps each case to the Architect's EARS clauses.
>
> **Evidence policy: LIVE** — a PASS requires a live observable: a `telemetry-query.ps1` read against `fredo.db`, an injected `fredo emit`/OTLP-fixture row read back from those tables, or (F-5) an IPC/subscription capture. A `cargo test`/grep-only result is a FALSE PASS for these rows (it clears only N3's static half).
>
> **Bound vocabulary (Architect):** `open_code` / `claude_code` / `copilot_cli` / `internal` / `unknown`, resolved from the OTLP **resource identity** `service.name` (`fredo-opencode-plugin → open_code`; `copilot-cli → copilot_cli`; else `unknown`). Assert these literals exactly.
>
> **⚠ Oracle rule (Architect premise-correction):** the canonical row token derives from the resource `service.name` of the span's persisted merged attrs — **never** from `telemetry_spans.provider`, which keeps a mixed **model**-provider precedence (`gen_ai.provider.name` → flat `provider` → `service.name`) and is out of scope. For real OpenCode spans `telemetry_spans.provider` may read `openai`/`anthropic`; a row that equals the model provider is a FAIL.
>
> **Fixtures (G-172 — in-repo only):** `fredo emit` via the `fredo-cli-events` skill is the sanctioned distinct-provider lever (`--provider copilot_cli`, mocked — no paid Copilot subscription, no real Copilot CLI). The OTLP-resource legs use a live OpenCode drive (Run CLI / `dev-environment` skill); the unresolvable-provider negative control uses the in-repo `bun .opencode/scripts/inject-otlp-fixture.ts` (whose Resource omits `service.name`).
>
> **Isolation:** every run uses a fresh `e2e-<guid8>` session id; all queries filter on it. Restore any settings/retention writes to defaults.

## R1 (AC1) — every live-ingested row carries a resource-derived provider

- [ ] F-1 (Arch R1): drive a live OpenCode session (Run CLI real OTLP path), then `SELECT session_id, provider, COUNT(*) FROM chat_rows GROUP BY session_id, provider` (repeat `tool_use_rows`, `agent_session_rows`) and `SELECT COUNT(*) FROM chat_rows WHERE provider IS NULL OR provider = ''`.
  - EXPECTED: every newly ingested chat / tool-use / agent-session row carries a non-empty provider; OpenCode-origin rows carry exactly `open_code`; the NULL/empty count is **0**.
  - Edge: streaming Init before Response; a session producing all three row kinds; a session whose only row is a tool row; a pre-existing pre-migration row not re-written.
- [ ] F-2 (Arch R1, resource mapping — NOT the model provider): inspect the span's persisted merged attrs and compare with the row:
  - `SELECT session_id, json_extract(attributes_json, '$.service.name') AS service_name, provider AS model_provider FROM telemetry_spans WHERE session_id = '<s>'`
  - `SELECT provider FROM chat_rows WHERE session_id = '<s>'`
  - EXPECTED: the row's `provider` equals the token mapped from the span's resource `service.name` (`fredo-opencode-plugin → open_code`, `copilot-cli → copilot_cli`, else `unknown`); it must **NOT** equal the model provider (`openai`/`anthropic`) that `telemetry_spans.provider` may show. FAIL if row provider equals the model provider.
  - Edge: `service.name` present but `gen_ai.provider.name` = a model id; resource identity only; an unrecognised `service.name` → `unknown`; a child/composited row.

## R10 + R3 (AC2) — CLI vocabulary + distinct-provider injection

- [ ] F-3 (Arch R10/R3, mocked Copilot injection): `& $fredoBin emit --event-type chat --state init --provider copilot_cli --session-id <e2e-guid> --correlation-id <e2e-guid>_1` (repeat `tool_use`, `agent_session`), then `SELECT provider, session_id FROM chat_rows WHERE session_id = '<e2e-guid>'`. Also re-run `--provider open_code` / `claude_code` / `internal`.
  - EXPECTED: `--provider copilot_cli` parses (no invalid-value error) and the stored row's provider is exactly `copilot_cli` (no `internal` leakage, no NULL); the pre-existing three values keep parsing/mapping byte-identically. **No real Copilot CLI is needed — the mocked token is the sanctioned path.**
  - Edge: two providers under one session id (identity not collided); a bare `emit` with no `--provider` still defaults to `internal`; token formatting; `--provider bogus` still rejected.

## R2 (AC2) — query language exposes provider

- [ ] F-4 (Arch R2): validate + execute `chat(provider = "copilot_cli") { provider, userMessage }` (repeat `toolUse`, `agentSession`).
  - EXPECTED: validates with no `has no field 'provider'` error; `provider` is selectable in the projection; the filter returns ONLY rows carrying that token.
  - Edge: a filter token with zero matches → empty result, not an error; an unknown token → empty; string `=` (and string ordering per the schema rule); a pre-existing query that does not mention provider validates unchanged.

## R2 + R9 (AC2) — useEventRows scoping + typed wire; providers distinguishable

- [ ] F-5 (Arch R2/R9, subscription scoping): subscribe with args `{ provider: 'copilot_cli' }`; emit one `copilot_cli` row and one `open_code` row under distinct `e2e-<guid8>` sessions. Capture deliveries via `tauri_ipc_monitor` / `tauri_ipc_get_captured` (or the Stepper Probe readout).
  - EXPECTED: the scoped subscription receives ONLY `copilot_cli` rows (zero foreign-provider deliveries); each delivery patch exposes `provider`; ingesting the second provider does not alter the first provider's rows.
  - Edge: a subscription with NO provider arg receives all providers (unchanged); a scoped arg with no matching rows → empty + `replayCompleteQueryId` settle (no hang); a foreign-provider row must never surface.
- [ ] F-6 (Arch R2, typed wire): `apps/ui/src/shared/classes/EventSubscription.ts` — `ChatRow`/`ToolUseRow`/`AgentSessionRow` carry `provider: string | null` and all three `*_ROW_FIELDS` include `'provider'`; `pnpm --filter @fredo/ui build` is clean.
  - EXPECTED: provider is a first-class field on all three typed row shapes and in the canonical field tables; the TypeScript build passes with no fallback chain.
  - Edge: a partial update patch whose row already carries provider; a consumer reading `.provider` directly compiles.

## R4 (AC3) — provider survives the full row lifecycle

- [ ] F-7 (Arch R4, lifecycle): emit `chat --state init --provider open_code` on key (S, S_1), then replayed `init`, `update`, and `response` patches on the SAME key; read the row after each. Test BOTH a patch that omits/empties provider AND (per the bound `LastNonZero` rule) a patch declaring a DIFFERENT non-empty token.
  - EXPECTED: (a) provider is never NULL/`''` after any patch; (b) a patch that omits provider or carries an empty value never clears the existing token (`LastNonZero`); (c) a later NON-EMPTY token's effect must match the Architect's bound rule — `LastNonZero` overwrites, which **CONFLICTS with R4's "unchanged"** (see the plan Discussion). The Tester records the observed value against the declared rule.
  - Edge: Update before/after Response; replayed Init after a #523 re-key/compositing (ST-3 copies `existing.provider`); Timeout/Error states; retention eviction remains the only `remove` producer.

## R5 (AC3, NFR-6) — backfill re-derives provider identically

- [ ] F-8 (Arch R5, byte-comparability): over an existing store (upgrade), the one-shot re-derivation runs under the NEW `rtdb.backfill.provider.completed` marker (ST-6). For sampled keys compare the row's provider against the token the live path derives from the SAME persisted merged attrs (`json_extract(attributes_json, '$.service.name')` → mapping).
  - EXPECTED: the backfilled provider is byte-equal to the live-derived token for every sample; live ingest and backfill use ONE shared helper (`rtdb/attrs.rs` `resolve_provider_token`); no provider logic in `backfill.rs`.
  - Edge: a span with `service.name`; an unrecognised `service.name` (→ `unknown`); a span the live classifier already rowed; a store that already latched `rtdb.backfill.completed` (the NEW marker must still fire once).
  - Mechanism clause: if the re-derivation cannot be triggered in the sandbox, record a **named blocker** and the residual in-repo evidence is the shared-extract-rule unit pin (live vs backfill byte-comparability for the same span fixture). The row stays UNVERIFIED, not PASS.

## R8 (AC4) — regression-free adoption

- [ ] F-9 (Arch R8): run a pre-existing query without provider (e.g. `chat(sessionId = "<s>") { userMessage, agentReply }`) and open Mission Monitor against OpenCode rows.
  - EXPECTED: result set and fields identical to the pre-change baseline; no existing consumer needs a change; an OpenCode row's projected key set is a superset (loses no fields).
  - Edge: existing hard-named validation errors unchanged; `chat { rawJson, key.sessionId }` still valid; Mission Monitor renders unchanged.

## R7 (AC5) — unresolvable provider → `unknown`

- [ ] F-10 (Arch R7, negative control): `bun .opencode/scripts/inject-otlp-fixture.ts --count 1 --prefix ses_prov2932` (its Resource carries NO `service.name`; no `gen_ai.provider.name`/flat `provider`). Read the classified tool-use row for the injected span and `telemetry_spans.provider` for that span id.
  - EXPECTED: the row's provider is **non-empty** and equals the documented fallback `unknown`; `telemetry_spans.provider` for that span is also `unknown`. FAIL if NULL or `''`.
  - Edge: no `service.name` and no provider attr (the injector's exact shape); an empty-string value (treat as unresolvable); `fredo emit` cannot express "no provider" — this leg MUST use the OTLP fixture.
  - Mechanism clause: if `bun`/gRPC injection is sandbox-denied, record a named blocker with the extractor unit pin (fallback `unknown` non-empty) as residual — the row stays UNVERIFIED, not PASS.

## Non-functional

- [ ] N1 (Arch R6, migration — no data loss + pre-existing rows non-empty): do NOT clean the DB. Record counts BEFORE starting the upgraded binary; start it; then `PRAGMA table_info(chat_rows)` and `SELECT provider, COUNT(*) FROM chat_rows GROUP BY provider` (+ `WHERE provider IS NULL OR provider = ''`).
  - EXPECTED: `provider` column present (`NOT NULL DEFAULT 'unknown'`); NULL/empty count **0**; total rows unchanged (≥ pre-run); pre-existing rows show a re-derived real token where the source span exists, else `unknown`.
  - Edge: pre-cutover rows only; a genuinely fresh DB; a WAL from an unclean shutdown; re-running the ALTER is idempotent. If the store was cleaned before the run, record a named blocker and rely on the migration unit pin.
- [ ] N2 (perf): time ingest→row-visible for a fixed batch (e.g. 100 `fredo emit` events) provider present vs the pre-change baseline.
  - EXPECTED: no meaningful delta (pure in-memory lookup on the already-built attribute map; no DB round-trip, no new task — ST-1/ST-3); budget candidate ≤ 5% or ≤ 5 ms per batch.
  - Edge: a 100-emit burst; cold vs warm LRU cache; a session with many patch merges.
- [ ] N3 (NFR-6, one shared rule + totality): code pin — `resolve_provider_token` exists ONCE in `rtdb/attrs.rs`, consumed by `ingest.rs` (live) and the backfill path; the merge tables stay total (one rule per canonical field incl. the `provider` slot after `state`); the query schema covers `provider`; `cargo test` totality/length assertions green.
  - EXPECTED: zero duplicated provider extraction; live and backfill derivation byte-comparable (F-8); a `provider` added to `*_FIELDS` without a merge rule or schema entry fails the build — never silently defaults.
- [ ] N4 (build/console hygiene): `cargo check` zero warnings; `pnpm --filter @fredo/ui build` clean; `tauri_read_logs(source="console")` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## Round notes

> (Tester appends per-round results here — keep `- [ ]` on FAIL/UNVERIFIED, mark PASS with evidence, promote confirmed exploratory probes to a new `F-` row keeping the origin note.)
