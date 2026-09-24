# GitHub Copilot CLI Capture — Exploratory Probes (Spec #2933)

> Unscripted probes for the Tester. Each is a `- [ ]` prompt; a confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note). Run after functional + smoke.

## Content / extraction shapes

- [ ] E-1: With content disabled, is the degradation marker present on EVERY row class (chat/tool/session), or only chat — and is it the same marker the plan documents?
- [ ] E-2: A tool call whose arguments are hidden but whose result IS present (or vice versa) — do the tool row's fields degrade independently, or does one masked field blank the other?
- [ ] E-3: A very long prompt / a multi-part message array — is the extracted `userMessage` truncated, empty, or the first text part only? Compare with the OpenCode extractor's behavior.
- [ ] E-4: A prompt that triggers multiple tool calls in one turn — are all tool rows produced, and do their correlation ids stay distinct (no collapse into one key)?

## Identity / keying

- [ ] E-5: Force a Copilot session-id pattern that looks like an OpenCode id (`ses_…`) — does any key collide, or does the provider + session namespace keep them separate?
- [ ] E-6: A Copilot session that also carries a `session.parent_id` (subagent/child) — does it composite under a parent, and does the compositing preserve `provider`?
- [ ] E-7: Resume a Copilot session across a Fredo restart — do rows upsert (no duplicates) and does `seq` continue monotonically, or does it restart/collide?
- [ ] E-8: Deliver the same exchange twice with an identical `correlationId` — are rows deduped by composite key, or is a parallel row created at the same `startedAtNs` (the #2932 F-11 parallel-row class)?

## Degradation / failure

- [ ] E-9: Strip/deny the credential env at capture time — is the failure non-silent, and are NO partial/empty rows written?
- [ ] E-10: Hit a free-tier quota/rate limit mid-turn (before tool response) — what does the row store show, and does a later retry duplicate the turn?
- [ ] E-11: Kill the Fredo IPC socket during a hooks-mechanism capture — does the Copilot turn stall, error, or proceed (non-blocking hook)?
- [ ] E-12: Run capture with the OTLP receiver unavailable (native-export mechanism) — is the drop observable (a log/signal), never a silent zero-row result?

## Latency / ordering

- [ ] E-13: Order-of-arrival: response before init, or tool response before tool init — does the classifier still produce a coherent row (no orphan/empty)?
- [ ] E-14: High-volume burst (many Copilot spans in one export) — do all rows land, and do batches chunk correctly (>512 rows) without loss?
- [ ] E-15: Ingest latency — a Copilot row visible within the OpenCode flush-cadence bound; record both.

## Mechanism-dependent (`[mech]`)

- [ ] E-16: If BOTH mechanisms can run at once (hooks + native export), does a single Copilot turn produce DUPLICATE rows (same turn captured twice)? This is a real cross-transport dedupe risk — probe it explicitly.
- [ ] E-17: Does the captured `model` value match the actual Copilot model for the turn, or a static/default value?
