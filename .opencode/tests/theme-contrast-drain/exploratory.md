# theme-contrast-drain — exploratory

> Unscripted probes beyond the QA Plan. A confirmed finding **promotes** to `functional.md`
> as a new `F-` row (keep the origin note).

- [x] E-1: confirmed (round 1) — `fg.muted` on the **selected** radio-card tint is unenumerated
      by the gate and accent-dependent. Promoted to `functional.md` F-15. Also confirmed: the enabled
      outline/ghost button chrome was not painted by the contract at all (`data-variant` never emitted)
      → F-14. Round 2: F-14 is FIXED (recipe); F-15 is 4.688 dark / 4.823 light (still an observation).
- [ ] E-1 (original probe): Probe every state the AC names on each control (hover, focus, active,
      disabled, loading, selected) in **both** presets — any state the matrix does not enumerate?
- [ ] E-2: Probe the disabled→enabled transitions (`Save` after a successful test,
      `Export` after a query loads, `Run` after connect) — is the enabled state ever
      still disabled-looking? **Round 2: NOT reachable** — the embedded PostgreSQL cluster never
      became `ready` (`Password mismatch — the stored password does not match the running cluster`),
      so no saved connection / loaded result set could be produced. The enabled *mechanism* is proven
      by the enabled `db-conn-test`/`db-conn-cancel` (same recipe); the literal enabled `Run all`/
      `Export`/`Save` rows remain unexercised (named blocker on the verdict).
- [ ] E-3: Probe the caption at the narrowest window and the widest zoom — round 2 at 820px:
      `scrollWidth == clientWidth` (222), rect fully inside the toolbar, wraps to 2 lines; no word hidden.
- [ ] E-4: Probe the native option popup for Log verbosity / SSL mode / Access mode —
      OS chrome, not DOM-measurable; no visible low-contrast issue observed.
- [x] E-5: confirmed (round 1) — `RadioCard.ItemIndicator` is token-driven at all three call
      sites (`accent.strong`); the former `KNOWN_OUT_OF_SCOPE_PAIRS` exemption is removed and the
      `radio-card|selected|indicator` gate row is now in scope (`matrix.ts:359`). Round 2 re-confirmed
      live: the checked indicator renders `accent.strong` `rgb(173,120,221)` classic.
- [ ] E-6: Probe the pre-fix tip if reachable — which backlog items are already fixed?
      Round 2: the pre-fix frames comes from the round-1 baseline leg (`64c3051`); the select-migration
      defect is FIXED-ALREADY; the outline/ghost + icon defects were STILL-PRESENT pre-fix and are now fixed.
