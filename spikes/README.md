# Spikes

Research that **is part of a spec**. Each spike is one flat file named
`<issue-number>-<slug>.md`.

A spike is a **record, not code**. The PoC crate, its raw measurements, and any per-section design
files were all *disposable* — they answered a question and were then deleted. What survives is the
decision and the reasoning behind it, which is the part that still has to hold up when someone asks
"why did we ever consider this?". Where a spike cites a path that no longer exists, it says so
explicitly rather than leaving a dead link.

| Spike | Question | Outcome |
|-------|----------|---------|
| [#2948 — embedded PostgreSQL evaluation](2948-embedded-postgres-spike.md) | Is `postgresql-embedded` a viable replacement for the embedded SQLite behind `fredo.db`? | **NO-GO.** A measured harness, a 9-question set, and the NO-GO ADR. Its numbers are *design inputs*, not a veto |
| [#2964 — the migration approach](2964-postgres-migration-approach.md) | The migration is **mandated** — so how? | The full written approach (store, data, lifecycle, packaging), absorbing #2948's measurements as inputs |
| [#2897 — model-audio feasibility](2897-model-audio-feasibility.md) | Local transcription vs. model audio for speech input? | The ST-0 gating record. **Shipped** — model audio on the managed `llama-server` is the only speech path |
| [#2876 — local-first streaming STT engine](2876-stt-engine-selection.md) | Which local-first streaming STT engine? | **SUPERSEDED** by #2914, which removed the on-device engine. Kept verbatim as history |

## Not spikes

- [`../research/`](../research/) — the maintainer's own landscape research (external papers, vendor
  docs, community practice, OSS case studies). Not spec-scoped work.
- [`../docs/`](../docs/) — product and architecture documentation. Indexed at
  [`docs/README.md`](../docs/README.md).
