# Companion Vision — Regression

> "Must not change" baseline for the companion vision path (issue **#3234**). Every row is a live
> consumer of the media shaping / evaluation path that must keep working after the ordering +
> budget change. Any FAIL is a regression.
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
  - **Divisors:** `engine/request.rs:194-202` (audio branch), `engine/request.rs:380-401`,
    `engine/multimodal.rs:684-697`, `engine/request.rs:345-375` (parity audio case).
  - **Edge:** Doom-Mode active ⇒ the shipped suppression refusal (`disabled`) still emits one `llm-done`.
- [ ] **R-2 (image data-URL contract).** The image part is the shipped `data:image/png;base64,<body>`
      URL; a bare base64 string is refused, not guessed at.
  - **Divisors:** `engine/request.rs` `IMAGE_DATA_URL_PREFIX`, `engine/multimodal.rs:665-678`.
  - **Edge:** an `mmproj` missing ⇒ typed `MmprojInitFailed`, never a silent text-only fallback
    (`engine/multimodal.rs:94-106`, cross-ref `companion-embedded-engine` F-8).
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
    prefill's last position (`engine/multimodal.rs:449-505`).
- [ ] **R-5 (unchanged pins elsewhere).** The media-parts count and content-part invariants pinned in
      `request.rs:452-465` (no user message ⇒ nothing fabricated) and `request.rs:467-483` (template
      projection is text-only) still hold.
  - **Edge:** a media turn whose text-only projection leaks image bytes ⇒ FAIL.
