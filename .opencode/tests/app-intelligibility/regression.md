# App Intelligibility — Regression

> The **must-not-change** baseline for the app-intelligibility work (#3244). Every regression invariant
> is drawn from the plan's non-goals and the Architect's Domain Model. Run this suite on every testing
> phase whose Domain Model overlaps the companion turn assembly, the app registry, or the installed-app
> install matrix.

## Companion turn assembly

- [ ] **R-1.** Without a grounding context, `buildCompanionTurnMessages(text, persona)` returns the
      **byte-identical legacy `[persona, user]` pair** — the description+pair injection must NOT alter
      the no-context turn (`apps/ui/src/shared/components/companion/companionDispatch.ts`; pin
      `companionDispatch.test.ts`).
- [ ] **R-2.** The existing `registerCompanionGrounding(appId, provider)` seam
      (`apps/ui/src/shared/companion/grounding.ts`) keeps its contracts: last registration wins, the
      disposer is idempotent, `readCompanionGrounding` returns a **fresh** payload or `null`, and the
      **16384-byte** `COMPANION_CAPABILITY_LIMITS.maxContextBytes` guard is unchanged.
- [ ] **R-3.** A turn with NO context still emits NO grounding `system` message — exactly one
      grounding message is prepended when context exists, never two, never zero.

## Application registry

- [ ] **R-4.** `registerApplication()` stays a plain push with the #2826 double-registration contract;
      `dedupeByApplicationId` is unchanged (first-wins, keyed by `id`).
- [ ] **R-5.** The retained application set is still exactly the eight ids with their current `showable`
      flags (`retainedApplicationSet.test.ts`) — adding `description` must NOT add/remove/rename an app
      or flip a `showable` flag.

## Installed-app install matrix

- [ ] **R-6.** The 22 frozen refusal codes and the install/integrity decision matrix are unchanged
      (`.opencode/tests/installable-apps/`): no package that installs today may start refusing, and no
      refusal code may be re-pointed. The no-description failure must **NOT** add a 23rd install-refusal
      code — it is a **companion reply outcome** (UI/UX constraint), a separately-versioned vocabulary.
- [ ] **R-7.** The installed window stays **unreachable** by `tauri_webview_*` (isolation is the
      property under test): `execute_js`/`dom_snapshot`/`find_element`/`screenshot` still time out
      against an `installed-*` windowId, and the capability fixtures' self-driving mirror is unchanged.

## Neighbouring suites (run, do not duplicate)

- [ ] **R-8.** `.opencode/tests/companion-vision/functional.md` — the screenshot leg's media placement +
      visual-budget behaviour must be unaffected by the new per-turn injection.
- [ ] **R-9.** `.opencode/tests/companion-embedded-engine/` — the settled engine surfaces (F-8 vision,
      F-9 audio, F-16 settle, F-22 non-functional) stay green.
