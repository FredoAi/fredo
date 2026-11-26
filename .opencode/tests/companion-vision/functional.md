# Companion Vision — Functional

> Durable functional suite for the companion vision path's media placement and screen-capture
> visual budget (issue **#3234**, **re-scoped 2026-11-26**). One `- [ ]` case per acceptance-criterion
> leg (AC-1 … AC-5). **The rows are keyed to the AMENDED ACs**: the media turn keeps the shipped
> **text→image** order (AC-1), and AC-4 is a **recorded absolute measurement** (fixture count +
> dense prompt-token count), **not** a pass-set delta.
>
> **Row ids are stable** (G-476): F-1..F-15 keep their round-1 ids and are re-cut in place; the one
> NEW row (the regression guard) is appended as **F-16** after the highest existing id.
>
> **Verification policy: live.** AC-3c (a real over-batch image turn) and AC-4a (a real
> `fredo companion score` run with numbers) are genuine runtime observables. AC-1/AC-2/AC-3a-b and
> AC-5 are **pure unit pins** — their rows are **STATIC/CI**: the record is the green CI
> `rust-validate` run on the tested head SHA plus the non-draft `## Developer ST-n — verification`
> comment (the tester's shell has no `cargo`). **The live-policy receipt is the harness's own
> `companion.score` span set read back from `telemetry_spans`** (earned by F-11).
>
> **The order pins INVERT vs round 1.** They are GREEN on `main` and on the reverted tree; their
> control is that an image-first re-application **reddens** them. The **dense** screen-region case
> (target name only in a small title bar) is the TARGET case, not an edge case.
>
> Cross-references: the in-process engine migration's suite
> `.opencode/tests/companion-embedded-engine/` (F-8 vision, F-9 audio, F-16 settle contract,
> F-22 non-functional) is the regression home for the unchanged surfaces; this suite owns the
> **media order + budget** behaviour.

## ACA — the media turn keeps the shipped text→image order

- [ ] **F-1 (AC-1a, STATIC/CI).** Unit pin `an_image_turn_attaches_text_and_image_url_to_the_last_user_message`
      (`apps/tauri/src-tauri/src/applications/llm_server/engine/request.rs`, reverted).
  - **Expected:** `ChatTurn::text(conversation()).with_image("QUJD").render()`'s last user message is
    `RenderedContent::Parts` of exactly **2** parts, order `[Text{"look at this"},
    ImageUrl{data:image/png;base64,QUJD}]`; every earlier message keeps plain content.
    **GREEN on `main` and on the reverted tree; INVERTS — re-apply `[ImageUrl, Text]` and it reddens.**
  - **Record:** green `rust-validate` on the tested head SHA + `## Developer ST-n — verification`.
  - **Edge:** an empty-text image turn ⇒ `[Text{""}, ImageUrl]` still text-first; a turn with no
    user message fabricates nothing.
- [ ] **F-2 (AC-1b, STATIC/CI).** Unit pin `the_media_projection_places_the_marker_where_the_part_sits`
      (`engine/request.rs`, reverted).
  - **Expected:** for a one-image turn, `template_messages_json_with_media("<__media__>")` yields
    `parsed[last]["content"] == "look at this<__media__>"` (marker **after** the user text), exactly
    one marker, no image bytes in the prompt; the empty-marker projection still equals
    `template_messages_json()` byte for byte.
  - **Edge:** leading/trailing-marker and marker-count-mismatch refusals stay green; the audio
    projection stays one marker, no transcript.
- [ ] **F-3 (AC-1c, STATIC/CI).** Pure pin (`engine/multimodal_tests.rs`)
      `the_media_plan_evaluates_the_text_before_the_bitmap` (**renamed** from
      `…_bitmap_before_the_text` so the name does not lie):
      `interleave("look at this<__media__>", "<__media__>", 1)` ⇒ `[Text("look at this"), Media(0)]`,
      so `plan_turn`'s part list is `[Text, Bitmap]`.
  - **Expected:** the media segment is `Media(0)` in the **last** position — the plan evaluates
    `[text, bitmap]`, text before bitmap.
  - **Edge:** the audio plan stays exactly ONE marker, no transcript text.
- [ ] **F-4 (AC-1d, STATIC).** Grep the Rust tree for any remaining image-before-text construction
      (the `[{"type":"image_url"…},{"type":"text"…}]` order); paste the command + output (G-444).
  - **Expected:** zero production/test sites construct `ImageUrl` before `Text`; the shipped media
    branch (`request.rs`) is text-first and the retired reference `chat::render_messages` image arm
    matches so the parity pin compares like-with-like.
  - **Edge:** the audio branch is untouched; audio+image takes the audio branch (audio wins,
    unchanged); `image_shape_ok` (`engine/chat_format.rs`) is order-agnostic — re-check it; it may
    pass unmodified.

## ACB — the pins were updated deliberately, and the record states the reversal's reason

- [ ] **F-5 (AC-2a, STATIC).** Sweep the enumerated pin/doc set (the `request.rs` image-order +
      projection pins, the `multimodal.rs` module doc, the `multimodal_tests.rs` order comment +
      placement pin, the `chat::render_messages` image pins); paste the grep command + output
      (G-444, G-477/G-478).
  - **Expected:** each line ST-1 had flipped to image-first now encodes text-before-image **and the
    change states the reversal's reason** — the measured falsification of the vendor-guidance premise
    on the dense screen-region case; **no** line still asserts image-first or offers a vendor reason
    FOR image-first. Quote each sentence read against the plan's claim list (G-178); tag **[NEW]**.
  - **Edge:** `image_shape_ok` may pass unmodified (order-agnostic); a line still teaching
    image-before-text, or a vendor-placement justification for it, is a FAIL.
- [ ] **F-6 (AC-2b, STATIC/CI).** Unit pin `shaping_is_byte_equal_to_the_retired_request_renderer`
      (`engine/request.rs`).
  - **Expected:** the **text** and **audio** cases stay byte-equal to the retired renderer; the
    **image** case is re-based on BOTH sides so it still compares equal (never made vacuous).
  - **Edge:** an image case comparing two independently-moved renderers without re-basing ⇒ FAIL.
- [ ] **F-7 (AC-2c, STATIC + CI).** Read the committed test list for the named pins; the CI run shows
      them present and executed.
  - **Expected:** all AC-2 pins exist and run — no `#[ignore]`, no deletion, no skip added for this work.
  - **Edge:** a pin replaced with a weaker assertion ⇒ FAIL even if it still passes.

## ACC — a screen-capture turn carries the higher visual budget

- [ ] **F-8 (AC-3a, STATIC/CI).** Read the screen path (`screenshot/commands.rs`
      `capture_screen_region` → `llm_chat_with_image` → `skills::skill_turn`) + the committed constant
      `SCREEN_VISUAL_TOKEN_BUDGET` and `load_projector` → `image_max_tokens`.
  - **Expected:** the screen-capture path declares the ONE constant `SCREEN_VISUAL_TOKEN_BUDGET`; the
    non-screen path declares `NON_SCREEN_VISUAL_TOKEN_BUDGET`, which stays `= SCREEN_VISUAL_TOKEN_BUDGET`
    (one projector, one ceiling — NOT a distinct lower budget; two identical `prompt_tokens` for the
    two paths are EXPECTED).
  - **Edge:** if the projector cannot support the budget, the highest supported value is chosen **and
    recorded**; the runtime value, not the vendor list, is authoritative.
- [ ] **F-9 (AC-3b, STATIC/CI).** Pure pin on `context_params` (`engine/thread.rs`):
      `n_ubatch() >= SCREEN_VISUAL_TOKEN_BUDGET`. **Reddens on the pre-change tree** (default 512) —
      the clamp's failability control; removing `.with_n_ubatch(...)` reddens it `left: 512 right: 2048`.
  - **Expected:** the prefill batch is sized to carry the budget (DERIVED from the constant, never a
    restated literal).
  - **Edge:** `n_ubatch` below the derived budget ⇒ FAIL.
- [ ] **F-10 (AC-3c, LIVE).** On the serving checkout: `capture_screen_region` a region of dense small
      on-screen text, then `llm_chat_with_image` with that base64.
  - **Expected:** ≥1 `llm-token`, **exactly one** `llm-done` (last), **no** `llm-error`; the turn
    settles once.
  - **Edge:** a turn that hangs, settles `llm-error`, emits two `llm-done`, or ignores the text ⇒
    FAIL. **Firm ground:** a witnessed clamp is unreachable on the pinned causal E2B (its image
    encoding is **260** tokens < the old 512 batch — `observations.md`), so the failability rides
    F-9's derived pin; disclose which carried it.

## ACD — the screen-region fixtures are read at the pinned budget, and the numbers are recorded

- [ ] **F-11 (AC-4a, LIVE — the `telemetry_spans` receipt).** `fredo companion score --pg-port
      <resolved loopback port> --report .opencode/tmp/3234/score.json` on the serving checkout; then a
      `telemetry_spans` query for `event_type = 'companion.score'`.
  - **Expected:** one JSON report (`status:"scored"`, one record per fixture, `total:6`, `passed:6`,
    `failed:0`, `regressions:[]`), exit 0; the **TWO** committed screen-region fixtures
    (`vision-screen-text` + `vision-dense-text`) both `passed:true` — the receipt records **2 of 2
    acted on**; the **dense** record's `promptTokens` is present, non-zero, and equals the
    pinned-budget measurement **772**; **one `companion.score` span per fixture persisted** and
    readable by a separate process.
  - **Edge:** `--pg-port 0`/unreachable store ⇒ exit 2; models absent ⇒ exit 3 named skip (no total);
    a run whose `vision-dense-text` record is absent, `passed:false`, or carries `promptTokens == 0`
    ⇒ FAIL; two runs produce distinguishable `span_id`/`start_time_ns` sets.
- [ ] **F-12 (AC-4b, STATIC + build).** THE DERIVED-BUDGET BINDING — assert the PROPERTY, never the
      literal. Owned by **R-ST-2** (D1: the `skills.rs` declaration pin asserts
      `turn.visual_token_budget == Some(SCREEN_VISUAL_TOKEN_BUDGET)`) and **R-ST-4** (D2:
      `every_scored_screen_fixture_runs_at_the_shipped_screen_budget`), plus **R-ST-3** (D3:
      `n_ubatch() >= SCREEN_VISUAL_TOKEN_BUDGET`). Every side DERIVES from the ONE constant, so the
      literal `1120` occurs **exactly once** (the constant's definition) and is ABSENT from the pins'
      bodies. (There is no readable `image_max_tokens` accessor — the anchor is the DECLARED budget.)
  - **Expected:** the binding derives; "it passes while expressing nothing the day the budget moves"
    is the FAIL it forbids. **Derivation proof (mutation control):** move the constant in a scratch
    copy → D1/D2 stay GREEN at the moved value and D3 stays green only while `COMPANION_N_UBATCH ≥
    budget`; a literal-restating pin would redden; restore → green.
  - **Edge:** the pre-change tree reddens (`n_ubatch` 512 < derived budget); a pin that restates
    `1120` ⇒ FAIL. Executor: Tester static (symbol present / literal absent grep) + Developer build
    (mutation leg, `## Developer ST-n — verification`).

## ACE — edge cases hold

- [ ] **F-13 (AC-5a, STATIC/CI).** Unit pins `an_audio_turn_carries_one_input_audio_part_and_no_text_part`
      (`request.rs`) and `an_audio_turn_renders_one_media_part_and_no_text_part` (`multimodal.rs`).
  - **Expected:** an audio turn renders exactly one `input_audio` part (`format:"wav"`), no text part;
    the audio parity case is byte-equal; the audio media projection is one marker, no transcript.
    **[RETAINED]** — green today, must stay green.
  - **Edge:** a second `input_audio`, a text transcript part, a non-`"wav"` format, or audio losing
    precedence over an image ⇒ FAIL.
- [ ] **F-14 (AC-5b, STATIC/CI).** Read the non-screen image path + the committed pin: the non-screen
      declared budget is the bounded constant `NON_SCREEN_VISUAL_TOKEN_BUDGET`
      (`== SCREEN_VISUAL_TOKEN_BUDGET` — one projector, one ceiling), never unbounded/zero.
  - **Expected:** a pasted image / attachment declares that bounded constant; its turn still evaluates
    completely. **[RETAINED]**.
  - **Edge:** an unbounded/zero declared budget, or a media plan with NO declared budget ⇒ FAIL.
- [ ] **F-15 (AC-5c, STATIC/CI).** Committed pin on the multimodal fit guard (`engine/mtp.rs`):
      a media plan with `plan.n_tokens() + budget > ctx_size` returns the **existing** typed
      `ContextCreateFailed`, never a truncated answer.
  - **Expected:** the refusal is the existing typed error (no new enum) on the media path.
  - **Edge:** the TEXT path's `truncate_prompt` (truncate-oldest) is shipped behaviour, out of scope —
    a row asserting the text path refuses would contradict it. The live drive to 131,072 tokens on a
    media turn has no in-round lever ⇒ **NAMED BLOCKER**; the committed pin is the firm ground.

## AC-4c (appended, G-476) — the regression guard: the dense fixture is a SCORED fixture

- [ ] **F-16 (AC-4c, LIVE + build).** The dense fixture committed as a SCORED fixture (id
      `vision-dense-text`, seed **606**, target `Query Viewer`, expectation `open_app`); asset
      `score/fixtures/screen-dense-text.png` regenerated byte-identically from the committed
      generator `gen_fixture.mjs`; `FIXTURE_IDS` + coverage 5 → 6; `score-baseline.json` regenerated
      (6 entries, all `passed:true`, provenance = the run's tree).
  - **Expected:** under text-first the dense fixture PASSES and `baseline::compare` yields
    `regressions:[]`, exit 0; **re-applying image-first reddens it** — `passed:false`,
    `detail:"expected a open_app call; observed calls: []"` → `regressions:["vision-dense-text"]` →
    non-zero exit.
  - **Edge:** the scored guard is harness-driven (needs models, not run in CI) — disclosed; the
    STRUCTURAL in-CI layer is F-1's order pin. The green
    `the_committed_baseline_matches_the_committed_fixture_set` pin (6th entry, seed 606) is the
    committed-record check.
