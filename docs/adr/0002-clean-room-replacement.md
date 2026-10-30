# ADR-2: Clean-Room Replacement, Not Incremental Extension

- **Status:** Accepted

## Context

One capability is declared in five vocabularies: `WIREFRAME_ACTIONS`
(`apps/ui/src/applications/wireframe/actions/wireframeActions.ts`), the command surface
(`apps/ui/src/applications/wireframe/wireframeCommandSurface.ts`), the hotkey registry
(`apps/ui/src/shared/hotkeys/registry.ts`), `data-hotkey` discovery
(`apps/ui/src/shared/hotkeys/hotkeyElements.ts`), and the companion manifest
(`apps/ui/src/shared/companion/manifest.ts`). Incremental extension produced exactly this: each
addition obeyed one surface and left the others to catch up. #3099 had to publish a mirrored action
list so the companion could run what applications already had.

## Decision

Clean-room replacement, not extension. For any application, the legacy vocabulary and the
NavigationEngine may **not** coexist past that application's named migration phase (ADR-7). There is
no open-ended coexistence, no permanent compatibility layer, and no phase after which the legacy
surface may linger: each migration phase ends with the legacy surface deleted. This rule is
unconditional and applies to every application in the migration order.

## Consequences

- Each migration phase has a bounded end — it closes by deleting the legacy surface, not by maintaining two paths.
- The cost is a planned, bounded rewrite of the declaration and dispatch surfaces in scope.
- The alternative cost — two authoritative capability lists, forever — is rejected outright.
- Adapters exist only as a dated seam (ADR-7), never as a destination.

## Rejected alternatives

- **Permanent adapters.** A compatibility layer that never dies makes neither path authoritative and doubles every future change.
- **A feature-flagged dual runtime.** Two runtimes behind a flag means two behaviours to test and a flag nobody dares remove.
- **Incremental extension of `WIREFRAME_ACTIONS`.** Extending the existing table preserves the five-vocabulary fan-out the replacement exists to remove.
