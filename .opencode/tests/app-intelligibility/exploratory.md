# App Intelligibility — Exploratory

> Unscripted probes beyond the script — error/failure states and "what-if" sequences for the
> description contract and the per-turn injected pair (#3244). A confirmed finding **promotes** to
> `functional.md` as a new `F-` row (keep the origin note).

## Probes to attempt (invent beyond these)

- [ ] **E-1.** An app declares a description at the **280-char cap** (the installed-manifest
      `maxLength`) — does the pair-injection budget still hold, and does the description survive
      un-truncated into the turn?
- [ ] **E-2.** An app whose screen is **empty** / renders only the root element — what does the
      "simplified HTML" leg carry? Is the pair still actionable, or does the model receive an empty
      representation (a silent gap)?
- [ ] **E-3.** An untaught app **closes** mid-turn (window destroyed) — does the injection record
      reflect the absence rather than a stale capture?
- [ ] **E-4.** Two different untaught apps open in sequence — do their turn records carry the correct
      `appId` + description (no cross-bleed), with no per-app code added?
- [ ] **E-5.** A very **dense** screen (hundreds of DOM nodes) — where does the simplified-HTML leg
      hit the budget, and what is the observable degradation (refusal vs silent truncation)?
- [ ] **E-6.** A description that is declared but **whitespace-only** — does it take the AC-1b typed
      failure or leak as an empty string?
- [ ] **E-7.** A **rapid** sequence of turns with no screen change — does the capture time advance each
      turn (fresh) or is a cached snapshot reused (stale)?

> Prompt: probe the boundary between "the pair is fresh and bounded" and "the pair is silently stale,
> empty, or over-budget" — reported behaviour that looks fine but is a silent gap is the highest-value
> finding here.
