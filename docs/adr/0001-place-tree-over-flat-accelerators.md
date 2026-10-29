# ADR-1: Place Tree Over Flat Accelerators

- **Status:** Accepted

## Context

The `[a-z0-9]` accelerator space is saturated. `docs/UX_FLUENCY_RESEARCH.md` §3.1 and §3.2 record
Wireframe at **36 simultaneous bindings** — 24 mode keys plus 12 carrier bindings — against a
single-stroke command grammar (`apps/ui/src/shared/hotkeys/commandSurface.ts:143`) and an element
grammar of `[a-z0-9](+[a-z0-9])?` (`apps/ui/src/shared/hotkeys/hotkeyGrammar.ts:25`). A mode is an
undiscoverable mutation of that same flat space: the bar lists only the active mode's keymap
(`apps/ui/src/shared/hotkeys/hotkeyBarModel.ts:245-258`), while the 12 `g+*` sequences and the 3
kept globals (`apps/ui/src/shared/hotkeys/defaults.ts:38-57`) never render as rows.

## Decision

Navigation is a declared place tree: one root, child places with place-local `keys`, and
application-level `directAliases` for verbs reachable from anywhere. A place is entered explicitly,
and because its keys are scoped to that place they stay one stroke long. We do not grow a flat,
single-key accelerator space, and we do not encode places as modes.

## Consequences

- Depth is explicit: the place path is the navigation state, so "which keys work now" is answered by the tree, not by a hidden flag.
- Keys stay short per place; the tree carries breadth, not a modifier.
- Entering and exiting are observable and journaled (`place.enter` / `place.exit`), so an agent can state where it is acting.
- Reachability is checkable: every verb is reachable from a place path, which an audit can enumerate.

## Rejected alternatives

- **A bigger flat modifier space.** Shift/Alt/Ctrl chords buy slots by making every binding slower to type and no more discoverable; the saturation returns at the next capability.
- **Chord-only sequences with no places.** Sequences add capacity but leave scope implicit — nothing tells a user which verbs are currently available.
- **A menu tree with no key surface.** Discoverable but not fluent; it abandons the keyboard-first premise the research measures.
