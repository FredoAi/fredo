# Realtime Data Layer — Exploratory Probes (Spec #2896)

> Unscripted edge/failure probes for the read/watch layer. A CONFIRMED finding promotes to `functional.md` as a new `F-` case (keep the origin note). Real-path classes (G-088/G-130): multi-hop compositing, contested ownership, mid-switch timing, continuous-stream completeness — fixture-only evidence is invalid.
>
> **Round 1 (2026-09-19, `spec/2896 @ c23087fd`):** the upgrade-path probe CONFIRMED a defect and promoted to `functional.md` **F-19** (declared `feature_mission_monitor_sessions` collides with the legacy table ⇒ declared data never materializes). E-1..E-10 (except E-11/E-34) are BLOCKED — no declared-row mutation is possible, so register-vs-mutate races, post-stop deliveries, scope leaks, and delete-while-mutating cannot be observed. E-11/E-34 (console check): PASS — `tauri_read_logs(source="console")` clean after every interaction.

## Probes to run beyond the script

- [ ] E-1 (OPEN): Register-vs-mutate race — start a watch and emit a mutation in the same tick; repeat 10×. Any single lost change is a delivery-guarantee defect (REQ-3).
- [ ] E-2 (OPEN): Stop a watch while a delivery for it is pending — does a stale post-stop delivery arrive, or is it discarded? Repeat across coalescing windows.
- [ ] E-3 (OPEN): Rapid scope switching while two scopes both stream continuously — does the previous scope leak into the new watch, or does the new watch miss a change during the switch window? Cross-check `telemetry_spans` + IPC captures at the same instant.
- [ ] E-4 (OPEN): Delete the watched record while it is mutating — does the watch close cleanly (no orphan subscription, no delivery for the deleted key), and does the deletion survive a restart with no resurrection?
- [ ] E-5 (OPEN): Close the consuming UI mid-stream, keep driving activity, reopen — is any change missed while the UI was closed (closed-UI correctness)? Compare reopened state vs `telemetry_spans`.
- [ ] E-6 (OPEN): Restart with a write in flight — does the first read show a torn/partial row presented as current, or settle to a consistent current value (REQ-1)?
- [ ] E-7 (OPEN): Two scopes with the same table name and same record key — zero cross-feature bleed and a named refusal on cross-namespace access (REQ-4 isolation).
- [ ] E-8 (OPEN): Field-watch isolation churn — alternate mutations of two sibling fields over many writes; does either sibling watch ever fire spuriously (REQ-2)? Probe (A-12): `tauri_ipc_execute_command` drives two `feature_data_watch` calls with `fields` narrowing; `tauri_ipc_monitor`/`tauri_ipc_get_captured` and the Dev Mode → Feature Data feed read the deliveries.
- [ ] E-9 (OPEN): Very large corpus (history far exceeding one replay batch) — does the table watch stay live/responsive, and does a newly created record appear without a full-history rescan (REQ-4/REQ-5)?
- [ ] E-10 (OPEN): Memory/leak probe — start/stop many watches over a long window and sample `performance.memory.usedJSHeapSize`; a heap that grows with the number of started watches and never settles suggests leaked subscriptions.
- [ ] E-11 (OPEN): Console check on every probe — any `Maximum update depth exceeded` or `Uncaught` invalidates that leg's evidence.
