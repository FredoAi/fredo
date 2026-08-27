# Mission Monitor — Exploratory Tests

Unscripted probes for the Tester. A confirmed finding promotes to `functional.md` as a new `F-` row (keep the origin note).

- [ ] E-1: Rapid-fire nesting — a run where a subagent dispatches multiple `task` calls back-to-back while streaming is still in progress. Watch for node flicker, duplicate nodes, or interleaved re-keying artifacts.
- [ ] E-2: Abrupt termination — kill the agent process mid-recursion (during a 3+ level run). Does the graph retain a consistent partial state? Any stuck "streaming" indicators?
- [ ] E-3: Panel reopened mid-run — close and reopen Mission Monitor while a deep run streams. Does the rebuilt graph match the live one?
- [ ] E-4: Deeply-wide combination — 4 levels AND 5+ siblings at the innermost level simultaneously (stress both NFR dimensions at once).
- [ ] E-5: Duplicate relationship metadata — the same parent-child relationship emitted twice (re-delivery). No duplicate nodes/edges.
- [ ] E-6: Orphan with descendants — an orphaned child that itself has tool events and children. Do the descendants render safely or vanish, and is the rest of the graph intact?
