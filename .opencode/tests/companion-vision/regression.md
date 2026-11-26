# Companion Vision — Regression

> "Must not change" baseline for the companion vision path (issue **#3234**, re-scoped
> 2026-11-26). Every row is a live consumer of the media shaping / evaluation path that must keep
> working after the media-order revert + budget change. Any FAIL is a regression.
>
> **Row ids are stable** (G-476): R-1..R-5 keep their round-1 ids; the one NEW row (the media-order
> regression the re-scope exists to keep red) is appended as **R-6**.
>
> This feature **does** emit a live-policy receipt of its own: the harness's `companion.score`
> spans in `telemetry_spans` (functional F-11). The overlapped surfaces below are owned by
> `.opencode/tests/companion-embedded-engine/` — run that suite's rows too where the change touches
> them (README: a spec whose Domain Model overlaps a feature's surface runs that feature's
> regression suite).

## Must NOT change

- [ ] **R-1 (audio media shape, cross-ref `companion-embedded-engine` F-9).** A model-audio turn
      renders **exactly one** `input_audio` part (`format:"wav"`), **no** transcript/text part, and
      settles with exactly one `llm-done`.
  - **Divisors:** `engine/request.rs` audio branch, `engine/request.rs` audio pin,
    `engine/multimodal.rs` audio projection, `engine/request.rs` parity audio case.
  - **Edge:** Doom-Mode active ⇒ the shipped suppression refusal (`disabled`) still emits one `llm-done`.
- [ ] **R-2 (image data-URL contract).** The image part is the shipped `data:image/png;base64,<body>`
      URL; a bare base64 string is refused, not guessed at.
  - **Divisors:** `engine/request.rs` `IMAGE_DATA_URL_PREFIX`, `engine/multimodal.rs` `payload_of`.
  - **Edge:** an `mmproj` missing ⇒ typed `MmprojInitFailed`, never a silent text-only fallback
    (`engine/multimodal.rs` `require_projector`, cross-ref `companion-embedded-engine` F-8).
- [ ] **R-3 (event contract, cross-ref `companion-embedded-engine` F-16 / R-1).** `llm-token`
      (string), `llm-done` (empty), `llm-error` (string), `llm-status` (string), `llm-skill-call`
      (`{skill, arguments}`) keep their names and payload shapes; every vision/audio turn settles with
      exactly one trailing `llm-done`.
  - **Divisors:** `apps/ui/src/app/adapters/TauriAdapter.ts`,
    `apps/ui/src/app/adapters/adapterBridge.ts`.
  - **Edge:** a vision turn that emits two `llm-done`, none, or anything after `llm-done` ⇒ FAIL.
- [ ] **R-4 (MTP / non-functional, cross-ref `companion-embedded-engine` F-5 / F-22).** Speculative
      decoding still works (`draftsProposed > 0` AND `draftsAccepted > 0`); zero warnings, no
      `#[allow(...)]`, no `unwrap()` on a fallible path (CI `rust-validate` on the tested head SHA).
  - **Divisors:** `engine/mtp.rs`, `engine/thread.rs`, CI `rust-validate`.
  - **Edge:** the batch-size change must not disable or bypass the MTP `process()` hook on the
    prefill's last position (`engine/multimodal.rs` `eval_plan`).
- [ ] **R-5 (unchanged pins elsewhere).** The media-parts count and content-part invariants pinned in
      `engine/request.rs` (no user message ⇒ nothing fabricated) and (template projection is
      text-only) still hold, and `shaping_is_byte_equal_to_the_retired_request_renderer` stays
      byte-equal for its text + audio cases with the image case re-based on BOTH sides.
  - **Edge:** a media turn whose text-only projection leaks image bytes ⇒ FAIL; a one-sided image
    re-base ⇒ FAIL.
- [ ] **R-6 (the media-order regression — appended, G-476).** The shipped one-image media turn
      renders **`[Text, ImageUrl]`** on the last user message and the media projection is
      **`<user text><marker>`**; the media plan evaluates **`[text, bitmap]`**. A future change that
      re-applies **image-first** MUST redden functional F-1/F-2/F-3 (and, on the harness, flip
      `vision-dense-text` to `passed:false` via F-16). This is ST-4's falsification turned into a
      permanent pin.
  - **Divisors:** `engine/request.rs` image-order + projection pins, `engine/multimodal_tests.rs`
    placement pin, `engine/multimodal.rs` module doc.
  - **Edge:** a one-sided re-base of the parity pin's image case ⇒ FAIL (R-5 above).
