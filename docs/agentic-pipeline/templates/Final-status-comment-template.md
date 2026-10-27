# Final Status Comment Template

> Drafted by the **Orchestrator** as `.opencode/tmp/<issue>/final-status.md`, posted as the `## Final Status` timeline comment by the `close-issue --to-phase done` action at the done close. **ONE closing comment** — it folds in the outcome, the doc-sync classification summary, the final metrics, and the merged PRs. Do **not** post a separate `## Status` doc-sync comment; the doc-sync summary belongs here.

## Outcome

- Audit verdict: **SUCCESS** — all N/N acceptance criteria evidenced; the feature is complete.
- <the shipped feature, one line, with the spec branch `spec/<N>`.>

## Doc sync

- <the doc-sync classification summary: which product docs the merged diff touched — `ARCHITECTURE.md` / `CLI_GUIDE.md` / `SETUP.md` / `SECURITY.md` / `FAQ.md` — and that they merged in the SPEC MAINT PR `maint/<N>`. If no product docs were affected, say "no product docs affected".>

## Metrics

- <the run's final metrics — cycle time, lead time, rounds, rework, guards fired — from the machine's final-metrics summary. Reference the machine's summary rather than restating every field.>

## Merged PRs

- Spec PR: #<n> (`spec/<N>` → `main`) — merged.
- SPEC MAINT PR: #<n> (`maint/<N>`) — merged (the pipeline's own edits + the product docs).

## Handoff

- The issue is labeled `done` and left **OPEN** — human review, then close manually. `spec/<N>` is deleted (recreated from `origin/main` on reopen).

*Authored by Orchestrator*
