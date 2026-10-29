# ADR-6: One Declaration, Every Surface Derived

- **Status:** Accepted

## Context

One capability fans out to five derived sites today — the root keymap
(`wireframeCommandSurface.ts:216-228`), the `data-hotkey` carrier
(`WireframeHotkeyCarrier.tsx:40-50`), `TABLE_COMMANDS` (`wireframeCommandSurface.ts:328-342`), the
companion manifest (`manifest.ts:89-104`), and a toolbar control — and the toolbar list is
hand-maintained twice. `docs/UX_FLUENCY_RESEARCH.md` §3.3 item 2 names this as "one capability, five
derived sites". Each hand-maintained list drifts from the others.

## Decision

One declaration; every surface is derived. The rail, map, palette, hint, onboarding, tooltip,
companion manifest, and docs index are deterministic projections of the place tree plus the verb
descriptors (§8's derivation table). A hand-maintained second list for any of them is a contract
violation, and no surface may show a key the resolver does not honour.

## Consequences

- A new capability is declared once and appears on every surface.
- Derivations are testable by manifest-projection equality rather than by visual inspection.
- Declaration and resolution cannot disagree, because both read the same source.
- Removing a verb removes it everywhere at once, including the companion manifest and the docs index.

## Rejected alternatives

- **Curated per-surface lists.** They are exactly the drift the current code demonstrates.
- **A generator with an override list.** The override list becomes the hand-maintained second declaration it was meant to remove.
- **Docs maintained separately from the declaration.** The index would describe capabilities the resolver no longer honours.
