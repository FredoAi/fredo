# Theme Contract — Exploratory

> Unscripted probes the Tester runs beyond the functional cases. A confirmed finding **PROMOTES** to
> `functional.md` as a new `F-` row (keep the origin note). Probes target the CONTRACT enumeration, the
> gate's CONSUMPTION of it, and live preset/accent/state rendering.

## Probes to try

- [ ] **E-1 — Contract vs gate divergence hunt.** Find any second, hand-maintained list of presets,
      surfaces, states, or token names that the gate reads instead of the contract (grep
      `matrix.ts`/`evaluate.ts` for literals). A divergent copy that can silently drift is a finding
      (promotes to F-1/F-10).
- [ ] **E-2 — Unbacked state sweep.** Enumerate every `(preset, token, state)` the contract declares and
      resolve it against each shipped preset. Any `undefined`/unparseable value for a declared state is a
      finding (promotes to F-2).
- [ ] **E-3 — No-preset base parity.** Compare `classic (base — no preset)` rows/rendering against the
      `Default / None` selector option (`""`). Do they agree (same CSS vars, same matrix rows)? A base
      that is not actually the no-preset fallback is a finding (promotes to F-1/F-5).
- [ ] **E-4 — Light-preset control legibility.** In each light preset (Light Default, Solarized, Arctic,
      Sunset, Paper), force outline/select/radio-card disabled + selected and judge whether label/border
      remain legible or the control "disappears". A class that fails is a finding (promotes to F-6/F-7).
- [ ] **E-5 — Component-local override hunt.** Grep the implicated components (outline buttons, selects,
      radio cards) for any `bg=`/`color=`/`style` colour that is not a contract token. Any component-local
      colour override is a finding (promotes to F-6).
- [ ] **E-6 — Contract-consumption mutation.** Change ONE token value in the contract source, rebuild,
      and confirm the gate matrix ratios AND the rendered CSS var both move; revert. A change that moves
      the app but not the gate (or vice-versa) is a finding (promotes to F-10).
- [ ] **E-7 — Accent churn on a preset.** On a preset, rapidly change the accent across several values;
      watch for stale CSS vars, lag, or "Maximum update depth exceeded" (AGENTS.md #523). A loop is a
      finding (promotes to F-5/F-12).
- [ ] **E-8 — Mid-luminance derivation stress (G-236).** With a pale accent and a low-contrast text pair,
      verify the derived `--accent-strong`/`--text-subtle` do not collapse to an endpoint. A collapsed
      mix target is a finding (promotes to F-11).
- [ ] **E-9 — Bogus preset id / unparseable token.** Manually set `localStorage['Fredo_theme_preset']` to
      a bogus id, reload; and feed `mustParse` an unparseable token. Do they clamp/throw non-silently
      (the static pin) rather than rendering a broken surface? Silent breakage is a finding.
- [ ] **E-10 — Freeze frame vs preset switch.** Capture a frame mid preset-switch; look for a
      half-themed flash (some surfaces old, some new). A visible partial state is a finding
      (promotes to F-5).
