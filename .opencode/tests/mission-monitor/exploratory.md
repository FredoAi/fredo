# mission-monitor - Exploratory

Unscripted probes for the Mission Monitor delivery domain. Run after functional +
smoke; promote any confirmed finding to `functional.md` as a new `F-` row (keep the origin note).

## Probes

- [ ] E-1: gRPC second emitter (if a client is available on the test machine) - non-opencode OTLP gRPC client to 127.0.0.1:4317; spans persist + deliveries flow (provider-agnosticism on the gRPC leg)
- [ ] E-2: 3 rapid opencode runs back-to-back - zero dropped spans across the burst; session sidebar shows all three sessions
- [ ] E-3: subagent with LATE relationship metadata (PostToolUse task after child session.created) - SubagentNode still appears (re-key end+init) and no duplicate/orphan child session lingers in the sidebar
- [ ] E-4: >10k distinct child sessions in one process lifetime - registry eviction (`engine.rs:739-745`) drops oldest-first without losing deliveries or crashing
- [ ] E-5: emitter batch with an open (never-completed) span - row persists on receipt; no orphan-sweep ERROR rewrite of the raw identity
- [ ] E-6: batch with duplicate spanIds - idempotent upsert (no double count, no error), QA-25 count stays exact
- [ ] E-7: `deliveryCorrelationId(d) !== deliverySessionId(d)` detection on a composited delivery - subagent node created on `init` even when the parent session re-keyed mid-stream

## Spec #2449 additions (re-open of #2218)

- [ ] E-8: Concurrent gRPC + HTTP exports with overlapping spanIds - no crash, no double count, no lost rows (store-write race)
- [ ] E-9: Rapid same-session deliveries across both OTLP legs - init before update before end ordering preserved per composite key
