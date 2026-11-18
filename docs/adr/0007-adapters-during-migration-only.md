# ADR-7: Adapters During Migration Only

- **Status:** Superseded (Spec #3153, slice 3 of 3) — P8 closed and every `ADP-` id is gone, and
  the `validateSurface()` result this record makes authoritative went with them (#3151). Its
  direction — a dated seam that lets the keyboard engine land — is void twice over: there was no
  migration to serve, and the keyboard is not the interaction surface. The **companion** is.
  The adapter programme's deadline model is therefore **moot**: the migration it existed to bound
  ended in deletion, not in a completed migration, so no adapter outlived its phase. Where the
  product went instead, in this record's own terms: the migration order's one surviving half —
  window traversal — is now the plain `Tab` / `Shift+Tab` window-boundary hand-off in
  `apps/ui/src/shared/window-system/traversal.ts`, and there is nothing left for an adapter to
  translate.

## Context

Seven application surfaces cannot migrate atomically. Adapters are the seam that lets a legacy
surface keep working while the NavigationEngine lands, but a seam without an end becomes a second
system — which ADR-2 forbids. The plan names fifteen adapters, each wrapping a specific legacy
declaration (`WIREFRAME_ACTIONS`, the command surface, the hotkey registry, per-element key sites).

## Decision

Adapters are temporary and exist only during migration, each with a hard deletion deadline. Every
adapter id `ADP-01` … `ADP-15` carries a `deleteBy` phase: `ADP-01`–`ADP-04` → `P5`,
`ADP-05`–`ADP-12` → `P7`, and `ADP-13`–`ADP-15` → `P8`. P8 is complete only when a single grep for
every `ADP-` id over `apps/ui/src/` returns **zero matches** — the condition met since P8 (#3122). An adapter MAY expose a legacy surface
as declared verbs and MAY translate legacy args; it MUST NOT own state and MUST NOT duplicate
validation — the `validateSurface()` result is authoritative. App order is Wireframe → terminal
pass-through + window traversal → Mission Monitor → Dev Mode.

## Consequences

- The dual system has a dated end; no adapter outlives its phase.
- A reviewer verifies P8 with one grep, without judgement calls.
- Each migration phase closes by deleting its adapters alongside the legacy surface.
- Adapters stay translators: they own no state and add no second validation path.

## Rejected alternatives

- **Indefinite compatibility shims.** They are the dual system ADR-2 forbids.
- **A big-bang rewrite with no pilot.** Wireframe must prove the model before six other surfaces move.
- **Adapters that own state.** A stateful adapter becomes a second source of truth and cannot be deleted cleanly.
