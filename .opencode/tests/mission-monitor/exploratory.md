# Mission Monitor — Exploratory Probes (Spec #2791 — Ghost sessions)

> Unscripted edge/failure probes. A CONFIRMED finding promotes to `functional.md` as a new `F-` case (keep the origin note).

## Probes to run beyond the script

- [x] E-1 (PASS 2026-09-02 #2791): Rapidly toggle selection between a normal session and a ghost session — does the canvas ever show a stale or wrong-session graph (previously-selected session's nodes)? The screenshot must show the state the AC asserts (G-035): confirm the selected session via DOM before capture. — Selected parent (normal: ChatNode+SubagentNode) → child (ghost explanatory state) → parent (normal) — each canvas updated correctly, no stale/wrong-session graph. Confirm per-switch via DOM.
- [x] E-2 (COVERED-NOTE 2026-09-02 #2791): Open a session, then let it stream more turns while selecting — does any window render a silent blank canvas (the defect) mid-stream? Cross-check DOM + `telemetry_spans` at the same instant. — Two completed fixtures observed post-landing: content-or-explanation at every selection; no silent-blank window at the landed-rows stage (ghost renders the explanatory state, never a blank). Mid-stream streaming windows not separately observed (fixtures drove to completion before selection).
- [x] E-3 (PARTIAL 2026-09-02 #2791): Composited / multi-hop session (delegation depth ≥ 3) — does the subagent-only or re-keyed session render a silent blank? NOTE: this behavior class may not be modelable by single-copy fixtures — require a real drive / real-corpus replay (G-088) before declaring PASS/FAIL. — Single-hop subagent/composited class covered (a `task`-tool child session is listed but renders zero nodes → ghost; child composites under parent's SubagentNode). The delegation-depth-≥3 multi-hop re-key class was NOT exercised in a single drive (opencode ran tools in-session for the primary, no depth-≥3 tree spawned). REMAINS OPEN for the depth-≥3 class — a real-corpus replay of a prior depth-≥3 session is the closest decisive path; not covered this round.
- [x] E-4 (PASS 2026-09-02 #2791): High session-count list — does the session list lag or block (per-session rescan regression, NFR-1)? — 13 listed sessions rendered without visible lag; selection switches were immediate (single map pass, no per-session rescan).
- [x] E-5 (PASS 2026-09-02 #2791): Console check on every probe — any `Maximum update depth exceeded` or `Uncaught` is an environment/code defect to report in the verdict (invalidate the leg's evidence even if the visual assertion renders). — `tauri_read_logs source="console"` clean after every interaction (no Error/Uncaught/Maximum update depth).

---

# Mission Monitor — Exploratory Probes (Spec #2792 — Tool-failure reason in detail view)

> Unscripted edge/failure probes for the tool-failure-reason surface. A CONFIRMED finding promotes to `functional.md` as a new `F-` case (keep the origin note).

## Probes to run beyond the script

- [ ] E-6 (OPEN): Rapidly open/close the detail view across a failed and a succeeded tool — does the reason row ever linger on a now-selected successful call, or show a reason from a previously-selected call (stale `call` reference)? The screenshot must show the state the AC asserts; confirm the selected call via DOM before capture.
- [ ] E-7 (OPEN): A very long error message (multi-KB, many newlines, special characters) — does the reason row render within the panel without overflow and without breaking the panel layout?
- [ ] E-8 (OPEN): A session containing the failed-no-reason tool (`success:false`, empty error) — does it render the explicit absent-reason placeholder on first open AND after re-selecting the session (no silent blank, no stale "succeeded" state)?
- [ ] E-9 (OPEN): Live streaming — open the detail view for a tool still in-progress, let it complete as a failure that gains a reason — does the reason row appear without a re-render loop or a flash of a stale/blank state?
- [ ] E-10 (OPEN, confirmed finding promotes to functional): Theme/accent override — does the reason row and placeholder re-tint with the user accent (no hardcoded hex) across light/dark? A fixed non-token color is a defect (NFR-1).
- [ ] E-11 (OPEN): Open the detail view from a `build`/`plan` internal tool-execution context — is it correctly NOT surfaced as a subagent node, and does the reason still render on the parent's tool list if applicable (subagent filter regression, Spec #509)?
