# ADR-289: Contract-Based Replay for Mission Monitor

**Status:** Accepted
**Date:** 2026-06-22
**Spec:** #289

## Context

The Mission Monitor displays agent chat sessions in both live (streaming) and replay (past session) modes. Originally:

1. Raw `FredoEvent[]` were persisted to localStorage keyed by `mm:events:${sessionId}`.
2. Replay mode reconstructed the graph from raw events using `buildGraphFromEvents()` — a separate code path from live mode's subscription-driven `processChatNodeSubscription()`.
3. Subagent nodes (from `message.part.updated` with type `agent`/`subtask`) were counted in header badges but never rendered as actual ReactFlow nodes.
4. `layoutVersion` was unconditionally incremented on every dimension change, causing infinite render loops (Spec #275).

This created a maintenance burden: two graph-building code paths that must produce identical results, raw event storage with cap/trim logic, and no subagent visualization.

## Decision

Replace raw event persistence and legacy replay with a unified contract-based architecture:

1. **Contracts replace raw events as canonical storage.** `ChatNodeContract` and `SubagentContract` objects are persisted to `mm:contracts:${sessionId}` on every lifecycle transition.
2. **Single subscription processor for live and replay.** Both modes use the same `processChatNodeSubscription()` → delivery → ReactFlow node pipeline. Replay reads stored contracts and builds nodes via `buildGraphFromContracts()`.
3. **Subagent nodes rendered in both modes.** When the subscription processor receives a `message.part.updated` with type `agent` or `subtask`, it creates a `SubagentContract` and emits a delivery, which creates a `subagentNode` connected to its parent `chatNode`.
4. **layoutVersion only increments on actual position change.** The dimension-change handler checks whether any node position changes after layout recomputation before incrementing `layoutVersion`.

## Consequences

### Positive

- Single code path for graph construction (live and replay).
- No `buildGraphFromEvents`, `buildLegacyGraph`, or raw-event parse/migrate logic.
- Subagent nodes are visible and connected to their parent ChatNodes.
- Reduced localStorage storage (contracts are structured, not event arrays).
- No cap/trim logic needed for event storage.

### Negative

- Legacy sessions stored as raw events (`mm:events:*`) are no longer readable.
- No backward compatibility for old raw-event localStorage data.
- All session data will be re-populated as contracts when live sessions run.

## Technical Details

### Data Flow

```
Live:
  StreamContext event → processChatNodeSubscription() → ChatNodeContract/SubagentContract delivery
  → ReactFlow node creation → persistContracts()

Replay:
  loadContracts() → buildGraphFromContracts() → ReactFlow nodes
  (uses same delivery-to-node pipeline)
```

### Storage

- `mm:contracts:${sessionId}` — `StoredSessionContracts` JSON blob
- `mm:sessions` — `SessionRecord[]` metadata (unchanged)

### Node Types

- `chatNode` — `ChatNode` component (existing, unchanged)
- `subagentNode` — `SubagentNode` component (new)
