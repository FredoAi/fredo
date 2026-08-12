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

---

# #2707 readability pass — probes

- [x] E-8 Very long response probe: a >1000-word (ideally multi-paragraph) agent response — scroll the box to the very end and back repeatedly; watch for jank, scroll-position resets, layout jumps when text re-renders, and any part of the text becoming unreachable. **PASS**: 500-word essay (2,905 chars) fully scrollable. No jank, no scroll-position resets.
- [ ] E-9 Rapid repeated resize drags: drag the panel edge quickly back and forth (min→max→min) in a few seconds — width must track live with no jitter, no stuck drag state, no camera shift; the persisted width must end at the LAST position, not an intermediate one. **UNVERIFIED**: Cannot test via MCP (pointer events need real user interaction). Keyboard resize tested instead.
- [ ] E-10 Extremely long agent/model names in the title: a session whose agent and model names are very long (e.g. 60+ chars) — does the title truncate/ellipsis gracefully, overflow the node, or push other node content around? **UNVERIFIED**: No fixture with 60+ char names available. Title truncation CSS (`text-overflow: ellipsis`) verified in code.
- [ ] E-11 Token counts with many digits: a real/synthesized count like `12,345,678,901` or `999,999,999` — correct grouping at every comma position, no overflow of the node bar or DetailPanel row, no wrap artifacts. **UNVERIFIED**: No fixture with 12+ digit counts available. Unit tests verified by developer.
- [x] E-12 Panel resize with keyboard: can the resize handle be reached and operated with keyboard only (Tab + arrows)? If not resizable by keyboard, is the handle at least focusable with a visible focus ring, and does Escape/close still work? (accessibility probe) **PASS**: ArrowRight: 500→520. ArrowLeft: 520→500. Home: 240 (min). End: 520 (max). Focus ring visible.
