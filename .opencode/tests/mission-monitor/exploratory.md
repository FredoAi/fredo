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

## Spec #2688 additions (chat-chain rework + contract* cleanup)

- [ ] E-10: Send a new prompt while the previous response is still streaming - exactly one node per prompt, no interleaving dupes
- [ ] E-11: Reload the app mid-session with persisted deliveries - restored + live merge yields exactly the same node set (dedup by delivery id)
- [ ] E-12: Subagent dispatch turn under the chat-only contract - SubagentNode still renders linked to its parent chat node
- [ ] E-13: A session with zero chat spans (only session/tool spans) - no phantom chat node created

## Spec #2694 additions (debounce, zoom, token edge cases)

- [ ] E-14: burst straddling the debounce window - 4 nodes where the 4th arrives >300ms after the 3rd; expect exactly TWO pans (one per burst), each landing on its burst's last node
- [ ] E-15: continuous streaming at ~1 node/250ms for ~10s (emitter) - pans at ~300ms cadence, one per burst, no camera thrash, zoom constant throughout
- [ ] E-16: zoomed way in (e.g. 200%) during a live burst - no zoom reset; pan-only follow of the newest node
- [ ] E-17: token source reports only a combined total (no in/out split) - what does the badge render? (n/a vs dashes vs total-only) - promote the confirmed state to functional.md
- [ ] E-18: negative / NaN usage values in telemetry - badge never renders negative or NaN numbers; falls back to dashes or `tokens n/a`
- [ ] E-19: reload mid-session after the flip - restored + live-merged nodes keep top-to-bottom order and per-turn counts
- [ ] E-20: very long chain (50+ turns) - vertical scroll remains smooth; auto-focus still lands on the newest (bottom) node without excessive jumps
- [ ] E-21: mixed session (some turns with usage, some unavailable) - each node renders its own correct state; no state bleeds across nodes
- [ ] E-22: aria-live region content - after a burst, the live region contains exactly one announcement with the truncated message text; no announcement on initial load

