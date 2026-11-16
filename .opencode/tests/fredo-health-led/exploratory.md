# Exploratory — fredo-health-led

Unscripted probes. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).

- [ ] **E-1:** all four subsystems down simultaneously → is the overall state the worst-wins `down`?
- [ ] **E-2:** Postgres `starting` (→ `unknown`) while the companion is `down` → does `unknown` correctly stay neutral while the companion degrades?
- [ ] **E-3:** toggle `coveredByWindow` while the tooltip is open → does it stay correct/legible (no clipping/stale position)?
- [ ] **E-4:** rapid stream connect/disconnect flapping → any re-render loop or stale-patch drop?
- [ ] **E-5:** a `llama-server-status` event storm → is the immediate refresh de-bounded (no IPC per event)?
- [ ] **E-6:** headless/attached Postgres (`attached`) → mapped `healthy`? (mapping has no live lever — pin statically if unreachable)
- [ ] **E-7:** companion installed with only SOME model files present → is the split correct (`llamaServer` vs `companionModel`)?
