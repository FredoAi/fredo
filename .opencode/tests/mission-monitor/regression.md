# Mission Monitor — Regression tests

> Feature domain: `mission-monitor`. These pin the invariants that MUST NOT
> regress as a result of the #2835 perf fix. A regression is a FAIL.
>
> Executable unit gates: `rowPatchPipeline.test.ts`, `corpusParity.test.ts`,
> `useMissionMonitor.realCorpus.test.ts`, `buildGraph.test.ts`,
> `layout.chain-parity.test.ts`, `lateCompletion.test.ts`,
> `useMissionMonitor.test.ts`, `useSessionHistory.test.ts`.

## R-01 RTDB row-pipeline mapping + ingest classification unchanged
- The row-derivation mapping (chat/tool → typed columns) and ingest
  classification (`rtdb/ingest.rs`, `attrs.rs`) are UNCHANGED — `corpusParity`
  derives the byte-identical node set + edge set as the v1 golden
  (`v1Golden.json`) after the fix.

## R-02 #523 row-native compositing + `compositedChildSessionId` preserved
- Child-session rows remain COPIED under the parent key carrying
  `parentSessionId` + `compositedChildSessionId`; a re-key NEVER removes rows;
  `remove` only from retention eviction. The multi-hop real-corpus
  (`realCorpus.ts`) depth-3 nested SubagentNode STILL presents correctly.

## R-03 #509/#523 subagent-agent-name filter preserved
- Internal tool-execution agents (`build`/`plan`) STILL create NO SubagentNode
  and NO embedded tool item; the skipped dispatch is exempt from the orphan
  count.

## R-04 Contract-trust — NO fallback extraction reintroduced
- The graph reads fields at their single typed path; no `??` fallback chains,
  no multi-path lookups, no event-level rewrite, no v1 hydration machinery
  reinstated (Spec #568 cleanup not regressed).

## R-05 No re-render loop (epoch-based recomputation)
- Recomputations key on the monotonic row-store `epoch` primitive — no
  `.length` / newly-created object-ref `useEffect`/`useMemo` deps. No
  `Maximum update depth exceeded` / no infinite re-render trace.

## R-06 No cross-feature imports; theming tokens only
- No imports from other features; no hardcoded hex/rgba; no
  `var(--token)NN` alpha-append (use the shared `tint()`/`color-mix()`).

## R-07 Chat subscription is SINGLE (deduped — sub-task 2)
- Only ONE `useEventRows('Chat', …, { replay: true })` exists per panel mount
  (the panel's); `useDeliverySessions` consumes it via `chatRows` and opens no
  second replay leg. First-open Chat replay = 14,011 inserts (not ×2).

## R-08 Graph rebuild is selected-session-scoped (sub-task 1 / R-2.c)
- The association pass processes ONLY the selected session's calls; the layout
  operates on the selected session's chain + companion geometry. The derivation
  over OTHER sessions' nodes does not drive the canvas.

## R-09 No d3-force on the chain rebuild (sub-task 3)
- `computeForceLayout` is NOT invoked on a chain structure change; the positions
  are pure closed-form chain + subagent companion geometry (the chain-parity
  goldens are byte-identical).

## R-10 `replayCompleteQueryId` / `useEventRows.ready` settle preserved
- The narrowed replay (sub-task 4) still resolves `ready` on the terminal
  marker; a subscribe failure still opens the gate on `error !== null`.

## R-11 Wire / replay volume bounded (AC1 / R-1)
- First-open replay is a single Chat leg (deduped) + a narrowed recent-window
  ToolUse/Chat; emitted batch count and IPC size are measurably BELOW the
  BEFORE (`main`) baseline (≈89 batches → ≤40 target).

## R-12 No window-manager / launcher / theming regression (R-4 / AC4)
- `tauri_manage_window` list/resize/focus/min/max succeed; the CLI launcher
  (Run CLI) launches; the theming resolves from semantic tokens/CSS vars only.

*Authored by Developer (sub-task 7)*
