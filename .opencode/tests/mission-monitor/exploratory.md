# Mission Monitor — Exploratory Suite (Spec #2700)

Unscripted probes beyond the scripted cases. A confirmed finding PROMOTES to functional.md
(new F- row, keep origin note).

- [ ] E-1: Rapid streaming — start a multi-turn run and let nodes arrive as fast as possible;
      watch camera behavior for jarring jumps, oscillation, or center drift; note the worst
      observed case.
- [ ] E-2: Long run — run 50+ turns; check chain ordering at the top, middle, and bottom, and
      interaction responsiveness near the end.
- [ ] E-3: Mid-stream token display — during streaming (before usage attributes land), record
      what each node shows; confirm the finalized value on the end delivery.
- [ ] E-4: Subagent-only turn — a turn producing a SubagentNode only; confirm the subagent's
      span tokens never bleed into the parent chat node.
- [ ] E-5: Interleaved sessions — two sessions producing nodes alternately; confirm chains
      never cross.
- [ ] E-6: Compaction + ordering — compacted session mid-run; confirm order and token figures
      survive compaction styling.
- [ ] E-7: Persistence restore mid-session — kill and restart the app while a run is active;
      check ordering and token figures on the restored graph.
- [ ] E-8: Zero-usage spans — a turn with no `gen_ai.usage.*` on its `fredo.llm` span; confirm
      the node shows 0 and the NEXT turn doesn't inherit the previous figure.
