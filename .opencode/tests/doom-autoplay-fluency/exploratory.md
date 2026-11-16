# doom-autoplay-fluency — Exploratory Test Cases (Spec #3026)

> Unscripted edge/failure probes for the continuous-motion / frame-transport / pacing changes. The
> Tester adds probes here as they work; a confirmed finding **promotes** to `functional.md` as a new
> `F-` row (keep the origin note).
>
> **Verification policy: live** — probes run against the running artifact; record DOM/screenshot/
> process/port receipts and the `telemetry_spans` live-pipeline reference (app-pool read preferred,
> G-307; managed `psql` fallback DISCLOSED, G-284). Doom emits no span — DISCLOSE. A static-only
> observation is not a finding.
>
> **G-300:** every error/failure probe names an in-repo induction lever (the scripted decision
> source `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT` →
> `.opencode/tmp/3026/agent-script.json`; a delay/stall entry; `FREDO_DOOM_FAIL_ENGINE_SPAWN=1`;
> a hard-kill) or is marked a static/unit pin, non-AC.
>
> **Seam-driven (G-316):** every "advances over time" probe is STEP-DRIVEN through the injectable
> clock/tick seam and the ST-9 driver — never an idle-frame / wall-clock motion assertion.

## Prompt lines

- [ ] E-1: A decision returns *just as* the tick loop is mid-window — is there any interleaving
  corruption (a torn frame, a double-applied action, a skipped tick)? (Lever: delay entry tuned to
  land mid-window.)
- [ ] E-2: Close the window while a decision is in flight — clean bounded teardown, no panic, no
  orphan, no hang? (Lever: stall entry + native close.)
- [ ] E-3: The model answers in a slow trickle (partial answers) — does the degraded cadence floor
  hold and the max-frame-gap bound never trip? (Lever: delay entry with small values.)
- [ ] E-4: Model unavailable, then recovers — does the run climb back to the normal tick cadence
  without a frozen gap? (Lever: scripted sequence ending in valid decisions.)
- [ ] E-5: The held action is empty (`actions:[]`) for many ticks — does the world still advance
  (or degrade) without stalling? (Lever: script with `{tics:1,actions:[]}`.)
- [ ] E-6: A safety-reflex override chained repeatedly (wall, wall, wall) — does the reflex keep
  the run moving without itself driving into a hazard? (Lever: repeated forward-into-wall script.)
- [ ] E-7: Fire is held while a target appears mid-window — does fire resume (the reflex must not
  latch permanently off)? (Lever: position/target transition.)
- [ ] E-8: Rapid open/close/open while the run is degrading — does a second tick worker/loop
  accumulate, or a leaked thread appear? (Lever: close while degraded; poll process inventory.)
- [ ] E-9: Two runs of the ST-9 driver with the SAME script but a different map — do the reports
  differ (sanity) and remain internally deterministic across repeats? (Lever: `DoomDriverConfig.map`.)
- [ ] E-10: A render stall (a tick with no new frame) — does the canvas keep the last frame and
  flag a transient note rather than entering `error`? (Lever: injected clock holding one tick.)
- [ ] E-11: Theme/light-dark on any transient note shown during degrade — token-native only, no
  hardcoded hex; contrast on the Doom near-black grounds in both themes.
- [ ] E-12: The `doom` window is open when the app exits mid-degrade — do the Doom + `llama-server`
  + PG exit hooks all complete within their bounds? (Lever: `RunEvent::Exit`.)
- [ ] E-13: Retry-idempotency under degrade — restarting autoplay while degraded never starts a
  second tick worker; exactly one loop. (Lever: `start_doom_autoplay` while running.)
