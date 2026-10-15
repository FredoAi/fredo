# env-isolation — Regression

> "Must not change" baseline for the dev/test-round isolation guard (#3066). These
> invariants MUST hold after the change — any FAIL is a regression. Run on every testing
> phase that touches `dev-env.ps1`, `verify-env-isolation.ps1`, the shared-cluster
> resolution, or the round process rules.
>
> **Verification policy: live** — the legacy-boot and post-round-ready invariants are only
> observable on a running app; the Tester's Evidence MUST carry a live receipt
> (`pg_supervisor_status` on a non-round legacy launch / a legacy `Up` readiness) for a live
> verdict. A static-only PASS is a FALSE PASS.
>
> **G-263 SAFETY:** every live leg is time-bounded and torn down via the `dev-env.ps1`
> lever. Never an unbounded run; never a bare `postgres`/`pg_ctl`.

## Must NOT change (regression invariants)

- [ ] **R-1 (guard OFF ⇒ byte-identical legacy).** With `-RequireIsolation` unset and
  `FREDO_REQUIRE_ENV_ISOLATION` unset, the legacy single-env path
  (`dev-env.ps1:1382-1392` + the legacy action arms) is unchanged: `-Action Up -Spec <N>`
  on default ports (Vite 5174 / MCP 9223 / OTLP 4317+4318 / llama 8080), `-Action
  Status`/`Down`/`Logs` behave as before, and no refusal/audit-only side effect is added to
  the human's manual run. **FAIL:** the default path now requires a new arg, refuses, or its
  ports/strings change.

- [ ] **R-2 (env-mode port/data resolution unchanged).** `dev-env.ps1:1317-1356` — `-EnvSlot
  n≥1` → base `16000 + 10*(n-1)`; `-EnvId`-only resolves to `<repo>/.opencode/tmp/envs/<id>`;
  `$env:FREDO_ENV_ROOT` override honored; `FREDO_DATA_DIR` defaults to `<env-root>/data`;
  `$PgDataDir = <env-root>/postgres`. The guard is ADDITIVE and read-only — it changes none
  of this. **FAIL:** any resolution hunk.

- [ ] **R-3 (collision gate unchanged).** The env-mode fail-closed port-collision gate still
  refuses a bound port (never scans/falls back). **FAIL:** a collision is silently absorbed
  or the gate is loosened. (Lever precedent:
  `.opencode/tests/multi-env-isolation/error-path-levers.ps1 -Lever PortCollision`.)

- [ ] **R-4 (`-EnvVar` semantics unchanged).** `-EnvVar` is still applied BEFORE port
  resolution (`dev-env.ps1:1295-1299`) and honored/recorded. **FAIL:** the seam is applied
  later, dropped, or its precedence changes.

- [ ] **R-5 (`Stop-EnvManifest` unchanged).** `dev-env.ps1:885-962` — PID-scoped,
  image-guarded (`Test-RoleImageMatch`), tree-killed (`taskkill /PID <pid> /T [/F]`), bounded
  (G-263), NO `/IM`. **FAIL:** any teardown hunk, a global image kill, or a lost image guard.
  (Lever: `.opencode/tests/env-isolation/error-path-levers.ps1 -Lever NoGlobalImageKill`.)

- [ ] **R-6 (`verify-env-isolation.ps1` cross-env checks unchanged).** The cross-env
  data-root/port/PID checks (`:316-344`), the exit-code contract (0 OK / 1 violation), and
  the `-Summary` line shape are unchanged; the ST-3 shared-root check is ADDITIVE. **FAIL:**
  an existing check is altered, or the summary line shape changes.

- [ ] **R-7 (script gates).** `.opencode/scripts/test-scripts.ps1` all green on the SERVED
  `spec/3066` tree (G-305); the new static pins (guard function present; `AssertIsolation` in
  the `ValidateSet`; no `/IM`) pass. **FAIL:** any red gate.

- [ ] **R-8 (no product-code change).** This is a tooling/process slice — no Rust/TS hunk, no
  new credential mechanism, no edit to `AGENTS.md`/`opencode.json` (human-owned). **FAIL:**
  any product-code or human-owned-file change.

- [ ] **R-9 (AC4 standing invariant — shared cluster boots Ready).** After the change, a
  non-round legacy launch still boots the app against the shared cluster to
  `pg_supervisor_status.state == "ready"` with `failureKind == null`. This is functional F-9
  mirrored as a standing invariant. **FAIL:** `authMismatch`/`failed`.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-10:** inherit and run `.opencode/tests/multi-env-isolation/regression.md` — the
  env-mode port/data/manifest/teardown surface this guard must not disturb.
- [ ] **R-11:** inherit and run `.opencode/tests/postgres-lifecycle/regression.md` — the PG
  supervision / credential / no-orphan invariants.
- [ ] **R-12:** inherit and run `.opencode/tests/pipeline-hygiene/regression.md` — the
  pipeline process rules this slice extends (ST-4).

## Notes

- Out of scope (do NOT assert): guarding a running app's own postgres-UI reset
  (`pg_database_reset`) — that is product-code scope (a PO decision), not this tooling slice.
- The G-328 `Restart`-drops-`-EnvSlot` defect is NOT fixed here; ST-4 forbids `Restart` for
  isolated envs (use explicit `Down` then `Up`).
- This suite is reusable by any later spec that touches dev-env instance management, the
  shared-cluster resolution, or the round process rules.
