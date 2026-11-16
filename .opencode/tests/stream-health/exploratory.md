# Exploratory — stream-health

Unscripted probes. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep
the origin note).

- [ ] **E-1:** rapid lever toggling (`degraded` → unset → `down` → unset) mid-session — does the state settle within one interval each time, with no stuck `down` and no double-announce storm?
- [ ] **E-2:** a heartbeat arriving at the exact `STREAM_HEARTBEAT_STALE_MS` boundary — is the comparison inclusive (fresh) or exclusive (stale), and is it consistent between the producer and `deriveStreamHealth`?
- [ ] **E-3:** the producer's first tick before ANY heartbeat/probe has landed (cold start) — does the status read `healthy` (or a neutral settle) rather than a spurious `down`?
- [ ] **E-4:** probe latency > `STREAM_HEALTH_CHECK_INTERVAL_MS` (a slow `stream_health` response) — is a late response dropped (seq guard) rather than clobbering a fresher state?
- [ ] **E-5:** a `streamHealth` envelope with a malformed/foreign shape on `fredo-stream-event` — is it ignored by the discriminator WITHOUT being mis-routed into the row store?
- [ ] **E-6:** close/reopen a consumer (Mission Monitor) during `degraded` — does the freshness marker survive the remount (module-scoped) and the state stay `degraded`?
- [ ] **E-7:** the LED tooltip open while the state transitions `degraded` → `healthy` — does the text/label update in place (no stale line, no clipping)?
- [ ] **E-8:** `stream_health` invoked while the OTLP receiver is mid-restart — does `ingestConnected` flap and does the status flap correspondingly (or debounce)?
