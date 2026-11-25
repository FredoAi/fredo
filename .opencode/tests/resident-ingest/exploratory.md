# resident-ingest — Exploratory

Unscripted probes for the single-owner contract (Spec #3194). A confirmed finding **promotes** to
`functional.md` as a new `F-` row (keep the origin note). Never run an unbounded binary (G-263);
never kill the serving tree (G-461); prefer a receiver-side reading over a destructive lever
(G-462).

## Prompts

- [ ] **E-1: start-time failure modes of the ONE boot path.** With the env's Vite serving, force
  each startup failure in turn and record the status shape within the bound: an unwritable lock
  dir, a missing/uninitialised cluster dir, a corrupted `PG_VERSION`. (Was `headless-ingest`
  exploratory E-1 — INVERTED to the resident path.)
  Does the app publish `failed` + a structured `error` + `failureKind`, start no postmaster, and
  leave no lock/partial dir? Promote if any failure is unbounded, unstructured, or leaves a
  half-initialised cluster.

- [ ] **E-2: a conflict on a port that is bound but NOT by a TCP listener on loopback** — e.g. bound
  on `0.0.0.0`, or in `TIME_WAIT` after a restart. Does the typed error stay honest
  (`addrInUse` vs `bindFailed`), and does the sibling still collapse? Promote if the classifier
  mislabels or the app half-binds.

- [ ] **E-3: two sequential conflicts in one session lifetime.** Quit and relaunch the app twice
  with a holder on the OTHER receiver each time. Does `ingestFailure` always describe the CURRENT
  process (no stale port/receiver from the previous process)? The value is per-process state — a
  stale value across a relaunch is a finding for the FD/monitor owner.

- [ ] **E-4: teardown after an induced crash.** Hard-kill the app (no graceful path) with the
  cluster running, then inventory `postgres.exe` and the four ports, then start the app again.
  Does the next start's sweep reclaim the orphan and does the census pair agree again?
  (Was `headless-ingest` exploratory E-8 — INVERTED.) G-280: a `dev-env Down` orphan is
  environment, not a spec FAIL. Promote only if the product's OWN crash-recovery wedges.

- [ ] **E-5: the health line under a conflict that resolves while the tooltip is open.** Open the
  LED tooltip, then quit and relaunch with the port free. Does the row return to
  `Healthy / Streaming` with the `technicalDetail` node REMOVED (no stranded mono line), and does
  the polite live region announce the change once? Promote if a stale evidence line survives.

- [ ] **E-6: `--help` under a mangled locale / a redirected stdout.** `run-exitcode.ps1` the help
  with `-TimeoutSecs 20`; does the exit code and the subcommand set stay stable (never a partial
  help page that would make F-9's absence assertion vacuous)? Promote if the help is truncated or
  the exit code flips.
