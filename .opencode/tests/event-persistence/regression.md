# Event persistence regression tests

Baseline invariants ("must not change") from the #2768 plan's non-goals:

- [ ] R-1 Non-persistent contracts behave byte-identically: no rows written, no declaration validation change, no new deliveries.
- [ ] R-2 Hot path untouched: live delivery remains at-most-once and fast; zero synchronous storage work in the emit path (see F-6).
- [ ] R-3 Hydration is PULL-only: no re-broadcast on the stream channel; features already live are not spammed with re-deliveries.
- [ ] R-4 StreamContext semantics unchanged: append-only, id-dedupe, cap/TTL behavior; hydrated rows replay under original delivery ids.
- [ ] R-5 No ECE reprocessing of hydrated rows: buffer-reset (Spec #627) and re-key end+init semantics replay faithfully as-delivered.
- [ ] R-6 FeatureStore and `telemetry_spans` untouched by the contract store; separate connection/table.
- [ ] R-7 Overlapping suite: `.opencode/tests/mission-monitor/` — Mission Monitor mount-time hydration (F-1/F-2 here) must keep the mission-monitor functional/regression baselines green (chat node order, subagent layout, orphan chip zero-state).
- [ ] R-8 Collector child-keying (4a9361e): `upsertSubagentActivity` keys by the child session id (outer-payload `compositedChildSessionId` ?? `key.sessionId`); both maps child-keyed; `collectorParentByChildSession` is a true child→parent map. Round-1 FAIL anchor: parent-keyed self-map starved SubagentNodes of TOOLS and counted child tool calls as orphans (chip `⚠ 2/3`). Never regress — verified round 2 via F5/F4B re-verify + R2A/R2B live drives (chip hidden + TOOLS accordions everywhere).
- [ ] R-9 S4 seam does not blank attribution: with `FREDO_SUPPRESS_PARENT_ROUTING=1`, child spans carry NO `session.parent_id` (4/4 NOT-STAMPED, R2B) AND Mission Monitor still renders the SubagentNode with its TOOLS accordion and 0 orphans (legacy Hook task-relationship path). Verified round 2 (live).
- [ ] R-10 Mixed delivery shapes collapse per correlationId: the same child call delivered child-keyed (F1-era) and composited (re-key end+init replay) must merge into ONE collector entry — no double count. Unit: useMissionMonitor.test.ts "Spec #2768 round 3" cases (a)-(d), 96/96.
- [x] R-6 (evidence note) FeatureStore survives contract pruning — round-2 live proof: F5's `contract_events` rows fully pruned (cycle 2) yet the MM graph hydrated completely from `feature_mission_monitor_events`. The stores are independent; "prune ⇒ empty UI" assertions are wrong.
