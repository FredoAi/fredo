# App Intelligibility — Functional

> Durable functional suite for the **app-intelligibility** feature (issue **#3244**): every shipped app
> declares a plain-language **description**; on every order turn the companion automatically receives a
> **screenshot + a simplified HTML representation** of the app's current screen; the mechanism is
> **uniform**, so an installed app Fredo was never taught is the same path as a shipped one.
>
> One `- [ ]` case per acceptance-criterion leg (AC-1 … AC-5 + NFR-1), plus the plan's beacon
> ingress-hardening row (ING-1) — see `fixtures/BEACON-INGRESS-CONTROLS.md`.
>
> **Verification policy: live.** AC-2/AC-3 are runtime observables of a running app + companion; AC-4 is
> a genuine runtime measurement; AC-5 is a driven row (the human bound its subject on 2026-11-26).
> **AC-1a/AC-1b/AC-2b are STATIC/CI** (labeled per case) — their receipt is the green CI run on the
> spec PR head SHA + the non-draft `## Developer ST-<id> — verification` comment. **`telemetry_logs` is
> NOT an accepted live receipt (gate gap M9)** — live cases name a `telemetry_spans` result, a
> `tauri_webview_*` receipt, or a `user-attachments` URL.
>
> **Data:** every fixture these rows drive is produced by the committed deterministic generator
> `.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs`; conventions,
> invocation, the determinism receipt and the child-evidence transport fact are in
> `.opencode/tests/app-intelligibility/fixtures/README.md`. **No `installed-*` window is reachable by
> `tauri_webview_*`** — read those windows with a native/UIA text read, never `execute_js`.
>
> **Turn-input receipt:** a plan-emitted per-turn **injection span** is the primary live receipt for
> AC-2/AC-3/AC-4 (`appId`, `taught`, `descriptionBytes`, `screenshotBytes`, `simplifiedHtmlBytes`,
> screenshot digest, simplified-HTML digest). If the plan does not emit it, the live cases have no
> accepted receipt and are UNSATISFIABLE AS WRITTEN — a named blocker, never a substitution.
>
> **Cross-references:** the screenshot leg's media placement + visual budget live in
> `.opencode/tests/companion-vision/` (#3234); the in-process engine suite is
> `.opencode/tests/companion-embedded-engine/`. This suite owns the **description contract**, the
> **per-turn pair injection**, the **freshness**, and the **measurement**.

## AC1A — every shipped app declares a description

- [ ] **F-1 (AC-1a, STATIC/CI).** Unit pin over the live registry: load `allApplications`, iterate
      `getApplications()` and read each app's `description`
      (`apps/ui/src/applications/__tests__/retainedApplicationSet.test.ts` is the pattern to extend).
  - **Expected:** every registered app exposes a **non-empty `description`** for all eight retained
    ids (`wireframe`, `terminal`, `mission-monitor`, `database-client`, `theming`, `setup`, `settings`,
    `dev-mode`). **FAIL on the pre-change tree** (no `description` member on `FredoApplicationClass`).
  - **Record:** green UI-test CI job log on the tested head SHA + `## Developer ST-n — verification`.
  - **Edge:** a whitespace-only description FAILS; hidden-but-shipped `theming`/`dev-mode` must declare
    one too; a description present only on installed packages but absent from the first-party contract
    FAILS.
  - **Data:** the eight retained app ids.

## AC1B — a missing description is a visible, typed failure

- [ ] **F-2 (AC-1b, STATIC + optional LIVE).** Unit pin on the **typed outcome vocabulary**: driving
      the missing/blank-description input yields a **new closed member** (`noDescription`, beside
      `'success'|'unknown'|'ambiguous'|'failed'` in
      `apps/ui/src/shared/components/companion/appOpenReply.ts`) plus a typed muted row marker at the
      registry description slot. Optionally corroborate on the live reply surface.
  - **Expected:** the missing-description path yields a **named typed failure** — a discriminated
    outcome value **surfaced to the caller** — never `undefined`, never `''`, never a silent no-op.
    The reply sentence names the app + the cause ("declares no description") and does **NOT** reuse the
    frozen install-refusal codes (`apps/ui/src/shared/installed-apps/types.ts:39-62`) nor the
    "couldn't open it" copy (G-505).
  - **Record:** green CI + `## Developer ST-n — verification` quoting the typed member; a
    `tauri_webview_*` receipt / `user-attachments` URL of the reply sentence if the live leg is run.
  - **Edge:** an empty-string description counts as MISSING; `null` fails identically; **do NOT squeeze
    this into a new install-refusal code** — a missing description is not an install/load refusal.

## AC2 — an untaught app is operable from its description + the injected pair

- [ ] **F-3 (AC-2, LIVE).** Open the **untaught** fixture package `qa3244-untaught` (zero references
      under `apps/**`), then trigger **one** companion order turn targeting it; read the per-turn
      injection record.
  - **Expected:** one turn-input record for the untaught app id carries **(i)** the declared
    `description`, **(ii)** the injected pair (screenshot leg AND simplified-HTML leg), **(iii)** a
    uniformity witness (`taught=false` / no per-app provider) — the SAME path with **no per-app
    enablement**.
  - **Receipt:** `telemetry_spans` query result for the injection span (PRIMARY) + `upload-evidence` of
    the reply surface as a `user-attachments` URL (secondary).
  - **Edge:** the observable is the **turn-input receipt**, NOT a completed order loop — **no leg
    requires #3243**. An app with no description must take the F-2 typed-failure path, never produce a
    silently description-less pair.
  - **Data:** fixture `qa3244-untaught`, produced by the committed deterministic generator
    `.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs`
    (see `.opencode/tests/app-intelligibility/fixtures/README.md` §1/§5). Drive it with a **native
    click** on its own `[data-qa3244-mutate]` button and read it with a **native/UIA text read** —
    never `tauri_webview_*` (the `installed-*` window is unreachable by design).

## AC2B — no per-app enablement, proven by absence

- [ ] **F-4 (AC-2b, STATIC).** Executed sweep of the **description+pair path** for the fixture id
      `qa3244-untaught`; read `buildCompanionTurnMessages`
      (`apps/ui/src/shared/components/companion/companionDispatch.ts`).
  - **Expected:** **zero product-code hits** for the fixture app id in the description+pair modules;
    the description+pair assembly is **one shared code path** with **no per-app conditional branch**.
  - **Record:** the committed sweep's quotable last line —
    `bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs` →
    `SWEEP RESULT: PASS … hits=0` — quoted in the `## Tests Runs` verdict, corroborated by the F-3
    turn span. (Not a bare `rg` command: the committed artifact is the record, and the matcher
    distinguishes a product-code hit from a comment/test mention; see `fixtures/README.md` §7.)
  - **Edge:** a helper special-casing a "known" app id, or a shipped-id lookup table **in the
    description+pair modules**, FAILS this even when F-3 passes. A shipped unit test naming the id as
    a fixture value is **not** a product hit — the sweep reports it as `test` and does not fail.
    `.opencode/**` is a **false negative** for repo-wide greps (G-024): "the pipeline's grep found
    nothing" never means the sweep is missing.

## AC3 — the injected pair is fresh each turn

- [ ] **F-5 (AC-3, LIVE).** With the app open, drive two turns separated by a visible screen change;
      read the two injection records.
  - **Expected:** both pair legs **differ** between the turns; the second reflects the app's **current**
    screen (the changed text appears in the simplified HTML); each record's capture time ≈ its turn
    time — no reuse of the earlier capture.
  - **Receipt:** two `telemetry_spans` records with **distinct** `span_id` and distinct digests (PRIMARY).
  - **Edge:** a turn with **no** screen change must still re-read (fresh capture) — checkable via a
    distinct capture-time/generation counter even when content is byte-identical; a stale snapshot
    (identical digest after a visible change) is a **FAIL**.
  - **Data:** fixture `qa3244-untaught` and its own change levers — a **visible screen change** is
    either a native click on `[data-qa3244-mutate]` (advances `QA3244-SCREEN step=<n> token=…`) or
    the guaranteed `[data-qa3244-live]` tick (every 1000 ms). Both are plain text inside the
    projected root, so the change lands in the simplified-HTML leg. Generated by
    `.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs`; read the
    installed window with a **native/UIA text read**, never `tauri_webview_*`
    (`fixtures/README.md` §1/§5).

## AC4 — the screen-read limit is measured

- [ ] **F-6 (AC-4, LIVE).** Run the plan's recorded screen-read measurement (a scored run over
      progressive screen fixtures recording the limit at which the small model still acts correctly).
  - **Expected:** **a NUMBER is recorded** for the pair's screen-read limit, persisted in a committed
    (NON-DRAFT) artifact and/or a `telemetry_spans` record and re-readable by a separate process.
  - **Receipt:** the committed report path + the `telemetry_spans` measurement record.
  - **Edge:** a hard-coded constant presented as a "measurement" FAILS. AC-4's number is the **pair's**
    limit, NOT #3234's visual-token budget (1120) — do not re-assert that budget here. A probe needing
    #3234's harness/assets is a **named blocker**, never a PASS by substitution.
  - **Data:** the `qa3244-dense-*` ladder (`-08`, `-32`, `-72`, `-120`, `-160`, `-url11k`) from
    `.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs` — six rungs of
    declared named-control density (see `fixtures/README.md` §1; rung `-120` sits exactly at
    `SCREEN_OUTLINE_MAX_NODES = 120` and must report `truncated=true`). The writer
    `.opencode/tests/app-intelligibility/measurement/build-ac4-record.mjs` fills
    `measurement/ac4-screen-read-record.json` from the run's `companion.injection` span. The rung
    declares density; **the bytes/nodes/image tokens are the run's reading** (G-511) — never a
    number from this suite.

## AC5 — release-one demonstrates the claim on one untaught app

- [ ] **F-7 (AC-5, LIVE — driven).** Drive **one** companion order turn on the built-in
      **`mission-monitor`** — a Fredo app Fredo was never taught **for the description+pair path**
      (the human bound this subject on 2026-11-26) — through the shipped composer submit
      (`CompanionEntity.handleComposerSubmit`, `CompanionEntity.tsx:1676` → `buildTurnTarget` →
      `buildTurnScreenContext` → `ask`). Then read the per-turn injection span back from
      `telemetry_spans` **and** run the committed scoped source-sweep.
  - **Expected — the observables are the NEGATIVE WITNESS, all three parts on the SAME run:**
    **(i)** `taught: false` **and** `perAppEntries: 0` on that run's `companion.injection` span
    (`attributes_json`); **(ii)** the committed sweep
    (`bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs`, subject
    `mission-monitor`) reports **zero product-code subject-id hits** in the description+pair modules —
    its `SWEEP RESULT: PASS … hits=0` line is the quote. The sweep also prints separately every
    `comment`/`test` mention it did **not** grade (as `not-graded …` lines): a mention in a doc
    comment or a unit test is a fixture/documentation value, not a per-app runtime branch, and the
    row's claim is the absence of a **special case** (`--strict` shows the literal any-mention count
    as a diagnostic). **(iii)** the positive injection receipt on that same run
    (the span exists, carries the subject's `appId`, and its `descriptionBytes` /
    `screenshotBytes` / `simplifiedHtmlBytes` are non-zero). A successful operation **alone is not
    the witness** — "operating a built-in successfully proves little if Fredo has a hand-written path
    to it; proving there is NOT one is the point."
  - **The confound this row NAMES (`MissionMonitorPanel.tsx:881`):** MM carries a hand-written per-app
    **grounding registrar** (`registerCompanionGrounding('mission-monitor', …)`). It supplies
    **selection metadata only** — no description, no per-turn pair — so it is **NOT enablement** and
    does not make MM operable without the description+pair path. This row therefore proves the
    **description+pair path has no per-app entry**; it must **never** be read as, or rewritten to,
    "MM has zero per-app Fredo code" (it does not). The sweep is scoped to the description+pair
    modules for exactly this reason.
  - **Record:** the `telemetry_spans` receipt for the per-turn injection span (PRIMARY, live) +
    the sweep's `SWEEP RESULT: PASS … hits=0` line — both quoted in the `## Tests Runs` verdict.
    Neither is a `.opencode/tmp/3244/` draft (G-415).
  - **Edge:** a per-app resolution turns part (i) red (`taught: true` or `perAppEntries > 0`); a
    subject-id branch in any description+pair module makes part (ii) exit 1 — **never widen the
    sweep's scope to green it**; a turn that fails to operate leaves part (iii) absent, which is a
    FAIL, not a partial PASS. All three parts must be on the SAME run: a span from one turn and a
    sweep re-run later is not the witness.
  - **Data:** the built-in id `mission-monitor`; the committed sweep
    `.opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs`; the per-turn
    `companion.injection` span, persisted by
    `apps/tauri/src-tauri/src/applications/llm_server/injection.rs` from the facts the webview
    derives in `screenTurnExtras` (`CompanionEntity.tsx:287`) and passes as the `injection` argument
    of `llm_chat_with_status`. The installed fixtures are **not** this row's subject (AC-2's
    `qa3244-untaught` is).

## NFR1 — the injected pair fits the context budget

- [ ] **F-8 (NFR-1, LIVE + STATIC).** Measure the serialized injected pair (screenshot token cost +
      simplified-HTML bytes + description bytes) against the companion's context budget; read the cap.
  - **Expected:** the pair's size is a **recorded number within the budget**; the assembly
    **refuses/degrades** an over-budget pair rather than silently truncating it into an unusable
    payload (mirrors `companionGroundingContent`'s over-cap → `null`).
  - **Receipt:** the recorded size number (committed / NON-DRAFT) + the code-read of
    `COMPANION_CAPABILITY_LIMITS.maxContextBytes` (`apps/ui/src/shared/companion/grounding.ts`, 16384
    bytes) and the model-context budget.
  - **Edge:** a pair exactly at the boundary; a dense screen yielding an over-budget pair must degrade
    observably, never truncate silently.

## ING1 — the beacon ingress treats its payload as untrusted input

- [ ] **F-9 (ING-1, LIVE).** Drive every beacon-ingress negative control the committed fixture can
      produce, and read the host's **typed** outcome for each from `telemetry_spans`.
  - **Steps:** open `qa3244-beacon-control` (the three mount-time controls fire on their own); then
     arm **`Suppress the next beacon`** with a native click and drive one companion turn targeting it,
     and separately arm **`Replay the last nonce after the TTL`** and drive one turn. The full control
     table, the expected typed reason per control, the attribution recipe and the reading instrument
     are in `.opencode/tests/app-intelligibility/fixtures/BEACON-INGRESS-CONTROLS.md`.
  - **Expected:** **one `installed.beacon.ingress` span per attempt**, each carrying the typed reason
    the control plan names — `oversize`, `missing-nonce`, `unknown-nonce`, and `timeout` for the
    suppress leg. **The replay leg yields two spans:** the turn's own beacon must read **`accepted`**
    (the turn working) and the replay ≈2.25 s later must read **`unknown-nonce`** (the control). Every
    rejection carries `accepted=false`. The typed reason **is** the observable: a beacon that merely
    does not crash, or a fixture panel that rendered, is **not** a PASS. A rejected beacon must also
    produce **no turn input**.
  - **Receipt:** the `telemetry_spans` rows (`SELECT span_id, status_message, attributes_json FROM
    telemetry_spans WHERE span_name = 'installed.beacon.ingress'`), quoted in the `## Tests Runs`
    verdict. `telemetry_logs` is refused (M9).
  - **Edge:** a control that produced no span is a FAIL, not "skipped" — the ingress records a span on
    every attempt, accepted or not. The `expired` reason is **not fixture-reachable** (the shipped TTL
    equals the correlation timeout and the nonce is closed when the wait ends); it is pinned by the
    unit test `an_expired_nonce_is_dropped` in `beacon.rs`, and that limit is stated in the control
    plan §4 rather than papered over. `chunk-incomplete` is likewise not producible from a child; if
    GATE-0 concluded no chunking is needed, say so in those words. Never `tauri_webview_*` against the
    installed window — arm the levers with native clicks and read the receipt from the host.
  - **Data:** fixture `qa3244-beacon-control` from
    `.opencode/tests/app-intelligibility/fixtures/build-intelligibility-fixtures.mjs`; the beacon
    contract (`BEACON_PATH`, `BEACON_MAX_BYTES`, `BEACON_TIMEOUT_MS`, `BEACON_INGRESS_SPAN_NAME`) in
    `apps/tauri/src-tauri/src/applications/installed_apps/beacon.rs`.
