# persistence-spike — Exploratory

Feature: embedded PostgreSQL vs embedded SQLite evaluation. Issue #2948 (SPIKE). Unscripted
probes for the spike's evidence quality — error/failure states and "what-if" sequences. A
confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).

## Prompts

- [ ] **E-1: offline failure mode.** Disable network (or block the binary host) and run the
  PoC cold. Record: what fails, the error text, whether the failure is recoverable, and
  whether the raw-numbers file names this as `unknown` + "network-blocked binary download".
  Promote to F-2 if the artifact does not name the blocker.

- [ ] **E-2: port/socket collision.** Start the PoC while a PostgreSQL instance already
  binds the chosen port. Observe detection vs silent reuse vs crash. Does the 9-question
  answer for port/socket match observed behavior?

- [ ] **E-3: process lifecycle leak.** After a normal run and after a killed run, check for
  orphaned `postgres`/`pg_ctl` processes and whether the data dir is left inconsistent.
  Does the process-lifecycle answer match?

- [ ] **E-4: write/read fidelity edge.** Round-trip empty string, very large text/blob,
  non-ASCII/emoji, NULL, and high-concurrency writes; compare against the PoC's claimed
  representative workload. Note gaps between the "representative" claim and reality.

- [ ] **E-5: baseline fairness probe.** Re-run the SQLite baseline and PG benchmark
  back-to-back on the same machine/session; check whether deltas are stable within the
  recorded variance, or whether the headline number is a single warm-cache sample.

- [ ] **E-6: measurement definition probe.** Does "install/binary size" mean the
  download archive or the extracted on-disk footprint? Do memory numbers come from RSS peak
  or steady state? Missing definitions make AC2 numbers non-reproducible — promote to F-2.

- [ ] **E-7: decision honesty probe.** Search the decision record for hedging language
  ("probably", "seems", "worth exploring" with no token). Any claim not backed by a number
  or a committed artifact is a finding; promote to F-4 if the token/effort/risks are
  absent.

- [ ] **E-8: time-box probe.** Was the 1–2 day box respected? An overrun with a partially
  complete but honest artifact set is acceptable — record which ACs went `unknown` and why.
