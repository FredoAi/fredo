# Companion Vision — Functional

> Durable functional suite for the companion vision path's media placement and screen-capture
> visual budget (issue **#3234**). One `- [ ]` case per acceptance-criterion leg (AC-1 … AC-5).
>
> **Verification policy: live.** AC-3c (a real over-batch image turn) and AC-4 (a real
> `fredo companion score` run with numbers) are genuine runtime observables. AC-1/AC-2 and AC-5's
> audio leg are **pure unit pins** — their rows are **STATIC/CI**: the record is the green CI
> `rust-validate` run on the tested head SHA plus the non-draft `## Developer ST-n — verification`
> comment (the tester's shell has no `cargo`). **The live-policy receipt is the harness's own
> `companion.score` span set read back from `telemetry_spans`** (earned by AC-4a).
>
> Cross-references: the in-process engine migration's suite
> `.opencode/tests/companion-embedded-engine/` (F-8 vision, F-9 audio, F-16 settle contract,
> F-22 non-functional) is the regression home for the unchanged surfaces; this suite owns the
> **new** ordering + budget behaviour.

## ACA — the image is placed before the text

- [ ] **F-1 (AC-1a, STATIC/CI).** Unit pin `an_image_turn_attaches_text_and_image_url_to_the_last_user_message`
      (`apps/tauri/src-tauri/src/applications/llm_server/engine/request.rs`, re-based).
  - **Expected:** `ChatTurn::text(conversation()).with_image("QUJD").render()`'s last user message is
    `RenderedContent::Parts` of exactly **2** parts, order `[ImageUrl{data:image/png;base64,QUJD},
    Text{"look at this"}]`; every earlier message keeps plain content. **FAIL on the pre-change tree**
    (which is `[Text, ImageUrl]`).
  - **Record:** green `rust-validate` on the tested head SHA + `## Developer ST-n — verification`.
  - **Edge:** an empty-text image turn ⇒ `[ImageUrl, Text{""}]` still image-first; a turn with no
    user message fabricates nothing.
- [ ] **F-2 (AC-1b, STATIC/CI).** Unit pin `the_media_projection_places_the_marker_where_the_part_sits`
      (`engine/request.rs:489-510`, re-based).
  - **Expected:** for a one-image turn, `template_messages_json_with_media("<__media__>")` yields
    `parsed[last]["content"] == "<__media__>look at this"` (marker **before** the user text), exactly
    one marker, no image bytes in the prompt; the empty-marker projection still equals
    `template_messages_json()` byte for byte.
  - **Edge:** leading/trailing-marker and marker-count-mismatch refusals (`engine/multimodal.rs:536-574`)
    stay green.
- [ ] **F-3 (AC-1c, STATIC/CI).** Pure pin (extend `engine/multimodal.rs` tests — no model):
      `interleave("<__media__>look at this", "<__media__>", 1)` ⇒ `[Text(""), Media(0),
      Text("look at this")]`, so `plan_turn`'s part list is `[Bitmap, Text]`.
  - **Expected:** the media segment is `Media(0)` in **position 0** — the plan evaluates `[bitmap,
    text]`, image before text.
  - **Edge:** the audio plan stays exactly ONE marker, no transcript text (`engine/multimodal.rs:514-577`).
- [ ] **F-4 (AC-1d, STATIC).** Grep the Rust tree for any remaining text-then-image construction
      (the old `[{"type":"text"…},{"type":"image_url"…}]` order); paste the command + output.
  - **Expected:** zero production/test sites construct `Text` before `ImageUrl`; the shipped media
    branch (`request.rs:204-215`) is image-first and the retired reference `chat::render_messages`
    image arm (`applications/llm_server/chat.rs:89-102`) is re-based so the parity pin still
    compares like-with-like.
  - **Edge:** the audio branch (`request.rs:194-202`) is untouched; audio+image takes the audio
    branch (audio wins — `request.rs:404-414`, unchanged).

## ACB — the pins were updated deliberately

- [ ] **F-5 (AC-2a, STATIC).** Sweep the enumerated pin/doc set (`request.rs:419-448`,
      `request.rs:489-510`, `multimodal.rs:23-25` docs, `multimodal_tests.rs:197` & `:219-233`,
      `chat_format.rs:186-196`), pasting the grep command + output (G-444).
  - **Expected:** each line now encodes image-before-text (or the new budget) and carries the vendor
    reason ("place Image content before the text"; budgets 70/140/280/560/1120); no line still
    asserts the old order or the absence of a budget.
  - **Edge:** `image_shape_ok` is order-agnostic today — re-check it; it may pass unchanged, and if
    the verdict should cover placement it is extended, never left asserting a stale premise.
- [ ] **F-6 (AC-2b, STATIC/CI).** Unit pin `shaping_is_byte_equal_to_the_retired_request_renderer`
      (`engine/request.rs:345-375`).
  - **Expected:** the **text** and **audio** cases stay byte-equal to the retired renderer; the
    **image** case is re-based on BOTH sides so it still compares equal (never made vacuous).
  - **Edge:** an image case comparing two independently-changed renderers without re-basing ⇒ FAIL.
- [ ] **F-7 (AC-2c, STATIC + CI).** Read the committed test list for the named pins; the CI run shows
      them present and executed.
  - **Expected:** all AC-2 pins exist and run — no `#[ignore]`, no deletion, no skip added for this work.
  - **Edge:** a pin replaced with a weaker assertion ⇒ FAIL even if it still passes.

## ACC — a screen-capture turn carries the higher visual budget

- [ ] **F-8 (AC-3a, STATIC/CI).** Read the screen path (`screenshot/commands.rs:26`
      `capture_screen_region` → `llm_chat_with_image` → `skills::skill_turn`) + the committed pin
      asserting the screen-capture budget == **1120**.
  - **Expected:** the screen-capture path requests the 1120 visual-token budget (a single declared
    constant); the non-screen image path uses a distinct lower/default budget (F-13).
  - **Edge:** if the projector cannot support 1120, the highest supported value is chosen **and
    recorded**; the runtime value, not the vendor list, is authoritative.
- [ ] **F-9 (AC-3b, STATIC/CI).** Pure pin on `context_params` (`engine/thread.rs:651-656`):
      `n_ubatch() >= 1120`. **This pin reddens on the pre-change tree** (default 512) — the clamp's
      failability control.
  - **Expected:** the prefill batch is sized to carry the budget; a 1120-token visual encoding is not
    clamped to 512.
  - **Edge:** `n_ubatch` below the chosen budget ⇒ FAIL.
- [ ] **F-10 (AC-3c, LIVE).** On the serving checkout: `capture_screen_region` a region of dense
      small on-screen text, then `llm_chat_with_image` with that base64.
  - **Expected:** ≥1 `llm-token`, **exactly one** `llm-done` (last), **no** `llm-error`; the engine's
    `companion multimodal prompt evaluated` log line (`engine/mtp.rs:655-662`) records a
    media-inclusive `prompt_tokens > 512`.
  - **Edge:** a turn that hangs, settles `llm-error`, emits two `llm-done`, or ignores the text ⇒
    FAIL. Where debug logging is off by default, the `>512` assertion rests on F-9 + AC-4's
    discriminating fixture (disclose which carried it).

## ACD — the screen-capture fixtures read the text

- [ ] **F-11 (AC-4a, LIVE — the `telemetry_spans` receipt).** `fredo companion score --pg-port
      <resolved loopback port> --report .opencode/tmp/3234/score.json` on the serving checkout; then a
      `telemetry_spans` query for `event_type = 'companion.score'`.
  - **Expected:** one JSON report (`status:"scored"`, a record per fixture), exit 0/1 per contract,
    **and one `companion.score` span per fixture persisted** and readable by a separate process.
  - **Edge:** `--pg-port 0`/unreachable store ⇒ exit 2; models absent ⇒ exit 3 named skip (no total);
    two runs produce distinguishable `span_id`/`start_time_ns` sets.
- [ ] **F-12 (AC-4b, LIVE — before/after).** A pre-change run (default budget, old order) vs a shipped
      run, both via `fredo companion score`, on the screen-region fixture(s).
  - **Expected:** the shipped configuration scores **higher** than the baseline with the before/after
    numbers recorded. **See the AC-4 gap in the triage `## Discussion`:** the committed baseline is an
    all-`true` pass set already, so this needs a **discriminating fixture** (fails at 512, passes at
    1120) — a NEW committed asset, the owning sub-task's deliverable (G-409).
  - **Edge:** if the committed `screen-small-text.png` cannot discriminate, the row is
    **UNSATISFIABLE AS WRITTEN** — a named blocker, never a PASS by substitution.

## ACE — edge cases hold

- [ ] **F-13 (AC-5a, STATIC/CI).** Unit pins `an_audio_turn_carries_one_input_audio_part_and_no_text_part`
      (`request.rs:380-401`) and `an_audio_turn_renders_one_media_part_and_no_text_part`
      (`multimodal.rs:684-697`).
  - **Expected:** an audio turn renders exactly one `input_audio` part (`format:"wav"`), no text part;
    the audio parity case is byte-equal; the audio media projection is one marker, no transcript.
  - **Edge:** a second `input_audio`, a text transcript part, or a non-`"wav"` format ⇒ FAIL.
- [ ] **F-14 (AC-5b, STATIC/CI + optional LIVE).** Read the non-screen image path + the committed pin:
      the non-screen budget is in `(0, 1120]`.
  - **Expected:** a pasted image / attachment keeps a deliberate lower budget; its turn still evaluates
    completely (optional live pasted-image turn streams and settles once).
  - **Edge:** a non-screen image silently taking 1120, or an unbounded/zero budget ⇒ FAIL.
- [ ] **F-15 (AC-5c, STATIC/CI).** Committed pin on the multimodal fit guard (`engine/mtp.rs:585-596`):
      a media plan with `plan.n_tokens() + budget > ctx_size` returns the **existing** typed
      `ContextCreateFailed` ("the multimodal prompt and its reply do not fit …"), never a truncated
      answer.
  - **Expected:** the refusal is the existing typed error (no new enum) on the media path.
  - **Edge:** the TEXT path's `truncate_prompt` (truncate-oldest) is shipped behaviour, out of scope —
    a row asserting the text path refuses would contradict it (see triage `## Discussion`). The live
    drive to 131,072 tokens on a media turn has no in-round lever ⇒ NAMED BLOCKER; the committed pin is
    the firm ground.
