# Applications Rename — Exploratory

> Unscripted probes for the `feature` → `application` rename (#2956). The Tester probes beyond the
> script here; a confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin
> note). **Verification policy: live.**

- [ ] **E-1 — Rename-boundary hunt.** Probe for a missed occurrence the residual grep gate's
  allowlist would not catch: an abbreviation of the concept (`ftr`, `feat`) used for the app
  concept; a user-facing dynamic string built at runtime (window title from a data field, a
  context-menu label, an aria-label composed from data); a renamed dir whose `index.ts` barrel
  still exports an old-named symbol. Record expected-vs-actual.

- [ ] **E-2 — Cross-surface timing.** Open a window during a rename-related re-render; switch apps
  rapidly; toggle the launcher; confirm no stale "Feature" label flashes and no re-render loop
  (`Maximum update depth exceeded`) appears.

- [ ] **E-3 — Existing-install upgrade corner cases.** Boot against a pre-rename DB that carries a
  declared table with a tombstone, an empty declared table, and a hyphenated app id; confirm the
  frozen prefix resolves for each and no table is dropped/recreated. Also probe a DB where the
  metadata column `feature_id` exists but a code path requests `application_id` — record the
  observed failure/behavior (should resolve via the retained literal).

- [ ] **E-4 — CLI/IPC partial-rename probe.** With an older frontend build hypothetically invoking
  `feature_data_read`, confirm the renamed backend does NOT silently accept the legacy command
  against the running app (record the observed error), i.e. no accidental dual-name shim.

- [ ] **E-5 — Retained-sense false positives.** Confirm the allowlist does not mask a genuine
  regression: e.g. an Optimizely file whose copy legitimately says "Feature Flags" must NOT be
  flagged, while a launcher label that also says "Feature Flags" (wrong sense) MUST be flagged.
  Record the discriminating cases.

- [ ] **E-6 — Open question.** _(Tester adds probes for unscripted edge/failure states found during
  the round; promote confirmed findings to `functional.md`.)_
