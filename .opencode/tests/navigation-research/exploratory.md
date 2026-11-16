# navigation-research — Exploratory

Feature: place-based navigation fluency research (Issue #3115). Unscripted probes for the
spike's evidence quality — artifact leaks, incomplete prototype coverage, fabricated-looking
data, and arithmetic drift. A confirmed finding **promotes** to `functional.md` as a new `F-`
row (keep the origin note).

> **Do not invent results.** These are prompt lines for the tester; no outcome is recorded at
> triage. AC3/AC4/AC5/AC6 are human-attestable — a probe may inspect the *documents*, never
> simulate a session.

## Prompts

- [ ] **E-1: prototype leaks a runtime/network dependency.** Read `index.html` +
  `prototype.js` + `prototype.css` for any absolute URL, CDN `<script>`/`<link>`, `fetch`,
  `XMLHttpRequest`, import map, service worker, or bundler-only import. Does it open as a bare
  `file://` static page? Promote to F-2 if a leak exists.

- [ ] **E-2: prototype teaches the keys.** Look for a key legend, a task list, on-screen hints,
  or an always-visible shortcut cheat-sheet. The unaided clause requires the prototype NOT to
  teach keys — a teaching UI invalidates AC2's participant evidence. Promote to F-2/F-2g.

- [ ] **E-3: prototype covers all 7 places and the full T1–T6 flow.** Walk the source for each
  `data-place-id` and each task affordance from Architect §4.3; note any task with no reachable
  affordance (T7 is recall-only and needs none). Promote to F-2.

- [ ] **E-4: undo is exact, not global.** Check the undo handler: does it restore only the named
  property on the named object, or does it reset the object/whole canvas? Check two consecutive
  companion changes — does undo target the named change? Promote to F-2f.

- [ ] **E-5: report conclusion cites a number not derivable from §7.** For each number in
  §8.1–§8.3, try to recompute it from §7.2/§7.3. A number that cannot be derived (or comes from
  an external benchmark) is a finding. Promote to F-4.

- [ ] **E-6: quote integrity.** For each quote in §8, confirm the exact text exists in the
  attributed participant's §7.3 `quote_1`/`quote_2` or the §10.2 index, and that the same quote
  is not silently reused across RQs. Promote to F-4.

- [ ] **E-7: silent threshold edit.** Compare §9.1's six gate lines with Architect §4.5
  byte-for-byte; look for a changed number (70/80/100), a `>=` where the spec says strictly
  `>`, or a per-task average substituted for GO-2's pooled rate. Promote to F-5.

- [ ] **E-8: duplicated-but-diverged protocol.** Compare the task/question text in
  `session-protocol.md` with any copy in the report (§6.1 must point, not duplicate). A
  divergence breaks P6 verbatim reuse. Promote to F-3.

- [ ] **E-9: leftover raw identifiers.** Grep committed artifacts for emails, handles, org names
  or a participant's real name; the report must use only `P1`–`P8`. Promote to F-3.

- [ ] **E-10: a NO-GO "retried away".** Look for a second/superseded verdict, a note scheduling
  a re-run "to get a GO", or a threshold changed after a failed line. NO-GO is a valid outcome;
  a retry-to-GO is a finding. Promote to F-5.

- [ ] **E-11: stale index or broken relative link.** Check `docs/README.md` and
  `spikes/README.md` rows and every relative link in the report/spike README. Promote to the
  regression suite's R-5.

- [ ] **E-12: `PENDING GATE H` residue.** Search the whole report for the marker after ST-6.
  A residue in §8/§9 only (results present but the marker left) is a finding. Promote to F-3.

- [ ] **E-13: task script drift.** Compare the committed `session-protocol.md` T1–T7 text with
  Architect §4.3's task column; a reworded task breaks verbatim P6 reuse. Promote to F-3.
