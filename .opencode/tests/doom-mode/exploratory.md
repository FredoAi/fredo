# doom-mode — Exploratory Test Cases (Spec #2968)

> Unscripted edge/failure probes for the Doom window/runtime slice. The Tester adds probes here as they work; a confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).
>
> **Verification policy: live** — probes are driven against the running artifact; record DOM/screenshot/process receipts and the `telemetry_spans` live-pipeline reference (managed `psql` on the PG default, G-284). A static-only observation is not a finding.
>
> **G-300:** any error/failure probe added here must name an in-repo induction lever (env override under `.opencode/tmp/2968/`, or a static/unit pin marked non-AC) — no lever-less error edge.

## Prompt lines

- [ ] E-1: Rapid open/close/open during the `starting` phase — does a stale window or a second engine accumulate? (Lever: STUB; poll PIDs.)
- [ ] E-2: Close the window exactly while `doom_step` is in flight — does the request fail cleanly (`requestFailed`) with no panic and no orphan?
- [ ] E-3: `doom_frame` while the engine is hung (`FREDO_DOOM_STUB_HANG=1`) — does the bounded request timeout fire and the UI degrade to the last rendered frame rather than block?
- [ ] E-4: Hard-kill Fredo mid-`ready`, then relaunch — does the startup sweep reclaim the orphan and never kill an unrelated reused PID?
- [ ] E-5: Two simultaneous `doom_read_state` calls — is the round trip still single-request each, with no interleaving corruption?
- [ ] E-6: Open the `doom` window, then open it from a second entry path — still exactly one window/engine?
- [ ] E-7: `FREDO_DOOM_ARCHIVE_URL` reachable but `_SHA256` mismatched — is the failure typed `acquireFailed` and fail-closed (no partial staged binary used)?
- [ ] E-8: Boot with a stale `doom_install_dir` PID marker whose PID now belongs to an unrelated process — the image guard must refuse to kill it.
- [ ] E-9: Theme/light-dark on the error state and status readout — theme tokens only, no hardcoded hex.
- [ ] E-10: The `doom` window is open when the app exits — both the Doom and llama-server/PG exit hooks complete within their bounds.
