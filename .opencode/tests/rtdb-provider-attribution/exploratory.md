# RTDB Provider Attribution — Exploratory Probes (Spec #2932)

> Unscripted edge/failure probes for provider attribution. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note here). Probes are prompts, not pass/fail gates until promoted.

## Vocabulary / normalization

- [ ] E-1: Feed the same provider through different layers and see whether the canonical token converges — a CLI `--provider open_code` row, a real span with resource `service.name` = the plugin identity, and a span with `gen_ai.provider.name` = a kebab value (e.g. `open-code`). Do the stored row tokens match? Where do they diverge?
- [ ] E-2: Send a provider token with unusual formatting — uppercase, a hyphen, an underscore, leading/trailing whitespace, an empty string via a crafted payload. Does the classifier normalize, reject, or store verbatim? Is the query filter able to match what was stored?
- [ ] E-3: Two CLIs emitting the SAME `session_id`/`correlation_id` with different providers — does one overwrite the other's row or do the composite keys collide? What does the provider show after the collision?
- [ ] E-4: `gen_ai.provider.name` present but empty-string, alongside a valid `service.name` — which layer wins, and is the stored token the fallback or the real provider?

## Lifecycle / merge

- [ ] E-5: Emit an Init, a replayed Init (after a #523 re-key/compositing path), then Response — does a replayed Init with a different provider re-stamp the attribution? Does a provider-less update patch clear it?
- [ ] E-6: Force retention eviction and confirm the `remove` path still carries no phantom provider data and no second `remove` producer appeared.
- [ ] E-7: A row whose provider is the documented fallback is later patched by a real provider — does the fallback get overwritten or kept? Is that the intended contract?

## Migration / store

- [ ] E-8: Start the upgraded app over a store with pre-cutover rows and a legacy-shaped table (missing the column); confirm `ALTER TABLE` migration and that pre-existing rows get a non-empty provider — or fail loudly rather than silently defaulting an empty value.
- [ ] E-9: Kill the app mid-write (unclean WAL), restart, and check no row lost the new column / no duplicate row materialized.
- [ ] E-10: Full stop/start with a provider row in the write-behind cache at shutdown — does the provider survive the reopen?

## Backfill

- [ ] E-11: Run the canonical backfill where the live classifier already rowed the same span — is the provider re-derived identically (byte-equal) or does a second path produce a different token?
  - **CONFIRMED (round 1, promoted to F-11):** the re-derivation derives the correct token (`open_code`) but does NOT update the pre-existing live-rowed key; it creates a PARALLEL row (`ses_f358…`: 20 span-matched rows stayed `unknown`; 16 have a matching `open_code` row at the same `started_at_ns`). The replay's correlation key differs from the live key.
  - **CLOSED (round 2, `182fec5`):** the corrected identity-keyed pass upgrades pre-existing rows IN PLACE at their own `(session_id, correlation_id)` — `ses_f358…` now has 0 span-matched unresolved rows, 0 parallel rows, 50/50 `open_code`, and unchanged row count. Promoted case F-11 PASSES.
- [ ] E-12: A `telemetry_spans` row whose `provider` column is NULL/empty (a legacy span) — what does the backfill put on the canonical row? Is it the documented fallback (non-empty)?
  - **CONFIRMED (round 1):** the fallback is non-empty (`unknown`); the OTLP fixture whose Resource omits `service.name` yields row + span provider `unknown`, never NULL/'' (F-10 PASS).

## Query / subscription

- [ ] E-13: A provider-scoped subscription opened BEFORE any matching row exists — does it deliver the row when it later arrives, and does `ready` settle correctly?
- [ ] E-14: Filter on the fallback token (e.g. `unknown`) — does it match the fallback rows, and is that desirable/exposed?
- [ ] E-15: A subscription whose provider arg appears with both `=` and a string ordering operator — behavior and validation errors?

## Frontend

- [ ] E-16: A consumer that reads `row.provider` directly on a delivery patch with no provider key (a buggy/partial patch) — does it crash, or is the field guaranteed by the contract? (Contract-Trust: a `??` guard is a smell, not a fix.)
- [ ] E-17: Rapid provider-scoped subscription mount/unmount — any console error, stale delivery, or re-render loop?
