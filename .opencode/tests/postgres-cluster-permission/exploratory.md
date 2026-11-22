# postgres-cluster-permission — Exploratory

Unscripted edge/failure probes for the **cluster-directory permission recovery** feature
(issue **#3188**, revises **#3180** — do not reopen). A confirmed finding **promotes** to
`functional.md` as a new `Q-` row (keep the origin note). The Tester adds probes below beyond the
script.

> **Verification policy: live** for the runtime probes (a running supervisor/app under a finite
> timeout); the unit/static probes say so explicitly. **G-263 SAFETY:** every boot is time-bounded
> and torn down via `dev-env.ps1 -Action Down`; never a bare `postgres`/`pg_ctl`, never an unbounded
> run.
>
> **Evidence record:** the POSTED timeline comment, never a `.opencode/tmp/3188/` draft (**G-415**).
> No image file extensions in prose (**G-104**); evidence frames are named only as an uploaded
> `https://github.com/user-attachments/...` URL.

## Probes seeded from the QA Plan's edge-case column

- [ ] **E-1 (from Q-1 edge / Q-13) — second boot on an initialised cluster is a no-op.**
  Boot the Q-1 profile a second time on the same env. Does the app reuse the initialised cluster
  (`state:"ready"`, SAME `dataDir`) with NO new `cluster.rejected-*` sibling and `postgresql.conf`
  unchanged — i.e. is a crate-written `start.log` inside an initialised cluster correctly NOT
  residue? A second sibling here is a data-safety red flag.
- [ ] **E-2 (from Q-2 edge / Q-11 edge) — a `PG_VERSION`-only directory is still Residue.**
  Seed a dir holding `PG_VERSION` but NO `postgresql.conf`. Does the classifier still call it
  `Residue` (quarantined by rename, not treated as `Empty`), and at the legacy path does it produce
  a FRESH cluster at `<app>/postgres/cluster`? Record which predicate fired; the marker must be
  `postgresql.conf`, never `PG_VERSION`.
- [ ] **E-3 (from Q-10 edge) — residue under an ARMED quarantine seam is still `dataDirNotEmpty`.**
  Boot the Q-10 residue fixture with `FREDO_PG_CLUSTER_QUARANTINE_FAIL=1`. Is the outcome
  `state:"failed"` + `failureKind:"dataDirNotEmpty"` (frozen), with NO deletion and no
  `dataDirPermissionDenied` conflation? The empty-dir permission seam must not have altered the
  residue class.
- [ ] **E-4 (from Q-7 edge) — a blank/`0`/`FALSE` seam is unset, never armed.**
  Boot a fresh EMPTY cluster dir with each of `""`, `"   "`, `0`, `FALSE` (and the case variants).
  Does each reach ready and create the vacate sibling (Q-1 semantics)? Any of these producing the
  armed failure (Q-3 semantics) is an inertness defect.
- [ ] **E-5 (from Q-4 / UI-UX §6) — long remedy wraps; the a11y label excludes the raw error.**
  On the Q-3 armed failure: does the remedy line wrap (`white-space: normal`, `overflow-wrap:
  anywhere`) without truncation, and does the LED trigger's composed `aria-label` contain the
  cause + remedy but NOT the raw `status.error` (which belongs only to `technicalDetail`)? Record
  the rendered text and the label verbatim.

## Additional prompt lines (Tester may extend)

- [ ] **E-6 — seam values `1` / `true` / `yes` arm; `no` / `off` (non-`false`) are ambiguous.**
  Probe which non-blank values beyond the pinned set arm the seam, and whether `no`/`off` behave as
  armed or inert. Record the observed rule; do not assume it matches the residue sibling.
- [ ] **E-7 — quarantine rename collision.** Two vacate/quarantine boots within the same unix second
  on the same parent: does the `cluster.rejected-<ts>` target collide (suffix/retry), or does the
  second rename fail typed? A silent overwrite of the first sibling would be data loss.
- [ ] **E-8 — a residue/empty dir locked by another process (open handle).** Does the rename fail
  typed with `dataDirPermissionDenied` (+ remedy + technical detail), or hang past the setup bound?
- [ ] **E-9 — repeated failed boots accumulate `cluster.rejected-*` siblings.** Is there any
  retention rule, or does the set grow without bound (disk growth)? Record the growth; do not delete.
- [ ] **E-10 — cluster path exists as a FILE, not a directory.** Does `inspect_cluster_dir` classify
  it as Residue (rename the plain file) or fail typed — and never panic? Record which, and whether a
  next step is shown.
- [ ] **E-11 — kind without `failed`.** A snapshot with `failureKind:'dataDirPermissionDenied'` but
  `state:'starting'` must render from `state` (`Starting`) and ignore the kind (copy is read only in
  the `failed` branch). Confirm the copy does not leak into a non-failed row.
- [ ] **E-12 — recovery banner stays hidden for the new kind.** On the Q-3 boot,
  `PgRecoveryBanner` must return `null` for `dataDirPermissionDenied` (a reset cannot fix an ACL
  denial). Any destructive-reset affordance here is a defect.
