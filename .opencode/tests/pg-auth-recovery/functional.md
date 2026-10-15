# pg-auth-recovery — Functional

Durable functional suite for the **embedded-PostgreSQL `AuthMismatch` recovery affordance** feature
domain: the app-level, non-modal recovery banner (visible without opening Settings → Database) that
offers a one-click, confirmation-gated `Reset database`, plus the `WHILE Failed` log-flood back-off.
Seeded at issue **#3067**. Inherited by every later slice that touches the PG supervisor's
failure-kind surface, the app-shell banner host, or the storage-unavailable error emitters.

> **Verification policy: LIVE** — every AC is provable only by observing the running app: a
> `tauri_webview_*` DOM/screenshot receipt (F-1..F-4) or an app-log line-count window + a
> `telemetry_spans` result (F-5). A static-only PASS is a FALSE PASS; the testing exit gate and
> audit fail-closed without a genuine live receipt.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** Every external-runtime
> start (the app dev instance AND the postmaster) MUST be bounded and torn down through
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up|Down -Spec 3067 -EnvId spec3067 -EnvSlot 1 -RequireIsolation`.
> Never a hand-rolled `pnpm dev:tauri` spawn, never a bare `postgres`/`pg_ctl`. The legacy shared
> `%APPDATA%\com.fredo.app` path is FORBIDDEN for rounds (fails closed, exit 3); `Restart` is
> forbidden for isolated envs (G-328) — recover with `Down` then `Up`.

> **Induction levers (all in-repo, G-275/G-300):**
> - **LEVER-A `authMismatch` (one-launch, ST-1):** `-EnvVar "FREDO_PG_FORCE_AUTH_MISMATCH=1"` →
>   `Failed`/`authMismatch` at boot. NOT usable for a reset→ready leg (the forced probe keeps
>   failing after `restart_cluster` — use it for the reset-ERROR path).
> - **LEVER-B real drift that reset HEALS (two-launch; `postgres-config` F-3 precedent):**
>   `.opencode/tmp/3067/pw-a.txt` / `pw-b.txt`; boot with `FREDO_PG_PASSWORD_FILE=<pw-a>` → initdb
>   seeds A → `ready`; `Down`; boot with `<pw-b>` → `28P01` → `Failed`/`authMismatch`; reset re-inits
>   + re-probes with the same resolved password (B) → `ready`.
> - **LEVER-C `portInUse`:** pin a busy loopback port (`9223`/`4318`) in the isolated env's
>   `<app-data-dir>/postgres-supervisor.json` and hold it, or pin via Settings→Apply.
> - **LEVER-D `unknown`:** `-EnvVar "FREDO_PG_FORCE_START_FAIL=1"`.

## Cases

- [ ] **F-1 (R-1 / AC1) — banner appears in the app shell, no Settings opened.**
  Boot with LEVER-A. Open NO window and do NOT open Settings. Snapshot
  `tauri_webview_dom_snapshot(type="structure")` and `tauri_webview_find_element('[data-testid="pg-recovery-banner"]')`.
  **Expected:** `pg-recovery-banner` renders at the `Home` shell level within ≤ 1×`PG_STATUS_POLL_MS`
  (3 s) after boot; `pg-recovery-banner-title` names the credential mismatch; `pg-recovery-banner-reset`
  is present, enabled, and reads `Reset database…`; the banner is non-modal (`role="status"`, no
  backdrop, no focus trap). **FAIL** = the banner is absent, appears only inside Settings, or is modal.

- [ ] **F-2 (R-2 / AC2) — confirm reset → `pg_database_reset` → `ready` → banner clears.**
  Induce with **LEVER-B**. Confirm the banner; click `pg-recovery-banner-reset` →
  `pg-recovery-banner-reset-dialog` → tick `pg-recovery-banner-reset-ack` → click
  `pg-recovery-banner-reset-confirm`. Capture IPC (`tauri_ipc_monitor` / `tauri_ipc_get_captured`)
  and poll `pg_supervisor_status`.
  **Expected:** `pg_database_reset` is invoked (captured) and returns `ok:true`;
  `pg_supervisor_status.state === 'ready'`; `pg-recovery-banner` is ABSENT on the next observed
  status (≤ 1 poll interval); console clean. **FAIL** = reset not invoked, a false success, or a
  stale banner while `ready`.

- [ ] **F-3 (R-3 / AC3) — destructive warning + ack-gated confirm + NO auto-reset.**
  Boot LEVER-A; capture IPC from boot across ≥ 3 poll intervals. Click `pg-recovery-banner-reset`;
  assert the dialog and the confirm's disabled state; click `pg-recovery-banner-reset-cancel`.
  **Expected:** `pg-recovery-banner-reset-dialog` (`role="alertdialog"`) renders with
  `pg-recovery-banner-warning` naming local-data destruction; `pg-recovery-banner-reset-confirm` is
  `disabled` until `pg-recovery-banner-reset-ack` is ticked; **zero `pg_database_reset` IPC
  invocations** from boot until `-reset-confirm` is clicked; cancel closes with no IPC and the banner
  stays. **FAIL** = no warning, no ack gate, or any automatic reset.

- [ ] **F-4 (R-4 / AC4) — non-`authMismatch` Failed ⇒ banner absent.**
  (a) LEVER-C (`portInUse`); (b) LEVER-D (`unknown`). For each, snapshot the shell and read
  `pg_supervisor_status`.
  **Expected:** `state === 'failed'` with `failureKind !== 'authMismatch'`; `pg-recovery-banner` is
  ABSENT; no console error. **FAIL** = the banner appears for any non-`authMismatch` failure.

- [ ] **F-5 (R-5 / AC5, continuous-state, G-123) — per-site error emission bounded WHILE Failed.**
  Boot LEVER-B (the real, reset-healing drift; LEVER-A is equivalent for the pure bound but cannot
  recover) and HOLD `Failed` for ≥ 120 s. Record the app-log line counts at T0 and T1 (60 s
  apart) and diff, per site, over `log flush error` / `span flush error` / `metrics flush error` /
  `OTLP metrics insert failed` / `OTLP log insert failed` (+ HTTP siblings) — read the isolated env's
  `dev-env-stdout.log` / `-stderr.log` (`dev-env.ps1 -Action Logs -EnvId spec3067 -Lines <large>`).
  Then reset → `ready` (LEVER-B heals) and re-read.
  **Expected:** each site emits **≤ 6 lines / 60 s window** (base 1 s, ×2, cap 60 s → windows
  1,2,4,8,16,32,60 s); inter-line gaps grow monotonically toward the 60 s cap; after recovery the
  engine-not-ready family drops to **0** (a successful write calls `reset()`); a `telemetry_spans`
  query returns **non-zero** rows for a live session post-recovery. **FAIL** = > 6 lines/site/60 s, no
  back-off, or no `telemetry_spans` receipt.

## Non-functional

- [ ] **N-1 (no secret):** the `FREDO_PG_PASSWORD_FILE` sentinel appears in NEITHER the DOM snapshot
  NOR `telemetry_logs` / app-data / any IPC payload; `-title`/`-warning` carry no password.
- [ ] **N-2 (no auto-reset):** zero `pg_database_reset` IPC invocations until an explicit
  `pg-recovery-banner-reset-confirm` (F-3).
- [ ] **N-3 (poll teardown / no interval leak):** `usePgSupervisorStatus` clears its interval on
  unmount (`PG_STATUS_POLL_MS` bounded, `clearInterval` on cleanup) — **static unit pin**, marked
  non-AC (the `Home` shell never unmounts live).
- [ ] **N-4 (no re-render loop):** `tauri_read_logs(source="console")` shows no
  `Maximum update depth exceeded` over the Failed window.
- [ ] **N-5 (banner does not intercept desktop):** `tauri_webview_find_element('[data-testid="pg-recovery-banner"]')`
  rect; a click on a desktop element OUTSIDE the banner box activates it; the banner is non-modal.
- [ ] **N-6 (tokens-only, both themes):** the banner uses `status.error`/`status.warning`/`bg.surface`/
  `fg.default`/`fg.muted`/`border.subtle` + `tint()`; no hardcoded hex/rgba and no alpha-append onto a
  `var()`; verified in BOTH light and dark.
- [ ] **N-7 (build hygiene):** `cargo check --locked` + `cargo test --locked` +
  `cargo clippy --locked -- -D warnings`; `pnpm --filter @fredo/ui build` exits 0 with zero TS errors.
- [ ] **N-8 (no row-pipeline regression):** Mission Monitor still renders from the store; row
  emission remains ONLY via `EventBus.emit_row_delivery_batch` (mirrors `postgres-lifecycle` F-15).

## Suite-level pass/fail

PASS = F-1..F-5 green and N-1..N-8 hold, with F-5 carrying an app-log line-count delta AND a
post-recovery `telemetry_spans` receipt. Any banner for a non-`authMismatch` kind, any
`pg_database_reset` without an explicit confirm, any secret occurrence, per-site emission > 6 in a
60 s window, a leaked poll interval, or a static-only receipt = **FAIL**.

## Notes

- The banner's status seam is the EXISTING `pg_supervisor_status` command (`postgresConfigStore.ts:220`)
  polled at `PG_STATUS_POLL_MS`; there is no supervisor status event, and no new IPC is introduced.
- `PostgresSettings.tsx` is out of scope — the banner is additive; do not edit the pane.
