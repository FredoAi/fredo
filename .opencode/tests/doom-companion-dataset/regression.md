# doom-companion-dataset — Regression Test Cases (Spec #3032)

> Durable regression suite (feature domain `doom-companion-dataset`). The "must-not-change"
> baseline for the **fine-tuning dataset export** slice (#3032) and links to the overlapping Doom
> suites. #3032 ADDS a local per-decision JSONL dataset under the app-data dir and REPLACES/MERGES
> the two capped audit files (`doom-agent-requests.jsonl` cap 64, `doom-agent-actions.jsonl` cap
> 256). It is **opt-in** and must not alter the autoplay loop's decision/step behaviour, the
> `doom_plan` execution contract (#3039), the observation contract (`walls`/`forward`), the
> decision-source seams, or the game-only `doom` window.
>
> **Verification policy: live** — each run needs the live-pipeline `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) plus file/DOM/IPC receipts per leg. The Doom loop emits no span. A
> static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **Autoplay behaviour unchanged when the dataset is OFF** — with the opt-in disabled (or
  absent), the continuous loop's `decisions`/`steps`/`plans`/`replans`/`planIndex` and the
  in-window status surface behave byte-identically to today. The dataset must observe, never
  mutate, the loop. (Links: `doom-companion-planning/functional.md` F-2, F-3; the loop at
  `applications/doom/agent.rs run_continuous_loop`.)
- [ ] R-2: **#3039 `doom_plan` execution contract intact** — the plan is still executed one step
  per tick; doors are still first-class (`OpenDoor` presses `use` and waits for
  `state=="waiting"`); the five re-plan reasons (`blocked|noProgress|frontEnemy|doorClosed|
  exhausted`, `plan.rs:107-133`) still fire; `plans`/`replans`/`planIndex` are unchanged. The
  dataset records this contract — it does not replace it. (Links:
  `doom-companion-planning/regression.md` R-1/R-2.)
- [ ] R-3: **Observation contract intact, `forward` additive/bounded** — the observation still
  carries the S1 `walls` triple + the additive `forward` sensor (`rays` ≤ 9, `openings` ≤ 8,
  `doorBearings` ≤ 8, `exitBearing`; `perception.rs:76-85`), present and bounded. The dataset
  records `forward` verbatim; it does not redefine it. (Links:
  `doom-observation-geometry/regression.md` R-1/R-2.)
- [ ] R-4: **Decision-source seams unchanged** — `ModelDoomDecisionSource`
  (`applications/llm_server/doom_agent.rs`) and the scripted lever still parse the SAME plan via
  the shared `parse_doom_plan`; `chat::build_response_format_request_body` and every OTHER
  `llm_server` consumer stay byte-identical. The retired audit writers' remaining callers (if any)
  keep their behaviour. (Links: `doom-companion-progress/regression.md` R-4.)
- [ ] R-5: **Determinism preserved** — `run_bounded_driver` + `FixedTickClock` still reproduce a
  run; the dataset writer introduces no RNG and no wall-clock dependence into the loop
  (its `at` timestamp is the only non-deterministic output and lives in the file, not the loop).
  (Links: `doom-companion-planning/regression.md` R-3, `doom-native/`.)
- [ ] R-6: **Game-only `doom` window unchanged** — the `doom` window renders ONLY `doom-root`,
  `doom-frame-canvas`, `doom-frame-desc` (+ the minimal transient states and `doom-autoplay-note`);
  the dataset adds NO chrome. (Links: `doom-mode/regression.md`.)
- [ ] R-7: **No process leak / no orphan / no new listener** — the dataset + export path adds no
  thread, no child process, and no network listener/outbound socket; across every leg only
  `fredo.exe` is in the process inventory. (Links: `doom-native/regression.md` R-6.)
- [ ] R-8: **Opt-in isolation** — enabling/disabling the dataset never changes the *content* of a
  decision, a plan, an executed action, or a terminal outcome; it only toggles record writing.
  (Links: `doom-companion-planning/functional.md` F-1/F-4.)
- [ ] R-9: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL ready;
  the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns; the dataset
  writer flushes/rotates within the bounded stop path. (Links: `postgres-lifecycle/`,
  `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-companion-planning/` — the #3039 plan-execution + doors-first-class +
  `forward` slice the dataset RECORDS (the closest baseline for the record's plan/execution/replan
  fields).
- `.opencode/tests/doom-companion-progress/` — the #3031 escape/unstick + local-locomotion slice
  the loop retains; the closest baseline for the loop the dataset observes.
- `.opencode/tests/doom-observation-geometry/` — the #3030 bounded `walls` geometry + the `forward`
  sensor the dataset stores verbatim.
- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the ST-9 deterministic driver
  (`run_bounded_driver`), the baseline for engine/determinism and no-egress/no-orphan.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/theme/save).
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — the model-serving the
  decision leg depends on, and exit-hook co-existence.
