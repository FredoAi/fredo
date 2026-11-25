# Exploratory — fredo-health-led

Unscripted probes. A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep the origin note).

- [ ] **E-1:** all four subsystems down simultaneously → is the overall state the worst-wins `down`?
- [ ] **E-2:** Postgres `starting` (→ `unknown`) while the companion is `down` → does `unknown` correctly stay neutral while the companion degrades?
- [ ] **E-3:** toggle `coveredByWindow` while the tooltip is open → does it stay correct/legible (no clipping/stale position)?
- [ ] **E-4:** rapid stream connect/disconnect flapping → any re-render loop or stale-patch drop?
- [ ] **E-5:** a `llama-server-status` event storm → is the immediate refresh de-bounded (no IPC per event)?
- [ ] **E-7:** companion installed with only SOME model files present → is the split correct (`llamaServer` vs `companionModel`)?

> **Deleted by Spec #3194 (recorded, not reworded):** former `E-6` ("headless/attached Postgres
> (`attached`) → mapped `healthy`?") and former `E-12` ("Postgres `attached` (headless daemon) with
> the engine down — a `healthy`/`down` mix"). Their ONLY trigger was the ATTACH state, which #3194
> removed with the second boot path: `attached` is no longer a member of `FredoPgState`
> (`fredoHealth.ts:138`), so neither the mapping nor the mix can be produced or probed. The
> successor assertions are: the neutral-payload rule `## UI/UX Expert` **U-8** (a foreign payload that
> still carries `attached` must render `unknown`/`Starting`, never `down` — pinned in
> `fredoHealth.test.ts`), the live DOM absence of the string `attached`, and
> `.opencode/tests/resident-ingest/functional.md` **F-1/F-2** (one owner, `state:"ready"`, no
> `attached` key). Do not re-add an `attached` row here — a probe with no trigger is a deletion,
> not a debt.

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

## Probes added by Spec #3194 (typed ingest cause on the telemetry row — copy per `## UI/UX Expert`)

- [ ] **E-13:** With a typed `addrInUse` failure on the telemetry row, keep the tooltip open while
  the failing port is freed out-of-band — does the row keep showing `Port <port> is in use` for the
  rest of the process lifetime (no retry — Architect (6)), and does nothing flicker to `healthy`?
  (A flicker would mean a silent re-bind, which AC3/R-3c forbid.)
- [ ] **E-14:** The mono evidence line with a message that already CONTAINS the port and a `·` —
  is the `otlp:<receiver>:<port>:<code> · <message>` shape still unambiguous, and does the tooltip
  stay within its width with no horizontal scroll?
