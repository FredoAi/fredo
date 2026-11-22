# postgres-cluster-permission — Functional

Durable functional suite for the **cluster-directory permission recovery** feature domain of the
embedded-PostgreSQL supervisor: an existing-but-empty (or permission-refusing) cluster directory is
VACATED by rename so `initdb` creates it itself, and a residual refusal surfaces the typed
`dataDirPermissionDenied` cause + remedy. Seeded at issue **#3188**.

> **Revises #3180 — do NOT reopen it.** #3180 delivered the reinstall-safe cluster layout, the
> quarantine-by-rename recovery, the legacy carve-out and the typed `dataDirNotEmpty` cause. This
> suite EXTENDS that Postgres test family. The #3180 residue rows remain **byte-identical** in
> `.opencode/tests/postgres-lifecycle/functional.md` (`F-2`, `F-22`, `F-25`) and are LINKED — never
> restated — from `regression.md` here. Any edit to those three rows is out of scope for this suite.

> **Frozen contracts (do not re-derive, do not change):**
> - **`FREDO_PG_DATA_DIR` precedence:** a non-blank value resolves the cluster dir VERBATIM
>   (trimmed); a blank/whitespace-only value is INERT — a blank `-EnvVar "FREDO_PG_DATA_DIR="` is
>   UNSET, never a redirect. Below the override: legacy `<app>/postgres` IFF `postgresql.conf`
>   exists, else `<app>/postgres/cluster`.
> - **`FREDO_PG_CLUSTER_QUARANTINE_FAIL` residue semantics:** armed ⇒ a `Residue` dir yields the
>   typed refusal (`failureKind:"dataDirNotEmpty"`); inert ⇒ residue is quarantined by rename.
>   UNCHANGED by this feature.
> - **The FOUR existing failure kinds stay frozen:** `authMismatch`, `portInUse`,
>   `dataDirNotEmpty`, `unknown` (wire values). The only new member is `dataDirPermissionDenied`.
> - `PG_CLUSTER_SUBDIR = "cluster"`, `PG_REJECT_PREFIX = "cluster.rejected-"`,
>   `PG_CLUSTER_MARKER = "postgresql.conf"`.

> **Target platform note:** Windows is the target FILESYSTEM CLASS (the reported refusal is a
> Windows ACL denial), but the fix is cross-platform `std::fs` only — it MUST NOT add
> `#[cfg(target_os)]` gating, so non-Windows platforms do not regress. The rendered cause copy names
> "Windows" verbatim and is binding for this round.

> **Verification policy: LIVE.** AC-1, AC-2 and AC-4 are genuine runtime behaviours (a database
> reaching `state=ready`; a typed failure kind + rendered remedy; an injectable fault). AC-3 is live
> for its readiness legs. A static-only verdict on a live row is a **FALSE PASS**.

> **Live evidence this suite requires (a static-only PASS is REJECTED):**
> (a) a live `tauri_ipc_execute_command` result of `pg_supervisor_status` (or
> `tauri_webview_execute_js` → `__TAURI__.core.invoke('pg_supervisor_status')`) quoted verbatim with
> its `state` / `failureKind` / `dataDir` / `error`; (b) a live webview read of
> `[data-testid="health-line-postgres"]` (`webview_find_element` / `webview_dom_snapshot`) for the
> rendered cause+remedy; and (c) one genuine `telemetry_spans` query result for the row-pipeline
> regression row (Q-20). The release binary emits no OTel producer, so the live receipt for the DB
> rows is the webview/IPC receipt, not a span — a spans query is required for Q-20 only and must
> never be fabricated.

> **Evidence record rules.** The record is a **NON-DRAFT** artifact: the POSTED `## Tests Runs`
> comment on #3188 (carrying the quoted live payloads), the POSTED `## Developer ST-n —
> verification` comments, and the green CI run on the tested head SHA. Never a `.opencode/tmp/3188/`
> draft (the developer summary, the tests-runs draft, the triage plan or a fix plan), which the
> transition posts and then consumes (**G-415**). Fixtures under `.opencode/tmp/3188/<leg>/` are
> fixtures only — never the evidence record. Evidence frames are named only as an uploaded
> `https://github.com/user-attachments/...` URL; **no image file extensions in prose** (**G-104**).

> **G-263 SAFETY.** The #2948 ~11 h `pg.stop()` failure mode is named. Every boot is bounded by the
> declared PG bounds (control 180 s, setup 600 s, start 180 s, ready 60 s) and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Down`. Never a bare `postgres`/`pg_ctl`.
> An observed unbounded wait is a FAIL, not a skip.

## Verification rules (quoted from the plan — carry these into every run)

> **G-449 profile-shaping pre-flight** (applies to EVERY leg below that shapes a profile — Q-1, Q-3,
> Q-7, Q-9…Q-13): (1) record the served commit in the verdict. (2) Boot once with
> `FREDO_PG_DATA_DIR=<scratch>/preflight` (absent) and read the product's OWN
> `pg_supervisor_status.dataDir`; require it to equal that path exactly and to live under
> `.opencode/tmp/`. If it does not, or if any leg's boot reports `dataDir` equal to
> `%APPDATA%\com.fredo.app\postgres\cluster`, that leg is a SHARED-PROFILE leg: back that profile up
> first, restore it afterwards and verify byte-identity, or REFUSE the leg and report a
> shared-profile blocker (G-449). A blank `-EnvVar "FREDO_PG_DATA_DIR="` is UNSET, never a redirect —
> the env's isolation comes from `FREDO_DATA_DIR=<env-root>/data`, which the pre-flight must confirm
> from the product's `dataDir`.

> **G-451 observation window** (applies to every `-Action Up`): call
> `dev-env.ps1 -Action Up … -TimeoutSecs 600` and pass the executing tool an explicit window
> ≥ **660,000 ms** (the script's default wait is 120 s and the first cold `pnpm dev:tauri` build can
> exceed it). A call that ends at a phase marker with no `ready` line is a **CUT**, not a hang —
> re-drive with the window sized, never at the default.

> **Seam-arming rule (all three seams).** ARMED: the trimmed value is non-empty AND != `0` AND
> != `false` (ASCII case-insensitive). INERT: unset | `""` | `"   "` | `0` | `false` | `FALSE`.

> **G-275 / G-447 seam discipline.** The permission seam must be **INERT by default** (Q-7), and the
> armed leg's fixture survives from write to read: `dev-env -Action Up` creates only the env's own
> `<env-root>` dirs and never touches the `FREDO_PG_DATA_DIR` override path; `dev-env -Action Clean`
> DOES remove env artifacts, so do not run Clean between a fixture write and its boot (or re-create
> the fixture). An armed-seam boot returns Err from `ensure_initialisable` before `pg.setup()`, so
> nothing recreates the fixture. The observable only the armed seam can produce is
> `failureKind: "dataDirPermissionDenied"` together with **NO** `cluster.rejected-*` sibling; a leg
> that creates a sibling is a **FAILED DRIVE**, not a PASS.

## Cases

- [ ] **Q-1 (AC-1 / R-1a, R-1b) — Empty cluster dir on a first-run profile still reaches ready, vacated by rename.**
  Live: run the G-449 pre-flight, create an EMPTY `<scratch>/leg-a/postgres/cluster`, then
  `dev-env.ps1 -Action Up -Spec 3188 -EnvId 3188a -EnvSlot 1 -RequireIsolation -TimeoutSecs 600 -EnvVar "FREDO_PG_DATA_DIR=<scratch>/leg-a/postgres/cluster,FREDO_PG_INSTALL_DIR=<env-root>/postgres-install"`.
  **Expected:** `state:"ready"`; `dataDir` equals the emitted override path verbatim; `port` and
  `pid` populated; `failureKind` null; the parent `<scratch>/leg-a/postgres/` holds exactly ONE NEW
  entry matching `cluster.rejected-*`, and it is an EMPTY directory; the vacated path now holds
  `postgresql.conf`; the before/after parent listing proves nothing else was removed; elapsed within
  the declared bounds; 0 `postgres.exe` residue concerns while ready.
  **Edge:** A second boot on the same profile is R-3e (Q-13). If `ready` is reached but NO
  `cluster.rejected-*` sibling exists, the drain did not exercise the defect path — FAIL, never PASS.
  If `dataDir` is the shared profile the leg is refused under G-449.

- [ ] **Q-2 (R-1c / AC-3 no-delete) — only `Empty` is vacated; `Residue` still quarantines; `Cluster` untouched.**
  Live: a residue dir (`start.log` + `log/postgres.log`, no `postgresql.conf`) booted with the
  permission seam UNSET; a `PG_VERSION`-only dir; an initialised `Cluster` dir. Unit record: ST-1's
  `ensure_initialisable_vacates_empty_and_quarantines_residue`.
  **Expected:** Residue → `ready` with one `*.rejected-*` sibling holding both files BYTE-IDENTICAL;
  a `PG_VERSION`-only dir is still classified RESIDUE and quarantined (never treated as `Empty`); an
  initialised `Cluster` dir is never quarantined and gets no sibling; no path deleted.
  **Edge:** The new `Empty` branch must not swallow the residue class — a residue dir that reaches
  ready with no sibling is a FAIL.

- [ ] **Q-3 (AC-2 / R-2a + AC-4 / R-4a) — armed seam on an empty cluster dir yields the typed failure + remedy, touching nothing.**
  Live: an EMPTY `<scratch>/leg-b/postgres/cluster`; boot with
  `-EnvVar "FREDO_PG_DATA_DIR=<scratch>/leg-b/postgres/cluster,FREDO_PG_CLUSTER_PERMISSION_FAIL=1,FREDO_PG_INSTALL_DIR=<env-root>/postgres-install"`.
  **Expected:** `state:"failed"`; `failureKind:"dataDirPermissionDenied"` EXACTLY (not `null`, not
  `unknown`); `error` non-empty, `[setup]`-tagged, containing the remedy words "permission",
  "FREDO_PG_DATA_DIR", "restart Fredo" and "Nothing is removed"; `port` and `pid` null; the fixture
  dir is still present and still EMPTY; NO `cluster.rejected-*` sibling was created; the failure
  lands in seconds (well inside the setup bound); no lingering `postgres.exe` for this run.
  **Edge:** The paired control is Q-1/Q-7 (same shape, seam unset → ready + sibling). `failed` with
  `failureKind:"unknown"` or `null` is an AC-2 FAIL. Do not read readiness from a port alone.

- [ ] **Q-4 (AC-2 / R-2c) — the rendered Postgres health row carries the new cause + remedy.**
  Live: on the Q-3 boot focus `[data-testid="desktop-status-led"]`, wait ~300 ms, read
  `[data-testid="health-line-postgres"]` + the trigger's `aria-label` in ONE `webview_execute_js`
  call (the shipped #3180 F-25 one-shot recipe).
  **Expected:** Row `data-health-state="down"`; overall LED `down` (Postgres is mandatory); the row
  text carries ST-3's cause ("Windows is blocking Fredo from preparing the database folder.") and
  remedy (parent-folder modify permission OR `FREDO_PG_DATA_DIR`, then restart Fredo, "Nothing is
  removed."); the mono line equals `status.error` verbatim; the text never instructs a deletion.
  **Edge:** A bare `Down` with no cause/remedy while the raw payload carried the kind means the
  closed validator dropped the member (`postgresConfigStore.ts:133` / `useFredoHealth.ts:219`) —
  FAIL, and name which file.

- [ ] **Q-7 (R-4b / G-275 inert) — the permission seam is inert unset/blank/`0`/`FALSE`.**
  Unit: ST-1's `permission_fail_rule_is_inert_by_default_and_reads_the_lever` (env name pinned;
  `FALSE` case-insensitive). Live: the Q-1 boot with the seam UNSET, then a repeat boot on a fresh
  empty dir with `FREDO_PG_CLUSTER_PERMISSION_FAIL=0` — both reach ready and both create the vacate
  sibling.
  **Expected:** Unset, `""`, `"   "`, `0`, `FALSE` → normal vacate path (Q-1 semantics); `1`,
  `true`, `yes` → Q-3 semantics.
  **Edge:** A blank `-EnvVar "FREDO_PG_CLUSTER_PERMISSION_FAIL="` is UNSET, never armed. The two
  seam values are two SEQUENTIAL boots on ONE env.

- [ ] **Q-8 (R-4c) — one isolated env, sequential boots, one seam per boot.**
  Process: every live leg runs on the SAME `-EnvId` (`3188a`), ONE `Up` at a time, each `Up`
  carrying only that leg's `-EnvVar` set, `-Action Down` between legs.
  **Expected:** Each armed and inert leg has its own receipt; no second environment and no second
  filesystem; the seam is read at boot in the boot that declares it.
  **Edge:** Two concurrent envs for one issue is refused by the env lease (R-3.4) — do not attempt
  it.

- [ ] **Q-9 (R-3a / AC-3 clean) — a clean profile reaches ready on the DEFAULT layout.**
  Live: `-Action Clean -EnvId 3188a` (no `-EnvVar`), then Up with `-EnvVar "FREDO_PG_DATA_DIR="`
  (blank = unset) + the install dir; run the G-449 pre-flight on this same boot.
  **Expected:** `state:"ready"`; `dataDir` ends `postgres\cluster` and is under
  `.opencode/tmp/envs/3188a/`; `port` and `pid` populated; a repeat boot reuses it with no new
  sibling.
  **Edge:** If `dataDir` equals `%APPDATA%\com.fredo.app\postgres\cluster`, refuse the leg (or back
  up/restore byte-verified) and report a shared-profile blocker — never treat the blank override as
  a redirect.

- [ ] **Q-10 (R-3b / AC-3 dirty) — leftover `start.log` + stale lock recovers by rename with no deletion.**
  Live: seed `<scratch>/leg-dirty/postgres/cluster/start.log` (any bytes) and
  `<scratch>/leg-dirty/lock/postgres.lock` (garbage + non-running PID e.g. `4000000`); boot with
  `FREDO_PG_DATA_DIR=<scratch>/leg-dirty/postgres/cluster,FREDO_PG_LOCK_DIR=<scratch>/leg-dirty/lock,FREDO_PG_INSTALL_DIR=<env-root>/postgres-install`.
  **Expected:** `state:"ready"`; one `cluster.rejected-<ts>` sibling holds the seeded `start.log`
  with UNCHANGED bytes; the lock file is replaced/cleared; no manual delete step anywhere in the
  drive transcript.
  **Edge:** The SAME residue with `FREDO_PG_CLUSTER_QUARANTINE_FAIL=1` must still be `failed` +
  `failureKind:"dataDirNotEmpty"` (Q-6). Never leave a seam from a previous leg armed.

- [ ] **Q-11 (R-3c / AC-3 legacy) — a legacy cluster at `<app>/postgres` is used as-is.**
  Live: boot once, `save_setting` `llama_server_backend=cpu`, Down, copy the initialised cluster to
  `<scratch>/legacy-data/postgres/`, boot with `FREDO_DATA_DIR=<scratch>/legacy-data` + blank
  `FREDO_PG_DATA_DIR`.
  **Expected:** `state:"ready"`; `dataDir` equals `<scratch>/legacy-data/postgres` (NOT
  `…/cluster`); `postgresql.conf` present with its pre-copy byte length;
  `get_setting('llama_server_backend') === 'cpu'` (initdb did not run); no `*.rejected-*` for a valid
  cluster.
  **Edge:** A `PG_VERSION`-only directory at that path is NOT a cluster → the boot is fresh at
  `<app>/postgres/cluster` (crate-predicate parity).

- [ ] **Q-12 (R-3d / AC-3 override) — `FREDO_PG_DATA_DIR` still wins verbatim (trimmed).**
  Live: boot with `FREDO_PG_DATA_DIR=<scratch>/leg-override/pgdata` → `dataDir` equals that path
  exactly. Unit: the committed pin `resolve_cluster_dir_covers_absent_residue_and_legacy_layouts`
  (trim + blank-is-inert).
  **Expected:** Verbatim resolved path returned by the product; leading/trailing whitespace trimmed;
  a blank/whitespace-only value is inert.
  **Edge:** Re-derive precedence from the product's `dataDir` read, never from the environment
  variable.

- [ ] **Q-13 (R-3e / AC-3 reuse) — an already-initialised dedicated cluster is reused.**
  Live: the SECOND boot of Q-1 on the same profile.
  **Expected:** `state:"ready"`; the SAME `dataDir`; NO new `cluster.rejected-*` sibling;
  `postgresql.conf` unchanged.
  **Edge:** A second sibling on an initialised cluster is a FAIL (an initialised cluster must never
  be quarantined).

- [ ] **Q-20 (regression / row pipeline) — the RTDB row pipeline still works after the change.**
  Live: on a `ready` boot, drive ONE real OTLP-producing action (a live agent turn / Run CLI — never
  `fredo emit`, G-256) and query `telemetry_spans` for that session at the same instant; open
  Mission Monitor.
  **Expected:** The app boots to ready; Mission Monitor renders the live session/tools/tokens;
  `telemetry_spans` returns the landed rows for that session.
  **Edge:** The release binary emits no OTel producer, so this row is DEV-env only. A static-only
  receipt here is a FALSE PASS.

## Suite-level pass/fail

PASS = every live functional row above observed green on the named surface (quoted
`pg_supervisor_status` payload + rendered `[data-testid="health-line-postgres"]` read), plus a
genuine `telemetry_spans` result for Q-20.

Automatic FAIL: any `failureKind` of `unknown` or `null` on Q-3; any deleted directory or file on
Q-1/Q-2/Q-10; a `ready` without the vacate sibling on Q-1 (a FAILED DRIVE, never PASS); a `dataDir`
equal to the shared `%APPDATA%` profile without a byte-verified backup/restore (or refusal) (a
FAILED DRIVE); a static-only verdict on a live row (a FALSE PASS).
