# Event persistence exploratory tests

Unscripted probes — add findings on the fly; confirmed findings promote to `functional.md` as `F-<n>` rows (keep the origin note).

- [ ] E-1 Probe: kill/restart the app between persist and hydrate — does hydration survive a full app restart (not just feature close)?
- [ ] E-2 Probe: drive many sessions until the store holds thousands of rows, then hydrate — hydration latency and UI responsiveness under a large replay set.
- [ ] E-3 Probe: corrupt/lock the SQLite file (external handle) — does the writer degrade gracefully (drop persistence work, never deliveries) without console errors?
- [ ] E-4 Probe: two features hydrating the same session concurrently (Mission Monitor + stepper-probe) — interference, ordering, or duplicated state?
- [ ] E-5 Probe: session that never completes (no end span) — hydration returns the partial Init/Update chain without hanging; buffer timeout interplay.
- [ ] E-6 Probe: retention knob set to 0 — is the store effectively disabled, and does the app still function (no error loop)?
