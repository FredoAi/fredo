# ADR-5: Object-First Vocabulary

- **Status:** Superseded (Spec #3153, slice 3 of 3) — the closed object glossary this record makes
  normative lived in `docs/NAVIGATION_ENGINE.md` §1 and fed the companion manifest; both are gone
  with the NavigationEngine (#3151). The direction reversed: the **companion** is the interaction
  surface for directing Fredo conversationally, not the keyboard. The product went to a
  **carrier-less** shared language: there is no object glossary to keep uniform because the
  surfaces it unified no longer exist, and the surviving copy is per-application prose. The
  glossary's one durable trace is the research record in `docs/UX_FLUENCY_RESEARCH.md`, kept as
  history, not as a contract.

## Context

Five vocabularies described one capability: `WIREFRAME_ACTIONS`
(`apps/ui/src/applications/wireframe/actions/wireframeActions.ts`), the per-application command
surface, the hotkey registry, per-element key discovery, and the companion manifest
(`apps/ui/src/shared/companion/manifest.ts`). Because each surface named things its own way, the
companion had to translate between the names, and a UI refactor could rename a capability without
anyone noticing.

## Decision

Object-first (OOUX) nouns are the shared language of humans and agents. A verb's `appliesTo` names
objects and places — never widgets. The §1 glossary is normative and carries a forbidden-synonym
table: `widget`/`control`/`item` → object, `action` → verb, `shortcut`/`accelerator` → key, and
`mode` → place. The companion manifest, palette, rail, and docs all use the same object nouns.

## Consequences

- The companion manifest and the palette speak the nouns a human sees, so no translation table is needed.
- A UI refactor cannot rename a capability: the verb id and its object are stable public identifiers.
- Validation can reject a widget reference in `appliesTo` as a vocabulary error, not a style nit.
- Onboarding copy and the glossary share one set of words.

## Rejected alternatives

- **Widget-first vocabulary.** It binds the language to today's layout; a re-layout breaks the agent's language.
- **A per-surface vocabulary with a translation table.** The table becomes another hand-maintained list that drifts (see ADR-6).
- **Free-text natural-language-only addressing.** It gives no stable identity for a journal entry, a manifest row, or a test.
