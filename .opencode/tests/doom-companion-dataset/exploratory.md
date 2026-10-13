# doom-companion-dataset — Exploratory Probes (Spec #3032)

> Unscripted edge/failure probes for the fine-tuning dataset export slice. The Tester works these
> AFTER the scripted functional/regression legs. A confirmed finding **promotes** to `functional.md`
> as a new `F-` row (keep the origin note). Leave `- [ ]` + a `FAIL` note with expected-vs-actual +
> repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: **Crash mid-write** — kill the app during a dataset append; on restart is the trailing
  partial line handled (skipped/repaired) without corrupting the whole file, and is the record
  count still consistent?
- [ ] E-2: **Rotation vs export race** — start a long run that crosses the retention bound while an
  export reads the dataset; are the exported records complete (no torn line), and is a
  just-rotated-away record still recoverable if an export referenced it?
- [ ] E-3: **Opt-in toggled mid-run** — flip the opt-in ON mid-run: do records start from the
  toggle point, and does the terminal record still carry the full `runId`? Flip OFF mid-run — is
  the file left in a valid, non-truncated state?
- [ ] E-4: **Reward correctness on a death/restart** — the player dies and the level restarts;
  are `dHealth`/`moved`/`dDistanceToExit` computed against the correct pre/post states (no
  cross-level bleed), and does a restart emit a distinct record rather than a silent merge?
- [ ] E-5: **Re-plan boundary** — a re-plan fires mid-decision; is the `replan` record correlated
  to the SAME `runId` + the correct `planIndex`, and does it NOT duplicate the decision record?
- [ ] E-6: **Decision error on the FIRST decision** — the very first decide errors/times out; is a
  record still written (observation + typed error + fallback `source:"reflex"`), or is the run
  lost?
- [ ] E-7: **`{"stall":true}` timeout** — the stall entry never answers; is the record's error
  exactly `timedOut` (not `malformed`), and is the fallback action that ran recorded?
- [ ] E-8: **Very large observation** — under `FREDO_DOOM_INJECT_OBSERVATION` with a full
  `enemies`/`doors`/`walls`/`forward` payload, does a single record stay under the pinned byte
  bound, or is it silently truncated (a corruption)?
- [ ] E-9: **Export to an unwritable path** — `--out` under a non-existent/locked dir; is the
  failure a typed error with NO partial file left behind?
- [ ] E-10: **Export of an EMPTY dataset** — opt-in ON but zero records; does export produce the
  typed "no records" outcome (no empty-but-valid-looking file), and is raw still the default?
- [ ] E-11: **Egress under a proxy env** — with `HTTP_PROXY`/`HTTPS_PROXY`/a telemetry endpoint set,
  does the dataset/export path attempt ANY outbound connection? (Must be ignored.)
- [ ] E-12: **SFT/DPO formatting** — do `--format sft` and `--format dpo` each produce a shape that
  a literal parser accepts (prompt/response pair; chosen/rejected pair) — and are malformed
  decisions excluded or handled per the pinned policy?
- [ ] E-13: **Retention bound = 1** — a degenerate bound: does the file keep exactly one record
  and never crash on rotation (off-by-one at the boundary)?
- [ ] E-14: **Concurrent runs** — two runs active (different `runId`): are records interleaved
  without crossing `runId`s, and does each terminal record stamp its OWN `levelResult`?
