# doom-native — Exploratory Test Cases (Spec #3023)

> Unscripted edge/failure probes for the native-Doom rewrite. The Tester adds probes here as they
> work; a confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).
>
> **Verification policy: live** — probes run against the running artifact; record DOM/screenshot/
> process/port receipts and the `telemetry_spans` live-pipeline reference (app-pool read preferred,
> G-307; managed `psql` fallback DISCLOSED, G-284). Doom emits no span — DISCLOSE. A static-only
> observation is not a finding.
>
> **G-300:** every error/failure probe names an in-repo induction lever (`FREDO_DOOM_FAIL_ENGINE_SPAWN=1`,
> a `FREDO_DOOM_WAD_PATH` copy under `.opencode/tmp/3023/wad/`, the scripted autoplay lever, a
> hard-kill) or is marked a static/unit pin, non-AC.
>
> **Step-driven (G-316):** "advances" probes drive a step through the parity surface, then re-sample —
> never idle motion.

## Prompt lines

- [ ] E-1: Rapid open/close/open while the native engine is `starting` — does a stale window, a second
  engine instance, or a leaked thread accumulate? (Lever: close while `starting`; poll process inventory.)
- [ ] E-2: Close the window at the exact instant a step/advance is in flight — clean teardown with no
  panic, no orphan, no hang? (Lever: native close during a driven step.)
- [ ] E-3: Hard-kill Fredo mid-`ready`, then relaunch — is any leftover reclaimed, and is a reused
  unrelated PID never killed? (Lever: hard-kill + relaunch.)
- [ ] E-4: Two simultaneous observation reads / step calls — is the control surface internally
  consistent with no interleaving corruption? (Lever: rapid IPC calls.)
- [ ] E-5: Corrupt the WAD copy mid-run (truncate under `FREDO_DOOM_WAD_PATH`) — does the runtime
  degrade to a typed error without crash/orphan? (Lever: WAD-path copy.)
- [ ] E-6: Boot with a stale save at an OUT-OF-SET coordinate (e.g. `episode=4`) — is it rejected
  (clean E1M1 start) rather than resumed? (Lever: `FREDO_DOOM_SAVE_STATE_DIR` fixture.)
- [ ] E-7: Enter the mode, then reject/allow the companion decision path — does a malformed/error
  decision leave the run bounded without stalling? (Lever: scripted decision lever.)
- [ ] E-8: Theme/light-dark on the new `error` panel — token-native only, no hardcoded hex; panel/
  icon/label clear contrast on the Doom near-black grounds in both themes.
- [ ] E-9: The `doom` window is open when the app exits — do the Doom + llama-server + PG exit hooks
  all complete within their bounds? (Lever: `RunEvent::Exit`.)
- [ ] E-10: Offline boot (network disabled) from a truly-cleared install dir — any residual attempt
  to download or build? (Lever: fresh scratch + no network.)
- [ ] E-11: Drive a frame/observation gap (a slowed step) — does the surface keep the last frame and
  show `doom-frame-reconnecting` rather than entering `error`? (Lever: step cadence.)
- [ ] E-12: Retry spam on the error panel (rapid clicks) — never more than one engine attempt; no
  orphan; the error/ready state settles correctly. (Lever: F-11/F-12 seen, then Retry.)
