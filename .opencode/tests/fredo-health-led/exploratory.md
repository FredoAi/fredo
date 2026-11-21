# Exploratory — fredo-health-led

Unscripted probes. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).

- [ ] **E-1:** all four subsystems down simultaneously → is the overall state the worst-wins `down`?
- [ ] **E-2:** Postgres `starting` (→ `unknown`) while the companion is `down` → does `unknown` correctly stay neutral while the companion degrades?
- [ ] **E-3:** toggle `coveredByWindow` while the tooltip is open → does it stay correct/legible (no clipping/stale position)?
- [ ] **E-4:** rapid stream connect/disconnect flapping → any re-render loop or stale-patch drop?
- [ ] **E-5:** a `llama-server-status` event storm → is the immediate refresh de-bounded (no IPC per event)?
- [ ] **E-6:** headless/attached Postgres (`attached`) → mapped `healthy`? (mapping has no live lever — pin statically if unreachable)
- [ ] **E-7:** companion installed with only SOME model files present → is the split correct (`llamaServer` vs `companionModel`)?

## Probes added by Spec #3180 (remedy / technical detail in the rows)

- [ ] **E-8:** Keep the tooltip OPEN while a row transitions `down → healthy` (recover a forced
  failure live) — does the remedy/technical lines disappear without a stale flash, and does the
  polite live region announce once rather than per frame?
- [ ] **E-9:** A multi-KB `lastError` (force a failure whose raw detail is long) — does the technical
  detail stay single-line with a `title` carrying the full string, with no layout blowout and no
  horizontal clip of the tooltip?
- [ ] **E-10:** A remedy containing a long unbroken Windows path — does `overflowWrap: anywhere`
  keep it inside the ~20 rem cap (no overflow, no truncation)?
- [ ] **E-11:** Open the tooltip, then press Esc and Tab away — does focus return to the trigger and
  does the content unmount cleanly (no stranded portal, no orphaned `aria-describedby`)?
- [ ] **E-12:** Postgres `attached` (headless daemon) with the engine down — a `healthy` / `down`
  mix: does the engine's non-mandatory `down` read `degraded` overall while Postgres stays
  `healthy`?
