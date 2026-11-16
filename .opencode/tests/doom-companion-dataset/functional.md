# doom-companion-dataset — Functional Test Cases (Spec #3032)

> Durable functional suite (feature domain `doom-companion-dataset`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3032
> `### QA Plan`. This domain covers the **fine-tuning dataset export** slice: a **raw,
> per-decision correlated JSONL** (observation → model output → executed action(s) → next state
> → reward → terminal) written **locally** under the app-data dir, replacing/merging the two
> capped audit files (`doom-agent-requests.jsonl` cap 64, `doom-agent-actions.jsonl` cap 256),
> with **shaped reward** `{dKills,dItems,dSecrets,dHealth,dDistanceToExit,moved}`, a **terminal
> stamp** (`terminal.kind` + `terminal.levelResult`, `runId` on every record), **bounded
> retention + rotation**, a **local-only export** (`fredo doom export-dataset --format
> <raw|sft|dpo> --out <path>`, raw default), an **opt-in** gate, and **decision error/timeout**
> records carrying the fallback action.
>
> **Bound to the `## Software Architect` Names block (BINDING — G-255).** A record captures the
> bounded `doom_plan` (executed one step per tick; doors first-class) + the additive bounded
> `forward` sensor + re-plan events (`execution.replans[]`) — NOT the legacy `{tics, actions}`
> decision. Mechanics live in the continuous loop (`applications/doom/agent.rs
> run_continuous_loop`), the plan executor (`applications/doom/plan.rs`), and the new
> `applications/doom/dataset.rs`; observed through `DoomAutoplayStatus` (`autoplay.rs`), the
> deterministic driver (`engine.rs:633 run_bounded_driver`), and the dataset JSONL.
>
> **Verification policy: live** — a running bounded run writing the JSONL, plus the export path
> actually executing. The tester's Evidence MUST reference `telemetry_spans` (a live-query
> result: NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed
> `psql` on the PG default as a DISCLOSED fallback, G-284) at round start AND after the run.
> **The Doom loop emits NO OTLP span — the query proves the live pipeline, not the feature;
> DISCLOSE it.** The authoritative live evidence is the on-disk JSONL (`FREDO_DOOM_DATASET_DIR`,
> fallback `FREDO_DATA_DIR`, `boot_config.rs:40`) and the export file. A static-only PASS is a
> FALSE PASS (G-033).
>
> **No wall-clock flakiness (G-316).** Every record-assembly / retention / correlation row is
> STEP-DRIVEN through `run_bounded_driver` (`engine.rs:633`) + `FixedTickClock` and the injectable
> `FREDO_DOOM_*` seams. The F-LIVE end-to-end leg is the ONE live leg.
>
> **G-300/G-275 — every failure edge names an in-repo induction lever.** All names below are the
> Architect's pinned seams (Names block); no invented levers.
>
> **Scratch:** `.opencode/tmp/3032/`. Env overrides via the `dev-environment` skill.

## Named levers / literals (Architect-pinned)

Env: `FREDO_DOOM_DATASET_ENABLED` (default off), `FREDO_DOOM_DATASET_DIR` (test dir override),
`FREDO_DOOM_DATASET_RAW`, `FREDO_DOOM_DATASET_REASONING`, `FREDO_DOOM_DATASET_MAX_RECORDS` (test
retention override); existing `FREDO_DATA_DIR` (`boot_config.rs:30`),
`FREDO_DOOM_AGENT_DECISION_SOURCE` / `FREDO_DOOM_AGENT_SCRIPT` (`decision.rs:32/34`),
`FREDO_DOOM_AGENT_MAX_STEPS` (`decision.rs:40`), `FREDO_DOOM_AGENT_MAX_FAILURES` (`decision.rs:43`),
`FREDO_DOOM_FORCE_EXIT` (`engine.rs:1018`), `FREDO_DOOM_AGENT_STOP_ON_EXIT` (`agent.rs:164`),
`FREDO_DOOM_INJECT_OBSERVATION` (`engine.rs:1046`), `FREDO_DOOM_DOOR_WAIT_MAX_TICKS` (`plan.rs:98`),
`FREDO_DOOM_FAIL_PERCEPTION` (`perception.rs:70`). Consts: `DOOM_DATASET_FILE`=`"doom-dataset.jsonl"`,
`DOOM_DATASET_ROTATION_PREFIX`=`"doom-dataset."`, `DOOM_DATASET_FILE_MAX_BYTES`=`32*1024*1024`,
`DOOM_DATASET_MAX_TOTAL_BYTES`=`256*1024*1024`, `DOOM_DATASET_MAX_RECORDS`=`500_000`,
`DOOM_DATASET_REASONING_MAX_BYTES`=`4096`, `DOOM_DATASET_EXPORT_DIR`=`"exports"`,
`DOOM_DATASET_ENABLED_KEY`=`"doom_dataset_enabled"`. Commands: `export_doom_dataset`,
`get_doom_dataset_status`, `set_doom_dataset_enabled`. Wire: `terminal.kind` ∈
`exited|dead|timeout|aborted`; `source` ∈ `model|scripted|local`; `controller` ∈
`plan|legacy|reflex|fallback`; `decisionError.kind` ∈ `malformed|modelUnavailable|timedOut|engineError`;
re-plan `reason` ∈ `blocked|noProgress|frontEnemy|doorClosed|exhausted` (`plan.rs:107-133`).

## REQ-1 / AC1 — one per-decision correlated record

- [ ] F-1 (REQ-1, AC1, REQUIRED, live) **Each decision attempt yields ONE JSONL record correlating
  observation → plan → executed action(s) → nextState → reward.** Recipe **R1**.
  - EXPECTED: `doom-dataset.jsonl` has exactly one record per decision attempt; each carries
    `runId`/`episodeId`/`decisionId`, `tic`, `stepIndex`, `source` ∈ `model|scripted|local`, `level`,
    `model`, `observation` (incl. the additive `walls` + `forward`), `decision.plan` (the bounded
    `doom_plan` steps — NOT a legacy `{tics,actions}`), `execution.steps[{index,controller,actions,
    tics}]`, `execution.replans[]`, `nextState`, and `reward{dKills,dItems,dSecrets,dHealth,
    dDistanceToExit,moved}`; record count == `get_doom_autoplay_status.decisions` (`commands.rs:717`).
  - Edge: a decision executing 0 steps (all-unusable); a multi-step plan; a mid-plan re-plan appears
    as `execution.replans[]` (NOT a separate record); first/last correlation; `moved` true vs false;
    `dDistanceToExit` null (fair-play gated).

## REQ-2 / AC2 — terminal stamp on run end

- [ ] F-2 (REQ-2, AC2, REQUIRED, live) **`runId` is stamped on every record; the run end stamps the
  terminal kind + level result.** Recipes **R2a–R2d**.
  - EXPECTED: every record carries `runId`; a run-end record carries `terminal.kind` ∈
    `exited|dead|timeout|aborted` AND `terminal.levelResult{episode,map,outcome,kills,items,secrets,
    ticMs}`.
  - Edge: exit (`FREDO_DOOM_FORCE_EXIT=1`); death; budget-exhausted (`timeout`); cooperative
    stop/close (`aborted`); engine error.

## REQ-3 / AC3 — bounded retention + no deletion of export-referenced records

- [ ] F-3 (REQ-3, AC3, REQUIRED, live) **The dataset is bounded with rotation, and an export's
  referenced records are never deleted.** Recipe **R3**.
  - EXPECTED: the active file rotates at `DOOM_DATASET_FILE_MAX_BYTES`=32 MiB; the dir is bounded by
    `DOOM_DATASET_MAX_TOTAL_BYTES`=256 MiB / `DOOM_DATASET_MAX_RECORDS`=500_000 (oldest rotated files
    evicted first); WHILE an export is in progress the `export_in_progress` guard DEFERS eviction, so
    an export's referenced records survive a later rotation.
  - Edge: tiny cap via `FREDO_DOOM_DATASET_MAX_RECORDS` (e.g. 2); cap = 1; exactly-at-cap;
    export → rotate → re-export; torn/partial trailing line after a crash.

## REQ-4 / AC4 — export local + no egress

- [ ] F-4 (REQ-4, AC4, REQUIRED, live) **Export writes the dataset locally in the requested format,
  with no egress.** Recipe **R4**.
  - EXPECTED: `fredo doom export-dataset --format <raw|sft|dpo> --out <path>` writes a local file
    (raw = the JSONL verbatim; sft = `{prompt,completion,reward,terminal}`; dpo =
    `{prompt,chosen,rejected,reward}`) into `<dir>/exports/`; the export path performs NO network I/O;
    the source files are never mutated.
  - Edge: `--format` omitted ⇒ raw; `sft`/`dpo` shapes; dpo skips records without a replan; unwritable
    `--out` → typed `DoomCommandError`, no partial file.

## REQ-5 / AC5 — opt-in (disabled ⇒ no records)

- [ ] F-5 (REQ-5, AC5, REQUIRED, live) **With capture OFF (default) no dataset records are written;
  the run still advances.** Recipe **R5**.
  - EXPECTED: no dataset file is created (the writer is ABSENT) while `decisions`/`steps` still climb;
    toggling via `FREDO_DOOM_DATASET_ENABLED` and/or `set_doom_dataset_enabled` (persisting
    `doom_dataset_enabled`) enables capture; ON ⇒ records appear; `get_doom_dataset_status` reflects
    `enabled`/`dir`/`records`/`bytes`.
  - Edge: toggled mid-run (capture stops/starts at the next decision; never gates the run); ON with an
    EMPTY dataset exported (typed error, no partial file).

## REQ-6 / AC6 — decision error/timeout recorded with the fallback action

- [ ] F-6 (REQ-6, AC6, REQUIRED, live) **An unusable decision is recorded with its typed error AND
  the fallback action that actually ran.** Recipe **R6**.
  - EXPECTED: a failed attempt closes a record with `decision:null` + `decisionError{kind ∈
    malformed|modelUnavailable|timedOut|engineError, detail}` AND the applied fallback actions in
    `execution.steps[].actions` with `controller:"reflex"|"fallback"`, so model/plan control is
    distinguishable from reflex/fallback control.
  - Edge: single error then recovery; consecutive errors to `max_failures`; `{"stall":true}` →
    `timedOut`; malformed; error on the FIRST decision.

## Non-functional

- [ ] F-7 (NFR-1, bounded payload + rotation, live) **No unbounded/oversized record; the file
  rotates.** EXPECTED: each record ≤ the pinned bounds — the observation reuses
  `DOOM_OBSERVATION_BYTE_BUDGET`=8192 (`perception.rs:62`); no per-pixel data; `reasoning` ≤
  `DOOM_DATASET_REASONING_MAX_BYTES`=4096 and only behind its flag; size bounded across the run. Edge:
  cap crossed N times; one maximal observation; rotation atomicity (no torn record).
- [ ] F-8 (NFR-2, opt-in gate, live/static pin) **The opt-in is the ONLY writer switch.** EXPECTED:
  default OFF constructs no writer and writes nothing; the env/AppStore key gate is the only switch.
  Edge: see F-5.
- [ ] F-9 (NFR-3, no-egress, live) **The dataset/export path opens no listener and makes no outbound
  connection.** EXPECTED: writes confined to `<app_data_dir>/doom-dataset/`; process inventory
  unchanged (`fredo.exe` only); a proxy/telemetry env set is IGNORED; SECURITY.md local-only posture.
  Edge: see F-4.
- [ ] F-10 (NFR-4, reasoning-flag bound, live/static pin) **The captured model output is the bounded
  parsed plan, and `reasoning`/`modelRaw` are gated + bounded.** EXPECTED: `decision.plan.steps` ≤
  `DOOM_PLAN_MAX_STEPS`=8 with range-checked fields; `reasoning` present ONLY with
  `FREDO_DOOM_DATASET_REASONING=1` and truncated to `DOOM_DATASET_REASONING_MAX_BYTES`=4096;
  `modelRaw` ONLY with `FREDO_DOOM_DATASET_RAW=1`; both flags off ⇒ neither key present. Edge:
  reasoning-on server; empty/oversized reply.
- [ ] F-11 (NFR-5, determinism of record assembly, G-316) **Assembly is deterministic.** Run
  `run_bounded_driver` TWICE (identical script + `FixedTickClock`). EXPECTED: field-for-field identical
  record bodies EXCEPT `ts` and `latencyMs`; no RNG/hidden clock in assembly. Edge: N repeats stable;
  a different script changes the records (sanity).
- [ ] F-12 (REG) **Prior Doom suites still pass.** EXPECTED: `doom-companion-planning`,
  `doom-companion-progress`, `doom-observation-geometry`, `doom-native`, `doom-mode` regression rows
  pass (run-links in `regression.md`).
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the run.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits no span — DISCLOSE.**
  Edge: managed-`psql` pool-saturated → app-pool read substitution, DISCLOSED (G-307/G-284).

## Required test data (all in-repo or produced by an in-repo lever — G-172)

- **Dataset dir seam:** `FREDO_DOOM_DATASET_DIR=.opencode/tmp/3032/dataset` (`DOOM_DATASET_DIR_ENV`),
  fallback `FREDO_DATA_DIR` (`boot_config.rs:40`). File `doom-dataset.jsonl`; exports under `exports/`.
- **Opt-in seams:** `FREDO_DOOM_DATASET_ENABLED` (default off) and/or IPC `set_doom_dataset_enabled`
  (persists `doom_dataset_enabled`); status via `get_doom_dataset_status`.
- **Retention seam:** `FREDO_DOOM_DATASET_MAX_RECORDS`.
- **Raw/reasoning flags:** `FREDO_DOOM_DATASET_RAW`, `FREDO_DOOM_DATASET_REASONING`.
- **Export surface:** CLI `fredo doom export-dataset --format <raw|sft|dpo> --out <path>` (raw default)
  → IPC `export_doom_dataset` (`infrastructure/cli/mod.rs:133` `build_ipc_command`).
- **Retired/merged audit files:** `doom-agent-actions.jsonl` (`agent.rs:124`, cap 256, retired by ST-2),
  `doom-agent-requests.jsonl` (`doom_agent.rs:85`, cap 64, retired by ST-4).
- **Scripted decision source:** `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` +
  `FREDO_DOOM_AGENT_SCRIPT` (`decision.rs:32/34`); entries `{"steps":[…]}` (plan), legacy
  `{tics,actions}`, `{"malformed":true}`, `{"error":"…"}`, `{"delayMs":N}`, `{"stall":true}`.
- **Budgets:** `FREDO_DOOM_AGENT_MAX_STEPS` (`decision.rs:40`), `FREDO_DOOM_AGENT_MAX_FAILURES`
  (`decision.rs:43`).
- **Terminal / observation induction:** `FREDO_DOOM_FORCE_EXIT=1` (`engine.rs:1018`),
  `FREDO_DOOM_AGENT_STOP_ON_EXIT=1` (`agent.rs:164`), `FREDO_DOOM_INJECT_OBSERVATION`
  (`engine.rs:1046`), `FREDO_DOOM_DOOR_WAIT_MAX_TICKS` (`plan.rs:98`),
  `FREDO_DOOM_FAIL_PERCEPTION=1` (`perception.rs:70`).
- **Deterministic driver:** `run_bounded_driver` (`engine.rs:633`) + `FixedTickClock` (`clock.rs`).
- **Read paths (IPC):** `doom_read_state`, `start_doom_autoplay`, `stop_doom_autoplay`,
  `get_doom_autoplay_status` (`commands.rs:717`), `get_doom_dataset_status`.
- **Telemetry receipt:** `telemetry_spans` via the `telemetry-query` skill — DISCLOSED (no Doom span).
- **Scratch root:** `.opencode/tmp/3032/` (gitignored).

## Exact forcing recipes

- **R1 (REQ-1).** `.opencode/tmp/3032/agent-script-plan.json` =
  `{"decisions":[{"steps":[{"op":"move","bearing":90,"distance":256}]},{"steps":[{"op":"open-door","bearing":270}]}],"repeat":true}`;
  `FREDO_DOOM_DATASET_DIR=<scratch>/dataset`, `FREDO_DOOM_DATASET_ENABLED=1`,
  `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted`, `FREDO_DOOM_AGENT_MAX_STEPS=20`. Drive
  `run_bounded_driver` + `FixedTickClock`; parse `doom-dataset.jsonl`.
- **R2 (REQ-2).** `FREDO_DOOM_FORCE_EXIT=1` at `FREDO_DOOM_AGENT_MAX_STEPS=20` (⇒ `exited`); repeat
  for `timeout` (budget exhausted) and `aborted` (`stop_doom_autoplay` mid-run).
- **R3 (REQ-3).** `FREDO_DOOM_DATASET_MAX_RECORDS=2`; long `repeat:true` script; export after
  rotation; rotate again; re-export to prove the `export_in_progress` guard.
- **R4 (REQ-4).** `fredo doom export-dataset --format raw --out .opencode/tmp/3032/export/raw.jsonl`;
  then `--format sft` / `--format dpo`; capture process inventory + `netstat` to prove no egress; set
  `HTTP_PROXY` and confirm it is ignored.
- **R5 (REQ-5).** Leave `FREDO_DOOM_DATASET_ENABLED` UNSET (and `doom_dataset_enabled` false); re-run
  R1; assert no file. Then `FREDO_DOOM_DATASET_ENABLED=1` and re-drive.
- **R6 (REQ-6).** `.opencode/tmp/3032/agent-script-error.json` =
  `{"decisions":[{"error":"model unavailable"},{"stall":true},{"malformed":true}],"repeat":true}` with
  `FREDO_DOOM_AGENT_MAX_FAILURES=3`; drive; assert `decision:null` + typed `decisionError.kind` +
  `controller:"reflex"|"fallback"` on the executed fallback.
- **RN (NFR-1/5).** Bounded run for the byte bound; `run_bounded_driver` TWICE for the determinism
  comparison (ignore `ts`/`latencyMs`).

**Run budget:** deterministic record rows `FREDO_DOOM_AGENT_MAX_STEPS=20–200`; the live/F-LIVE leg
`FREDO_DOOM_AGENT_MAX_STEPS=30000` (shipped `DOOM_CONTINUOUS_MAX_TICKS`), ≤ 3 live iterations before
FAIL.

## Coverage

REQ-1→F-1 · REQ-2→F-2 · REQ-3→F-3 · REQ-4→F-4 · REQ-5→F-5 · REQ-6→F-6 · NFR-1→F-7 · NFR-2→F-8 ·
NFR-3→F-9 · NFR-4→F-10 · NFR-5→F-11 · REG→F-12 · live-pipeline→F-LIVE.

## Residual gaps (⚠ — resolve at convergence)

- **Action-audit retirement vs #3039 AC3 (ST-2).** `execution.replans[]` supersedes the per-line
  `{"event":"replan",…}` audit record (`agent.rs:1596-1606`).
- **`--out` resolution + "no records" typed error (REQ-4).**
- **Opt-in source of truth.** UI/UX localStorage vs the Architect's `doom_dataset_enabled` AppStore key
  — the UI toggle MUST call `set_doom_dataset_enabled`.
