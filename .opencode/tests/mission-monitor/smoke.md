# Mission Monitor smoke tests

- [ ] S-2766 app/feature: Dev instance serves the required spec commit, Mission Monitor opens, and the Run CLI window launches only after Mission Monitor is mounted.
- [ ] S-2766 console: Read the webview console before and after each streaming fixture; no Error, Uncaught, or Maximum update depth exceeded.
- [ ] S-2766 live receipt: Every live visual fixture has a marker-resolved provider session id and a telemetry_spans tree matching the rendered node set 1:1.
- [x] S-2766 app/feature — exercised round 2 (#2768): instance served spec/2768 @ the origin tip; MM open before each Run CLI drive (strict order).
- [x] S-2766 console — exercised round 2: zero Error/Uncaught/duplicate-key entries across all interactions (only pre-round 00:09 UTC entries in the buffer, prior era).
- [x] S-2766 live receipt — exercised round 2: R2A (`ses_faf58aae4ffeA5TEEA31QbFMni`, 3 nodes/2 edges) and R2B (`ses_faf4b16cbffefWVYwzXt1GTqwO`, 2 nodes/1 edge) trees matched rendered nodes 1:1.
- [ ] S-2770 fixture doctrine (G-080): fixtures are real Run CLI drives at MINIMAL viable volume on a FREE model (select Muse Spark 1.2 Free — never leave the default paid model selected); Mission Monitor mounted BEFORE any fixture launch (ECE contracts register only at mount — a fixture launched first delivers into unregistered contracts).
- [ ] S-2770 marker receipts (G-076): fixture A's first user prompt embeds `fredo-2770-FIXA-<date>`; fixture B's embeds `fredo-2770-FIXB-<date>`; resolve the real (provider-minted) session id by querying spans for the marker — never key receipts on invented labels; markers never reach child sessions (join via the parent's task-span child-session attributes).
- [ ] S-2770 windows-only waits (G-083): fixture prompts use PowerShell `Start-Sleep -Seconds 3` in leaf tasks to keep spans observable — never POSIX `sleep`.
- [ ] S-2770 completion gating (G-073) + one-fixture-per-launch (G-074): a fixture is COMPLETED only when the telemetry store has its idle record and a completed session span (query via `.opencode/skills/telemetry-query/telemetry-query.ps1`), never the PTY done-marker alone; between fixtures close the terminal and relaunch — a prompt submitted mid-turn queues into the same conversation and contaminates the session; assert DOM only on COMPLETED sessions whose telemetry agrees at the same instant.
