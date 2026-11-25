# settings-credits — Functional

> Durable functional suite for **Settings → Credits** (Spec #3206): the in-app third-party
> notice surface, Fredo's own dual licence, the design-reference credit, the DOOM trademark
> notice, and the ONE OS-handoff link primitive.
>
> **Verification policy: live.** F-1..F-6, F-11, F-13 and F-15 assert a user-observable runtime
> behaviour (a rendered pane, an OS handoff, a window that stays put) and need a live webview
> receipt (`tauri_webview_dom_snapshot` / `tauri_webview_execute_js` / `tauri_webview_screenshot`
> + `upload-evidence` URLs). F-7..F-10, F-12, F-14, F-16 are generator/suite/build receipts —
> their evidence is an exit code plus the run's own printed lines.
>
> **Where the content authority lives.** Every string the pane shows originates in
> `apps/ui/src/applications/settings-app/credits/credits.generated.ts`, which
> `scripts/generate-credits.mjs` produces from `docs/THIRD_PARTY_NOTICES.md` §1–§4/§7 +
> `LICENSE-MIT` + `LICENSE-APACHE-2.0`. Rows therefore bind three-way —
> **DOM == artifact == doc/file** — never to a hand-copied expectation: read the expected value
> from the artifact (or the doc) at test time and compare. A row that hard-codes a sentence a
> doc edit can change is a suite defect.
>
> **Execution order matters (G-446).** F-8 mutates the committed artifact and F-9 mutates the
> doc + rebuilds the served bundle. Both run **LAST**, after every row that reads the artifact
> or `apps/tauri/dist/**`, and both restore from a copy under `.opencode/tmp/3206/drift/` and
> verify restoration by SHA-256. Do not reorder.
>
> **Exit codes.** Every command assertion goes through the committed wrapper:
> `powershell -NoProfile -File .opencode/scripts/run-exitcode.ps1 -Command "<cmd>"`; read the
> literal `EXITCODE=<n>` line. A bare chained command cannot produce an assertable exit code in
> this sandbox.

## F-1 (AC-1 · R-1.2) — the Credits nav item exists, is labelled `Credits`, and is LAST in the static group

- [ ] **F-1a (unit).** Run the shell wiring test ST-3 authors,
      `pnpm --filter @fredo/ui test:run src/applications/settings-app/components/__tests__/SettingsSurface.credits.test.tsx`
      (via `run-exitcode.ps1`). It renders `SettingsSurface` with **zero** registered features.
  - **Expected:** `EXITCODE=0`. `screen.getByTestId('settings-nav-credits')` has text content
    `Credits`; clicking it renders `[data-testid="credits-settings"]` **synchronously** (no
    `await waitFor`, no `findBy*` — proving the section has no async gate) and
    `[data-testid="companion-settings"]` is gone.
  - **Expected (UI/UX U-1, copy C-1):** inside `credits-settings` the first heading is an `h2`
    whose text equals the nav label `Credits`; exactly FOUR `h3` render, in order
    `Third-party components`, `Fredo's own licence`, `Design references`, `Trademarks`; exactly
    SIX `h4` entry names render in doc order (`llama.cpp`, `Vulkan`, `ggml`, `neurodoom`,
    `DOOM1.WAD`, `Posable Doomguy`) — heading levels never skipped.
  - **Fails on the pre-change tree:** the testid does not exist, so `getByTestId` throws → RED.
  - **Control (G-469):** the ordering assertion must name the reference item too — capture the
    ordered list of every element matching `[data-testid^="settings-nav-"]` in document order and
    assert its LAST entry is `settings-nav-credits` AND that `settings-nav-installed-apps` is
    present and precedes it. Two non-empty readings naming the same subject; an empty list is a
    failure, never a pass.
  - **Edge:** a Credits item inserted before `installed-apps` fails the "last" assertion (that is
    the discriminating mutation — a placement-insensitive assertion is a FAIL of this row).
  - **Edge:** the pane's group order is a SEPARATE assertion (U-2): five `credits-entry-*` with
    `section <= 4`, then `credits-fredo-licence`, then `credits-entry-posable-doomguy`, then
    `credits-doom-trademark`, then the canonical-source footer — assert it with
    `compareDocumentPosition` pairs, not by document text order.
- [ ] **F-1b (live).** Boot the isolated dev env, open Settings from the launcher tile
      `Settings` (`.opencode/tests/launcher/functional.md` F-49: the tile produces
      `div[role="group"][aria-label="Settings"]`), then
      `tauri_webview_execute_js(script="document.querySelector('[data-testid=\"settings-nav-credits\"]').click()")`,
      then `tauri_webview_dom_snapshot(type="structure")` + `tauri_webview_screenshot`.
  - **Expected:** `settings-nav-credits` existed **before** the click (a DOM snapshot of the
    Settings surface names it); after the click the snapshot contains `credits-settings`, the
    pane's `h2` reads `Credits`, and the screenshot shows the Credits pane inside the Settings
    window (nav visible on the left).
  - **Fails on the pre-change tree:** no such element → the `execute_js` returns
    `TypeError: Cannot read properties of null` and the snapshot has no `credits-settings`.
  - **Edge:** with ≥1 feature exposing settings (the normal shipped app) the item is still the
    last `settings-nav-*`; a `credits` item that only appears when the registry is empty is a
    FAIL of F-1a.

## F-2 (AC-1 · R-1.1) — the four third-party classes render with licence identifier, distribution form and one upstream link

- [ ] **F-2a (live, DOM).** On the Credits section, `tauri_webview_execute_js` returning a JSON
      array of, per entry: the `credits-entry-<id>` root's text, its `credits-entry-name-<id>`
      text, each field's `dt` testid + label + the `dd` next-sibling text, the licence triggers'
      text, and any `[href]` / `[target]` node inside the entry.
  - **Expected — the entry set (UI/UX §1, group A):** exactly these FIVE entry roots are in
    group A, in doc order: `llama-cpp`, `vulkan`, `ggml`, `neurodoom`, `doom1-wad` — the five
    components recorded in §1, §2 (two rows), §3, §4, covering all FOUR classes (sections
    `1, 2, 2, 3, 4`). `posable-doomguy` is NOT in this group (it is §7's card, F-5), and the
    group's membership comes from `CREDIT_ENTRIES.filter(e => e.section <= 4)` — never a
    hardcoded count.
  - **Expected — per entry:** the `credits-entry-name-<id>` text equals that entry's `name` in
    `CREDIT_ENTRIES`; every field the artifact carries for that entry renders as a **definition
    list pair** — the `dt` carrying `credits-field-<id>-<fieldSlug>` and its
    `nextElementSibling` (`dd`) carrying the value, which must equal the artifact's value
    **character for character**; the `dt` whose label is `Distribution form` exists (the
    generator requires the field, so its absence is also a build failure); the licence
    identifier renders as the label of a licence trigger (`credits-body-<id>-<licenceSlug>`)
    whose text is `<doc identifier> licence text` (e.g. `MIT licence text`,
    `Apache-2.0 licence text`, `BSD-3-Clause licence text`, `id Software shareware licence
    text`) — the identifiers are `MIT`+`Apache-2.0` (llama-cpp), `Apache-2.0` (vulkan), `MIT`
    (ggml), `BSD-3-Clause` (neurodoom), `id Software shareware` (doom1-wad); exactly ONE
    `credits-link-<id>` exists.
  - **Expected — the five upstream URLs of these entries (read them from the artifact, do not
    retype):** `llama-cpp` → `https://github.com/ggml-org/llama.cpp`;
    `vulkan` → `https://www.vulkan.org/` (**the FIRST https URL in the §2 cell** — the cell also
    carries `https://github.com/KhronosGroup/Vulkan-Loader`; the second must NOT be the link);
    `ggml` → `https://github.com/ggml-org/ggml`;
    `neurodoom` → `https://codeberg.org/olanod/NeuroDoom`;
    `doom1-wad` → `https://www.doomworld.com/idgames/?id=7043`. (§7's
    `posable-doomguy` URL is F-5's.)
  - **Fails on the pre-change tree:** no `credits-entry-*` element exists.
  - **Control:** the four section values `{1,2,3,4}` must all appear among the five entries'
    `section` fields (a dropped class → RED); a four-entry set that repeats one class fails.
  - **Edge:** §2's licence column label is `License / terms` (American spelling, slash) while
    §1/§3 use `License` and §7.1 uses `Licence` (British). The identifier must still be
    recognised for both spellings; a pane that drops §2's identifiers because the label differs
    is a FAIL.
  - **Edge:** the §1 `Distribution form` value is ~700 characters and contains inline markdown
    emphasis. The rendered value must equal the artifact's value (markdown markers stripped by
    the generator, never rendered raw) — a raw `**` in the DOM is a FAIL.
- [ ] **F-2b (unit — DOM == artifact).** In `CreditsSettings.test.tsx`, render the component and
      assert for EVERY entry and EVERY field in `CREDIT_ENTRIES` that the field's `dd` value equals
      the artifact's value (the `dt` testid is `credits-field-<id>-<fieldSlug>`; the value is its
      `nextElementSibling` — the UI/UX section states this once, so no row guesses), and that
      `CREDIT_ENTRIES.length === 6`.
  - **Expected (copy C-13):** the pane footer's text equals
    `Canonical source: <CREDITS_SOURCE.docPath> — this list is generated from that file.` built
    from the artifact's own `docPath` — the footer names the doc the content came from.
  - **Expected:** zero mismatches; the test imports the artifact (not a fixture), so a
    doc→artifact change moves the assertion with it.
  - **Edge:** a component with a hand-copied literal instead of the artifact fails the moment a
    value in the artifact differs — that is the defect this row exists for (AC-4).

## F-3 (AC-2 · R-2.1) — Fredo's own dual MIT / Apache-2.0 statement

- [ ] **F-3.** On the Credits section, read `[data-testid="credits-fredo-licence"]` text and the
      two body triggers `credits-body-fredo-mit` / `credits-body-fredo-apache-2-0`.
  - **Expected:** the block's whitespace-normalised text EQUALS `FREDO_LICENCE.statement` from
    the artifact; that statement contains BOTH `MIT` and `Apache-2.0` (the dual licensing);
    both body triggers exist.
  - **Expected (content authority, AC-4):** `FREDO_LICENCE.statement`, whitespace-normalised,
    occurs verbatim in `docs/THIRD_PARTY_NOTICES.md` (the preamble paragraph at `:3-6`) — no
    app-only sentence.
  - **Fails on the pre-change tree:** no `credits-fredo-licence` element.
  - **Edge (disclose, do not adjudicate here):** if the implementation prints the SPDX
    expression `MIT OR Apache-2.0` verbatim, that exact string must ALSO exist in the doc
    (the doc preamble currently says "the MIT and Apache-2.0 licenses"). Record which form is
    shipped; an in-app-only SPDX expression is an AC-4 FAIL. See the QA plan's discussion point.

## F-4 (AC-2 · R-2.2) — both full licence texts are readable in-app, untruncated and not linkified

- [ ] **F-4a (live, MIT).** Expand `credits-body-fredo-mit` (execute_js `.click()` or
      `tauri_webview_interact`), then read `[data-testid="credits-text-fredo-mit"]`.
  - **Expected:** the element's normalised text (CRLF→LF, trailing whitespace per line trimmed)
    EQUALS `LICENSE-MIT`'s normalised text; it starts with `MIT License`; it ends with
    `SOFTWARE.`; `querySelectorAll('a').length === 0`.
  - **Fails on the pre-change tree:** no such trigger/text.
  - **Control:** the assertion is full-text equality against the file — a first-N-lines stub, a
    "see the repository" placeholder, or a `…` elision fails on length and on the last anchor.
- [ ] **F-4b (live, Apache-2.0).** Expand `credits-body-fredo-apache-2-0` **without collapsing
      MIT**, then read `credits-text-fredo-apache-2-0`.
  - **Expected:** normalised text EQUALS `LICENSE-APACHE-2.0`'s normalised text; it contains
    BOTH `END OF TERMS AND CONDITIONS` (near the top third) and
    `APPENDIX: How to apply the Apache License to your work.` (near the end); it contains the
    literal `http://www.apache.org/licenses/` **as text**; `querySelectorAll('a').length === 0`
    (the `http://` URL inside the licence body must NOT become an anchor — an `http` link would
    both violate the https-only rule and navigate away from Credits).
  - **Expected:** MIT's text is still present while Apache is open (a `multiple` accordion; a
    single-open accordion that closes MIT is a FAIL of "both … readable").
  - **Edge:** a virtualized/collapsed body that omits the tail of the 202-line Apache text is a
    FAIL even if the heading renders.
  - **Edge:** the rendered body must be selectable plain text (`white-space: pre-wrap`), not an
    `<iframe>`, a `<pre>` with `overflow: hidden` + fixed height, or an image. The UI/UX
    contract renders it as `<Box as="pre" … userSelect="text">` with NO `overflow`, NO
    `maxHeight` and NO `tabIndex` — assert the body element's computed `overflow` is `visible`
    and it has no `tabindex` attribute (a focusable scroll box would trap Tab inside the pane).
- [ ] **F-4c (entry licence bodies — plan contract (b), not an AC clause).** Expand each of the
      entry-level triggers (`credits-body-llama-cpp-mit`, `-apache-2-0`, `-vulkan-apache-2-0`,
      `-ggml-mit`, `-neurodoom-bsd-3-clause`, `-doom1-wad-shareware`,
      `-posable-doomguy-cc-by-4-0`) and read each `credits-text-<id>-<licenceSlug>`.
  - **Expected:** every body is NON-EMPTY; for the three complete texts the body equals its
    source — MIT → `LICENSE-MIT`, Apache-2.0 → `LICENSE-APACHE-2.0`, BSD-3-Clause → the doc's
    `### BSD 3-Clause License` block (`docs/THIRD_PARTY_NOTICES.md:92-120`) after EOL
    normalisation. The `shareware` and `cc-by-4-0` bodies are doc excerpts (§4's redistribution
    note / §7 prose) and are asserted **non-empty and source-matching**, never "complete" —
    the trigger copy deliberately says `licence text`, not `Full text` (2 of the 9 panels are a
    summary; a `Full text` label would be a false claim).
  - **Edge:** nine panels in total (7 entry bodies + 2 Fredo bodies) and all are independently
    expandable (`multiple`) — expanding one never collapses another.

## F-5 (AC-3 · R-3.1) — the Fjaru / CC BY 4.0 design-reference credit

- [ ] **F-5 (live + doc cross-check).** Read `[data-testid="credits-entry-posable-doomguy"]`
      (group C — the design-reference card; it renders AFTER the Fredo licence block, not beside
      the §1–§4 cards).
  - **Expected:** the `credits-entry-name-posable-doomguy` text contains `Posable Doomguy`; the
    licence trigger `credits-body-posable-doomguy-cc-by-4-0` exists and its text starts with
    `CC BY 4.0 licence text`; the `dt` `credits-field-posable-doomguy-source` exists and its
    `dd` carries `https://www.thingiverse.com/thing:4873090` (equal to the artifact's
    `upstreamUrl` and to `credits-link-posable-doomguy`'s URL); the `dd` of the
    `Distribution form` field CONTAINS the exact characters
    `Reference only — no geometry shipped` — **capital R, em dash U+2014, no trailing period
    before the dash** (the UI/UX section freezes this casing, and the value is a longer
    generated sentence that BEGINS with the phrase, so the assertion is containment of the
    exact string, never equality of the whole cell).
  - **Expected (content authority):** the same exact string occurs in
    `docs/THIRD_PARTY_NOTICES.md` §7.1 (ST-1's added `Distribution form` row) — grep the doc and
    record the match.
  - **Expected:** the §7 card's `Licence URL` row
    (`https://creativecommons.org/licenses/by/4.0/`) renders as PLAIN TEXT and is NOT
    activatable — one activatable link per entry (R-1.1), and the pane has zero `[href]` nodes
    (F-11b). Do not assert an `href` on it.
  - **Expected (content authority):** the same phrase occurs in `docs/THIRD_PARTY_NOTICES.md`
    §7.1 (ST-1's added `Distribution form` row) — grep the doc and record the match.
  - **Fails on the pre-change tree:** no entry; also fails if the pane shows only the §7.1
    pre-existing `Redistributed` wording (`No. Reference only.`) without the AC's phrase.
  - **Edge:** asserting `Reference only` alone is a FAIL of this row — the AC's phrase is
    "reference only — no geometry shipped" and a seven-word prefix is a different claim.

## F-6 (AC-3 · R-3.2) — the DOOM trademark + non-affiliation notice, verbatim from §4

- [ ] **F-6 (live + doc cross-check).** Read `[data-testid="credits-doom-trademark"]` text.
  - **Expected:** after normalising whitespace and removing `**` emphasis markers, the text
    EQUALS the `**Trademarks.**` paragraph of §4 (`docs/THIRD_PARTY_NOTICES.md:150-152`):
    `DOOM and the DOOM logo are trademarks of id Software LLC / ZeniMax Media Inc. Fredo is not
    affiliated with, endorsed by, or sponsored by id Software; the DOOM name is used only to
    identify the bundled shareware game data.`
  - **Expected:** the exact substring `not affiliated with, endorsed by, or sponsored by id
    Software` is present (not merely "not affiliated").
  - **Fails on the pre-change tree:** no `credits-doom-trademark` element.
  - **Control:** the doc carries a SECOND `**Trademarks.**` paragraph in §7 (`:215-219`) whose
    wording differs (it discusses the avatar). Record which paragraph the app's text matches;
    matching §7's text instead of §4's is a FAIL (R-3.2 pins §4).
  - **Edge:** an assertion that only checks "contains `not affiliated`" is a FAIL of this row —
    the requirement is the notice "with the same meaning", and a paraphrase is not equality.

## F-7 (AC-4 · R-4.1) — the committed artifact equals a fresh generation, and content is equal in BOTH directions

- [ ] **F-7a (regeneration is a no-op).** Record `Get-FileHash` of
      `apps/ui/src/applications/settings-app/credits/credits.generated.ts`; run
      `run-exitcode.ps1 -Command "pnpm credits:generate"`; re-hash.
  - **Expected:** `EXITCODE=0` and the two hashes are EQUAL.
  - **Precondition (stated, not assumed):** this leg is only meaningful **after** F-9 has proved
    the generator actually writes (a doc edit changes the artifact bytes). Without that control,
    an unchanged hash is equally consistent with a generator that does nothing — the G-476
    vacuity. If F-9 was not run, this row is `UNVERIFIED`, never PASS.
- [ ] **F-7b (doc hash stamped in the artifact).** Read line 1 of the artifact; extract the
      `sha256:<hex>` value; compute `Get-FileHash docs/THIRD_PARTY_NOTICES.md -Algorithm SHA256`.
  - **Expected:** the hex values are equal (EOL-normalised input, per the generator contract).
  - **Fails on the pre-change tree:** the artifact file does not exist → RED.
- [ ] **F-7c (the gate suite is green on the committed tree).**
      `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui test:run src/applications/settings-app/credits/__tests__/creditsGenerator.test.ts"`.
  - **Expected:** `EXITCODE=0`, a non-zero number of tests run (`Tests  N passed` with N ≥ 5),
    and the file is named in the output (guard against a "no test files found" false green —
    that prints `EXITCODE=1` and 0 tests, which is `UNVERIFIED`, not PASS).
- [ ] **F-7d (app → doc: nothing exists only in the app).** For each value read from the
      artifact — the six names (`llama.cpp`, `Vulkan`, `ggml`, `neurodoom`, `DOOM1.WAD`,
      `Posable Doomguy`), the five licence identifiers (`MIT`, `Apache-2.0`, `BSD-3-Clause`,
      `CC BY 4.0`, `id Software shareware`) and the six `upstreamUrl` values (`F-2a`'s list plus
      `https://www.thingiverse.com/thing:4873090`) — run
      `Select-String -Path docs/THIRD_PARTY_NOTICES.md -Pattern "<value>" -SimpleMatch`.
  - **Expected:** every one returns ≥1 match. A zero is an app-only entry ⇒ AC-4 FAIL, naming
    the value.
  - **Control (G-430):** the scan target is the DOC file only; the suite's own text is not
    scanned, so the row cannot count itself. Prove the scanner works by also searching for a
    string known to be absent (`zzz-not-present-3206`) and requiring 0 matches.
- [ ] **F-7e (doc → app: nothing exists only in the doc, inside the include set).** Read the doc
      and enumerate every component row in §1, §2 (the two table rows), §3, §4 and §7.1; compare
      the count with `CREDIT_ENTRIES.length`.
  - **Expected:** 6 == 6, and each doc component's name appears in the artifact (the exact six
    ids are asserted by F-7c's suite). A doc entry with no matching artifact entry is a FAIL
    (it would ship silently omitted).
  - **Expected (§5/§6 excluded, R-4.3):** the artifact contains NEITHER `RESTful-DOOM` NOR
    `Removed out-of-process companion runtime` (scan the artifact file only — these tokens are
    written here deliberately and must not be scanned as part of this row's own text).
  - **Edge:** §2's table has two component rows in ONE section; a generator that takes only the
    first row per section would fail this row (ggml missing).

## F-8 (AC-4, G-476) — a stale artifact FAILS the test suite (the gate must be able to go red)

- [ ] **F-8a (precondition: nothing regenerates behind the gate).** Read the root `package.json`
      and `apps/ui/package.json` scripts.
  - **Expected:** neither defines `prebuild`, `pretest`, `pretest:run`, `prepare` or any hook
    that invokes `scripts/generate-credits.mjs` / `credits:generate`. If such a hook exists, the
    same suite that must fail is fed a freshly regenerated file, the mutation below is repaired
    before the read, and this row is a FAILED DRIVE (record it as a plan-level defect — G-447).
- [ ] **F-8b (leg 1 — a mutated ARTIFACT reddens the suite).** Copy the artifact to
      `.opencode/tmp/3206/drift/credits.generated.ts.bak` (and record its SHA-256). Apply a
      minimal in-place value mutation that keeps the file valid TypeScript (e.g. change the
      `posable-doomguy` entry's `name` from `Posable Doomguy` to `Posable Doomguyx`). Then run
      the F-7c command.
  - **Expected:** `EXITCODE` is NOT 0; the output contains the drift message naming
    `credits.generated.ts` and the `credits:generate` command (the generator contract's
    "the doc drifted — run `pnpm credits:generate` and commit the artifact" wording, or a
    superset of it). A green run here is a FAIL of this row (the gate is vacuous → the AC-4
    clause is unproven).
- [ ] **F-8c (leg 2 — a mutated DOC reddens the same suite with the ARTIFACT untouched).**
      Restore the artifact from the `.bak` (verify SHA-256 equality), then edit
      `docs/THIRD_PARTY_NOTICES.md` in place — change one field VALUE (e.g. §1's
      `| Use in Fredo | …` cell) — and re-run the F-7c command.
  - **Expected:** `EXITCODE` is NOT 0 with the same drift message. This is the AC's literal
    "editing the doc … a stale generated artifact fails the test suite".
  - **Control:** the two mutations are independent (artifact-only, then doc-only); a run that
    reddens only when both are changed has not proved the comparison is content-bound.
- [ ] **F-8d (restore and re-verify).** Restore the doc (copy the `.bak` equivalent taken in
      F-8c) and the artifact; re-run F-7c and F-7a.
  - **Expected:** suite `EXITCODE=0`; artifact SHA-256 equals the baseline recorded in F-8b;
      doc SHA-256 equals the value recorded before the F-8c edit. A file left dirty after this
      row is a process FAIL — report it, do not proceed to a verdict.

## F-9 (AC-4) — editing the doc and rebuilding CHANGES the app's content (round trip with a marker only the edit can produce)

> Runs AFTER every row that reads the artifact or `apps/tauri/dist/**` (G-446). Marker:
> `QA-DRIFT-3206-MARKER` — a plain token that survives the generator's markdown stripping and
> exists nowhere in the repo, so its presence in the built bundle is producible by this edit
> only. The scan targets are the generated artifact and the **built bundle**; this suite's own
> text is not scanned (G-430).

- [ ] **F-9a (baseline).** Record: SHA-256 of `docs/THIRD_PARTY_NOTICES.md`, of the artifact, and
      of the credits-bearing asset in `apps/tauri/dist/assets/` (the `*.js` file whose text
      contains `llama.cpp` and `Vulkan`). Copy the doc to
      `.opencode/tmp/3206/drift/THIRD_PARTY_NOTICES.md.bak`. Assert
      `Select-String -Path apps/tauri/dist/assets/*.js -Pattern 'QA-DRIFT-3206-MARKER' -SimpleMatch` returns
      **0** matches (the negative control — the marker must not pre-exist).
  - **Precondition:** `apps/tauri/dist/` exists (produced by `pnpm --filter @fredo/tauri
    build:webview`). If it does not, run that build first and record its `EXITCODE=0`.
- [ ] **F-9b (edit → regenerate → rebuild).** Insert ` QA-DRIFT-3206-MARKER` at the END of §1's
      `| Use in Fredo |` cell value (before the closing ` |`). Then:
      `run-exitcode.ps1 -Command "pnpm credits:generate"` → `EXITCODE=0`;
      assert the artifact now contains the marker exactly once;
      assert the artifact's SHA-256 DIFFERS from F-9a's;
      `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui test:run src/applications/settings-app/credits/__tests__/creditsGenerator.test.ts"`
      → `EXITCODE=0` (doc and artifact still agree — the gate compares content, not committed
      bytes); then
      `run-exitcode.ps1 -Command "pnpm --filter @fredo/tauri build:webview"` → `EXITCODE=0`;
      assert `Select-String -Path apps/tauri/dist/assets/*.js -Pattern 'QA-DRIFT-3206-MARKER' -SimpleMatch`
      returns **≥1** match, naming the asset file.
  - **Expected:** all four assertions hold. The bundle carrying the marker is the AC's
    "rebuilding changes the app's content".
  - **FAILED-DRIVE conditions (G-447):** the marker is absent from the artifact after
    regeneration, or present in the artifact but absent from the rebuilt bundle, or present in
    the bundle **before** the edit. Each means the observation does not follow from the edit —
    report it as a failed drive, never as a PASS.
- [ ] **F-9c (restore → regenerate → rebuild → back to baseline).** Copy the `.bak` over the doc;
      `pnpm credits:generate`; `pnpm --filter @fredo/tauri build:webview`; then assert: the doc's
      SHA-256 equals F-9a's; the artifact's SHA-256 equals F-9a's; the marker count in
      `apps/tauri/dist/assets/*.js` is **0**; the bundle again contains `llama.cpp` and
      `Vulkan`; and the credits asset's SHA-256 equals F-9a's.
  - **Expected:** every equality holds. The bundle hash mismatch after restore is recorded as
    `BUILD_NONDETERMINISM` with the residual claims (marker absent, credits strings present)
    standing — do not fail the AC on a content-hash difference alone, but do disclose it.
  - **Edge:** if any regenerated file differs from baseline, the round's tree is dirty — report
    it and re-run F-7a/F-7c before any verdict.

## F-10 (AC-4, offline) — no runtime fetch: the credits content is embedded in the shipped bundle

- [ ] **F-10a (bundle literals).** On the built served bundle
      (`apps/tauri/dist/assets/*.js`), search for each of the six upstream URLs (F-2a's list plus
      `https://www.thingiverse.com/thing:4873090`) and for the licence-body anchors
      `MIT License` and `APPENDIX: How to apply the Apache License to your work.`
  - **Expected:** every search returns ≥1 match — the content is INLINED in the shipped JS, so
    no network is needed to display it.
  - **Fails on the pre-change tree:** the strings are absent (no credits module in the bundle).
- [ ] **F-10b (source scan: zero network calls in the credits module).** Scan every file under
      `apps/ui/src/applications/settings-app/credits/` (including `__tests__` exclusion is
      unnecessary — include them, they carry no network call either) for `fetch(`,
      `XMLHttpRequest`, `axios`, `http.get` and `https.get`.
  - **Expected:** 0 matches.
  - **Control (G-430/G-476):** run the SAME pattern over
    `apps/ui/src/shared/utils/azdoApi.ts` and require ≥1 `fetch(` match — proving the scanner
    can see a network call (a scanner that always returns 0 is the defect this control catches).
- [ ] **F-10c (live: the pane is fully rendered with no network success needed).**
      With the dev env's Vite server up, open Credits and read the console
      (`tauri_read_logs(source="console", lines=50)`).
  - **Expected:** the pane shows all six entries; the console has no `Failed to fetch`,
    no CSP `connect-src` refusal and no `net::ERR` entry attributable to the Credits mount.
  - **Edge:** an unrelated pre-existing console error is disclosed, not attributed — the row
    asserts only absence of network-failure entries at the moment the pane mounts.

## F-11 (AC-5 · R-5.1) — activating an upstream link hands the URL to the OS and leaves the window on Credits

- [ ] **F-11a (instrument self-test, run first).** In the live webview,
      `execute_js` appends `<a id="__credits_probe" href="https://probe.invalid/x">x</a>` to
      `document.body`, counts `document.querySelectorAll('[href]').length` (must be ≥1), then
      removes the node and re-counts to the pre-probe value.
  - **Expected:** the count rises by exactly 1 while the probe exists. This proves the selector
    the absence assertions below rely on can see a `href` at all (G-430's negative control) —
    including on a node inside a Chakra-rendered tree.
- [ ] **F-11b (no anchor anywhere in the pane, a real button).** On the Credits section, scoped
      to `[data-testid="credits-settings"]`:
      `querySelectorAll('[href]')` → length **0**; `querySelectorAll('[target]')` → **0**
      (UI/UX U-3: the pane renders zero `href` and zero `target` nodes at all — not merely zero
      `<a>`); and `document.querySelector('[data-testid="credits-link-llama-cpp"]')` is a
      `BUTTON` with `hasAttribute('href') === false`,
      `aria-label === 'Open llama.cpp upstream page in your browser'`, and visible text
      containing `llama.cpp upstream page` (the visible label is a substring of the accessible
      name — WCAG 2.5.3 Label in Name).
  - **Expected:** all hold for EVERY `credits-link-<id>` (loop the six ids and report each).
  - **Expected:** the link button is NOT disabled and shows no spinner in any state (success has
    no in-app feedback; the button stays enabled so a legitimate retry works).
  - **Fails on the pre-change tree:** the element does not exist. Fails on an `<a href>`
    implementation — which is the mechanism the AC forbids, because a same-tab `href` would
    replace the Settings document (`default-src 'self'` does not restrict top-level navigation).
- [ ] **F-11c (activation: OS handoff, no navigation, no new window).** Record `location.href`,
      `document.title` and `tauri_manage_window action="list"`; record the wall-clock t0;
      click `credits-link-llama-cpp`; wait ~2 s; re-read all three plus
      `tauri_webview_dom_snapshot(type="structure")`.
  - **Expected:** `credits-settings` is still present; `location.href`, `document.title` and the
    window list are **identical** to the pre-click readings; `credits-link-error` is absent (the
    invoke resolved); the console shows no navigation/CSP entry.
  - **Expected (the OS handoff has a real target):** read
    `HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice` →
    `ProgId` is non-empty (a default `https` handler is registered), and the invoke resolved Ok.
  - **Corroboration (never a FAIL gate, G-470):** a browser process whose `StartTime` is after t0
    may appear. **Zero new processes is NOT a failure** — the default browser commonly reuses a
    running instance and opens a tab. Record which of the two happened; the gate is
    (handler registered + invoke Ok + Credits still shown), and the visible browser window is an
    operator-review-window observation.
  - **Edge:** activating a SECOND entry (`credits-link-neurodoom`) leaves the window on Credits
    too, and the two links pass distinct URLs (F-14 covers the exact payload).

## F-12 (AC-5 · R-5.2) — a bad URL is refused with a pinned code and ZERO process launches

> The product path can never produce a bad URL (the generator refuses one at build time), so
> this row binds to the **injected-recorder unit seam** — the only place a refusal can be
> observed end-to-end (G-275/G-300). ST-4 owns these tests; the receipt required here is the
> run's OWN printed line per input, so the matrix is visible in the log instead of inferred
> from a green summary.

- [ ] **F-12a (run the seam's unit matrix).**
      `run-exitcode.ps1 -Command "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --locked open_external_link -- --nocapture"`.
  - **Precondition (from the plan's own dependency step):** promoting `open` from a transitive
    crate to a direct dependency ALSO edits the `fredo` package's `dependencies` list in
    `Cargo.lock:1905-…` even though no new crate is resolved — so `--locked` fails until that
    lockfile update is committed. If `--locked` fails with "the lock file needs to be updated",
    that is a developer defect whose fix is committing the lock update, **never** dropping
    `--locked` from the row.
  - **Expected:** `EXITCODE=0`; the output contains, for every input below, one line of the form
    `REFUSED <input> code=<code> launches=0`, and for the two accept URLs
    `ACCEPTED <url> launches=1`.
  - **Matrix (pinned code where the command contract states it; otherwise "refused with one of
    the five pinned codes"):**

    | input | expected |
    |---|---|
    | `http://example.com/x` | `not-https` |
    | `ftp://example.com/x` | `not-https` |
    | `file:///C:/Windows/win.ini` | `not-https` |
    | `javascript:alert(1)` | refused (`not-https` or `malformed` — record which) |
    | `data:text/html,<script>x</script>` | refused |
    | `//evil.com/x` | refused |
    | `https:///x` | `no-host` |
    | `https://` | refused (`no-host` or `malformed` — record which) |
    | `https://localhost/x` | `loopback-host` |
    | `https://127.0.0.1/x` | `loopback-host` |
    | `https://[::1]/x` | `loopback-host` |
    | `https://0.0.0.0/x` | `loopback-host` |
    | `https://user:pw@example.com/x` | `userinfo` |
    | `https://example.com/a b` (contains a space) | refused (`malformed`) |
    | 3000-character `https://` URL | refused (`malformed` — the length bound) |

  - **Control (G-469 — without this the matrix is vacuous):** the two `ACCEPTED … launches=1`
    lines must be present. `launches=0` for every refused input is only meaningful because the
    same recorder was proven to fire on accept.
- [ ] **F-12b (no shell, one call site).** Count the product-source `open::that*` call sites:
      `powershell -NoProfile -Command "Get-ChildItem -Path apps/tauri/src-tauri/src -Recurse -File -Include *.rs | Select-String -Pattern 'open::that' -SimpleMatch | ForEach-Object { $_.Path + ':' + $_.LineNumber }"`
      → exactly ONE line, inside `applications/settings/credits.rs`'s `default_opener`; and the
      same walk for `std::process::Command` / `cmd /c` / `powershell` string construction scoped
      to that module → ZERO lines.
  - **Expected:** 1 hit, 0 command-spawning hits. The OS handoff therefore has exactly one
    mechanism and "refused ⇒ nothing launched" is structural (the refusal returns before
    `default_opener` is reachable).
  - **Edge (disclose):** if the pinned `open` 5.3.4 implementation itself shells out
    (`cmd /c start`), record it here — the refusal path is still I/O-free, and the exploratory
    metacharacter probe (E-1) covers the accepted path.
- [ ] **F-12c (fallback if the tester sandbox has no `cargo`).** Quote the `rust-validate` job's
      green run on the **tested commit** (the CI run of `.github/workflows/validate.yml`), plus
      its log lines for the matrix. Record the substitution explicitly (precedent:
      `.opencode/tests/llama-setup/functional.md` cargo rows). A code-less "refused" claim for
      an unpinned input is acceptable; `launches=1` on ANY refused input is a FAIL; no run at
      all (local or CI) is `UNVERIFIED`, never PASS.

## F-13 (AC-5) — the live refusal seam through the dev debug bridge (`https` accepted, bad URL refused, nothing launched, no window change)

> Dev-only, inert in a release binary (`capabilities/mcp-bridge-dev.json` +
> `#[cfg(debug_assertions)]`). This is the round's own live receipt for the refusal half; F-12
> is the unit half.

- [ ] **F-13.** On the DEV instance, on the Credits section, run three `execute_js` invocations of
      the command (catch the rejection so the value comes back as a string):
      `window.__TAURI__.core.invoke('open_external_link', {url: '<u>'}).then(r=>'ACCEPTED', e=>String(e))`
      for `<u>` = `https://localhost/x`, `http://example.com/x`, and
      `https://github.com/ggml-org/llama.cpp`.
  - **Expected:** `https://localhost/x` → the string `external link refused: loopback-host`;
    `http://example.com/x` → `external link refused: not-https`; the github URL → `ACCEPTED`
    (control: the same seam accepts a well-formed https URL, so the refusals are the validator's
    decisions, not a broken bridge).
  - **Expected:** after each call, `tauri_manage_window action="list"` is unchanged,
    `credits-settings` is still present, and no `credits-link-error` appears (the pane was not
    driving).
  - **Precondition:** the instance must be the DEV build (`withGlobalTauri` is true only under
    `tauri.dev.conf.json`). If `window.__TAURI__` is undefined, use
    `window.__TAURI_INTERNALS__.invoke` and record which seam was used.
  - **Blocker discipline:** if neither handle exists (e.g. the round booted `dev:release`), the
    row is `UNVERIFIED` with that named blocker — never a PASS, and never a product FAIL.

## F-14 (AC-5 + AC-2/AC-3) — unit: button-not-anchor, one invoke with the entry's URL, refusal rendered, bodies never linkified

- [ ] **F-14.** In `CreditsSettings.test.tsx` (ST-3 authors it; mock
      `@/shared/utils/adapterBridge` with a recorder), assert:
  - **Expected:** every `credits-link-<id>` is a `BUTTON` whose `aria-label` is
    `Open <name> upstream page in your browser`; the rendered credits root contains ZERO
    `[href]` and ZERO `[target]` nodes.
  - **Expected (control):** the same query, run against a fixture `<a href="https://x/y">`
    rendered beside the component, finds exactly 1 — the selector is proven able to see a
    `href`, so the zero above is a reading and not a blind spot.
  - **Expected:** clicking `credits-link-llama-cpp` calls the bridge exactly once with
    `('open_external_link', { url: 'https://github.com/ggml-org/llama.cpp' })`; clicking
    `credits-link-vulkan` calls it with `https://www.vulkan.org/` (distinct payloads).
  - **Expected (re-entrancy, UI/UX U-4):** a SECOND click while the first invoke is still
    pending does NOT invoke again (the per-entry in-flight guard drops it) — and the button is
    never `disabled` (a disabled button loses focus).
  - **Expected (refusal render, R-5.2 + copy C-11):** when the mocked invoke rejects with
    `external link refused: loopback-host`,
    `[data-testid="credits-link-error"]` appears with `role="alert"`,
    `data-refusal-code="loopback-host"`, the sentence
    `Fredo couldn't open the llama.cpp upstream page in your browser. The address is listed
    above, if you want to open it yourself.`, and the raw refusal string
    `external link refused: loopback-host` in the specifics line; when it rejects with
    `external link refused: not-https`, the code attribute is `not-https`.
  - **Expected:** exactly ONE `credits-link-error` exists in the DOM at a time (the state is
    `{entryId, raw}`); triggering a failure on a different entry moves the block there and
    leaves none behind.
  - **Expected (bodies):** each licence body element contains ZERO `<a>`; the Apache body's
    text contains `http://www.apache.org/licenses/` as TEXT.
  - **Fails on the pre-change tree:** the component does not exist (RED).

## F-15 (AC-1 · R-1.3) — no truncation of long values and exactly one scroll container

- [ ] **F-15.** On the live Credits section, `execute_js` returning, for the §1 `Distribution
      form` VALUE element — `document.querySelector('[data-testid="credits-field-llama-cpp-distribution-form"]').nextElementSibling`
      (the `dt` carries the testid, the `dd` carries the value) — and for the Credits root:
      `{ text, textLen, expectedLen (from the artifact value), scrollWidth, clientWidth,
      scrollHeight, clientHeight, computedOverflowWrap, scrollers: [ancestors with computed
      overflow-y auto|scroll] }`.
  - **Expected:** `textLen === expectedLen` and the text's LAST 20 characters equal the
    artifact value's last 20 (no ellipsis, no clamp in the text); `scrollWidth <= clientWidth + 1`
    and `scrollHeight <= clientHeight + 1` for the value element (a `lineClamp`/fixed-height
    `overflow: hidden` reports `scrollHeight > clientHeight` even though the text is "in the
    DOM"); `computedOverflowWrap === 'anywhere'` (the documented mechanism by which a long URL
    or an unbreakable token breaks instead of overflowing); `scrollers` contains exactly ONE
    element between the Credits root and the viewport (the Settings content scroller).
  - **Fails on the pre-change tree:** the element does not exist.
  - **Edge:** repeat at the window minimum (900×600) — a value that clips only when narrow is a
    FAIL; the requirements say no truncation of an entry name, licence identifier or
    distribution-form value at any supported size.

## F-16 (non-functional · theming gate, G-403) — the new component joins the literal-colour audit

- [ ] **F-16.** List `apps/ui/src/applications/settings-app/credits/*.tsx` (directory listing,
      excluding `__tests__/`), then read `AUDITED_FILES` in
      `apps/ui/src/applications/settings-app/components/__tests__/SettingsSurface.theming.test.tsx`,
      then run `pnpm --filter @fredo/ui test:run src/applications/settings-app/components/__tests__/SettingsSurface.theming.test.tsx`.
  - **Expected:** EVERY listed `.tsx` file in the credits folder appears in `AUDITED_FILES`
    (a second component file that is not added is a FAIL — the Architect's G-403 note);
    `EXITCODE=0`.
  - **Fails on the pre-change tree:** the list has no credits entry (and the audit's
    `AUDITED_FILES` is a fixed list, so the new file is unaudited by construction).
  - **Edge:** a paint expressed as `var(--accent-primary)22` (alpha-append on a `var()`) is a
    literal-shape offender the audit already scans for — if the suite is green and that string
    is present in the component, the audit's file list or pattern is wrong: report it.

## F-17 (non-functional · accessibility) — expandable bodies and links are real, focusable controls

- [ ] **F-17a (unit, real activation semantics).** With `@testing-library/user-event`:
      initially every one of the NINE licence triggers has `aria-expanded="false"` and its panel
      is `hidden` (`defaultValue={[]}` — Credits opens fully collapsed on every mount);
      focus `credits-body-fredo-mit`, press `Enter` → `aria-expanded="true"`, panel not
      `hidden`, `credits-text-fredo-mit` non-empty; press `Space` on
      `credits-body-fredo-apache-2-0` → same for Apache AND the MIT panel is STILL open
      (`multiple`); each `credits-link-<id>` is focusable and `Enter` triggers the bridge call.
  - **Expected (UI/UX §5.2):** every trigger is a real `<button>` with NO `aria-label` (its
    accessible name is the visible `<identifier> licence text`; an `aria-label` would mask
    `aria-expanded`'s subject); NO `tabIndex` override anywhere in the pane.
  - **Expected (UI/UX §5.2, G-409 — ST-3 owns it):** if the shipped Zag version emits
    `aria-controls`, it resolves to an existing element (`document.getElementById(trigger.getAttribute('aria-controls'))`
    is non-null); if it does not, ST-3 must add an explicit `id` + `aria-controls` pair and
    assert it here. The UI/UX section records that no shipped test asserts `aria-controls`, so
    this row is where it becomes true.
- [ ] **F-17b (live spot-check).** `execute_js` returning, for each trigger and link,
      `{ tag, tabIndex, ariaExpanded, ariaLabel, ariaControlsResolves }`.
  - **Expected:** `tag === 'BUTTON'`, `tabIndex === 0`, `ariaLabel` EMPTY on the triggers and
    equal to `Open <name> upstream page in your browser` on the links; `aria-expanded` toggles
    `false` → `true` on activation; `ariaControlsResolves` is `true` wherever `aria-controls`
    is present.
  - **Expected (focus order, report the count):** tabbing from the pane's first control visits
    every link button followed by that entry's own triggers, each reachable exactly once, in DOM
    order. The design states **15 stops** (6 link buttons + 9 triggers) — record the observed
    count; a different count is a disclosure against the UI/UX contract, and a control reachable
    zero times or twice is a FAIL of this row.
  - A live keyboard drive is **not** required (the accordion is a native button; the unit row
    owns activation semantics) — do not improvise a `KeyboardEvent` dispatch, which does not
    activate buttons reliably.

---

## Required test data (all rows)

- **Isolated env:** `powershell -NoProfile -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3206 -EnvId <id> -EnvSlot <n> -RequireIsolation`, env id from
  `.opencode/state/env-leases/3206.json`, ports from `.opencode/tmp/envs/<id>/manifest.json`.
  Teardown on run-complete only: `-Action Down -EnvId <id>`.
- **Files read, never retyped:** `apps/ui/src/applications/settings-app/credits/credits.generated.ts`
  (the artifact), `docs/THIRD_PARTY_NOTICES.md`, `LICENSE-MIT`, `LICENSE-APACHE-2.0`,
  `apps/tauri/dist/assets/*.js` (the built served bundle).
- **Scratch (backs up only):** `.opencode/tmp/3206/drift/` for the artifact and doc backups.
- **Screenshots:** `.opencode/tmp/3206/e2e/`, uploaded with
  `rust-script .opencode/scripts/pipeline-state.rs --issue 3206 --agent tester --action upload-evidence --image <path>`;
  embed the returned `user-attachments` URL in the `## Tests Runs` comment (a non-draft record, G-415).
- **No fixture may be invented:** every expected string comes from the artifact or the doc at
  test time.

_Evidence convention: pass keeps `- [x]` + the observed value / file:line / exit code; fail
leaves `- [ ]` and marks `FAIL` with expected-vs-actual + repro; a row that cannot run is
`UNVERIFIED` with a named blocker — never a PASS._
