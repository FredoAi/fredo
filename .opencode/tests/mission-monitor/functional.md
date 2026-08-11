# Mission Monitor — Functional Suite (Spec #2700)

Durable per-feature functional cases for #2700 (chat chain direction flip, auto-fit/center
on new node, per-node token accuracy). One `- [ ]` case per requirement, observable expected
outcome. Live environment: Tauri dev instance + real opencode agent run (OTLP gRPC →
127.0.0.1:4317) + telemetry-query skill for ground truth.

Test data: multi-turn agent run (≥5 distinct prompts) producing `fredo.llm` spans with
per-turn `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` in `telemetry_spans`;
a second run for multi-session cases. Isolation: `e2e-` session-id prefix.

- [ ] F-1 (REQ-1/AC1): Top-to-bottom chat chain in a completed conversation — oldest chat
      node is the TOP of its session's vertical chain; every later node renders strictly
      below the one before it; dashed `chat` edge links each node down to its successor.
      FAIL if any node appears above an older one.
- [ ] F-2 (REQ-1/AC4): Multi-step run (≥5 turns) — top-to-bottom order holds at every chain
      position; no reordering as new nodes arrive.
- [ ] F-3 (REQ-1 edge): Multiple sessions — each session's chain is independent and never
      interleaves with another session's nodes.
- [ ] F-4 (REQ-1 edge): Session switch away and back — order is preserved on remount/restore,
      no duplicate or reordered nodes.
- [ ] F-5 (REQ-2/AC2): Auto-fit+center — every new chat node (2nd and later) is automatically
      centered mid-screen during a live run with no manual interaction; reliable for each
      successive node.
- [ ] F-6 (REQ-2 edge): First node of a session follows the Architect-specified behavior
      (initial-load fitView, no per-node center) — assert per the plan.
- [ ] F-7 (REQ-3/AC3): Per-node token accuracy — for every chat node, displayed
      `X in / Y out / Z total` equals that turn's `fredo.llm` span `gen_ai.usage.input_tokens`
      / `output_tokens` / sum from `telemetry_spans`; never session-cumulative.
- [ ] F-8 (REQ-3 edge): Zero/missing usage — a turn whose span carries no `gen_ai.usage.*`
      renders 0, never a stale or cumulative figure.
- [ ] F-9 (REQ-3 edge): Persistence reload — restored deliveries render the same per-turn
      token figures as the live run.
- [ ] F-10 (REQ-3): Header counter consistency — if a session-level token counter is retained,
      it equals the sum of per-node per-turn values.
