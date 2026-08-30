# Mission Monitor exploratory tests

- [ ] E-2766 deep+wide: Combine four nesting levels with five or more innermost siblings; zoom out and inspect for overlap, clipping, freeze, or detached nodes. Record screenshot, DOM bounding boxes, console logs, and telemetry_spans receipt.
- [ ] E-2766 streaming: Observe a tool completing while response streams; verify the tool remains above the response and failing tool outcomes remain in chronological order.
- [ ] E-2766 orphan: Exercise an unresolved parent and verify the node is skipped rather than mis-placed; record the exact telemetry receipt.
- [ ] E-MM-1 (round 2): A new session row renders at sidebar index 0 within seconds of the first LLM span while MM is open — live streaming confirmed on R2A/R2B; arm canvas watchers (not row-list watchers) for SubagentNode witnessing.
- [ ] E-MM-2 (round 2): The FeatureStore `timestamp` of the node-creating init delivery IS the UI-appearance moment (± one React frame) — NFR-HOTP measurable without MutationObserver (promoted to event-persistence smoke S-7). DOM witnessing lags by poll cadence (R2B sighting 03:27:28.4 vs true appearance ≈03:27:17.8).
- [ ] E-MM-3 (round 2): Mission Monitor's window state persists across dev-instance cold restarts — it was found already open with the restored session list; dance steps assuming "MM closed after restart" must verify `#window-mission-monitor` presence first.
- [ ] E-MM-4 (round 2): `.react-flow__edge` elements expose NO id/data-id attributes in this ReactFlow build — NFR-DUPE receipts must key on node-id sets + edge counts.
- [ ] E-MM-5 (round 2): The agent node subtitle shows the drive's model (`build · muse-spark-1.2-contributor-free`) — a free receipt that the Run CLI model selection took effect.
