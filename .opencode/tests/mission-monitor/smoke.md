# Mission Monitor smoke tests

- [ ] S-2766 app/feature: Dev instance serves the required spec commit, Mission Monitor opens, and the Run CLI window launches only after Mission Monitor is mounted.
- [ ] S-2766 console: Read the webview console before and after each streaming fixture; no Error, Uncaught, or Maximum update depth exceeded.
- [ ] S-2766 live receipt: Every live visual fixture has a marker-resolved provider session id and a telemetry_spans tree matching the rendered node set 1:1.
- [x] S-2766 app/feature — exercised round 2 (#2768): instance served spec/2768 @ the origin tip; MM open before each Run CLI drive (strict order).
- [x] S-2766 console — exercised round 2: zero Error/Uncaught/duplicate-key entries across all interactions (only pre-round 00:09 UTC entries in the buffer, prior era).
- [x] S-2766 live receipt — exercised round 2: R2A (`ses_faf58aae4ffeA5TEEA31QbFMni`, 3 nodes/2 edges) and R2B (`ses_faf4b16cbffefWVYwzXt1GTqwO`, 2 nodes/1 edge) trees matched rendered nodes 1:1.
