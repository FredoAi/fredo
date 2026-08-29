# Event persistence regression tests

Baseline invariants ("must not change") from the #2768 plan's non-goals:

- [ ] R-1 Non-persistent contracts behave byte-identically: no rows written, no declaration validation change, no new deliveries.
- [ ] R-2 Hot path untouched: live delivery remains at-most-once and fast; zero synchronous storage work in the emit path (see F-6).
- [ ] R-3 Hydration is PULL-only: no re-broadcast on the stream channel; features already live are not spammed with re-deliveries.
- [ ] R-4 StreamContext semantics unchanged: append-only, id-dedupe, cap/TTL behavior; hydrated rows replay under original delivery ids.
- [ ] R-5 No ECE reprocessing of hydrated rows: buffer-reset (Spec #627) and re-key end+init semantics replay faithfully as-delivered.
- [ ] R-6 FeatureStore and `telemetry_spans` untouched by the contract store; separate connection/table.
- [ ] R-7 Overlapping suite: `.opencode/tests/mission-monitor/` — Mission Monitor mount-time hydration (F-1/F-2 here) must keep the mission-monitor functional/regression baselines green (chat node order, subagent layout, orphan chip zero-state).
