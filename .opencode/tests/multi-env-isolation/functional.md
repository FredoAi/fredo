# multi-env-isolation — Functional

Durable functional suite for **multiple isolated local Fredo test environments** (issue #2944).
One `- [ ]` case per requirement (AC1–AC5 + the mandatory Mission-Monitor E2E directive);
observable expected outcome per case.

> **Verification policy: LIVE** — this is a runtime/isolation feature. Concurrent reachability,
> per-env DB isolation, env-scoped lifecycle, env-aware MCP, and Mission Monitor rendering are
> provable only by observing running artifacts (process tables, listening sockets, per-env DB
> reads, DOM + screenshots). The testing exit gate and audit fail-closed unless the Tester's
> Evidence references live receipts (per-env DB row, process/port list, DOM snapshot +
> screenshot, audit exit). A static-only PASS is a FALSE PASS.

> **Names BOUND to the Architect's Names Block** (realigned at convergence — G-255/G-187): env-ID var
> `FREDO_ENV_ID`; per-env root `FREDO_ENV_ROOT` (default `<repo>/.opencode/tmp/envs/<envId>`);
> data-dir `FREDO_DATA_DIR` = `<env-root>/data` (app-data) and PostgreSQL data dir `<env-root>/postgres`; port selection via
> `-EnvSlot` (slot 0 = legacy 5174/9223/4317/4318/8080; slot n≥1 = `16000 + 10*(n-1)`) with explicit
> `-VitePort`/`-McpPort` overrides and OTLP ports via `FREDO_INGEST_GRPC_PORT`/`FREDO_INGEST_HTTP_PORT`;
> instance selector `dev-env.ps1 -EnvId <id>`; MCP `appIdentifier` = the env's MCP port decimal string
> (e.g. `"16001"`); process manifest `<env-root>/manifest.json` (override `FREDO_ENV_MANIFEST`);
> evidence `<env-root>/evidence.json` (override `FREDO_EVIDENCE_FILE`); runtime app identity
> `com.fredo.app#<envId>` + window title `Fredo [<envId>]` (no UI testid — UI/UX is N/A).

> **G-263 SAFETY:** NEVER run an unbounded binary. Every start/stop/teardown leg is time-bounded
> (Up ≤ 180 s / existing `-TimeoutSecs`; Down ≤ 30 s) with a hard-kill fallback
> (`taskkill /PID <pid> /T /F`). Start/stop only through the sanctioned lever
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -EnvId <id>` — never a
> hand-rolled `pnpm dev:tauri`, never a bare `postgres`/`pg_ctl`.

## Cases

- [ ] **F-1 (AC1, concurrent env reachability).** Start env A and env B at the same time (distinct
  `FREDO_ENV_ID`, `FREDO_DATA_DIR`, ports). From a clean shell probe each env's OWN endpoint for
  each named element: Vite server, Tauri app (MCP-bridge attach), MCP bridge, OTLP gRPC receiver,
  OTLP HTTP receiver, companion `llama-server`, and the `fredo` CLI path.
  **Expected:** every element in the named set is reachable independently for BOTH A and B through
  that env's own endpoint; A's and B's port sets are disjoint (no shared singleton). Coverage of
  the named set — not a literal count (G-271).
  **Edge:** one env's companion disabled → only that element absent for that env, other env
  unaffected; reversed start order; restart one env mid-run → its endpoints return on its own
  ports, other env untouched; a deliberately colliding port → fail-closed (F-4).

- [ ] **F-2 (AC2, data + identity isolation).** Send the SAME session ID to both A and B (per-env
  OTLP fixture / `fredo emit` into each env's receiver). Read each env's OWN PostgreSQL store
  (managed `psql` / the `telemetry-query` skill at that env's `ports.pg`; G-284/G-307). Capture each env's app/WebView
  identity (`tauri_driver_session status` + window label).
  **Expected:** A's DB holds exactly A's copy of the shared session id; B's DB holds exactly B's
  copy; zero rows/sessions in A carry B's env identity and vice-versa; A and B have distinct
  app/WebView identities. No row, session, or process bleeds across.
  **Edge:** identical session ID with different payloads per env; same `FREDO_DATA_DIR`
  misconfigured for both → fail-closed, never interleave; one env stopped mid-injection → the
  other's DB unaffected; retention eviction on one env → other env's rows intact.

- [ ] **F-3 (AC3, env-scoped lifecycle ownership).** Start A and B. Down A (manifest-scoped
  teardown, `dev-env.ps1 -Action Down -EnvId A`). Then seed A's OWN manifest (via the
  `FREDO_ENV_MANIFEST` override pointing under `.opencode/tmp/2944/`) with a STALE PID equal to B's
  live process PID and run A's clean/teardown again. Assert B's endpoints reachable, B's PIDs alive
  (`run-exitcode.ps1 -Command "Get-Process -Id <bPids>"`), B's DB intact, B's cache intact; assert
  no global image-name kill (`taskkill /IM fredo.exe|postgres.exe|node.exe`) is issued — B's live
  survival + a code-inspection pin.
  **Expected:** Down A leaves B running and reachable; the stale A PID never kills B;
  Clean/teardown acts ONLY on A's own process manifest; B's processes, DB, and cache are intact.
  No global image-name kill.
  **Edge:** stale PID reused by an unrelated live process → never killed; A's manifest
  corrupt/empty → teardown no-ops safely; A and B misconfigured to share a manifest → fail-closed,
  neither kills the other; teardown while B is mid-boot. **Induction lever:** F-7
  (`.opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever DecoyManifest`).

- [ ] **F-4 (AC4, env-aware MCP + fail-closed ports).** Start A and B; `tauri_driver_session start`
  against BOTH with explicit `appIdentifier`. Issue a webview/IPC tool call to each with explicit
  `appIdentifier` and assert each call lands in the intended env (observable: the env's window title
  `Fredo [<envId>]` / `FREDO_ENV_ID`).
  Then attempt to start B configured to A's already-occupied MCP port (`-McpPort <A's port>` /
  `FREDO_MCP_BASE_PORT=<A's port>`).
  **Expected:** both A and B connect; every MCP/webview/IPC call with an explicit `appIdentifier`
  targets the intended env with no default-app ambiguity; a port collision fails CLOSED with a
  named error — it does NOT silently fall back to another port or attach to the other env.
  **Edge:** a call with NO `appIdentifier` while two envs are connected → refused/ambiguous, never
  silently defaulted; collision on OTLP gRPC/HTTP and Vite ports → same fail-closed;
  `appIdentifier` given as the env's MCP port resolves to that env only; env torn down mid-call →
  named error, no cross-env fallback. **Induction lever:** F-8
  (`.opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever PortCollision`).

- [ ] **F-5 (AC5, env-tagged evidence + gates).** For each env inspect its evidence record and
  assert it carries each named element: environment ID, serving checkout path, served commit, DB
  path, endpoints/MCP port, and process manifest. Then write a forged evidence record
  (via `FREDO_EVIDENCE_FILE`) under `.opencode/tmp/2944/` that mislabels B's DB path/checkout as A
  and run the audit. Run the three gates.
  **Expected:** each env's evidence carries every named element (coverage of the set — not a
  literal count, G-271); the audit REJECTS evidence that cannot be attributed to the intended
  environment; `cargo check`, `pnpm --filter @fredo/ui build`, and `test-scripts.ps1` all pass.
  **Edge:** one named field missing → audit rejects; env-ID mismatch; evidence from a torn-down
  env; served commit ≠ checkout HEAD. **Induction lever:** F-9
  (`.opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever ForgedEvidence -RunAudit`).

- [ ] **F-6 (AC-E2E, MANDATORY human directive — Mission Monitor renders live sessions in the
  isolated env).** In an isolated env (A), boot the app and inject a Mission-Monitor-QUALIFYING
  session, then open Mission Monitor and confirm the session list AND graph render it. Qualifying
  row: a canonical `chat` row for a unique `e2e-<guid8>` sessionId with a non-empty assistant
  response (terminal, non-blank) — `fredo emit` classifies it into RTDB rows; a live Run CLI drive
  is the real-path alternative (G-256/G-088). Cross-check the env's own DB at the same instant.
  **Expected:** app boots in the isolated env; Mission Monitor's session list includes the
  qualifying session and the canvas renders ≥1 node (ChatNode / SubagentNode /
  `── TOOLS (N) ──`); the env's own DB returns the landed row for that session at the same
  instant. A static-only receipt = FALSE PASS.
  **Edge:** empty env → existing empty state, no cross-env row; the SAME session id injected in A
  and B → each MM shows only its own; subagent/composited session renders under its parent;
  console clean after injection (no `Maximum update depth exceeded`).

## Error-path induction rows (G-275)

These rows have no natural trigger: each one drives a committed, test-only lever under
`.opencode/tests/multi-env-isolation/error-path-levers.ps1` (levers are inert by default and write
only under `.opencode/tmp/2944/`). Run each through the allowlisted wrapper:
`powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/multi-env-isolation/error-path-levers.ps1 <args>"`.

- [ ] **F-7 (AC3 / R-3.1, R-3.3 — decoy manifest, stale-PID image guard).** Run
  `error-path-levers.ps1 -Lever DecoyManifest -Stage Run`. It starts a long-running `Start-Sleep`
  decoy (a stand-in for env B's live PID), writes `.opencode/tmp/2944/decoy-manifest.json` recording
  that PID under role `app`, and runs the target env's `dev-env.ps1 -Action Down` with
  `FREDO_ENV_MANIFEST` pointed at the decoy (set INSIDE the helper — G-279).
  **Expected:** Down exits 0; the teardown log shows `REFUSING to kill PID <n> ... role 'app' expects
  image 'fredo.exe' but live image is 'powershell.exe'`; the decoy PID is still alive
  (`DECOY_ALIVE=True`); `RESULT=PASS`. Pair with the static pin `-Lever NoImageKill` (no `/IM`).
  **FAIL:** the decoy is killed (cross-env kill), Down exits non-zero, or a PowerShell parse error
  means the teardown never ran (`DOWN_PARSE_ERROR=True`).

- [ ] **F-8 (AC4 / R-4.3 — bound-port collision fails closed, no scan).** Run
  `error-path-levers.ps1 -Lever PortCollision`. It binds the slot's Vite port with a `TcpListener`
  and runs `dev-env.ps1 -Action Up -Spec <probe> -EnvSlot 1 -VitePort <bound>` (bounded).
  **Expected:** `UP_EXITCODE != 0`; output contains `already bound` and `fail-closed (R-4.3)`; output
  does NOT contain `dev:tauri ready` / `already running` (no scan / no fallback); `RESULT=PASS`.
  **FAIL:** Up binds a different port, silently attaches, or reports ready.

- [ ] **F-9 (AC5 / R-5.2 — audit rejects forged evidence).** Run
  `error-path-levers.ps1 -Lever ForgedEvidence -RunAudit`. It writes
  `.opencode/tmp/2944/evidence-forged.json` (envId `spec2944` but B's checkout/DB path and a bogus
  `servedCommit`), sets `FREDO_EVIDENCE_FILE` INSIDE the helper (G-279), and runs
  `pipeline-state.rs --action audit --issue 2944`.
  **Expected:** audit output contains `ENV EVIDENCE REJECTED: serving checkout mismatch: ...`;
  `AUDIT_REJECTED=True`; `RESULT=PASS`.
  **FAIL:** the audit accepts the mismatched record.

## Non-functional

- [ ] **N-1 (boundedness, G-263):** every start/stop/teardown leg carries a finite wall-clock cap
  + hard-kill fallback (Up ≤ 180 s / `-TimeoutSecs`; Down ≤ 30 s). An observed unbounded wait is a
  FAIL, not a skip.
- [ ] **N-2 (zero cross-env contamination):** no row/session/DB bleed between A and B (F-2).
- [ ] **N-3 (zero cross-env kills):** no global image-name kill; B survives A's teardown (F-3).
- [ ] **N-4 (build gates):** `cargo check` zero warnings; `pnpm --filter @fredo/ui build` clean;
  `.opencode/scripts/test-scripts.ps1` all green (F-5).
- [ ] **N-5 (row-pipeline regression):** Mission Monitor renders from the RTDB row store in each
  env; emission remains ONLY via `EventBus.emit_row_delivery_batch` (F-6).
- [ ] **N-6 (no shared singleton):** ports/endpoints are the source of truth; A's and B's port
  sets stay disjoint (F-1).

## Suite-level pass/fail

PASS = F-1..F-9 all green and N-1..N-6 hold. Any cross-env bleed, any cross-env kill, a silent
port fallback, an unreachable named element, a missing named evidence field, a red gate, or an
unbounded wait = **FAIL**.
