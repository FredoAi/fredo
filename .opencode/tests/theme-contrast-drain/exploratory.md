# theme-contrast-drain — exploratory

> Unscripted probes beyond the QA Plan. A confirmed finding **promotes** to `functional.md`
> as a new `F-` row (keep the origin note).

- [x] E-1: confirmed (round 1) — `fg.muted` on the **selected** radio-card tint is unenumerated
      by the gate and accent-dependent (dark 4.663 / light 4.821 / custom accent 4.45 < 4.5).
      Promoted to `functional.md` F-15. Also confirmed: the enabled outline/ghost button chrome is
      not painted by the contract at all (`data-variant` never emitted) → F-14.
- [ ] E-1 (original probe): Probe every state the AC names on each control (hover, focus, active,
      disabled, loading, selected) in **both** presets — any state the matrix does not
      enumerate?
- [ ] E-2: Probe the disabled→enabled transitions (`Save` after a successful test,
      `Export` after a query loads, `Run` after connect) — is the enabled state ever
      still disabled-looking?
- [ ] E-3: Probe the caption at the narrowest window and the widest zoom — does any
      long-label preset push it into clipping or wrapping that hides a word?
- [ ] E-4: Probe the native option popup for Log verbosity / SSL mode / Access mode —
      OS chrome, not DOM-measurable; note anything visibly low-contrast.
- [x] E-5: confirmed (round 1) — `RadioCard.ItemIndicator` is token-driven at all three call
      sites (`accent.strong`; classic renders `rgb(232,141,92)`, checked border `accent.strong`),
      not Chakra stock; the former `KNOWN_OUT_OF_SCOPE_PAIRS` exemption is correctly removable
      (already removed by ST-2).
- [ ] E-6: Probe the pre-fix tip if reachable — which backlog items are already fixed?
