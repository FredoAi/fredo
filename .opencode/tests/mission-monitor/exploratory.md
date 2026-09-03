# Mission Monitor — Exploratory Probes (Spec #2791 — Ghost sessions)

> Unscripted edge/failure probes. A CONFIRMED finding promotes to `functional.md` as a new `F-` case (keep the origin note).

## Probes to run beyond the script

- [ ] E-1: Rapidly toggle selection between a normal session and a ghost session — does the canvas ever show a stale or wrong-session graph (previously-selected session's nodes)? The screenshot must show the state the AC asserts (G-035): confirm the selected session via DOM before capture.
- [ ] E-2: Open a session, then let it stream more turns while selecting — does any window render a silent blank canvas (the defect) mid-stream? Cross-check DOM + `telemetry_spans` at the same instant.
- [ ] E-3: Composited / multi-hop session (delegation depth ≥ 3) — does the subagent-only or re-keyed session render a silent blank? NOTE: this behavior class may not be modelable by single-copy fixtures — require a real drive / real-corpus replay (G-088) before declaring PASS/FAIL.
- [ ] E-4: High session-count list — does the session list lag or block (per-session rescan regression, NFR-1)?
- [ ] E-5: Console check on every probe — any `Maximum update depth exceeded` or `Uncaught` is an environment/code defect to report in the verdict (invalidate the leg's evidence even if the visual assertion renders).
