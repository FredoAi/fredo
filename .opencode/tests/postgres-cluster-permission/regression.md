# postgres-cluster-permission — Regression

"Must not change" baseline for the **cluster-directory permission recovery** slice of the
embedded-PostgreSQL supervisor. Seeded at issue **#3188** (revises **#3180** — do not reopen it).
Any FAIL here is a regression.

> **Frozen contracts (the invariants this file protects):**
> - **`FREDO_PG_DATA_DIR` precedence:** non-blank ⇒ resolved VERBATIM (trimmed); blank ⇒ INERT
>   (unset, never a redirect); then legacy `<app>/postgres` IFF `postgresql.conf`, else
>   `<app>/postgres/cluster`.
> - **`FREDO_PG_CLUSTER_QUARANTINE_FAIL` residue semantics:** armed ⇒ `Residue` refused with
>   `failureKind:"dataDirNotEmpty"`; inert ⇒ quarantined by rename. UNCHANGED.
> - **The FOUR existing failure kinds are frozen:** `authMismatch`, `portInUse`, `dataDirNotEmpty`,
>   `unknown` (wire values). `dataDirPermissionDenied` is the only addition.
> - The recovery path **never deletes** any directory or file.

> **Target platform note:** the change is cross-platform `std::fs` only and MUST NOT add
> `#[cfg(target_os)]`; Windows is the target filesystem class, not a compile-time gate.

> **Verification policy: mixed.** Q-5/Q-6 are pure-rule unit pins; Q-14 is a hermetic instrument
> self-test; Q-15/Q-17/Q-18/Q-19 are static/source or CI receipts; Q-16 is a named blocker. None of
> these may be reported as a live product PASS. **Evidence record:** the POSTED timeline comment /
> the green CI run on the tested head SHA — never a `.opencode/tmp/3188/` draft (**G-415**). No image
> file extensions in prose (**G-104**); evidence frames are named only as an uploaded
> `https://github.com/user-attachments/...` URL.

## Residual (residue) rows — LINK, DO NOT REWRITE

The residue/quarantine rows stay **byte-identical** in the sibling family. Run them from their own
file; this suite does NOT copy or restate their assertions:

- `.opencode/tests/postgres-lifecycle/functional.md` → **F-2** (re-scoped #3180 residue fail-closed leg)
- `.opencode/tests/postgres-lifecycle/functional.md` → **F-22** (residue INSIDE the cluster dir ⇒ quarantine by rename)
- `.opencode/tests/postgres-lifecycle/functional.md` → **F-25** (typed `dataDirNotEmpty` cause + remedy)

They remain the ground for the **Residue** class; the new **Empty** class is this suite's ground.
Editing those rows is out of scope for #3188.

## Cases

- [ ] **Q-5 (R-2b) — an `initdb` permission refusal never falls through to `Unknown`.**
  Static/unit (a pure rule, non-live by nature): ST-2's
  `classify_failure_maps_an_initdb_permission_message_to_permission_denied` (plain and
  context-wrapped) plus `classify_failure_maps_an_empty_cluster_dir_error_to_permission_denied`.
  Record = green `cargo test --locked` on the tested head SHA (CI `rust-validate`, or the posted
  `## Developer ST-2 — verification` comment).
  **Expected:** Both new tests green; the text match is exact-phrase only
  (`could not change permissions of directory` / `fixing permissions on existing directory`).
  **Edge:** A catch-all that maps every setup error to the new kind is a FAIL. Corroboration only —
  AC-2's live ground is Q-3/Q-4 (G-435).

- [ ] **Q-6 (R-2b + regression) — the Residue classification is unchanged and `unknown` stays reachable for generic errors.**
  Static/unit: keep `classify_failure_maps_a_cluster_dir_error_to_data_dir_not_empty` green; extend
  the `classify_failure_text` fallback so a non-permission setup error still yields `unknown`.
  **Expected:** Residue → `dataDirNotEmpty` (frozen); a generic setup error → `unknown` (the variant
  is still the fallback, never repurposed for a cluster-dir failure).
  **Edge:** If `unknown` becomes unreachable for generic errors = FAIL.

- [ ] **Q-14 (AC-5 / R-5a) — the gate instrument is intact and its self-test is green.**
  Live-hermetic:
  `powershell -NoProfile -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Mode selftest"`
  (drive through the pipe-captured wrapper — G-450; this leg returned in ~0.3 s in #3181 r5).
  **Expected:** exit 0 with a literal `SELFTEST: PASS` line; the Database negative-leg control is
  among the controls.
  **Edge:** `-Mode selftest` needs no installer, model, GUI or network (gate skill). A red self-test
  makes the instrument untrusted — report it, never a product FAIL.

- [ ] **Q-15 (AC-5 / R-5a) — the gate, probe and negative legs are unweakened by this diff (source/diff proof).**
  Static:
  `git diff --stat <merge-base main>...HEAD -- .opencode/scripts/gate-release-artifact.ps1 .opencode/scripts/gate-artifact-window.ps1 .opencode/scripts/gate-artifact-negative.psm1 .opencode/scripts/launch-artifact-probe.ps1 .opencode/scripts/verify-installer-payload.ps1 .github/workflows/release.yml`;
  then read that the fresh leg still pre-creates `<DataDir>\postgres\cluster` and exports
  `FREDO_PG_DATA_DIR` (`launch-artifact-probe.ps1:1331-1347`), the dirty seed persists, and all
  three `-Negative` legs are still dispatched (`release.yml:531-545`).
  **Expected:** Empty diff across ALL SIX files; all three negative legs still wired; NO new
  `-SkipCompanion` on a canonical leg; no new exclusion or early-continue. The Database leg's
  fixture is RESIDUE (`start.log`), so the Empty-vacate fix cannot make it vacuous — state that
  explicitly.
  **Edge:** A non-empty diff on ANY of the six files is an AC-5 FAIL ("not weakened or
  special-cased"). Re-derive the leg list from the files, do not trust this row's list alone.

- [ ] **Q-16 (AC-5 — NAMED BLOCKER, never a FAIL) — a canonical `-Mode gate -Manual` run is NOT drivable this round.**
  **NAMED BLOCKER:** it needs a produced `*-setup.exe` AND the three-model set; otherwise the gate
  refuses with `EXTRACT_FAILED` / `MODEL_SET_MISSING`, and `-SkipCompanion` is forbidden on an AC-5
  run. Command for a host that can produce the installer:
  `powershell -NoProfile -File .opencode/scripts/gate-release-artifact.ps1 -Installer <setup.exe> -Mode gate -Manual`,
  driven through `run-exitcode.ps1` with a window ≥ the gate's ~1100 s declared budget (observed
  941.2 s — G-451).
  **Expected (when it IS run):** exit 0; `DB_ISOLATION=isolated`; `DB_EFFECTIVE_DIR=fresh=<path>`;
  `run-fresh` and `run-dirty` both present; the three negative legs reproduce.
  **Edge:** Do NOT manufacture a run and do NOT swap `-SkipCompanion` in. Q-14 + Q-15 are the honest
  receipts this round; this is a blocker, never a FAIL. Reporting it as a FAIL is an evidence error.

- [ ] **Q-17 (non-behavioural / ST-4, G-398) — the product docs state the new behaviour.**
  Static: read `docs/ARCHITECTURE.md` (pg_supervisor + cluster_dir rows) and `docs/SETUP.md`
  (cluster-directory paragraph) on the spec branch.
  **Expected:** Both state: an existing-but-empty cluster dir is vacated by the timestamped
  `<path>.rejected-<ts>` rename before initialisation; a residual refusal surfaces the typed
  `dataDirPermissionDenied` with its remedy; `FREDO_PG_CLUSTER_PERMISSION_FAIL` is the in-repo seam,
  inert by default.
  **Edge:** `docs/CLI_GUIDE.md` unchanged (precedence/override semantics are frozen). The docs must
  not claim Fredo "fixes permissions", instruct a deletion, or say `dataDirNotEmpty` covers this
  case.

- [ ] **Q-18 (non-functional) — build hygiene and cross-platform safety.**
  Static: `cargo check --locked` (zero warnings), `cargo test --locked` green,
  `pnpm --filter @fredo/ui build` clean, frontend tests green; scan added lines in the changed
  `pg_supervisor` files for `#[cfg(target_os)]`.
  **Expected:** Zero warnings; all green; no OS gating added (the change is `std::fs` only), so
  non-Windows platforms do not regress.
  **Edge:** Record = CI on the tested head SHA (non-draft). An added `#[cfg(target_os)]` is a FAIL.

- [ ] **Q-19 (non-functional / never delete) — the recovery path still deletes nothing.**
  Static: added lines of
  `git diff -U0 -- apps/tauri/src-tauri/src/applications/pg_supervisor/` contain no `remove_dir`,
  `remove_dir_all` or `remove_file`; the diff is non-empty (non-vacuity control).
  **Expected:** Zero delete calls added; the diff is non-empty.
  **Edge:** A scan that hides the added lines is a FAILED DRIVE.

## Linked suites (overlapping surface — run alongside)

- [ ] **R-L1:** inherit `.opencode/tests/postgres-lifecycle/` — the residue/quarantine rows
  (`F-2`, `F-22`, `F-25`) and the lifecycle invariants for the same supervisor.
- [ ] **R-L2:** inherit `.opencode/tests/mission-monitor/` — the row-pipeline / Mission Monitor
  surface (Q-20's standing invariant).

## Suite-level pass/fail

PASS = Q-5, Q-6, Q-14, Q-15, Q-17, Q-18, Q-19 green **and** Q-16 carried as its named blocker. A
`#[cfg(target_os)]` addition, an added delete call, a non-empty gate diff, a catch-all
classification, or an unreachable `unknown` fallback = FAIL. Q-16 reported as a FAIL (rather than a
blocker) is an evidence error.
