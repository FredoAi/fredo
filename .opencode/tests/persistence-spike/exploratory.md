# persistence-spike — Exploratory

Feature: embedded PostgreSQL vs embedded SQLite evaluation. Issue #2948 (SPIKE). Unscripted
probes for the spike's evidence quality — error/failure states and "what-if" sequences. A
confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).

## Prompts

- [ ] **E-1: offline failure mode.** Disable network (or block the binary host) and run the
  PoC cold. Record: what fails, the error text, whether the failure is recoverable, and
  whether the raw-numbers file names this as `unknown` + "network-blocked binary download".
  Promote to F-2 if the artifact does not name the blocker.
  **Round 1 (2026-09-26): NOT RUN** — requires executing the PoC (bounded-run directive).
  The runtime-download network dependency IS named in `QUESTIONS.md` Q1 and the ADR risk 6.

- [ ] **E-2: port/socket collision.** Start the PoC while a PostgreSQL instance already
  binds the chosen port. Observe detection vs silent reuse vs crash. Does the 9-question
  answer for port/socket match observed behavior?
  **Round 1 (2026-09-26): NOT RUN** — requires executing the PoC (bounded-run directive).
  Q4 documents ephemeral binding (`settings.port = 0`); collision behavior unverified.

- [ ] **E-3: process lifecycle leak.** After a normal run and after a killed run, check for
  orphaned `postgres`/`pg_ctl` processes and whether the data dir is left inconsistent.
  Does the process-lifecycle answer match?
  **Round 1 (2026-09-26): CONFIRMED FINDING (promoted to F-1 evidence / QUESTIONS Q2).** The
  spike hit this head-on: with `settings.timeout = None`, `pg.stop()` (`pg_ctl -w stop`)
  waited **unbounded** (~11 h observed). The committed fix bounds every stage (180 s command
  timeout, 60 s bounded stop + `taskkill` fallback, 300 s harness child deadline). Residual
  production risk (supervisor + orphan sweep) is carried in the ADR risk 1. Not re-probed at
  runtime per the bounded-run directive.

- [ ] **E-4: write/read fidelity edge.** Round-trip empty string, very large text/blob,
  non-ASCII/emoji, NULL, and high-concurrency writes; compare against the PoC's claimed
  representative workload. Note gaps between the "representative" claim and reality.
  **Round 1 (2026-09-26): NOT RUN at runtime.** Committed source (`pgbench.rs`) does verify
  `raw_json` byte-equality and a non-ASCII round-trip (`héllo ✅ 漢字`); empty/NULL/large-text
  and concurrency edges remain unverified.

- [ ] **E-5: baseline fairness probe.** Re-run the SQLite baseline and PG benchmark
  back-to-back on the same machine/session; check whether deltas are stable within the
  recorded variance, or whether the headline number is a single warm-cache sample.
  **Round 1 (2026-09-26): OBSERVED (artifact, no re-run).** `measurements.json` records 2
  runs per variant in the same session; deltas computed from the mean of the runs. Re-run not
  performed (bounded-run directive).

- [x] **E-6: measurement definition probe.** Does "install/binary size" mean the
  download archive or the extracted on-disk footprint? Do memory numbers come from RSS peak
  or steady state? Missing definitions make AC2 numbers non-reproducible — promote to F-2.
  **Round 1 (2026-09-26): PASS (no gap).** `measurements.json.environment.sampler` states
  "sysinfo process-tree peak working set (root process + descendants; PostgreSQL child
  processes matched by name)"; `distribution_bytes = 164026008` is the **installed postgres
  dir** (notes), distinct from the **binary** `binary_bytes`; `data_dir_bytes` is the data dir
  after the workload. Units are encoded in field names (`_bytes`, `_ms`).

- [x] **E-7: decision honesty probe.** Search the decision record for hedging language
  ("probably", "seems", "worth exploring" with no token). Any claim not backed by a number
  or a committed artifact is a finding; promote to F-4 if the token/effort/risks are
  absent.
  **Round 1 (2026-09-26): PASS (no gap).** Explicit `Status: NO-GO`; effort L/~34 SP with the
  named scale; 10 prioritized risks each with impact + mitigation; explicit no-production
  attestation. Every quantitative claim traces to `measurements.json`.

- [x] **E-8: time-box probe.** Was the 1–2 day box respected? An overrun with a partially
  complete but honest artifact set is acceptable — record which ACs went `unknown` and why.
  **Round 1 (2026-09-26): PASS.** Delivered within the ~5-point / 1–2 dev-day box; AC2/AC3
  honest-unknowns are limited to out-of-scope items (`bundled` mode, operational migration,
  retention/security, crate health) — all named with blockers, none used as an AC1/AC5 escape.

## Round 1 (2026-09-26) outcome

No new `F-` rows promoted: the one confirmed finding (E-3 lifecycle hang) is already captured
in F-1's evidence and `QUESTIONS.md` Q2. Runtime probes E-1/E-2/E-4 were deferred by the
bounded-run directive; E-5 was judged from the committed run.
