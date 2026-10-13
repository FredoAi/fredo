# theme-contrast-drain — exploratory

> Unscripted probes beyond the QA Plan. A confirmed finding **promotes** to `functional.md`
> as a new `F-` row (keep the origin note).

- [ ] E-1: Probe every state the AC names on each control (hover, focus, active,
      disabled, loading, selected) in **both** presets — any state the matrix does not
      enumerate?
- [ ] E-2: Probe the disabled→enabled transitions (`Save` after a successful test,
      `Export` after a query loads, `Run` after connect) — is the enabled state ever
      still disabled-looking?
- [ ] E-3: Probe the caption at the narrowest window and the widest zoom — does any
      long-label preset push it into clipping or wrapping that hides a word?
- [ ] E-4: Probe the native option popup for Log verbosity / SSL mode / Access mode —
      OS chrome, not DOM-measurable; note anything visibly low-contrast.
- [ ] E-5: Probe `RadioCard.ItemIndicator` (the `KNOWN_OUT_OF_SCOPE_PAIRS` exemption) —
      is it still Chakra stock, or now token-driven (exemption removable)?
- [ ] E-6: Probe the pre-fix tip if reachable — which backlog items are already fixed?
