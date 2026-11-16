# Companion Embedded Engine — Exploratory

> Unscripted edge/failure probes for the in-process engine (Spec #3141). Confirm a finding, then
> promote it to `functional.md` as a new `F-` row (keep the origin note). A confirmed defect is a
> `## Tests Runs` FAIL; a non-drivable probe is a named blocker, never a PASS.

- Probe: what happens when a second chat turn is sent while the first is still streaming? Is it
  queued, or refused with a typed `Busy`? (NFR-2 — one generation at a time.) Does the refused
  turn still settle with exactly one `llm-done`?
- Probe: toggle the backend mode mid-stream / mid-start — does the change apply cleanly on the
  next start, or does it corrupt an in-flight turn?
- Probe: pull a model file aside *while* the engine is loaded, then send a turn — typed
  `ModelMissing`, or an abort? Does the app survive? (NFR-8: no process-level fault containment
  is promised — a ggml abort takes Fredo down; observe and record, don't assume.)
- Probe: `FREDO_COMPANION_FORCE_CPU=1` with mode `auto`, then remove the lever mid-session and
  restart — does the reported backend reconcile to the natural device set?
- Probe: set `llama_server_backend` to a JSON object / an array / `"GPU"` / whitespace — does it
  coerce to `auto` without a crash and without reaching the engine?
- Probe: start the engine, then `stop_llama_server` twice in a row — is the second stop a clean
  no-op, or does it error?
- Probe: start the engine with `mmproj` present but `mtp` missing — does vision still work and
  does MTP fail typed (`MtpInitFailed`), or does the whole start fail? Record which.
- Probe: a very long generation (≥ ~300 output tokens) through the in-process tokenizer — are
  multi-byte characters ever torn across `llm-token` emissions? (The shipped
  `drain_complete_lines` guarantee must be reproduced at the token boundary.)
- Probe: vision turn with an image that has no text content; audio turn with a zero-length clip.
- Probe: two isolated envs each select a different backend mode — does each report its own?
- Probe: an offline fresh install where the model download cannot complete — what does the
  wizard say, and does `check_companion_readiness` stay `false` with a readable cause?
- Probe: **not-ready-state reachability of the backend control (AC-25's recovery path).** Take the
  machine to a not-ready state two ways and compare: (a) model files **installed** + `gpu`
  unsatisfiable (`FREDO_COMPANION_FORCE_CPU=1`, `llama_server_backend="gpu"`) — the engine group
  must be **present and operable below the wizard** (`data-testid="companion-backend-mode"`), and
  switching to `cpu` then `Start companion engine` must recover; (b) model files **missing** —
  the control must be **absent** (only `Download model files`). Does a change to the persist /
  branch logic ever re-hide the control in case (a)? That is the AC-25 dead end returning.
