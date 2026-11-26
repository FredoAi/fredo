//! In-process multimodal (vision + audio) through `mtmd` (Spec #3141, ST-5;
//! AC-20 / AC-21, R-20.1 / R-21.1).
//!
//! ## What this replaces
//!
//! The retired HTTP transport rendered media as OpenAI content parts
//! (`image_url` with a PNG data URL; exactly ONE `input_audio` part with
//! `format:"wav"` and no transcript text) and left *encoding* to `llama-server`,
//! which loaded `--mmproj` and fed the projector itself. In-process there is no
//! server: this module owns the projector ([`load_projector`]), decodes the
//! base64 payload the command layer already receives ([`decode_media`]), builds
//! the marker-spliced part list ([`plan_turn`]) and evaluates it on the target
//! context ([`eval_plan`]).
//!
//! ## The ONE placement rule (NFR-6)
//!
//! The chat template is applied to the turn with each media part rendered as the
//! projector's own marker (`<__media__>` by default), and the rendered prompt is
//! then SPLIT on that marker ([`interleave`]). The marker therefore lands exactly
//! where the media part sits in the message, and this module never guesses at
//! template structure:
//!
//! * an **image** turn renders `[text, image_url]`, so the prompt is
//!   `…<user text><marker>…` ⇒ parts `[text(user), bitmap(image), text(rest)]`
//!   (the plan's "text + bitmap");
//! * an **audio** turn renders exactly ONE `input_audio` part and NO text part
//!   (`engine/request.rs`'s shipped rule), so the prompt is
//!   `…<start_of_turn>user\n<marker><end_of_turn>…` ⇒ parts
//!   `[text, bitmap(audio), text]` with **no transcript text anywhere**
//!   (#2897 REQ-3: this module NEVER fabricates a transcript).
//!
//! ## The visual-token budget is PROJECTOR-level (R-3a / R-5b / R-3c)
//!
//! `mtmd`'s visual-token budget is a property of the [`MtmdContext`], set ONCE
//! at projector creation (`MtmdContextParams::image_max_tokens`,
//! `mmproj -> clip_context_params`), NOT a parameter of a bitmap:
//! `MtmdBitmap::from_buf` takes no budget. The engine owns exactly ONE projector,
//! so [`load_projector`] loads it with [`SCREEN_VISUAL_TOKEN_BUDGET`] (the pinned
//! Gemma-4 E2B projector's native ceiling — `clip.cpp:1852`). The screen-vs-
//! non-screen distinction is carried as a per-turn DECLARATION
//! (`ChatTurn::with_visual_token_budget`, read by [`visual_token_budget_for`]),
//! and the ENCODED image-token count is recorded on the plan
//! ([`MediaPlan::image_tokens`]) — the observable budget. There is deliberately
//! NO per-bitmap budget API.
//!
//! ## The fit guard reuses the existing typed refusal (R-5c)
//!
//! A multimodal prompt plus its reply that does not fit the context window is
//! refused with the EXISTING [`CompanionEngineErrorCode::ContextCreateFailed`]
//! ([`plan_fits_context`]) — never a silent media truncation and never a new
//! error enum.
//!
//! ## Why the encoder's tokens go through the session
//!
//! `mtmd` can only inject media through `llama_batch_ext` embedding entries, and
//! [`MtpSession`](crate::applications::llm_server::engine::mtp::MtpSession)
//! takes a plain `LlamaBatch`. [`eval_plan`] therefore evaluates every chunk via
//! the mtmd helper EXCEPT a trailing text chunk, which it returns as `tail` so
//! the caller can decode it through the session's
//! `decode_target_and_process` — that keeps the speculative `process()` hook fed
//! on the prompt's LAST position (the row the draft's carry-over is harvested
//! from), instead of leaving it at zero for the first draft step.
//!
//! ## Typed failure, never a silent text-only fallback
//!
//! A missing/unusable projector is [`CompanionEngineErrorCode::MmprojInitFailed`]
//! with curated copy ([`mmproj_failure`]), and a media turn with NO projector
//! loaded is the SAME typed refusal ([`require_projector`]) — a media turn can
//! never quietly degrade to a text-only answer (R-20.1's negative clause).

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use llama_cpp_4::llama_batch::LlamaBatch;
use llama_cpp_4::model::LlamaModel;
use llama_cpp_4::mtmd::{
    MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputChunkType, MtmdInputChunks,
    MtmdInputPart, MtmdInputText,
};
use llama_cpp_4::mtp::MtpSession;
use llama_cpp_4::token::LlamaToken;

use super::request::{ChatTurn, ContentPart};
use super::CompanionEngineErrorCode;

/// The one sequence a turn uses (the retired config pinned `--parallel 1`).
pub const MEDIA_SEQ_ID: i32 = 0;

// ── The visual-token budget (Spec #3234, ST-2; R-3a / R-5b / R-3c) ────────────

/// The screen-capture visual-token budget (R-3a).
///
/// The pinned Gemma-4 E2B projector's native ceiling is ALREADY 1120
/// (`clip.cpp:1852` `set_limit_image_tokens(70, 1120)`), so this constant
/// declares that ceiling EXPLICITLY: [`load_projector`] loads the ONE projector
/// with it as its `image_max_tokens`, which stops a future model-metadata change
/// from silently lowering the visual detail a screen region reaches the model
/// with. The budget is PROJECTOR-level, not a per-bitmap parameter —
/// `MtmdBitmap::from_buf` takes no budget.
pub const SCREEN_VISUAL_TOKEN_BUDGET: i32 = 1120;

/// The visual-token budget a NON-screen image resolves to (R-5b).
///
/// The engine owns exactly ONE projector, loaded at
/// [`SCREEN_VISUAL_TOKEN_BUDGET`], so a non-screen image resolves to the SAME
/// deliberate, bounded ceiling — never `0`-by-omission and never unbounded. The
/// bound R-5b states is on the RESOLVED value (`0 < resolved ≤ 1120`), which is
/// why this is the resolved ceiling rather than the `0`
/// "defer-to-model-default" sentinel that would fail the bound.
pub const NON_SCREEN_VISUAL_TOKEN_BUDGET: i32 = SCREEN_VISUAL_TOKEN_BUDGET;

/// The visual-token budget a turn DECLARES (R-3a / R-5b).
///
/// A screen capture declares [`SCREEN_VISUAL_TOKEN_BUDGET`] on its turn
/// ([`ChatTurn::with_visual_token_budget`]); a turn with no declaration (a
/// non-screen image) resolves to [`NON_SCREEN_VISUAL_TOKEN_BUDGET`]. Pure, so
/// the declaration is pinned without a model or a projector.
pub fn visual_token_budget_for(turn: &ChatTurn) -> i32 {
    turn
        .visual_token_budget
        .unwrap_or(NON_SCREEN_VISUAL_TOKEN_BUDGET)
}

/// The media-path fit guard (R-5c).
///
/// A multimodal prompt plus its reply MUST fit `ctx_size`, or the turn is
/// refused with the EXISTING [`CompanionEngineErrorCode::ContextCreateFailed`] —
/// never a silently truncated media turn, and never a new error enum. Pure, so
/// the refusal is pinned without a model; the media arm of the generator wraps
/// it.
pub fn plan_fits_context(
    plan_tokens: u64,
    reply_budget: u32,
    ctx_size: u32,
) -> Result<(), (CompanionEngineErrorCode, String)> {
    if plan_tokens.saturating_add(u64::from(reply_budget)) > u64::from(ctx_size) {
        return Err((
            CompanionEngineErrorCode::ContextCreateFailed,
            "the multimodal prompt and its reply do not fit the engine's context window."
                .to_string(),
        ));
    }
    Ok(())
}

// ── The typed failure ────────────────────────────────────────────────────────

/// A curated detail for a projector-subsystem failure.
///
/// The typed code is always [`CompanionEngineErrorCode::MmprojInitFailed`] — the
/// code that names the subsystem — while `what` says which step failed, so the
/// primary copy a user sees is curated, never a bare library string (NFR-5).
pub fn mmproj_failure(
    what: &str,
    error: impl std::fmt::Display,
) -> (CompanionEngineErrorCode, String) {
    (
        CompanionEngineErrorCode::MmprojInitFailed,
        format!(
            "the vision projector could not {what}: {error}. \
             Re-download the model files from Companion setup."
        ),
    )
}

/// The typed refusal for a media turn when no projector is loaded.
///
/// This is R-20.1's negative clause made structural: there is no branch in which
/// a media turn proceeds without the projector, so it can never silently become
/// a text-only turn.
pub fn require_projector(
    loaded: bool,
) -> Result<(), (CompanionEngineErrorCode, String)> {
    if loaded {
        return Ok(());
    }
    Err((
        CompanionEngineErrorCode::MmprojInitFailed,
        "the multimodal projector is not loaded, so this image/audio turn cannot run. \
         Restart the companion, or re-download the model files from Companion setup."
            .to_string(),
    ))
}

// ── The projector ────────────────────────────────────────────────────────────

/// What the loaded projector reports about the model pair's input modalities.
///
/// Published into the engine status slot so the capability command reads a LIVE
/// verdict (the loaded projector's own answer) instead of inferring it from a
/// model name — the shipped #2897 REQ-7 rule, now answered in-process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MtmdCapability {
    /// The projector + model accept images.
    pub vision: bool,
    /// The projector + model accept audio.
    pub audio: bool,
    /// The projector's audio input sample rate in Hz (`-1` when unsupported).
    pub audio_sample_rate: i32,
}

impl MtmdCapability {
    /// Read the capability set from a loaded projector.
    pub fn of(projector: &MtmdContext) -> Self {
        Self {
            vision: projector.supports_vision(),
            audio: projector.supports_audio(),
            audio_sample_rate: projector.audio_sample_rate(),
        }
    }

    /// Whether audio input is actually usable: the projector reports it AND
    /// reports a real sample rate. Both are projector facts — never a model name.
    pub fn audio_ready(&self) -> bool {
        self.audio && self.audio_sample_rate > 0
    }
}

/// Load the multimodal projector from the manifest's `vision` path.
///
/// The ONE projector is loaded with [`SCREEN_VISUAL_TOKEN_BUDGET`] as its
/// `image_max_tokens` ceiling (R-3a): the budget is a projector-creation
/// parameter, so making the intent explicit stops a future model-metadata change
/// from silently lowering it. A failure here is the typed
/// [`CompanionEngineErrorCode::MmprojInitFailed`] refusal — the engine start
/// fails, and no turn can run in a silent "text-only, media ignored" mode.
pub fn load_projector(
    model: &LlamaModel,
    mmproj: &Path,
) -> Result<MtmdContext, (CompanionEngineErrorCode, String)> {
    MtmdContext::init_from_file(
        mmproj,
        model,
        MtmdContextParams::default().image_max_tokens(SCREEN_VISUAL_TOKEN_BUDGET),
    )
    .map_err(|error| mmproj_failure("be initialised", error))
}

// ── The placement rule (pure) ────────────────────────────────────────────────

/// One segment of a rendered prompt after it is split on the media marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptSegment<'a> {
    /// A run of template text (also the user's own text, when the turn has one).
    Text(&'a str),
    /// The `index`-th media attachment, in declaration order.
    Media(usize),
}

/// Split a marker-bearing prompt into text and media segments, in order.
///
/// The number of markers MUST equal the number of attachments: a template that
/// dropped, duplicated or invented a marker is a typed refusal rather than a
/// silently mis-placed image. Pure, so the placement rule is pinned without a
/// model or a projector.
pub fn interleave<'a>(
    prompt: &'a str,
    marker: &str,
    media_count: usize,
) -> Result<Vec<PromptSegment<'a>>, String> {
    if marker.is_empty() {
        return Err("the projector reported an empty media marker".to_string());
    }
    let segments: Vec<&str> = prompt.split(marker).collect();
    let found = segments.len().saturating_sub(1);
    if found != media_count {
        return Err(format!(
            "the rendered prompt carries {found} media marker(s) for {media_count} \
             attachment(s) — the template did not place them one-for-one"
        ));
    }
    let mut out = Vec::with_capacity(segments.len() + media_count);
    for (index, segment) in segments.iter().enumerate() {
        out.push(PromptSegment::Text(segment));
        if index < media_count {
            out.push(PromptSegment::Media(index));
        }
    }
    Ok(out)
}

// ── The decoded attachment ───────────────────────────────────────────────────

/// Which modality an attachment carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    /// An image (`image_url`, PNG data URL).
    Image,
    /// Model audio (`input_audio`, base64 WAV) — never a transcript.
    Audio,
}

impl MediaKind {
    /// The kind a typed content part declares.
    pub fn of(part: &ContentPart) -> Option<Self> {
        match part {
            ContentPart::ImageUrl { .. } => Some(Self::Image),
            ContentPart::InputAudio { .. } => Some(Self::Audio),
            ContentPart::Text { .. } => None,
        }
    }
}

/// The base64 payload of a media content part.
fn payload_of(part: &ContentPart) -> Result<&str, (CompanionEngineErrorCode, String)> {
    match part {
        ContentPart::ImageUrl { url } => {
            let prefix = super::request::IMAGE_DATA_URL_PREFIX;
            url.strip_prefix(prefix).ok_or_else(|| {
                (
                    CompanionEngineErrorCode::MmprojInitFailed,
                    "the image part is not the shipped PNG data URL.".to_string(),
                )
            })
        }
        ContentPart::InputAudio { data, format } => {
            if format != super::request::AUDIO_FORMAT {
                return Err((
                    CompanionEngineErrorCode::MmprojInitFailed,
                    format!(
                        "the audio part declared format {format:?}, but only {:?} is supported.",
                        super::request::AUDIO_FORMAT
                    ),
                ));
            }
            Ok(data)
        }
        ContentPart::Text { .. } => Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "a text part carries no media payload.".to_string(),
        )),
    }
}

/// Decode one media content part into an `mtmd` bitmap.
///
/// The decoded bitmap's own modality is CHECKED against the part that declared
/// it: an `input_audio` part that decodes to an image (or the reverse) is a
/// typed refusal, so a mislabelled payload can never be fed as the wrong
/// modality.
pub fn decode_media(
    projector: &MtmdContext,
    part: &ContentPart,
) -> Result<(MtmdBitmap, MediaKind), (CompanionEngineErrorCode, String)> {
    let kind = MediaKind::of(part).ok_or_else(|| {
        (
            CompanionEngineErrorCode::MmprojInitFailed,
            "a text part cannot be decoded as media.".to_string(),
        )
    })?;
    let bytes = STANDARD.decode(payload_of(part)?).map_err(|error| {
        mmproj_failure("decode the base64 media payload", error)
    })?;
    if bytes.is_empty() {
        return Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "the media payload is empty.".to_string(),
        ));
    }
    let bitmap = MtmdBitmap::from_buf(projector, &bytes)
        .map_err(|error| mmproj_failure("decode the media payload", error))?;
    let decoded_audio = bitmap.is_audio();
    match (kind, decoded_audio) {
        (MediaKind::Audio, true) | (MediaKind::Image, false) => Ok((bitmap, kind)),
        (MediaKind::Audio, false) => Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "the audio part did not decode to an audio bitmap — is the WAV valid?".to_string(),
        )),
        (MediaKind::Image, true) => Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "the image part decoded to an audio bitmap — is the PNG valid?".to_string(),
        )),
    }
}

// ── The plan ─────────────────────────────────────────────────────────────────

/// One turn's tokenised multimodal prompt, ready to evaluate.
pub struct MediaPlan {
    /// The tokenised chunks (text and media, in prompt order).
    pub chunks: MtmdInputChunks,
    /// Every TEXT token in the prompt, in order — the prompt tracking the
    /// speculative session is told about (media positions are embeddings).
    pub text_tokens: Vec<LlamaToken>,
    /// The number of audio attachments the plan carries (0 or 1 in production).
    pub audio_parts: usize,
    /// The number of image attachments the plan carries (0 or 1 in production).
    pub image_parts: usize,
    /// The ENCODED token count of the plan's image chunk(s) (Spec #3234, ST-2;
    /// R-3c) — the observable visual budget. `0` when the plan carries no image.
    /// This is what a live screen-region turn records (the projector reports it
    /// per chunk via `MtmdInputChunk::n_tokens`), and it is how "an image whose
    /// visual encoding exceeds 512 tokens evaluates completely" is made
    /// observable.
    pub image_tokens: usize,
}

impl MediaPlan {
    /// The total number of tokens across every chunk (text + media).
    pub fn n_tokens(&self) -> usize {
        self.chunks.n_tokens()
    }
}

/// Build the tokenised media plan for `turn` from its rendered prompt.
///
/// `prompt` is the chat-templated prompt WITH the projector's marker standing in
/// for each media part (`ChatTurn::template_messages_json_with_media_marker`).
pub fn plan_turn(
    projector: &MtmdContext,
    turn: &ChatTurn,
    prompt: &str,
) -> Result<MediaPlan, (CompanionEngineErrorCode, String)> {
    let rendered = turn.render();
    let media: Vec<(&ContentPart, MediaKind)> = rendered
        .iter()
        .flat_map(|message| message.content.media_parts())
        .filter_map(|part| MediaKind::of(part).map(|kind| (part, kind)))
        .collect();
    if media.is_empty() {
        return Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "the multimodal plan was built for a turn with no media.".to_string(),
        ));
    }

    let marker = projector.marker();
    let segments = interleave(prompt, marker, media.len())
        .map_err(|detail| (CompanionEngineErrorCode::MmprojInitFailed, detail))?;

    // Decode every attachment first: a rejected payload is a typed failure before
    // any text is tokenised.
    let mut bitmaps = Vec::with_capacity(media.len());
    let mut audio_parts = 0usize;
    let mut image_parts = 0usize;
    for (part, kind) in &media {
        match kind {
            MediaKind::Audio => audio_parts += 1,
            MediaKind::Image => image_parts += 1,
        }
        bitmaps.push(decode_media(projector, part)?);
    }

    // The text parts borrow the prompt, so they are built first and then
    // borrowed by the part list — the three levels stay alive across tokenize.
    let texts: Vec<MtmdInputText<'_>> = segments
        .iter()
        .filter_map(|segment| match segment {
            PromptSegment::Text(text) => Some(MtmdInputText::new(text, false, true)),
            PromptSegment::Media(_) => None,
        })
        .collect();
    let mut next_text = 0usize;
    let parts: Vec<MtmdInputPart<'_>> = segments
        .iter()
        .map(|segment| match segment {
            PromptSegment::Text(_) => {
                let text = &texts[next_text];
                next_text += 1;
                MtmdInputPart::Text(text)
            }
            PromptSegment::Media(index) => MtmdInputPart::Bitmap(&bitmaps[*index].0),
        })
        .collect();

    let mut chunks = MtmdInputChunks::new();
    projector
        .tokenize_from_parts(&parts, false, &mut chunks)
        .map_err(|error| mmproj_failure("tokenise the multimodal prompt", error))?;
    if chunks.is_empty() {
        return Err((
            CompanionEngineErrorCode::MmprojInitFailed,
            "the multimodal prompt tokenised to no chunks.".to_string(),
        ));
    }

    // Every text token in prompt order — the session's prompt tracking input.
    // The ENCODED image-token count is the observable visual budget (R-3c).
    let mut text_tokens = Vec::new();
    let mut image_tokens = 0usize;
    for chunk in chunks.iter() {
        match chunk.chunk_type() {
            MtmdInputChunkType::Text => {
                if let Some(tokens) = chunk.text_tokens() {
                    text_tokens.extend(tokens.iter().map(|raw| LlamaToken(*raw)));
                }
            }
            MtmdInputChunkType::Image => image_tokens += chunk.n_tokens(),
            MtmdInputChunkType::Audio => {}
        }
    }

    Ok(MediaPlan {
        chunks,
        text_tokens,
        audio_parts,
        image_parts,
        image_tokens,
    })
}

/// What [`prefill_plan`] evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanEval {
    /// The KV position after the whole multimodal prompt.
    pub n_pos: i32,
}

/// Decode a run of plain text tokens on the target, at explicit positions.
///
/// Explicit positions are what let a media chunk sit BETWEEN two text runs
/// without the batch's implicit positions restarting at zero.
fn decode_text_run(
    session: &mut MtpSession<'_, '_>,
    tokens: &[i32],
    start_pos: i32,
    n_batch: usize,
    logits_last: bool,
) -> Result<i32, (CompanionEngineErrorCode, String)> {
    let mut position = start_pos;
    let mut consumed = 0usize;
    let total = tokens.len();
    while consumed < total {
        let end = (consumed + n_batch).min(total);
        let chunk = &tokens[consumed..end];
        let mut batch = LlamaBatch::new(chunk.len(), 1);
        for (offset, token) in chunk.iter().enumerate() {
            let is_last = logits_last && consumed + offset + 1 == total;
            batch
                .add(LlamaToken(*token), position, &[MEDIA_SEQ_ID], is_last)
                .map_err(|error| {
                    (
                        CompanionEngineErrorCode::ContextCreateFailed,
                        format!("the multimodal prompt could not be batched: {error}"),
                    )
                })?;
            position += 1;
        }
        session
            .decode_target_and_process(&mut batch)
            .map_err(|error| mmproj_failure("evaluate the multimodal text", error))?;
        consumed = end;
    }
    Ok(position)
}

/// Evaluate a tokenised multimodal plan onto the session's target context.
///
/// This is the `mtmd` `eval_chunks` helper's per-chunk walk, with ONE deliberate
/// difference: TEXT chunks are decoded through the speculative session
/// ([`MtpSession::decode_target_and_process`]) instead of the helper, so the MTP
/// `process()` hook keeps harvesting the target's hidden rows for the prompt's
/// last position. A media chunk cannot go through the session (a `LlamaBatch`
/// cannot carry embedding entries) and is encoded/decoded by the projector
/// itself, exactly as `mtmd_helper_eval_chunk_single` does.
///
/// Returns the KV position after the whole prompt.
pub fn prefill_plan(
    session: &mut MtpSession<'_, '_>,
    projector: &mut MtmdContext,
    plan: &MediaPlan,
) -> Result<PlanEval, (CompanionEngineErrorCode, String)> {
    let n_batch = (session.target_context().n_batch().max(1) as usize).max(1);
    let total = plan.chunks.len();
    let mut n_pos: i32 = 0;

    for index in 0..total {
        let Some(chunk) = plan.chunks.get(index) else {
            return Err((
                CompanionEngineErrorCode::MmprojInitFailed,
                format!("the multimodal chunk {index} of {total} could not be read."),
            ));
        };
        let is_last_chunk = index + 1 == total;
        match chunk.chunk_type() {
            MtmdInputChunkType::Text => {
                let Some(tokens) = chunk.text_tokens() else {
                    continue;
                };
                // The prompt's final row must carry logits iff the prompt ENDS on
                // text; a trailing media chunk handles its own `logits_last`.
                n_pos = decode_text_run(session, tokens, n_pos, n_batch, is_last_chunk)?;
            }
            MtmdInputChunkType::Image | MtmdInputChunkType::Audio => {
                let mut next = n_pos;
                projector
                    .eval_chunk_single(
                        session.target_context_mut(),
                        &chunk,
                        n_pos,
                        MEDIA_SEQ_ID,
                        n_batch as i32,
                        is_last_chunk,
                        &mut next,
                    )
                    .map_err(|error| mmproj_failure("evaluate the multimodal attachment", error))?;
                n_pos = next;
            }
        }
    }

    Ok(PlanEval { n_pos })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::chat::LlmMessage;

    fn message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    /// The split rule: one marker ⇒ text, media, text — in that order.
    #[test]
    fn interleave_splits_one_marker_into_text_media_text() {
        let prompt = "<user>look at this<__media__><model>";
        let segments = interleave(prompt, "<__media__>", 1).expect("one marker for one attachment");
        assert_eq!(
            segments,
            vec![
                PromptSegment::Text("<user>look at this"),
                PromptSegment::Media(0),
                PromptSegment::Text("<model>"),
            ]
        );
    }

    /// A marker at the very start or end still yields the surrounding (empty)
    /// text segment, so the part list is always `[text, media, text]`.
    #[test]
    fn interleave_keeps_the_empty_edge_segment() {
        let leading = interleave("<__media__>tail", "<__media__>", 1).expect("leading marker");
        assert_eq!(
            leading,
            vec![
                PromptSegment::Text(""),
                PromptSegment::Media(0),
                PromptSegment::Text("tail"),
            ]
        );
        let trailing = interleave("head<__media__>", "<__media__>", 1).expect("trailing marker");
        assert_eq!(
            trailing,
            vec![
                PromptSegment::Text("head"),
                PromptSegment::Media(0),
                PromptSegment::Text(""),
            ]
        );
    }

    /// A template that dropped, duplicated or invented a marker is a refusal —
    /// never a silently mis-placed image.
    #[test]
    fn interleave_refuses_a_marker_count_mismatch() {
        for (prompt, attachments) in [
            ("no marker here", 1usize),
            ("<__media__><__media__>", 1),
            ("", 1),
            ("<__media__>", 0),
        ] {
            assert!(
                interleave(prompt, "<__media__>", attachments).is_err(),
                "prompt {prompt:?} with {attachments} attachment(s) must refuse"
            );
        }
        assert!(interleave("x", "", 0).is_err(), "an empty marker must refuse");
    }

    /// The failure helper always produces the subsystem's typed code and a
    /// curated primary copy — never a bare library string as the whole message.
    #[test]
    fn a_projector_failure_is_typed_with_curated_copy() {
        let (code, detail) = mmproj_failure("be initialised", "native null pointer");
        assert_eq!(code, CompanionEngineErrorCode::MmprojInitFailed);
        assert_eq!(detail, {
            let mut expected =
                "the vision projector could not be initialised: native null pointer".to_string();
            expected.push_str(
                ". Re-download the model files from Companion setup.",
            );
            expected
        });
        assert!(
            !detail.starts_with("native"),
            "the curated copy leads, the library string is the tail: {detail}"
        );
        assert!(!code.detail().trim().is_empty());
    }

    /// A media turn with no projector is the SAME typed refusal — there is no
    /// branch that degrades it to text-only.
    #[test]
    fn a_media_turn_without_a_projector_is_the_typed_refusal() {
        assert!(require_projector(true).is_ok());
        let (code, detail) = require_projector(false).expect_err("no projector");
        assert_eq!(code, CompanionEngineErrorCode::MmprojInitFailed);
        assert!(detail.contains("not loaded"), "detail: {detail}");
        assert!(detail.contains("cannot run"), "detail: {detail}");
    }

    /// The capability verdict needs BOTH the projector's audio flag AND a real
    /// sample rate — the shipped backend-owned rule.
    #[test]
    fn audio_readiness_requires_the_flag_and_a_real_sample_rate() {
        assert!(MtmdCapability {
            vision: true,
            audio: true,
            audio_sample_rate: 16_000,
        }
        .audio_ready());
        assert!(!MtmdCapability {
            vision: true,
            audio: true,
            audio_sample_rate: -1,
        }
        .audio_ready());
        assert!(!MtmdCapability {
            vision: true,
            audio: false,
            audio_sample_rate: 16_000,
        }
        .audio_ready());
        assert!(!MtmdCapability::default().audio_ready());
    }

    /// A text part is not media, and the kind mapping says so.
    #[test]
    fn text_parts_are_not_attachments() {
        assert_eq!(MediaKind::of(&ContentPart::Text { text: "hi".into() }), None);
        assert_eq!(
            MediaKind::of(&ContentPart::InputAudio {
                data: "UklGRg==".into(),
                format: super::super::request::AUDIO_FORMAT.into(),
            }),
            Some(MediaKind::Audio)
        );
        assert_eq!(
            MediaKind::of(&ContentPart::ImageUrl {
                url: format!("{}QUJD", super::super::request::IMAGE_DATA_URL_PREFIX),
            }),
            Some(MediaKind::Image)
        );
    }

    /// An audio part that declares a container other than `wav` is refused
    /// BEFORE any decode — the shipped one-format contract.
    #[test]
    fn a_non_wav_audio_part_is_refused_before_decoding() {
        let part = ContentPart::InputAudio {
            data: "UklGRg==".to_string(),
            format: "mp3".to_string(),
        };
        let error = payload_of(&part).expect_err("only wav is the shipped container");
        assert_eq!(error.0, CompanionEngineErrorCode::MmprojInitFailed);
        assert!(error.1.contains("only \"wav\""), "detail: {}", error.1);
    }

    /// The image part's payload is the base64 BODY of the shipped data URL; a
    /// bare base64 string (not the data URL) is refused rather than guessed at.
    #[test]
    fn the_image_payload_is_the_data_url_body_only() {
        let prefix = super::super::request::IMAGE_DATA_URL_PREFIX;
        let good = ContentPart::ImageUrl {
            url: format!("{prefix}QUJD"),
        };
        assert_eq!(payload_of(&good).expect("the data URL body"), "QUJD");
        let bare = ContentPart::ImageUrl {
            url: "QUJD".to_string(),
        };
        assert!(payload_of(&bare).is_err());
    }

    /// An AUDIO turn's render carries exactly one media part and no text part, so
    /// the plan can never carry transcript text (invariant re-pinned here because
    /// this module is the consumer of that shape).
    #[test]
    fn an_audio_turn_renders_one_media_part_and_no_text_part() {
        let turn = ChatTurn::text(vec![message("user", "")]).with_audio("UklGRg==");
        let rendered = turn.render();
        assert_eq!(rendered.len(), 1);
        assert_eq!(rendered[0].content.media_parts().len(), 1);
        assert!(
            rendered[0].content.text_only().is_empty(),
            "an audio turn never renders text beside the clip"
        );
        assert_eq!(
            MediaKind::of(rendered[0].content.media_parts()[0]),
            Some(MediaKind::Audio)
        );
    }
}
