# env-isolation — Functional

Durable functional suite for **dev/test-round isolation from the shared
`%APPDATA%\com.fredo.app` PostgreSQL cluster** (issue #3066). One `- [ ]` case per
requirement (R-1..R-5 + sub-clauses), observable expected outcome per case.
**Negative / error paths (AC2/AC3) come first.**

> **Verification policy: LIVE** — AC4 is provable only on a RUNNING app
> (`pg_supervisor_status` → `Ready`, `failureKind != authMismatch`) and R-5a is a
> process-table observation. The guard rows are additionally pinned statically, but a
> static-only PASS is a **FALSE PASS** — the testing exit gate and audit fail-closed on it.

> **Names BOUND to the Architect's Names Block (G-255).** Guard-only action
> `dev-env.ps1 -Action AssertIsolation` (exit 0 allowed / 3 refused); switch
> `-RequireIsolation`; env flag `FREDO_REQUIRE_ENV_ISOLATION`; test seam
> `FREDO_SHARED_APPDATA_DIR` (default `$env:APPDATA\com.fredo.app`); identities
> `SharedAppDataDir`/`SharedPgDataDir`; refusal codes `shared-dir`/`sentinel-seam`;
> refusal exit `3`; message prefix `ISOLATION REFUSED (<code>):`; audit file
> `.opencode/state/env-isolation.jsonl` (`decision` ∈ {`refused`,`isolated`}); refused seams
> `FREDO_PG_PASSWORD_FILE`/`FREDO_PG_KEYCHAIN_DISABLED`; new `verify-env-isolation.ps1`
> violation string `is the SHARED cluster dir`; levers
> `.opencode/tests/env-isolation/error-path-levers.ps1 -Lever <name>`.

> **SANDBOX SAFETY (G-172/G-275).** The REAL shared dir `%APPDATA%\com.fredo.app` is
> OUT-OF-REPO and **DENIED** to every agent. Every row drives the FIXTURE identity
> (`FREDO_SHARED_APPDATA_DIR` = a dir under `.opencode/tmp/3066/`, set INSIDE the lever —
> G-279). **No row requires reading the real shared cluster or its `postgres.log`.**
> G-263: every start/stop leg is time-bounded; never a bare `postgres`/`pg_ctl`.

## Cases

- [ ] **F-1 (R-2 / AC2 — shared-dir refusal, legacy).**
  `error-path-levers.ps1 -Lever SharedDirRefusal` sets `FREDO_SHARED_APPDATA_DIR` = fixture
  shared dir and `FREDO_DATA_DIR` = that same fixture dir, then runs
  `dev-env.ps1 -Action AssertIsolation -RequireIsolation` (legacy — no
  `-EnvId`/`-EnvSlot`/`-ServingCheckout`).
  **Expected:** exit **3**; stdout contains `ISOLATION REFUSED (shared-dir):`; the last
  `.opencode/state/env-isolation.jsonl` line has `decision=refused`,`code=shared-dir`; NO
  PostgreSQL started. `RESULT=PASS`.
  **Edge:** dir EQUAL to shared; a SUBDIR under shared; PG data dir under shared while
  app-data dir is not; different CASE (`%appdata%`); trailing separator; `..` traversal; 8.3
  short name; a prefix-lookalike (`…\com.fredo.app-other`) must NOT refuse.
  **FAIL:** any non-3 exit, a generic error, a silent fallback dir/port, or a PG start.

- [ ] **F-2 (R-2a / AC2 — legacy + marker).**
  `dev-env.ps1 -Action AssertIsolation -RequireIsolation` in LEGACY mode (no env flags) with
  `FREDO_SHARED_APPDATA_DIR` = the fixture shared dir.
  **Expected:** exit **3**, `ISOLATION REFUSED (shared-dir):`, `refused`/`shared-dir` audit
  line. `RESULT=PASS`.
  **Edge:** `FREDO_REQUIRE_ENV_ISOLATION=1` refuses identically;
  `FREDO_REQUIRE_ENV_ISOLATION=0`/`false`/blank ⇒ guard NOT armed (legacy unchanged, R-1).
  **FAIL:** the marker is ignored in legacy mode.

- [ ] **F-3 (R-2b / AC2 — env-mode redirected).**
  In env mode WITHOUT `-RequireIsolation`, redirect the resolved dir to the fixture shared
  dir: (a) `-EnvVar "FREDO_DATA_DIR=<fixture shared>"`; (b) `$env:FREDO_ENV_ROOT=<fixture
  shared>` (⇒ `$PgDataDir=<fixture shared>\postgres`); (c) `FREDO_PG_DATA_DIR=<fixture
  shared>\postgres`. Run `dev-env.ps1 -Action AssertIsolation -EnvId spec3066 -EnvSlot 1`.
  **Expected:** each redirect → exit **3**, `ISOLATION REFUSED (shared-dir):`, `refused`
  audit — because env mode ARMS the guard and the RESOLVED dirs are compared (not
  `$IsEnvMode`). `RESULT=PASS`.
  **Edge:** the refusal fires even with `-RequireIsolation` absent; a legit env root under
  `.opencode/tmp/envs/` must NOT refuse (see F-5). **FAIL:** env-mode shared dir allowed.

- [ ] **F-4 (R-3 / AC3 — sentinel seam refused at shared dir).**
  `error-path-levers.ps1 -Lever SentinelRefusal`: `FREDO_SHARED_APPDATA_DIR` = fixture
  shared, `FREDO_DATA_DIR` = fixture shared, AND `FREDO_PG_PASSWORD_FILE` = an in-repo
  fixture sentinel file; run `dev-env.ps1 -Action AssertIsolation -RequireIsolation`.
  **Expected:** exit **3**; stdout contains `ISOLATION REFUSED (sentinel-seam):` naming the
  seam; audit `decision=refused`,`code=sentinel-seam`, `seams` contains the seam; NO
  `initdb`/PG start. `RESULT=PASS`.
  **Edge:** `FREDO_PG_KEYCHAIN_DISABLED` set instead of/in addition to the sentinel ⇒ same
  refusal; seam via `-EnvVar` vs inherited process env; a BLANK seam value ⇒ seam NOT "set"
  (no refusal); the refusal precedes any PG start (F-11). **FAIL:** a seam is accepted at the
  shared dir.

- [ ] **F-5 (R-3a / AC3 — ALLOWED control; keeps F-4 non-vacuous).**
  `error-path-levers.ps1 -Lever IsolatedControl`: `FREDO_SHARED_APPDATA_DIR` = fixture
  shared, `FREDO_ENV_ROOT` = `.opencode/tmp/3066/env-root`, the sentinel
  `FREDO_PG_PASSWORD_FILE` SET, then `dev-env.ps1 -Action AssertIsolation -EnvId spec3066
  -EnvSlot 1` (resolved dir is the env root, NOT the fixture shared dir).
  **Expected:** exit **0**; audit `decision=isolated` with the env-root resolved dirs;
  `SEAMS_ALLOWED=True` (the #3005 isolated-env pattern — both seams stay usable off the
  shared dir). `RESULT=PASS`.
  **FAIL:** a refusal here means F-4 is vacuous (the guard refuses the seam
  unconditionally) — a plan defect.

- [ ] **F-6 (R-1 / AC1 — isolated round).**
  Bounded full round: `dev-env.ps1 -Action Up -Spec 3066 -EnvId spec3066 -EnvSlot 1
  -RequireIsolation` (≤ 180 s / `-TimeoutSecs`), torn down with
  `dev-env.ps1 -Action Down -EnvId spec3066`.
  **Expected:** the round's manifest + evidence record data dirs under
  `.opencode/tmp/envs/spec3066/`; the env's own PG cluster answers on its own `ports.pg`;
  the audit carries `isolated`. The shared cluster is NOT touched (proven by F-9's
  post-round Ready). `RESULT=PASS`.
  **Edge:** `FREDO_ENV_ROOT` override honored; `-EnvVar FREDO_DATA_DIR=<env-root>/data`
  honored; no fallback to the shared dir/ports.

- [ ] **F-7 (R-1a / AC1 — env-mode inject + audit).**
  `dev-env.ps1 -Action AssertIsolation -EnvId spec3066 -EnvSlot 1` (guard-only; no PG/app
  launch) with the default shared identity.
  **Expected:** exit **0**; an `isolated` audit record with
  `resolvedAppDataDir`/`resolvedPgDataDir` under the env root and `sharedAppDataDir` = the
  shared identity. `RESULT=PASS`.
  **Edge:** `-EnvSlot` ≥ 1 and `-EnvId`-only both resolve to the env root; a resolved dir
  equal-or-under shared ⇒ must refuse (F-3).

- [ ] **F-8 (R-1b / AC1 — verify-env-isolation shared-root violation).**
  `error-path-levers.ps1 -Lever SharedRootViolation`: writes a fixture manifest
  (`.opencode/tmp/3066/fixture-manifest.json`, `dataDir` = the fixture shared dir) and runs
  `verify-env-isolation.ps1 -ManifestPath <fixture>` with `FREDO_SHARED_APPDATA_DIR` =
  fixture shared.
  **Expected:** exit **1**; stdout contains the new violation string `is the SHARED cluster
  dir`; the checker stays READ-ONLY (no kill/bind/start). `RESULT=PASS`.
  **Edge:** the fixture manifest is passed explicitly so it is `Explicit` ⇒ in the `$active`
  set; an isolated env root ⇒ no violation (exit 0). **FAIL:** the checker misses a
  shared-root env or mutates anything.

- [ ] **F-9 (R-4 / AC4 — password intact after a round).**
  AFTER a completed round (F-6), run a **NON-ROUND** launch: `dev-env.ps1 -Action Up -Spec
  3066` in LEGACY mode — no `-EnvId`/`-EnvSlot`/`-ServingCheckout`, no `-RequireIsolation`,
  no `FREDO_REQUIRE_ENV_ISOLATION` (the human's manual run, not a guarded round). Then
  `tauri_ipc_execute_command command="pg_supervisor_status"`.
  **Expected:** `state == "ready"` AND `failureKind == null` (never `authMismatch`). A plain
  boot against an EXISTING cluster is a `setup()` no-op, so this observation launch does not
  itself re-password the cluster. `RESULT=PASS`.
  **Substitute (G-375/G-307, disclosed):** the raw
  `%APPDATA%\com.fredo.app\postgres\log\postgres.log` read is DENIED (out-of-repo) — the
  app's own status IS the AC4 observable. **FAIL:** `failureKind == authMismatch` or
  `state == failed`. Prefer `-Action Down` (legacy) first so the observation launch does not
  collide on 5174/9223.

- [ ] **F-10 (R-5 / AC5 — env-scoped teardown, no global kill).**
  `error-path-levers.ps1 -Lever NoGlobalImageKill` — static leg: assert `dev-env.ps1`'s env
  teardown path (`Stop-EnvManifest`) contains NO global image-name kill (`/IM`) and that the
  manifest teardown + image guard are present. Live leg: after a `SharedDirRefusal` run,
  assert no `postgres.exe` was spawned under the fixture shared dir.
  **Expected:** `IMAGE_KILL_PRESENT=False`, `MANIFEST_TEARDOWN_PRESENT=True`,
  `IMAGE_GUARD_PRESENT=True`, `POSTGRES_SPAWNED=False`. `RESULT=PASS`.
  **Edge:** teardown acts only on manifest PIDs, tree-killed (`taskkill /PID <pid> /T [/F]`);
  a stale PID reused by a foreign image is never killed (multi-env F-7 precedent).

- [ ] **F-11 (R-5a / AC5 — no postgres.exe on refusal).**
  Reuse the `SharedDirRefusal` run (and the `SentinelRefusal` run); assert neither refusal
  leg spawned a `postgres.exe` (the guard exits BEFORE `setup`/`start`).
  **Expected:** `PG_SPAWNED=False`; the fixture shared dir contains no `postgres` data dir.
  `RESULT=PASS`.
  **Edge:** both refusals precede PG start. The REAL shared dir is denied — the fixture
  identity is the only in-repo observable (disclosed).

- [ ] **F-12 (R-5b / AC5 — no `/IM` on the env teardown path).**
  Static pin via `-Lever NoGlobalImageKill`: read `.opencode/scripts/dev-env.ps1`, assert no
  `/IM` token on the env-scoped teardown path and that `Stop-EnvManifest` +
  `Test-RoleImageMatch` exist.
  **Expected:** `IMAGE_KILL_PRESENT=False`, `MANIFEST_TEARDOWN_PRESENT=True`,
  `IMAGE_GUARD_PRESENT=True`. `RESULT=PASS`.
  **Edge:** the legacy path kills by port owner only (also no `/IM`) — assert the whole file
  has no `/IM` used as an image kill.

## Error-path induction rows (G-275 — lever map)

Run each through the allowlisted wrapper:
`powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/env-isolation/error-path-levers.ps1 <args>"`.

| Row | Lever | Induces |
|-----|-------|---------|
| F-1, F-11 | `-Lever SharedDirRefusal` | `shared-dir` refusal (exit 3) + no PG spawn |
| F-2, F-3 | (direct `AssertIsolation` / `-EnvVar` redirect) | legacy + env-mode shared-dir refusal |
| F-4 | `-Lever SentinelRefusal` | `sentinel-seam` refusal (exit 3) |
| F-5, F-7 | `-Lever IsolatedControl` | isolated-env ALLOWED control (exit 0) |
| F-10, F-12 | `-Lever NoGlobalImageKill` | static `/IM` pin + live no-PG-spawn |
| F-8 | `-Lever SharedRootViolation` | `verify-env-isolation.ps1` exit 1 |

## Non-functional

- [ ] **N-1 (guard OFF ⇒ byte-identical legacy):** with `-RequireIsolation` unset and no
  `FREDO_REQUIRE_ENV_ISOLATION`, legacy `Up`/`Down`/`Status`/`Logs` are unchanged — no new
  required arg, no refusal, no new side effect on the human's manual run.
- [ ] **N-2 (no global image kill):** no `/IM` on the env teardown path (F-12).
- [ ] **N-3 (script gates):** `.opencode/scripts/test-scripts.ps1` all green on the SERVED
  `spec/3066` tree (G-305), including the new static pins.
- [ ] **N-4 (path-only, fail-closed):** the guard reads path strings only; never reads/writes
  the shared cluster dir; every refusal exits BEFORE any PG start; never falls back to another
  dir/port.
- [ ] **N-5 (path identity):** `GetFullPath` + case-insensitive compare handles
  equal/under/subdir/trailing-separator/`..`/short-name; a prefix-lookalike is NOT the shared
  dir.
- [ ] **N-6 (audit append-only):** `.opencode/state/env-isolation.jsonl` is append-only, one
  JSON object per line, `decision` ∈ {`refused`,`isolated`}; never rewritten/truncated.

## Suite-level pass/fail

PASS = F-1..F-12 all green and N-1..N-6 hold. Any shared-dir or sentinel seam accepted, any
refusal that proceeds / falls back / starts PG, a vacuous F-5 control, a `authMismatch` on
the AC4 observation, a global image kill, a missing audit record, or a red gate = **FAIL**.
