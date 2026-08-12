# Mission Monitor — Functional Test Suite

Feature domain: `mission-monitor` (chat-node token counts vs opencode session context).
Seeded at triage for Spec #2711 (node token counts must equal per-message token consumption as the opencode session reports them).

Conventions: one `- [ ]` case per requirement; ID prefix `F-`. Observable expected outcomes only.
On pass keep the checkbox and append evidence; on fail mark `FAIL` with expected-vs-actual + repro.

## Prerequisites (all cases)

- The **Mission Monitor feature must be opened BEFORE the session under test is generated** — it registers its ECE contracts at mount; events generated before registration never deliver (G-012) and a missing UI is a false attribution.
- Launch the agent session via Fredo's **Run CLI** feature and **maximize** the opencode window that opens so the context / used-context meter is readable.
- OpenCode OTLP gRPC spans reach Fredo's receiver on 127.0.0.1:4317 (transport `otlp_grpc` only — no Hook transport).
- Corroborating evidence: live `telemetry_spans` query (`.opencode/skills/telemetry-query/telemetry-query.ps1`) filtered by the Run CLI session's `session_id`, extracting `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` from `attributes_json`.
- One screenshot PER AC in the `## Tests Runs` per-AC table; `n/a — not visually observable` if no visual rendering.

## Cases

- [ ] F-1: **Run CLI launch + maximized context meter.** Open Mission Monitor first (contracts registered), then launch an opencode session via Run CLI. The opencode window opens; maximize it; the context / used-context meter is visible and readable. Capture the baseline meter read (`meter_after_0`). Evidence: launch + maximized-window screenshot with meter visible. Expected: window opens, maximizes, meter visible.

- [ ] F-2: **Per-message derivation from the meter (AC1 method).** Send ≥2 messages (prefer 3). After each message completes, read the meter (`meter_after_1`, `meter_after_2`, ...) and record the reads. Derive per-message consumption: `msgN_tokens = meter_after_N − meter_after_(N−1)`. Evidence: derivation table (formula + arithmetic) + screenshot per message read. Expected: a distinct, documented per-message number for each message.

- [ ] F-3: **Node values equal derived per-message consumption (AC1).** In Mission Monitor, read each chat node's displayed prompt/completion/total. Compare: `node_N.prompt/completion/total == msgN_tokens` from F-2 (tolerance only where the meter's units differ from tokens — documented; the node-vs-span comparison must be exact). Corroborate each node against the per-message span usage in `telemetry_spans` (`gen_ai.usage.input_tokens` → prompt, `gen_ai.usage.output_tokens` → completion; total = prompt + completion). Evidence: per-node readout, per-message span query, comparison table, screenshot per node/AC. Expected: node values equal the derived per-message numbers and the span usage.

- [ ] F-4: **Values are per-message, never session-cumulative (AC2).** After the multi-message session, assert no node displays the session-cumulative context total as its own usage. For each node: `node_N.total != meter_after_last` (equal only for a single-message session). Evidence: cumulative total read vs each node readout. Expected: every node's total is strictly its own message's usage.

- [ ] F-5: **Reconciliation with session context growth (AC3).** Sum the per-message node totals and compare to the session's context growth as opencode displays it: `Σ node_i.total ≈ meter_after_last − meter_after_0` (relationship correct and sensible; residual explained only by system/tool context isolated in AC5). Evidence: reconciliation table. Expected: arithmetic holds within documented units/rounding.

- [ ] F-6: **Cumulative display derivation is explicit (AC4).** Where the displayed usage is cumulative, verify the tester's derivation (formula + raw reads + resulting per-message numbers) is explicit in evidence, and node values match the DERIVED per-message consumption (never the raw cumulative read). Evidence: derivation written out. Expected: derivation documented; node == derived number.

- [ ] F-7: **System/tool context isolation (AC5).** Real sessions include system-prompt and tool-call/result spans. Verify each node's count represents only that message's own tokens: node values match the span-level `gen_ai.usage.*` usage for that message's spans; the displayed value never includes unrelated session context (system prompt, other messages, tool payloads). Evidence: session total vs node values; span-level usage per message; screenshot per node. Expected: node total < session total; node == per-message span usage.

- [ ] F-8: **Comma formatting preserved (#2707).** Token displays ≥1000 render with comma thousands separators (`1,840`, `42,000`), locale pinned to en-US via `formatTokenCount` (`apps/ui/src/features/mission-monitor/lib/graph.ts`). No `k`/`M` abbreviation. Evidence: screenshot of a node with ≥1000 tokens. Expected: comma formatting, no abbreviations.
