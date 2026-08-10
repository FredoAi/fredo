# mission-monitor - Functional

Durable test suite for the Mission Monitor delivery-contract consumer domain
(apps/ui/src/features/mission-monitor). Seeded at triage for #2218 (ECE delivers
ContractDelivery directly from the normalized OTLP projection; Mission Monitor
subscriptions + rendering unchanged). Cross-references: otlp-genai (Rust
receiver -> adapter -> ECE) and opencode-plugin (the emitter).

## Execution prerequisites

- dev;tauri running; OPENCODE_ENABLE_TELEMETRY=1 for every opencode run
- Unique markers: e2e-<guid> for opencode runs, qa-<guid>-* for OTLP/HTTP JSON emitter batches
- Wait >=5s after each run for pipeline flush (SpanBuffer cadence)
- fredo emit bypasses the OTLP receivers and MUST NOT be used for OTLP-path cases

## Cases

- [ ] F-1: chat-node renders from a live run
- [ ] F-2: tool + file nodes render
- [ ] F-3: subagent compositing renders
- [ ] F-4: chat-node delivery shape unchanged
- [ ] F-5: user-message Init does not complete the contract
- [ ] F-6: contract declaration is chat-only gRPC
- [ ] F-7: second-emitter spans reach the UI path
- [ ] F-8: Hook/IPC path untouched

## Spec #2449 additions

- [ ] F-9: custom-event subscription unchanged
- [ ] F-10: graph identical for the same session
- [ ] F-11: subscription declarations + matchers unchanged

## Spec #2688 additions (chat-chain rework + contract* cleanup)

- [ ] F-12: 5 consecutive prompts in one session -> exactly 5 chat nodes
  Round 3: FAIL. telemetry_spans confirms 5 fredo.llm spans (mm-r3-1..5) for Run CLI
  session ses_0138b44b7ffeyQarLIiJ5pOi9h but Mission Monitor rendered 0 agentNodes.
  Blocker: tester agent own session floods Mission Monitor with 67+ subagentNodes.
  Expected: 5 agentNodes from Run CLI session. Actual: 0 agentNodes, 67 subagentNodes
  from tester session contamination.

- [ ] F-13: vertical chain bottom-to-top with connecting edges
  Round 3: FAIL. Cannot verify - no agentNodes from Run CLI session visible.

- [ ] F-14: auto-focus newest chat node
  Round 3: FAIL. Cannot verify - no new chat nodes appeared from Run CLI session.

- [ ] F-15: detailed view shows everything incl. thoughts
  Round 2: PASS (code unchanged, ST9 backend-only)

- [ ] F-16: agent_session produces no chat-node delivery
  Round 2: PASS (code verified: eventTypes=['chat'] only)

- [ ] F-17: no contract_* files or identifiers remain
  Round 3: PASS. Repo-wide search confirms zero contract_* files outside ECE module.
  Plugin renamed: contract_601.ts -> telemetry-constants.ts, contract_633.ts -> genai-conventions.ts.

- [ ] F-18: session DBs cleaned before e2e
  Round 3: PASS. telemetry_spans purged (30797 rows). Feature store cleaned (0 sessions,
  0 events). After run: 5 fredo.llm + 5 fredo.session spans in telemetry_spans.

- [ ] F-19: reload dedups restored + live deliveries
- [ ] F-20: subagent turn still renders under chat-only contract

## Evidence-on-pass

Append telemetry-query output, DOM snapshots, screenshots, and vitest/cargo run
results under each case; every live case Evidence references telemetry_spans.
