//! Chat templating and grammar compilation for the in-process engine
//! (Spec #3141, ST-2; EARS R-26.1 producer half, R-26.3, R-26.4).
//!
//! ## What this replaces
//!
//! The retired HTTP path sent `messages` / `tools` / `response_format` to
//! `llama-server`, which applied the GGUF's Jinja chat template and built the
//! GBNF grammar internally. In-process there is no server: this module applies the
//! SAME template through the crate's `ChatTemplates` (the crate's Jinja
//! implementation, i.e. the same `--jinja` the retired config pinned) and
//! compiles a `response_format` JSON Schema into a GBNF grammar explicitly.
//!
//! ## The template comes from the model, never from a literal
//!
//! [`ChatFormat::from_model`] reads the GGUF's own template. The retired config
//! also pinned `--chat-template` capability through a `/props` probe that read a
//! `chat_template_tool_use` key; that key does not exist on the pinned build, and
//! in-process there is no `/props` to read. The replacement is the TRUTH ITSELF:
//! [`ChatFormat::capabilities`] renders a real tool offer through the model's own
//! template and compiles a real schema grammar, so the reported capability is
//! what the engine actually did — not a key some server echoed.
//!
//! ## The two grammars
//!
//! * **tool-call grammar** — when the registry is offered, the template returns
//!   the model-specific tool-call grammar (`applied.grammar`). On the pinned
//!   Gemma4 GGUF it is a LAZY grammar with one trigger: reasoning and prose flow
//!   unconstrained, and only the call body is forced well-formed.
//! * **schema grammar** — when the turn carries a `response_format` schema,
//!   [`schema_grammar`] compiles it with the crate's `json_schema_to_grammar`. A
//!   closed schema (`additionalProperties: false`) rejects any extra key, which
//!   is exactly R-26.4's requirement.
//!
//! The two are mutually exclusive by construction: a grammar built from a JSON
//! Schema is not the tool-call grammar, and the shipped status path deliberately
//! never mixes a tool offer with a `response_format` (see `status.rs`).
//!
//! ## `applied.parse`
//!
//! [`ChatFormat::parse`] runs the template's OWN reverse parser, so a rendered
//! tool-call body is decoded back into the message shape the template declares
//! (e.g. `{"role":"assistant","tool_calls":[...]}`) instead of a hand-written
//! heuristic that could drift from the template.

use llama_cpp_4::chat::{ChatApplyParams, ChatTemplates, GrammarTrigger, ToolChoice};
use llama_cpp_4::model::LlamaModel;

use super::request::{ChatTurn, AUDIO_FORMAT, IMAGE_DATA_URL_PREFIX};
use super::sampling::SamplingSettings;
use super::CompanionEngineErrorCode;

/// The tool-choice token the retired skill request shipped (`skills.rs:40`).
pub const TOOL_CHOICE_AUTO: &str = "auto";

/// The template name the plan's parity table maps (`--chat-template` ⇒
/// `chat_template(Some("tool_use"))`).
///
/// The pinned Gemma4 GGUF ships no separate named tool template — its DEFAULT
/// template renders the `<|tool>declaration:` block itself — so this names the
/// template whose availability [`ChatFormat::capabilities`] reports, while the
/// production render always uses the model's default template with `with_tools`.
pub const TOOL_USE_TEMPLATE_NAME: &str = "tool_use";

/// The opening marker of the pinned Gemma4 tool-declaration block.
pub const TOOL_DECLARATION_OPEN: &str = "<|tool>";

/// The closing marker of the pinned Gemma4 tool-declaration block.
pub const TOOL_DECLARATION_CLOSE: &str = "<tool|>";

/// The pinned Gemma4 template's argument-quoting escape (`format_argument` wraps
/// every string argument in it). Read from the GGUF's own template; the template's
/// reverse parser expects exactly this, so a reply rendered with plain `"` decodes
/// as plain content rather than a call.
pub const TOOL_ARGUMENT_QUOTE: &str = "<|\"|>";

/// The engine-side chat format for one loaded model.
///
/// Owns the crate's `ChatTemplates`, which copies the GGUF template strings (it
/// borrows nothing), so it lives beside the model on the engine thread.
pub struct ChatFormat {
    templates: ChatTemplates,
}

impl ChatFormat {
    /// Build the format from the loaded model's own templates.
    ///
    /// The template is read from the GGUF — never a literal — so a model swap
    /// changes the rendering without a code change.
    pub fn from_model(model: &LlamaModel) -> Result<Self, (CompanionEngineErrorCode, String)> {
        let templates = ChatTemplates::from_model(model, None).map_err(|error| {
            (
                CompanionEngineErrorCode::ContextCreateFailed,
                format!("the model's chat template could not be applied: {error}"),
            )
        })?;
        Ok(Self { templates })
    }

    /// Verify the shippable request-shaping surface against the loaded model.
    ///
    /// This is the in-process replacement for the retired `/props`
    /// `chat_template_tool_use` probe: instead of reading a server-reported key,
    /// it renders a real tool offer and compiles a real schema, and reports what
    /// the engine actually produced. Cheap (no decode), so it runs at start.
    pub fn capabilities(
        &self,
        model: &LlamaModel,
    ) -> Result<ChatCapabilities, (CompanionEngineErrorCode, String)> {
        let messages = vec![
            crate::applications::llm_server::chat::LlmMessage {
                role: "system".to_string(),
                content: "You are Fredo.".to_string(),
            },
            crate::applications::llm_server::chat::LlmMessage {
                role: "user".to_string(),
                content: "open Mission Monitor".to_string(),
            },
        ];

        // A tool offer through the model's own template.
        let offered = ChatTurn::text(messages.clone()).with_tools(
            vec![serde_json::json!({
                "type": "function",
                "function": {
                    "name": "open_app",
                    "description": "Open an application.",
                    "parameters": {
                        "type": "object",
                        "properties": { "app": { "type": "string" } },
                        "required": ["app"],
                    },
                }
            })],
            TOOL_CHOICE_AUTO,
        );
        let applied = self.apply(&offered, &SamplingSettings::default())?;
        let tool_grammar_present = applied
            .tool_grammar
            .as_ref()
            .map(|grammar| !grammar.grammar.trim().is_empty())
            .unwrap_or(false);
        let prompt_renders_tool_declarations = applied.prompt.contains(TOOL_DECLARATION_OPEN)
            && applied.prompt.contains(TOOL_DECLARATION_CLOSE);
        // The template's own DSL escaping (`<|"|>`) must appear in the rendered
        // declaration — it is what the REVERSE parser expects, so a template that
        // stopped emitting it would silently decode every call as plain content.
        let prompt_carries_dsl_escaping = applied.prompt.contains(TOOL_ARGUMENT_QUOTE);

        // The reply schema the shipped status contract compiles to a grammar —
        // exercised through the SAME `apply` path a real turn uses, not a
        // parallel compile call.
        let schema_turn = ChatTurn::text(messages.clone()).with_json_schema(
            crate::applications::llm_server::status::FREDO_STATUS_SCHEMA_NAME,
            crate::applications::llm_server::status::fredo_status_schema(),
        );
        let schema_grammar_compiles = self
            .apply(&schema_turn, &SamplingSettings::default())
            .map(|applied| {
                applied
                    .schema_grammar
                    .as_ref()
                    .map(|grammar| !grammar.trim().is_empty())
                    .unwrap_or(false)
            })
            .unwrap_or(false);

        // The template's own reverse parser decodes a plain assistant body.
        let plain = ChatTurn::text(messages.clone());
        let reverse_parser_ok = self
            .parse(&plain, "a plain reply", false)
            .ok()
            .and_then(|parsed| serde_json::from_str::<serde_json::Value>(&parsed).ok())
            .map(|parsed| parsed["content"] == "a plain reply")
            .unwrap_or(false);

        // The ONE media shaping rule is intact: exactly one audio part, no text.
        let audio = ChatTurn::text(vec![crate::applications::llm_server::chat::LlmMessage {
            role: "user".to_string(),
            content: String::new(),
        }])
        .with_audio("UklGRg==");
        let audio_parts = audio.render()[0].content.media_parts().len();
        let audio_shape_ok = audio_parts == 1
            && audio.render()[0].content.text_only().is_empty()
            && AUDIO_FORMAT == "wav";
        let image = ChatTurn::text(vec![crate::applications::llm_server::chat::LlmMessage {
            role: "user".to_string(),
            content: "look".to_string(),
        }])
        .with_image("QUJD");
        let image_url = format!("{IMAGE_DATA_URL_PREFIX}QUJD");
        let image_shape_ok = image.render()[0]
            .content
            .media_parts()
            .iter()
            .any(|part| matches!(part, super::request::ContentPart::ImageUrl { url } if *url == image_url));

        Ok(ChatCapabilities {
            named_tool_template: model
                .chat_template(Some(TOOL_USE_TEMPLATE_NAME))
                .map(|template| !template.trim().is_empty())
                .unwrap_or(false),
            tool_grammar_present,
            prompt_renders_tool_declarations,
            prompt_carries_dsl_escaping,
            schema_grammar_compiles,
            reverse_parser_ok,
            audio_shape_ok,
            image_shape_ok,
        })
    }

    /// Apply the format to one turn, producing the prompt + grammars + parsers.
    pub fn apply(
        &self,
        turn: &ChatTurn,
        settings: &SamplingSettings,
    ) -> Result<AppliedChatFormat, (CompanionEngineErrorCode, String)> {
        self.apply_with_media_marker(turn, settings, "")
    }

    /// Apply the format, rendering each media part as `media_marker`.
    ///
    /// The marker is the projector's own (`MtmdContext::marker`), so `mtmd` can
    /// splice the bitmap back in at exactly that position (ST-5). An empty marker
    /// is the text-only render every non-media consumer uses, so the media-aware
    /// and media-free paths share ONE implementation (NFR-6).
    pub fn apply_with_media_marker(
        &self,
        turn: &ChatTurn,
        settings: &SamplingSettings,
        media_marker: &str,
    ) -> Result<AppliedChatFormat, (CompanionEngineErrorCode, String)> {
        let applied = self
            .templates
            .apply(&self.params_for(turn, media_marker)?)
            .map_err(|error| {
                (
                    CompanionEngineErrorCode::ContextCreateFailed,
                    format!("the companion request could not be shaped: {error}"),
                )
            })?;

        // A `response_format` schema WINS over the template's tool grammar: the
        // two constrain the same decoder, and the shipped status path never sends
        // both (the schema is the tools-free contract).
        let tool_grammar = if applied.grammar.is_empty() {
            None
        } else {
            Some(ToolGrammar {
                grammar: applied.grammar.clone(),
                lazy: applied.grammar_lazy,
                triggers: applied.grammar_triggers.clone(),
            })
        };
        let compiled_schema = match turn.json_schema.as_ref() {
            Some((_name, schema)) => Some(schema_grammar(schema)?),
            None => None,
        };

        // The template's DECLARED hidden-reasoning channel. The crate surfaces the
        // marker strings it read from the GGUF's own template, so the streaming
        // gate can classify the span without a single hand-written marker literal
        // (Spec #3141 fix D2, NFR-6).
        let thinking_start_tag = applied.thinking_start_tag.clone();
        let thinking_end_tags = reasoning_end_tags(&applied.thinking_end_tags_json)?;
        // The control markers the streaming gate must not forward. Any marker that
        // participates in the declared reasoning span is EXCLUDED from this list so
        // the gate classifies the span itself (it checks the reasoning markers
        // FIRST, and its `Skipping`/`ToolBody` states must not be reachable from a
        // reasoning marker). The template lists its LEADING control token separately
        // (e.g. the channel opener is reserved on its own while the declared start
        // tag is that opener followed by the channel name).
        let reserved_tokens = reserved_markers_from(&applied.preserved_tokens_json)?
            .into_iter()
            .filter(|marker| {
                !thinking_start_tag.contains(marker.as_str())
                    && !thinking_end_tags.iter().any(|end| end.contains(marker.as_str()))
            })
            .collect();

        Ok(AppliedChatFormat {
            prompt: applied.prompt,
            tool_grammar,
            schema_grammar: compiled_schema,
            additional_stops_json: applied.additional_stops_json.clone(),
            reserved_tokens,
            thinking_start_tag,
            thinking_end_tags,
            max_tokens: turn.max_tokens.min(settings.max_tokens),
        })
    }

    /// Every marker the streaming gate needs, from ONE [`Self::apply`] render.
    ///
    /// The markers are a property of the GGUF's own chat template — not of the
    /// turn — so this reads all three lists from the SAME apply result the turn's
    /// own shaping produces (one extra Jinja render; pure string work, no decode
    /// cost). A template that declares no reasoning span yields an empty start
    /// marker and no end tags, and the gate then classifies only the reserved
    /// control markers.
    ///
    /// * `start` — the template's DECLARED reasoning-span opener (empty when none);
    /// * `ends` — its declared reasoning-span closers;
    /// * `reserved` — every control-token marker the template reserved, which the
    ///   gate must never forward as user-visible text.
    ///
    /// The gate matches marker TEXT, so this returns strings — there is no
    /// token-id resolution layer (Spec #3141 fix D3: the decoder is a UTF-8
    /// boundary only, and text deletion belongs to the ONE classifying stage).
    ///
    /// # Errors
    ///
    /// Whatever the turn's own shaping would return: a template whose declared
    /// markers cannot be read is a typed
    /// [`CompanionEngineErrorCode::ContextCreateFailed`], never a silent "no
    /// reasoning span" (which would re-open the D2 leak).
    pub fn stream_markers(
        &self,
        turn: &ChatTurn,
    ) -> Result<StreamMarkers, (CompanionEngineErrorCode, String)> {
        let applied = self.apply(turn, &SamplingSettings::default())?;
        Ok(StreamMarkers {
            start: applied.thinking_start_tag,
            ends: applied.thinking_end_tags,
            reserved: applied.reserved_tokens,
        })
    }

    /// Run the template's own reverse parser over a rendered assistant body.
    ///
    /// Returns the declared message shape (e.g. a `tool_calls` object) as JSON,
    /// so a tool-call turn is decoded by the template that produced it.
    pub fn parse(
        &self,
        turn: &ChatTurn,
        text: &str,
        partial: bool,
    ) -> Result<String, (CompanionEngineErrorCode, String)> {
        let applied = self
            .templates
            .apply(&self.params_for(turn, "")?)
            .map_err(|error| {
                (
                    CompanionEngineErrorCode::ContextCreateFailed,
                    format!("the companion request could not be shaped: {error}"),
                )
            })?;
        applied.parse(text, partial).map_err(|error| {
            (
                CompanionEngineErrorCode::ContextCreateFailed,
                format!("the companion reply could not be parsed: {error}"),
            )
        })
    }

    /// The crate's apply parameters for one turn (the template input).
    ///
    /// One implementation, shared by [`Self::apply`] and [`Self::parse`], so the
    /// render and the reverse parse can never be handed different options.
    fn params_for(
        &self,
        turn: &ChatTurn,
        media_marker: &str,
    ) -> Result<ChatApplyParams, (CompanionEngineErrorCode, String)> {
        let mut params =
            ChatApplyParams::new(turn.template_messages_json_with_media(media_marker));

        // The skill offer: the registry rendered as OpenAI-style functions plus
        // the shipped tool choice. `parallel_tool_calls:false` has no template
        // header — it is enforced by `skills::plan_terminal_events`' single-call
        // contract, exactly as the retired path documented.
        if turn.offer_tools {
            params = params.with_tools(
                serde_json::Value::Array(turn.tools.clone()).to_string(),
            );
            let choice = turn.tool_choice.as_deref().unwrap_or(TOOL_CHOICE_AUTO);
            let parsed = ToolChoice::parse_oaicompat(choice).map_err(|error| {
                (
                    CompanionEngineErrorCode::ContextCreateFailed,
                    format!("the companion request could not be shaped: unsupported tool choice \
                             {choice:?}: {error}"),
                )
            })?;
            params = params.with_tool_choice(parsed);
        }
        Ok(params)
    }
}

/// Every marker the streaming gate classifies, read from ONE template render.
///
/// Produced by [`ChatFormat::stream_markers`]. All three lists are marker TEXT
/// (never token ids) because the gate — the ONE classifying stage — matches text
/// (Spec #3141 fix D3).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StreamMarkers {
    /// The template's DECLARED reasoning-span opener (empty when it declares none).
    pub start: String,
    /// The template's DECLARED reasoning-span closers.
    pub ends: Vec<String>,
    /// The control-token markers the template reserved.
    ///
    /// These are the markers the GATE must never forward as user-visible text
    /// (while RETAINING them in its raw buffer so the template's reverse parser
    /// still sees a complete call body). The reasoning markers stay in this list:
    /// the gate checks its reasoning span FIRST, so it consumes them as a hidden
    /// channel before the generic reserved rule can apply.
    pub reserved: Vec<String>,
}

/// The request-shaping capability verdict for the loaded model.
///
/// Reported at engine start (logged) so a model whose template cannot render tool
/// declarations or whose reverse parser disagrees is visible in the engine log
/// instead of failing on a user's first tool turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatCapabilities {
    /// The GGUF publishes a named `tool_use` template (the pinned Gemma4 does not;
    /// its default template carries the declarations).
    pub named_tool_template: bool,
    /// The template produced a non-empty tool-call grammar for a tool offer.
    pub tool_grammar_present: bool,
    /// The rendered tool prompt carries the declaration markers.
    pub prompt_renders_tool_declarations: bool,
    /// The rendered tool prompt carries the template's own DSL quoting escape.
    pub prompt_carries_dsl_escaping: bool,
    /// The shipped reply schema compiles to a GBNF grammar.
    pub schema_grammar_compiles: bool,
    /// The template's own reverse parser decoded a plain assistant body.
    pub reverse_parser_ok: bool,
    /// The audio shaping rule produced exactly one part and no text.
    pub audio_shape_ok: bool,
    /// The image shaping rule produced the shipped PNG data URL.
    pub image_shape_ok: bool,
}

impl ChatCapabilities {
    /// Whether every capability the shipped consumers need is present.
    pub fn is_complete(&self) -> bool {
        self.tool_grammar_present
            && self.prompt_renders_tool_declarations
            && self.prompt_carries_dsl_escaping
            && self.schema_grammar_compiles
            && self.reverse_parser_ok
            && self.audio_shape_ok
            && self.image_shape_ok
    }
}

/// The model-specific tool-call grammar the template produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolGrammar {
    /// The GBNF grammar text.
    pub grammar: String,
    /// Whether the grammar stays dormant until a trigger fires (the Gemma4 case).
    pub lazy: bool,
    /// The trigger patterns for a lazy grammar.
    pub triggers: Vec<GrammarTrigger>,
}

/// One shaped turn: everything the decoder needs before sampling a token.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedChatFormat {
    /// The fully rendered prompt (template + messages + tool declarations).
    pub prompt: String,
    /// The template's tool-call grammar, when the turn offers tools.
    pub tool_grammar: Option<ToolGrammar>,
    /// The `response_format` schema grammar, when the turn carries a schema.
    pub schema_grammar: Option<String>,
    /// Additional stop sequences the template declared, as a JSON array string.
    pub additional_stops_json: String,
    /// The control-token MARKERS the template reserved, which the streaming gate
    /// must not forward as user-visible text (`<|"|>`, `<|turn>`, …).
    ///
    /// These are the marker STRINGS the chat shim emits (its real shape), not
    /// token ids: the gate matches marker TEXT, so no id-resolution layer exists
    /// (Spec #3141 fix D3 — the decoder is a UTF-8 boundary only). The gate RETAINS
    /// these markers in its raw buffer so the template's reverse parser still sees
    /// a complete call body, and drops them only from the released text.
    pub reserved_tokens: Vec<String>,
    /// The template's DECLARED opening marker for its hidden reasoning channel
    /// (the template's own `thinking_start_tag`). Empty when the template
    /// declares no reasoning span.
    ///
    /// Read from the template, never a literal: the streaming gate
    /// ([`super::stream::ContentGate`]) uses it to recognise the span and skip it
    /// instead of leaking the chain-of-thought as `llm-token` (fix D2).
    pub thinking_start_tag: String,
    /// The template's DECLARED closing markers for the reasoning channel.
    pub thinking_end_tags: Vec<String>,
    /// The effective completion budget for this turn.
    pub max_tokens: u32,
}

impl AppliedChatFormat {
    /// The grammar that actually constrains this turn, if any.
    ///
    /// The schema wins: a `response_format` turn is the tools-free contract, so
    /// the two never coexist in a shipped request.
    pub fn active_grammar(&self) -> Option<&str> {
        match (&self.schema_grammar, &self.tool_grammar) {
            (Some(schema), _) => Some(schema.as_str()),
            (None, Some(tool)) => Some(tool.grammar.as_str()),
            (None, None) => None,
        }
    }

    /// Whether the active grammar is a lazy one (dormant until a trigger fires).
    pub fn grammar_is_lazy(&self) -> bool {
        self.schema_grammar.is_none()
            && self
                .tool_grammar
                .as_ref()
                .map(|tool| tool.lazy)
                .unwrap_or(false)
    }

    /// The trigger patterns of the active lazy grammar (empty when none).
    pub fn grammar_triggers(&self) -> &[GrammarTrigger] {
        if self.schema_grammar.is_some() {
            return &[];
        }
        self.tool_grammar
            .as_ref()
            .map(|tool| tool.triggers.as_slice())
            .unwrap_or(&[])
    }
}

/// Compile a `response_format` JSON Schema into a GBNF grammar.
///
/// A closed schema (`additionalProperties: false`) yields a grammar with no
/// additional-key production, so an extra key is a decode-time rejection — the
/// R-26.4 proof.
pub fn schema_grammar(
    schema: &serde_json::Value,
) -> Result<String, (CompanionEngineErrorCode, String)> {
    llama_cpp_4::chat::json_schema_to_grammar(&schema.to_string(), false).map_err(|error| {
        (
            CompanionEngineErrorCode::ContextCreateFailed,
            format!("the reply schema could not be compiled: {error}"),
        )
    })
}

/// Read the template's reserved control-token MARKERS.
///
/// The shim emits `preserved_tokens_json` as an array of **strings** (the marker
/// text, e.g. `"<|\"|>"`), which is the crate's real shape — a `Vec<i32>` parse
/// silently yielded an empty list, so reserved-token dropping was dead code
/// (Spec #3141 fix D2). A marker that is not a string is skipped (the text gate
/// covers it); a value that is not JSON at all is a typed error, never a
/// `unwrap_or_default()` that hides a broken template.
///
/// # Errors
///
/// A `preserved_tokens_json` value that is not a JSON array of strings is a
/// [`CompanionEngineErrorCode::ContextCreateFailed`] — the same code the turn's
/// own shaping uses. A malformed declaration must not silently disable the
/// control-token drop.
fn reserved_markers_from(
    json: &str,
) -> Result<Vec<String>, (CompanionEngineErrorCode, String)> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
        (
            CompanionEngineErrorCode::ContextCreateFailed,
            format!("the template's reserved-token declaration could not be read: {error}"),
        )
    })?;
    let markers = value.as_array().ok_or_else(|| {
        (
            CompanionEngineErrorCode::ContextCreateFailed,
            "the template's reserved-token declaration is not an array.".to_string(),
        )
    })?;
    Ok(markers
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect())
}

/// Read the template's declared reasoning end-tags.
///
/// The shim emits them as a JSON array of strings (like the reserved markers).
/// An empty string means "no declared span" and yields no markers, so the gate
/// falls back to the tool-call prefix alone.
///
/// # Errors
///
/// A malformed declaration is a [`CompanionEngineErrorCode::ContextCreateFailed`],
/// never a silent "no reasoning span".
fn reasoning_end_tags(
    json: &str,
) -> Result<Vec<String>, (CompanionEngineErrorCode, String)> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    reserved_markers_from(json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::chat::LlmMessage;
    use crate::applications::llm_server::engine::paths;
    use crate::infrastructure::companion::models::default_manifest;

    fn message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    /// The models dir the templating pins load from (the SAME rule the engine
    /// integration gate uses: `FREDO_COMPANION_MODELS_DIR`, else
    /// `{home}/fredo-models`).
    fn models_dir() -> std::path::PathBuf {
        match std::env::var("FREDO_COMPANION_MODELS_DIR") {
            Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir.trim()),
            _ => std::path::PathBuf::from(
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".to_string()),
            )
            .join("fredo-models"),
        }
    }

    /// Load the pinned main model, or return the NAMED skip reason.
    ///
    /// A real model load needs the pinned GGUF trio, which is not a repo fixture
    /// (G-172). Absent files SKIP BY NAME with the lever printed — never a silent
    /// pass and never a red suite on a host that has no models.
    fn load_model_or_skip() -> Option<(llama_cpp_4::llama_backend::LlamaBackend, LlamaModel)> {
        let manifest = default_manifest();
        let engine_paths = match paths::resolve_for_app(&models_dir(), &manifest) {
            Ok(paths) => paths,
            Err((code, detail)) => {
                eprintln!(
                    "ST-2 TEMPLATE GATE SKIPPED (named blocker: {code:?}) — {detail}. \
                     Provide the pinned GGUF files under {} (set FREDO_COMPANION_MODELS_DIR) \
                     to run this gate. Nothing was asserted on this path.",
                    models_dir().display()
                );
                return None;
            }
        };
        let backend = match llama_cpp_4::llama_backend::LlamaBackend::init() {
            Ok(backend) => backend,
            Err(error) => {
                eprintln!("ST-2 TEMPLATE GATE SKIPPED (named blocker: backend) — {error}");
                return None;
            }
        };
        match paths::load_model(&backend, &engine_paths.model, &paths::model_params(0)) {
            Ok(model) => Some((backend, model)),
            Err((code, detail)) => {
                eprintln!("ST-2 TEMPLATE GATE SKIPPED (named blocker: {code:?}) — {detail}");
                None
            }
        }
    }

    fn tool_offer() -> Vec<serde_json::Value> {
        vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "open_app",
                "description": "Open an application.",
                "parameters": {
                    "type": "object",
                    "properties": { "app": { "type": "string" } },
                    "required": ["app"],
                },
            }
        })]
    }

    /// REQUIRED ARTIFACT 1 — the rendered prompt carries the tool-use template
    /// markers for the offered registry.
    ///
    /// The pinned GGUF has no separate named `tool_use` template; its DEFAULT
    /// template renders the declaration block itself. So the proof is that the
    /// declaration markers appear WITH the offer and are ABSENT without it — a
    /// property of the template, not of a hardcoded string.
    #[test]
    fn the_rendered_prompt_contains_the_tool_use_template_markers() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("the pinned model publishes a template");

        let messages = vec![
            message("system", "You are Fredo."),
            message("user", "open Mission Monitor"),
        ];

        // WITH the offer: the declaration markers are rendered.
        let offered = ChatTurn::text(messages.clone()).with_tools(tool_offer(), TOOL_CHOICE_AUTO);
        let applied = format
            .apply(&offered, &SamplingSettings::default())
            .expect("the tool offer renders");
        assert!(
            applied.prompt.contains(TOOL_DECLARATION_OPEN),
            "the rendered prompt must open a tool declaration block: {}",
            applied.prompt
        );
        assert!(
            applied.prompt.contains(TOOL_DECLARATION_CLOSE),
            "the rendered prompt must close the tool declaration block: {}",
            applied.prompt
        );
        assert!(
            applied.prompt.contains("declaration:open_app"),
            "the rendered prompt must declare the offered function: {}",
            applied.prompt
        );
        assert!(
            applied.prompt.contains(TOOL_ARGUMENT_QUOTE),
            "the rendered declaration must carry the template's own DSL quoting: {}",
            applied.prompt
        );
        assert!(
            applied.prompt.contains("open Mission Monitor"),
            "the rendered prompt must carry the user turn: {}",
            applied.prompt
        );

        // CONTROL: without the offer the markers are absent — so their presence
        // above is caused by the offer, not by the template always emitting them.
        let plain = ChatTurn::text(messages);
        let plain_applied = format
            .apply(&plain, &SamplingSettings::default())
            .expect("the plain turn renders");
        assert!(
            !plain_applied.prompt.contains(TOOL_DECLARATION_OPEN),
            "a turn that offers no tools must not render a declaration block: {}",
            plain_applied.prompt
        );
        assert!(plain_applied.prompt.contains("open Mission Monitor"));
        assert!(plain_applied.prompt.contains("You are Fredo."));
    }

    /// `applied.parse` runs the template's OWN reverse parser: a plain assistant
    /// body decodes to the declared message shape, and a rendered tool-call body
    /// decodes to the template's tool-call shape.
    ///
    /// The tool-call text uses the pinned template's OWN argument escaping
    /// (`<|"|>…<|"|>`, read live from the GGUF's template), which is what the model
    /// emits and what the template's reverse parser expects. A body without that
    /// escaping decodes to plain content, so this also proves the parser is doing
    /// real template work rather than a substring heuristic.
    #[test]
    fn the_templates_reverse_parser_decodes_a_rendered_reply() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");

        let plain = ChatTurn::text(vec![message("user", "hi")]);
        let parsed = format.parse(&plain, "a plain reply", false).expect("parse");
        let parsed: serde_json::Value =
            serde_json::from_str(&parsed).expect("the parser yields JSON");
        assert_eq!(parsed["role"], "assistant");
        assert_eq!(parsed["content"], "a plain reply");

        // The tool-call body the Gemma4 template declares round-trips through its
        // own parser into a `tool_calls` object.
        let offered = ChatTurn::text(vec![message("user", "open Mission Monitor")])
            .with_tools(tool_offer(), TOOL_CHOICE_AUTO);
        let body = format!(
            "<|tool_call>call:open_app{{app:{open_quote}Mission Monitor{close_quote}}}<tool_call|>",
            open_quote = TOOL_ARGUMENT_QUOTE,
            close_quote = TOOL_ARGUMENT_QUOTE,
        );
        let decoded = format.parse(&offered, &body, false).expect("tool call parse");
        let decoded: serde_json::Value =
            serde_json::from_str(&decoded).expect("the parser yields JSON");
        assert_eq!(decoded["role"], "assistant");
        assert_eq!(
            decoded["tool_calls"][0]["function"]["name"], "open_app",
            "the template's reverse parser must decode the call name: {decoded}"
        );
        assert_eq!(
            decoded["tool_calls"][0]["function"]["arguments"],
            "{\"app\":\"Mission Monitor\"}"
        );

        // CONTROL (non-vacuity): the SAME call WITHOUT the template's escaping
        // decodes to plain content — so the decode above is real template work.
        let unescaped = "<|tool_call>call:open_app{app:\"Mission Monitor\"}<tool_call|>";
        let unescaped_decoded = format
            .parse(&offered, unescaped, false)
            .expect("unescaped parse");
        let unescaped_decoded: serde_json::Value =
            serde_json::from_str(&unescaped_decoded).expect("valid JSON");
        assert!(
            unescaped_decoded.get("tool_calls").is_none(),
            "an unescaped body must not decode as a tool call: {unescaped_decoded}"
        );
    }

    /// The tool offer also yields the template's OWN tool-call grammar (lazy on
    /// the pinned model), and the plain turn yields no grammar at all.
    #[test]
    fn the_tool_offer_yields_the_template_tool_call_grammar() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");

        let offered = ChatTurn::text(vec![message("user", "open Mission Monitor")])
            .with_tools(tool_offer(), TOOL_CHOICE_AUTO);
        let applied = format
            .apply(&offered, &SamplingSettings::default())
            .expect("apply");

        let tool = applied
            .tool_grammar
            .as_ref()
            .expect("a tool offer must yield the template's tool-call grammar");
        assert!(
            !tool.grammar.trim().is_empty(),
            "the tool-call grammar must not be empty"
        );
        assert!(
            tool.lazy,
            "the pinned Gemma4 tool grammar is lazy (dormant until a trigger fires)"
        );
        assert_eq!(
            tool.triggers.len(),
            1,
            "the pinned template declares exactly one trigger"
        );
        assert_eq!(applied.active_grammar(), Some(tool.grammar.as_str()));
        assert!(applied.grammar_is_lazy());

        // The plain turn carries no grammar and no triggers.
        let plain = format
            .apply(
                &ChatTurn::text(vec![message("user", "hello")]),
                &SamplingSettings::default(),
            )
            .expect("apply");
        assert!(plain.tool_grammar.is_none());
        assert!(plain.active_grammar().is_none());
        assert!(!plain.grammar_is_lazy());
        assert!(plain.grammar_triggers().is_empty());
    }

    /// The start-time capability check is the in-process `/props` replacement: it
    /// must report the shipped consumers' needs as present on the pinned model.
    #[test]
    fn the_start_time_capability_check_reports_the_pinned_model_ready() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let capabilities = format.capabilities(&model).expect("capabilities");

        assert!(
            !capabilities.named_tool_template,
            "the pinned Gemma4 GGUF has no separate named tool_use template — its default \
             template renders the declaration block (verified live)"
        );
        assert!(capabilities.tool_grammar_present);
        assert!(capabilities.prompt_renders_tool_declarations);
        assert!(capabilities.prompt_carries_dsl_escaping);
        assert!(capabilities.schema_grammar_compiles);
        assert!(capabilities.reverse_parser_ok);
        assert!(capabilities.audio_shape_ok);
        assert!(capabilities.image_shape_ok);
        assert!(
            capabilities.is_complete(),
            "the pinned model must satisfy every shipped capability: {capabilities:?}"
        );
    }

    /// REQUIRED ARTIFACT 2 — the schema grammar ACCEPTS a valid `{reply,status}`
    /// object and REJECTS an extra key.
    ///
    /// The grammar is exercised at the TOKEN boundary through the crate's own
    /// grammar sampler: the model's own tokenisation of each text is fed to the
    /// sampler, so the verdict is what the decoder would actually allow — not a
    /// string comparison against the grammar text.
    #[test]
    fn the_schema_grammar_accepts_a_valid_reply_and_rejects_an_extra_key() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let schema = crate::applications::llm_server::status::fredo_status_schema();
        assert_eq!(
            schema["additionalProperties"],
            serde_json::Value::Bool(false),
            "the reply schema must be closed so an extra key is rejectable"
        );
        let grammar = schema_grammar(&schema).expect("the status schema compiles to GBNF");

        // ACCEPT: a valid `{reply,status}` object.
        let valid = "{\"reply\":\"hi\",\"status\":\"happy\"}";
        assert!(
            accepts(&model, &grammar, valid),
            "the grammar must accept a valid reply object"
        );

        // REJECT: the same object plus an undeclared key.
        let extra = "{\"reply\":\"hi\",\"status\":\"happy\",\"extra\":1}";
        assert!(
            !accepts(&model, &grammar, extra),
            "the grammar must reject an object with an extra key"
        );

        // REJECT: a value outside the closed status enum.
        let bad_status = "{\"reply\":\"hi\",\"status\":\"angry\"}";
        assert!(
            !accepts(&model, &grammar, bad_status),
            "the grammar must reject a status outside the closed enum"
        );

        // CONTROL (non-vacuity): both rejected texts are VALID JSON, so the
        // rejections come from the GRAMMAR, not from malformed input.
        assert!(serde_json::from_str::<serde_json::Value>(extra).is_ok());
        assert!(serde_json::from_str::<serde_json::Value>(bad_status).is_ok());
    }

    /// Feed `text`'s own tokenisation to a grammar sampler; `true` when every
    /// token is admissible.
    fn accepts(model: &LlamaModel, grammar: &str, text: &str) -> bool {
        use llama_cpp_4::model::AddBos;
        use llama_cpp_4::sampling::LlamaSampler;

        let Ok(tokens) = model.str_to_token(text, AddBos::Never) else {
            return false;
        };
        assert!(!tokens.is_empty(), "the text must tokenise");
        let mut sampler = LlamaSampler::grammar(model, grammar, "root");
        for token in &tokens {
            if sampler.try_accept(*token).is_err() {
                return false;
            }
        }
        true
    }

    /// A schema compiled from a closed object has no additional-key production,
    /// while an open one does — the difference the reject pin relies on.
    #[test]
    fn only_a_closed_schema_grammar_forbids_an_extra_key() {
        let closed = serde_json::json!({
            "type": "object",
            "properties": { "reply": { "type": "string" } },
            "required": ["reply"],
            "additionalProperties": false,
        });
        let open = serde_json::json!({
            "type": "object",
            "properties": { "reply": { "type": "string" } },
            "required": ["reply"],
            "additionalProperties": true,
        });
        let closed_grammar = schema_grammar(&closed).expect("closed compiles");
        let open_grammar = schema_grammar(&open).expect("open compiles");
        assert!(!closed_grammar.contains("additional-kv"));
        assert!(open_grammar.contains("additional-kv"));
    }

    /// A malformed schema is a TYPED failure, never a panic and never a silent
    /// fallback to unconstrained decoding.
    #[test]
    fn a_malformed_schema_is_a_typed_failure() {
        let error = schema_grammar(&serde_json::json!({ "type": "not-a-json-type" }))
            .expect_err("an unknown JSON type must not compile");
        assert_eq!(error.0, CompanionEngineErrorCode::ContextCreateFailed);
        assert!(
            error.1.contains("reply schema could not be compiled"),
            "detail: {}",
            error.1
        );
    }

    /// A schema turn's grammar is the ACTIVE grammar, and a schema turn offers no
    /// tool grammar (the shipped status contract never mixes the two).
    #[test]
    fn a_schema_turn_activates_the_compiled_schema_grammar() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let turn = ChatTurn::text(vec![message("user", "hi")]).with_json_schema(
            crate::applications::llm_server::status::FREDO_STATUS_SCHEMA_NAME,
            crate::applications::llm_server::status::fredo_status_schema(),
        );
        let applied = format
            .apply(&turn, &SamplingSettings::default())
            .expect("apply");
        let schema = applied
            .schema_grammar
            .as_ref()
            .expect("a schema turn must compile its grammar");
        assert_eq!(applied.active_grammar(), Some(schema.as_str()));
        assert!(applied.tool_grammar.is_none());
        assert!(!applied.grammar_is_lazy());
        assert!(applied.grammar_triggers().is_empty());
    }

    /// The turn's budget is clamped by the engine's reference setting, so a caller
    /// can never exceed the configured completion window.
    #[test]
    fn the_turn_budget_is_bounded_by_the_sampling_settings() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let settings = SamplingSettings::default();
        let turn = ChatTurn::text(vec![message("user", "hi")]).with_max_tokens(u32::MAX);
        let applied = format.apply(&turn, &settings).expect("apply");
        assert_eq!(applied.max_tokens, settings.max_tokens);
    }

    /// An unsupported tool choice is a TYPED failure, never a silent default.
    #[test]
    fn an_unsupported_tool_choice_is_a_typed_failure() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let mut turn = ChatTurn::text(vec![message("user", "hi")]).with_tools(tool_offer(), TOOL_CHOICE_AUTO);
        turn.tool_choice = Some("sometimes".to_string());
        let error = format
            .apply(&turn, &SamplingSettings::default())
            .expect_err("an unknown tool choice must refuse");
        assert_eq!(error.0, CompanionEngineErrorCode::ContextCreateFailed);
        assert!(error.1.contains("unsupported tool choice"), "{}", error.1);
    }

    /// Reserved control-token MARKERS are read from the template's declaration
    /// in the shim's REAL shape (an array of strings, not ids) — Spec #3141 fix
    /// D2. A `Vec<i32>` parse is what made the drop dead code.
    #[test]
    fn reserved_markers_parse_the_shims_real_string_shape() {
        assert_eq!(
            reserved_markers_from(r#"["<|\"|>","<|turn>","<turn|>"]"#).expect("the shim's array"),
            vec!["<|\"|>".to_string(), "<|turn>".to_string(), "<turn|>".to_string()],
            "the shim emits marker STRINGS; an id parse silently yields nothing"
        );
        assert!(reserved_markers_from("[]").expect("empty array").is_empty());
        // A non-string member is skipped, not fatal — the text gate covers it.
        assert_eq!(
            reserved_markers_from(r#"["<|x|>",7]"#).expect("mixed array"),
            vec!["<|x|>".to_string()]
        );
        // A malformed declaration is TYPED, never a silent empty list: a swallowed
        // parse error is exactly what disabled the drop before.
        let error = reserved_markers_from("not json").expect_err("malformed must be typed");
        assert_eq!(error.0, CompanionEngineErrorCode::ContextCreateFailed);
        assert!(
            error.1.contains("reserved-token declaration"),
            "detail: {}",
            error.1
        );
        let error = reserved_markers_from(r#"{"a":1}"#).expect_err("an object is not an array");
        assert_eq!(error.0, CompanionEngineErrorCode::ContextCreateFailed);
    }

    /// The reasoning end-tags read the SAME string shape; an empty declaration is
    /// "no declared span" (not an error), and a malformed one is typed.
    #[test]
    fn reasoning_end_tags_read_the_templates_declaration() {
        assert_eq!(
            reasoning_end_tags(r#"["<channel|>"]"#).expect("declared"),
            vec!["<channel|>".to_string()]
        );
        assert!(reasoning_end_tags("[]").expect("none declared").is_empty());
        assert!(reasoning_end_tags("").expect("absent declaration").is_empty());
        assert!(reasoning_end_tags("   ").expect("blank declaration").is_empty());
        assert!(reasoning_end_tags("not json").is_err());
    }

    /// The pinned model's template declares its reasoning span, and the resolved
    /// markers are the TEMPLATE's (never a hand-written literal) — the D2 premise.
    #[test]
    fn the_pinned_template_declares_a_reasoning_span() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let turn = ChatTurn::text(vec![message("user", "hi")]);
        let markers = format.stream_markers(&turn).expect("the template's markers");
        assert!(
            !markers.start.is_empty(),
            "the pinned template must declare a reasoning start marker"
        );
        assert!(
            !markers.ends.is_empty(),
            "the pinned template must declare a reasoning end marker"
        );
        // The reasoning markers must NOT appear in the reserved list: the gate
        // classifies the span BEFORE the generic reserved-marker rule, so a
        // reasoning marker reaching the reserved set would be dropped from
        // `pending` outside the span state machine.
        assert!(
            !markers.reserved.contains(&markers.start),
            "the reasoning start marker must be classified as a span, not a reserved marker: {:?}",
            markers.reserved
        );
        for end in &markers.ends {
            assert!(
                !markers.reserved.contains(end),
                "a reasoning end marker must be classified as a span, not a reserved marker: {:?}",
                markers.reserved
            );
        }
        eprintln!(
            "D2 TEMPLATE MARKERS: start={:?} ends={:?} reserved={:?}",
            markers.start, markers.ends, markers.reserved
        );
    }

    /// The reserved markers are the template's OWN declaration, in the shim's real
    /// STRING shape, and they never overlap the reasoning span (Spec #3141 fix
    /// D3: the gate — not the decoder — owns their deletion).
    #[test]
    fn the_reserved_markers_reach_the_gate_as_text() {
        let Some((_backend, model)) = load_model_or_skip() else {
            return;
        };
        let format = ChatFormat::from_model(&model).expect("templates");
        let turn = ChatTurn::text(vec![message("user", "hi")]);
        let markers = format.stream_markers(&turn).expect("the template's markers");
        eprintln!("D3 RESERVED MARKERS: {:?}", markers.reserved);
        // Non-vacuity: the pinned template DOES declare reserved control markers,
        // so a gate driven with an empty list would be testing nothing.
        assert!(
            !markers.reserved.is_empty(),
            "the pinned template declares reserved control markers"
        );
        // Every reserved marker is the template's own text; the gate matches it
        // verbatim, so an empty marker (which would match everywhere) is refused.
        for marker in &markers.reserved {
            assert!(
                !marker.is_empty(),
                "a reserved marker must never be empty: {:?}",
                markers.reserved
            );
        }
    }
}
