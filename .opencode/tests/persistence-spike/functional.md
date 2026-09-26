# persistence-spike — Functional

Feature: evaluation of embedded PostgreSQL (`theseus-rs/postgresql-embedded`) vs embedded
SQLite for Fredo local persistence. Issue #2948 (SPIKE — deliverable is a measured
decision, no production code).

Verification policy: **static** — evidence is captured PoC/benchmark command output plus
committed artifact files. There is no telemetry/span/event/UI surface for this feature, so
NO `telemetry_spans` evidence applies.

**Honest-unknown rule:** `unknown` + a named blocking factor is PASS-eligible ONLY for F-2
(AC2) and F-3 (AC3). F-1 (AC1) and F-5 (AC5) have no "unknown" escape. A `no-go` or
`conditional-go` recommendation from honest evidence is a PASS for F-4.

Required artifact paths are a hard dependency — the Developer/Architect commits: PoC source
+ run script, reproducible-steps doc, raw numbers file, 9-question answer set, decision
record. All must be committed on the spec branch (`.opencode/tmp/` is gitignored and is
NOT evidence).

## Cases

- [ ] **F-1 (AC1) — PoC runs embedded PostgreSQL on Windows and does a write+read.**
  From a clean checkout on the win32/WebView2 host, run the PoC command EXACTLY as written
  in the committed reproducible-steps doc (no undocumented manual steps). Capture
  stdout/stderr + exit code.
  **Expected:** exit 0; output shows a write (INSERT/UPSERT) then a read (SELECT) returning
  the **byte-equal value just written**; steps doc names the exact command, working dir,
  prerequisites. **FAIL** if it needs a pre-existing server, an undocumented action, or the
  read value ≠ written value. **No "unknown" escape.**
  Test data: a known round-trip value (include one non-ASCII string). Edge: first-run
  binary download (record success/failure + network needed), port already bound,
  Defender/firewall prompt, stale data dir (cold vs warm), re-run idempotency.

- [ ] **F-2 (AC2) — measured deltas are NUMBERS.**
  Open the committed raw-numbers file; per metric grep value + unit; re-run the committed
  benchmark command to confirm the numbers were produced.
  **Expected:** each of (1) install/binary-size delta (bytes/MB), (2) cold-start latency
  delta (ms), (3) memory footprint (MB/RSS), (4) disk footprint (MB) is EITHER a number OR
  literal `unknown` + named blocking factor; each PG value has its SQLite baseline recorded
  alongside. **FAIL** = adjective-only ("small"/"comparable"), silently absent metric, delta
  with no baseline, bare `N/A`/`unknown` with no reason.
  Test data: baseline + PG numbers measured in the same session. Edge: cold vs warm cache,
  per-run variance (≥2 runs), downloaded vs on-disk-extracted size (state which).

- [ ] **F-3 (AC3) — all 9 questions answered or explicitly unknown.**
  Enumerate entries in the questions/decision artifact.
  **Expected:** exactly 9 entries — packaging; process lifecycle; startup latency;
  port/socket; Windows feasibility; migration path/rollback; which workloads
  benefit/regress; operational/backup/security/licensing; crate health. Each is a
  substantive answer with evidence OR literal `unknown` + named blocking factor.
  **FAIL** = any missing/blank, `unknown` without reason, or two collapsed into one.
  Edge: assertion without evidence; crate health legitimately `unknown` if network-blocked;
  benefit/regress must name both sides.

- [ ] **F-4 (AC4) — decision record is decisive and linked.**
  Open the decision record (a linked artifact, not issue-comment-only).
  **Expected:** (1) explicit token `go`/`no-go`/`conditional-go`; (2) effort S/M/L or
  points; (3) prioritized risk list (ordered, each with impact + mitigation/accepted-risk);
  (4) explicit sentence that **no production migration occurred**; (5) reachable relative
  link from the plan/issue. **FAIL** = vague recommendation, missing effort, unordered
  risks, or missing no-production statement. Edge: `conditional-go` must name conditions;
  points must name the scale.

- [ ] **F-5 (AC5) — negative case: no production impact.**
  (a) `cargo check` in `apps/tauri/src-tauri`; (b) `pnpm --filter @fredo/ui build`;
  (c) inspect spec-branch diff vs `main`.
  **Expected:** (a) zero errors AND zero warnings; (b) exit 0, zero TS errors; (c) diff
  touches NO production persistence path — `infrastructure/storage/*`,
  `infrastructure/rtdb/*`, observability/`sqlx` + `telemetry_spans` code, RTDB row wire
  types (`RowDelivery`/`RowDeliveryBatch`), `fredo.db` schema/migrations; PoC isolated
  (e.g. `spikes/…`), not a member of the production workspace, deps not added to
  `apps/tauri/Cargo.toml`. **FAIL** = any production file changed, PoC wired into
  `AppRuntime`, or either build red. **No "unknown" escape.**
  Edge: crate accidentally added to root workspace; PG dep leaked into app manifest;
  `cargo check` warning; formatting-only production edit still counts as changed.

## Suite-level pass/fail

PASS overall = F-1 + F-5 fully green, F-2 + F-3 + F-4 green-or-honest-unknown-with-reason.
Any F-1/F-5 escape attempt, non-reproducible numbers, uncommitted/missing artifacts, or
production-path change = FAIL.
