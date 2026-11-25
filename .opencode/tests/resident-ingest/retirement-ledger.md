# retirement-ledger — the former `headless-ingest/` suite

**Provenance record for Spec #3194.** `.opencode/tests/headless-ingest/` (seeded #2992) described
the `fredo ingest` daemon, its descriptor, its attach mode and its shutdown-file/run-ms seams.
#3194 **removed** all of it: the command, the second boot path, `PgState::Attached`, the descriptor
and the seams. The folder is therefore deleted; this ledger is its durable successor record so no
former claim is lost and no row is silently reworded into something it cannot prove (G-444).

Polarity rule applied: a row that asserted the retired mode **PRESENT** is **INVERTED** (its
inverted form lives in this folder, named below); a row that already asserted it **ABSENT** is
**CONFIRMED** (unchanged in substance, retargeted where the subject moved); a row whose only
trigger was attach mode is **DELETED** with the reason — never reworded.

| Former row | Subject | Disposition | Successor |
|---|---|---|---|
| `functional.md` F-1 | one process owns the cluster | **INVERTED** (owner is the desktop process, not a daemon) | `functional.md` F-1 + F-2 |
| `functional.md` F-2 | OTLP delivery persists raw span + canonical row | **CONFIRMED** (lever updated) | `functional.md` F-5, `smoke.md` S-5 |
| `functional.md` F-3 | bounded shutdown via `FREDO_INGEST_SHUTDOWN_FILE` | **DELETED** — the file lever and `FREDO_INGEST_STOP_BOUND_MS` no longer exist | replaced by `functional.md` F-11 (product quit) |
| `functional.md` F-4 | hard-kill fallback on stop-hang (`FREDO_INGEST_STOP_BOUND_MS`) | **DELETED** — the lever is gone; the bounded-teardown property survives on the app's own path | `functional.md` F-11 + `postgres-lifecycle/` |
| `functional.md` F-5 | lock-conflict fail-fast for a second DAEMON | **INVERTED** — a second *instance* must fail and never adopt | `functional.md` F-3 |
| `functional.md` F-6 | GUI cluster-start fails, then **ATTACHES** (`state:"attached"`) | **INVERTED — the core inversion of this spec**: there is no attach path; the second process must FAIL | `functional.md` F-3, `regression.md` R-1 |
| `functional.md` F-7 | stale/missing-descriptor fallback (`is_live`) | **DELETED** — the descriptor no longer exists, so nothing can be stale or missing | — (module deleted by ST-1) |
| `functional.md` F-8 | autostart installs the CURRENT login entry | **CONFIRMED** (owned in full by `background-capture/` F-2/F-3) | `background-capture/functional.md` F-2/F-3, `functional.md` F-10 |
| `functional.md` F-9 | no backfill markers / no SQLite data store on the daemon path | **DELETED** — its subject is a second process's control-plane access; the SQLite-absence invariant is owned elsewhere | `postgres-only-persistence/` |
| `functional.md` F-10 | shared-state ATTACH + Mission-Monitor replay render | **DELETED** — its only trigger was attach mode; the replay-render subject belongs to the monitor suite | `mission-monitor/`, `event-persistence/` |
| `functional.md` F-11 | daemon resolver == GUI app-data dir | **DELETED** — there is only ONE resolver now | `multi-env-isolation/` (the `FREDO_DATA_DIR` contract) |
| `functional.md` F-12 | control-plane concurrency (daemon + GUI) | **DELETED** — one process remains, so the contention case cannot arise | — |
| `functional.md` F-13 | regression invariants (no row-pipeline change) | **CONFIRMED** | `regression.md` R-1…R-9 |
| `functional.md` F-14 | `fredo ingest --help` names its full flag set (G-254) | **INVERTED** — the subcommand is ABSENT and the positive value set is the remaining CLI's | `functional.md` F-9 |
| `functional.md` N-1 | boundedness (G-263) | **CONFIRMED** | `functional.md` N-1 |
| `functional.md` N-2 | teardown on every path | **CONFIRMED** | `functional.md` F-11 + N-2 |
| `functional.md` N-3 | loopback-only | **CONFIRMED** | `functional.md` N-3 |
| `functional.md` N-4 | build/CI parity | **CONFIRMED** (nextest forms per #3147/#3151) | `functional.md` N-4 |
| `functional.md` N-5 | no row-pipeline regression | **CONFIRMED** | `regression.md` R-4 |
| `functional.md` N-6 | seam semantics — caller wins (G-296) | **CONFIRMED for the KEPT seams only** (`FREDO_INGEST_GRPC_PORT`/`HTTP_PORT`); the retired seams are deleted | `regression.md` R-7 |
| `smoke.md` S-1 | GUI window renders | **CONFIRMED** | `smoke.md` S-1 |
| `smoke.md` S-2 | no console errors | **CONFIRMED** | `smoke.md` S-2 |
| `smoke.md` S-3 | Background-capture pane renders (testid set) | **CONFIRMED** (owned by `background-capture/`) | `background-capture/smoke.md` |
| `smoke.md` S-4 | headless daemon boots | **INVERTED** — the RESIDENT app boots and owns | `smoke.md` S-3 + S-4 |
| `smoke.md` S-5 | screenshot captured | **CONFIRMED** | `smoke.md` S-7 |
| `smoke.md` S-6 | daemon stops bounded (file lever) | **INVERTED** — quit through the product's own path | `smoke.md` S-6, `functional.md` F-11 |
| `smoke.md` S-7 | live `telemetry_spans` receipt | **CONFIRMED** (lever = the committed injector, never `fredo emit`) | `smoke.md` S-5, `functional.md` F-5 |
| `regression.md` R-1 | default GUI boot identical with the new seams unset | **CONFIRMED** | `regression.md` R-1 |
| `regression.md` R-2 | OTLP receiver contract unchanged | **CONFIRMED** + the typed failure is additive | `regression.md` R-2 |
| `regression.md` R-3 | RTDB row pipeline unchanged | **CONFIRMED** | `regression.md` R-4 |
| `regression.md` R-4 | supervisor lifecycle preserved — including "the attach path never starts/stops/sweeps a postmaster" | **CONFIRMED minus the attach clause** (that path no longer exists) | `regression.md` R-5, `postgres-lifecycle/` |
| `regression.md` R-5 | settings schema/keys unchanged | **CONFIRMED** | `postgres-naming/` R-10 |
| `regression.md` R-6 | pool sizing unchanged (8 / 5 s) | **CONFIRMED** | `postgres-connection-headroom/` |
| `regression.md` R-7 | existing tests stay green, none deleted or weakened (G-281/G-290) | **CONFIRMED** — with the ONE sanctioned deletion (the daemon E2E `tests/headless_ingest.rs`, which tests the deleted command) | `regression.md` R-8 |
| `regression.md` R-8 | builds stay green | **CONFIRMED** | `functional.md` N-4 |
| `regression.md` L-1…L-5 | linked suites | **CONFIRMED** (links re-expressed in `regression.md` L-1…L-7) | `regression.md` |
| `exploratory.md` E-1 | daemon start-time failure modes | **INVERTED** | `exploratory.md` E-1 |
| `exploratory.md` E-2 | shutdown-file races | **DELETED** — the lever no longer exists | — |
| `exploratory.md` E-3 | lock held by a foreign process / foreign lock dir | **CONFIRMED** (now a two-INSTANCE probe) | `exploratory.md` E-1, `functional.md` F-3 |
| `exploratory.md` E-4 | descriptor tampering | **DELETED** — no descriptor exists to tamper with | — |
| `exploratory.md` E-5 | control-plane contention (daemon writes `postgres_pid`) | **DELETED** — only one writer remains | — |
| `exploratory.md` E-6 | app-data-dir parity daemon vs GUI | **DELETED** — one resolver | `multi-env-isolation/` |
| `exploratory.md` E-7 | registry robustness | **CONFIRMED** | `background-capture/` |
| `exploratory.md` E-8 | orphan inventory after an induced crash | **INVERTED** | `exploratory.md` E-4 |
| `exploratory.md` E-9 | `--run-ms` self-terminate | **DELETED** — the seam no longer exists | — |

**Fixture.** `headless-ingest/fixtures/otlp-trace-chat.json` moved to
`resident-ingest/fixtures/otlp-trace-chat.json` with its vocabulary retargeted
(`fredo-headless-ingest-e2e` → `fredo-resident-ingest-e2e`,
`headless-ingest-e2e-session` → `resident-ingest-e2e-session`); it remains a committed,
deterministic OTLP/JSON producer (G-172).

**Rows that were already UNVERIFIED in that suite** (`F-7`, `F-10`, `F-3's` forced-kill edge) stay
unverifiable here for the same or a stronger reason and are NOT carried forward as rows: their
triggers no longer exist. Do not resurrect them as "known unverified" entries — a row with no
trigger is a deletion, not a debt.
