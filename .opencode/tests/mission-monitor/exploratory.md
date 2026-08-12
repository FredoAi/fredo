# Mission Monitor — Exploratory Tests

> Unscripted probes the Tester runs beyond the scripted suites; a confirmed finding PROMOTES to
> `functional.md` (with origin note). IDs: `E-<n>`.

- [ ] E-1 Long-session live probe: run a 20+ turn agent session with the monitor open — watch for node count explosion, layout drift, scroll/zoom jank, or memory growth over time (R5 NFR).
- [ ] E-2 Resize edge probes: resize the detail panel while the agent is mid-stream (does the graph jitter?), resize to minimum/maximum, resize with reduced-motion enabled.
- [ ] E-3 Scroll interplay probes: wheel over the response box's scrollbar vs its text area vs the node title/chrome — map exactly where canvas-zoom does and does not trigger.
- [ ] E-4 Token-format edge probes: a session whose span reports fractional/negative/absurd token counts (e.g. -1, 12.7 via OTLP) — what does the monitor render?
- [ ] E-5 Multi-session title probe: switch between sessions with different agents/models mid-stream — stale titles? flicker? wrong identity on composited subagent nodes?
- [ ] E-6 Restart-without-graceful-shutdown: kill the app while a session is live, relaunch — does the remembered panel width and the persisted graph both survive?
- [ ] E-7 Rapid @-subagent dispatch: dispatch several subagents in quick succession — spurious nodes, wrong parent edges, or duplicates (regresses R-9/R-7)?
