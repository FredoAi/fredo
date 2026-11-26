# App Intelligibility — Functional

> Durable functional suite for the **app-intelligibility** feature (issue **#3244**): every shipped app
> declares a plain-language **description**; on every order turn the companion automatically receives a
> **screenshot + a simplified HTML representation** of the app's current screen; the mechanism is
> **uniform**, so an installed app Fredo was never taught is the same path as a shipped one.
>
> One `- [ ]` case per acceptance-criterion leg (AC-1 … AC-5 + NFR-1).
>
> **Verification policy: live.** AC-2/AC-3 are runtime observables of a running app + companion; AC-4 is
> a genuine runtime measurement. **AC-1a/AC-1b/AC-2b are STATIC/CI** (labeled per case) — their receipt
> is the green CI run on the spec PR head SHA + the non-draft `## Developer ST-<id> — verification`
> comment. **`telemetry_logs` is NOT an accepted live receipt (gate gap M9)** — live cases name a
> `telemetry_spans` result, a `tauri_webview_*` receipt, or a `user-attachments` URL.
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
  - **Data:** fixture `qa3244-untaught`.

## AC2B — no per-app enablement, proven by absence

- [ ] **F-4 (AC-2b, STATIC).** Executed grep of `apps/ui/src` + `apps/tauri/src-tauri/src` for the
      fixture id `qa3244-untaught`; read `buildCompanionTurnMessages`
      (`apps/ui/src/shared/components/companion/companionDispatch.ts`).
  - **Expected:** **zero** source hits for the fixture app id; the description+pair assembly is **one
    shared code path** with **no per-app conditional branch**.
  - **Record:** the executed command + output in the suite / `## Developer ST-n — verification`,
    corroborated by the F-3 turn span.
  - **Edge:** a helper special-casing a "known" app id, or a shipped-id lookup table, FAILS this even
    when F-3 passes.

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

## AC4 — the screen-read limit is measured

- [ ] **F-6 (AC-4, LIVE).** Run the plan's recorded screen-read measurement (a scored run over
      progressive screen fixtures recording the limit at which the small model still acts correctly).
  - **Expected:** **a NUMBER is recorded** for the pair's screen-read limit, persisted in a committed
    (NON-DRAFT) artifact and/or a `telemetry_spans` record and re-readable by a separate process.
  - **Receipt:** the committed report path + the `telemetry_spans` measurement record.
  - **Edge:** a hard-coded constant presented as a "measurement" FAILS. AC-4's number is the **pair's**
    limit, NOT #3234's visual-token budget (1120) — do not re-assert that budget here. A probe needing
    #3234's harness/assets is a **named blocker**, never a PASS by substitution.

## AC5 — release-one demonstration (CONDITIONAL)

- [ ] **F-7 (AC-5, LIVE · CONDITIONAL — gated).** *(Default, pending the human's word — see triage
      `## Discussion`.)* **If confirmed:** the F-3 journey extended to a full demonstration on one
      untaught app.
  - **Expected:** one untaught app is operated end-to-end with **no Fredo code change**, recorded.
  - **Receipt:** the same live receipts as F-3 + the demonstration outcome.
  - **Edge:** **do NOT silently accept or drop.** Status = **GATED**: recorded as **DEFERRED with the
    PO/human decision as its record** unless the human confirms — never a PASS by assumption.

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
