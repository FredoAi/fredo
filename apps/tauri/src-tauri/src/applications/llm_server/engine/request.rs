//! The request model for one companion turn (Spec #3141, ST-2).
//!
//! One [`ChatTurn`] describes everything the engine needs to shape a request:
//! the conversation, at most one media attachment, whether the skill registry is
//! offered, an optional response schema, and the token budget.
//!
//! ## The ONE media shaping rule (NFR-6)
//!
//! [`ChatTurn::render`] re-points the single rule the retired HTTP path shipped
//! (`chat.rs:266-325`, [`super::super::chat::render_messages`]) without changing
//! its meaning:
//!
//! * **audio** wins over every other option and REPLACES the last user message's
//!   content with exactly ONE [`ContentPart::InputAudio`] part — model audio IS
//!   the turn's input, so the message's string content is discarded and **no
//!   `text` part is ever fabricated** (#2897 REQ-3);
//! * **image** turns the last user message into `[text, image_url]`, where the
//!   URL is the shipped `data:image/png;base64,<image>` data URL (R-3.2);
//! * every other message keeps its plain string content.
//!
//! The rule is what ST-5 (`engine/multimodal.rs`) consumes: the part list says
//! which media belongs on which message, and ST-5 maps each part onto the `mtmd`
//! encoding. In-process there is no HTTP body, so this module models the SHAPE
//! only — and [`ChatTurn::template_messages_json`] deliberately projects TEXT
//! ONLY, so media bytes can never leak into the prompt as text.
//!
//! The retired renderer is still live (the old transport is deleted by ST-3), so
//! a parity pin compares this rule against it directly.

use serde_json::{json, Value};

use super::super::chat::{LlmMessage, MAX_TOKENS};

/// The only audio container the capture path produces (`stt_take_audio_clip`
/// always yields a 16 kHz mono 16-bit PCM WAV), so the renderer pins it.
pub const AUDIO_FORMAT: &str = "wav";

/// The MIME prefix of the shipped image data URL (R-3.2).
pub const IMAGE_DATA_URL_PREFIX: &str = "data:image/png;base64,";

/// One typed content part of a shaped message.
///
/// The vocabulary is the retired body's part set; the *rule* about which part
/// belongs on which message lives here exactly once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentPart {
    /// A plain text part.
    Text { text: String },
    /// The shipped `image_url` part carrying a PNG data URL.
    ImageUrl { url: String },
    /// The one `input_audio` part: the base64 clip and its container format.
    InputAudio { data: String, format: String },
}

/// A shaped message's content: the plain-string form, or the multimodal parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderedContent {
    /// Plain string content (every non-media message).
    Text(String),
    /// A multimodal content array (the last user message of a media turn).
    Parts(Vec<ContentPart>),
}

impl RenderedContent {
    /// The text-only projection used when the content is fed to a chat template.
    ///
    /// A part array contributes only its text parts, so a template never receives
    /// raw media bytes as prompt text.
    pub fn text_only(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }

    /// The media parts only (what ST-5 encodes), in declaration order.
    pub fn media_parts(&self) -> Vec<&ContentPart> {
        match self {
            Self::Text(_) => Vec::new(),
            Self::Parts(parts) => parts
                .iter()
                .filter(|part| !matches!(part, ContentPart::Text { .. }))
                .collect(),
        }
    }
}

/// One shaped message: its role and its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedMessage {
    /// The message role, forwarded verbatim.
    pub role: String,
    /// The shipped content shape for this message.
    pub content: RenderedContent,
}

/// Everything one engine turn needs (the C-1 `ChatTurn` contract).
///
/// `tools` is the ADDITIVE carrier for `offer_tools`: the skill registry is owned
/// by the application layer (it is built from the app's published surfaces), so
/// the engine can never derive it. `offer_tools` stays the semantic switch the
/// contract names; `tools` is what it offers.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatTurn {
    /// The conversation; [`LlmMessage`] remains the IPC DTO.
    pub messages: Vec<LlmMessage>,
    /// A base64 PNG attached to the last user message (R-3.2).
    pub image: Option<String>,
    /// A base64 WAV that IS the last user message (REQ-3/REQ-5).
    pub audio: Option<String>,
    /// Whether the skill registry is offered on this turn.
    pub offer_tools: bool,
    /// The offered tools (the registry rendered by `skills::render_tools`).
    pub tools: Vec<Value>,
    /// The tool choice forwarded to the template (`"auto"` for the shipped
    /// registry offer). `None` leaves the model's default behaviour.
    pub tool_choice: Option<String>,
    /// An optional `response_format` schema: its name and the schema itself.
    pub json_schema: Option<(String, Value)>,
    /// The completion token budget (mirrors the retired `max_tokens`).
    pub max_tokens: u32,
}

impl ChatTurn {
    /// A text-only turn with the reference token budget.
    pub fn text(messages: Vec<LlmMessage>) -> Self {
        Self {
            messages,
            image: None,
            audio: None,
            offer_tools: false,
            tools: Vec::new(),
            tool_choice: None,
            json_schema: None,
            max_tokens: MAX_TOKENS,
        }
    }

    /// Attach a base64 PNG to the last user message (R-3.2).
    pub fn with_image(mut self, image_base64: impl Into<String>) -> Self {
        self.image = Some(image_base64.into());
        self
    }

    /// Make the turn a model-audio turn (REQ-5). Audio wins over any image.
    pub fn with_audio(mut self, audio_base64: impl Into<String>) -> Self {
        self.audio = Some(audio_base64.into());
        self
    }

    /// Offer the rendered registry on this turn under `tool_choice`.
    pub fn with_tools(mut self, tools: Vec<Value>, tool_choice: &str) -> Self {
        self.offer_tools = true;
        self.tools = tools;
        self.tool_choice = Some(tool_choice.to_string());
        self
    }

    /// Constrain the reply to `schema` under `name` (`response_format`).
    pub fn with_json_schema(mut self, name: impl Into<String>, schema: Value) -> Self {
        self.json_schema = Some((name.into(), schema));
        self
    }

    /// Override the completion token budget.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    /// Shape the conversation under the ONE media rule.
    ///
    /// Semantically equal to [`super::super::chat::render_messages`] for every
    /// input (see the parity pin), so re-pointing cannot change a turn's shape.
    pub fn render(&self) -> Vec<RenderedMessage> {
        let mut rendered: Vec<RenderedMessage> = self
            .messages
            .iter()
            .map(|message| RenderedMessage {
                role: message.role.clone(),
                content: RenderedContent::Text(message.content.clone()),
            })
            .collect();

        // Audio IS the turn's input: it replaces the last user message's content
        // with exactly one `input_audio` part and never adds a text part.
        if let Some(audio) = self.audio.as_deref() {
            if let Some(index) = last_user_index(&self.messages) {
                rendered[index].content = RenderedContent::Parts(vec![ContentPart::InputAudio {
                    data: audio.to_string(),
                    format: AUDIO_FORMAT.to_string(),
                }]);
            }
            return rendered;
        }

        if let Some(image) = self.image.as_deref() {
            if let Some(index) = last_user_index(&self.messages) {
                rendered[index].content = RenderedContent::Parts(vec![
                    ContentPart::Text {
                        text: self.messages[index].content.clone(),
                    },
                    ContentPart::ImageUrl {
                        url: format!("{IMAGE_DATA_URL_PREFIX}{image}"),
                    },
                ]);
            }
        }

        rendered
    }

    /// Whether this turn carries any media attachment (image or audio).
    ///
    /// ST-5's media path is entered on this predicate, so a turn that carries an
    /// attachment can never take the text-only branch silently.
    pub fn has_media(&self) -> bool {
        self.image.is_some() || self.audio.is_some()
    }

    /// The TEXT-ONLY template projection of the conversation.
    ///
    /// The chat template consumes text; a media turn's part array contributes only
    /// its text parts here. [`Self::template_messages_json_with_media`] is the
    /// media-aware projection ST-5's `mtmd` path uses, so a template is never
    /// handed raw media bytes as text.
    pub fn template_messages_json(&self) -> String {
        self.template_messages_json_with_media("")
    }

    /// The template projection with each media part rendered as `marker`.
    ///
    /// `mtmd` splices a bitmap wherever the projector's own marker appears in the
    /// prompt, so the marker must land exactly where the media part sits in the
    /// message. The joining rule mirrors llama.cpp's own (`chat.cpp`
    /// `to_json_oaicompat`): text parts are newline-separated, and no newline is
    /// added before or after a media marker.
    ///
    /// An empty `marker` reproduces the text-only projection
    /// ([`Self::template_messages_json`]), which is what every non-media consumer
    /// sees.
    pub fn template_messages_json_with_media(&self, marker: &str) -> String {
        let rendered: Vec<Value> = self
            .render()
            .iter()
            .map(|message| {
                let content = match &message.content {
                    RenderedContent::Text(text) => text.clone(),
                    RenderedContent::Parts(parts) => parts
                        .iter()
                        .fold(
                            (String::new(), false),
                            |(mut content, last_was_media), part| match part {
                                ContentPart::Text { text } => {
                                    if !last_was_media && !content.is_empty() {
                                        content.push('\n');
                                    }
                                    content.push_str(text);
                                    (content, false)
                                }
                                ContentPart::ImageUrl { .. } | ContentPart::InputAudio { .. } => {
                                    content.push_str(marker);
                                    (content, true)
                                }
                            },
                        )
                        .0,
                };
                json!({ "role": message.role, "content": content })
            })
            .collect();
        Value::Array(rendered).to_string()
    }
}

/// The index of the last `user` message, or `None` when the turn has none.
fn last_user_index(messages: &[LlmMessage]) -> Option<usize> {
    messages.iter().rposition(|message| message.role == "user")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::llm_server::chat;

    fn message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn conversation() -> Vec<LlmMessage> {
        vec![
            message("system", "be terse"),
            message("user", "first"),
            message("assistant", "ok"),
            message("user", "look at this"),
        ]
    }

    /// Render the shaped conversation into the retired wire shape, so the parity
    /// pin compares like with like.
    fn wire(messages: &[RenderedMessage]) -> Value {
        Value::Array(
            messages
                .iter()
                .map(|message| {
                    let content = match &message.content {
                        RenderedContent::Text(text) => Value::String(text.clone()),
                        RenderedContent::Parts(parts) => Value::Array(
                            parts
                                .iter()
                                .map(|part| match part {
                                    ContentPart::Text { text } => {
                                        json!({ "type": "text", "text": text })
                                    }
                                    ContentPart::ImageUrl { url } => json!({
                                        "type": "image_url",
                                        "image_url": { "url": url },
                                    }),
                                    ContentPart::InputAudio { data, format } => json!({
                                        "type": "input_audio",
                                        "input_audio": { "data": data, "format": format },
                                    }),
                                })
                                .collect(),
                        ),
                    };
                    json!({ "role": message.role, "content": content })
                })
                .collect(),
        )
    }

    /// The re-point is byte-equal to the retired body's `messages` array for every
    /// shape — the migration cannot silently reshape a turn.
    #[test]
    fn shaping_is_byte_equal_to_the_retired_request_renderer() {
        let messages = conversation();

        // Text-only.
        let turn = ChatTurn::text(messages.clone());
        assert_eq!(
            wire(&turn.render()),
            Value::Array(chat::render_messages(&messages, None, None))
        );

        // Image.
        let turn = ChatTurn::text(messages.clone()).with_image("QUJD");
        assert_eq!(
            wire(&turn.render()),
            Value::Array(chat::render_messages(&messages, Some("QUJD"), None))
        );

        // Audio.
        let audio_messages = vec![
            message("system", "be terse"),
            message("user", "first"),
            message("assistant", "ok"),
            message("user", ""),
        ];
        let turn = ChatTurn::text(audio_messages.clone()).with_audio("UklGRg==");
        assert_eq!(
            wire(&turn.render()),
            Value::Array(chat::render_messages(&audio_messages, None, Some("UklGRg==")))
        );
    }

    /// REQ-3: an audio turn carries exactly ONE `input_audio` part and NEVER a
    /// text part, whatever the message's string content says.
    #[test]
    fn an_audio_turn_carries_one_input_audio_part_and_no_text_part() {
        let messages = vec![message("user", "this text must be discarded")];
        let turn = ChatTurn::text(messages).with_audio("UklGRg==");
        let rendered = turn.render();

        let RenderedContent::Parts(parts) = &rendered[0].content else {
            panic!("the last user message must be the part array");
        };
        assert_eq!(parts.len(), 1, "exactly the ONE audio part: {parts:?}");
        assert_eq!(
            parts[0],
            ContentPart::InputAudio {
                data: "UklGRg==".to_string(),
                format: AUDIO_FORMAT.to_string(),
            }
        );
        assert_eq!(AUDIO_FORMAT, "wav");

        // REQ-3: the message text is discarded, never rendered alongside the audio.
        assert!(rendered[0].content.text_only().is_empty());
        assert_eq!(rendered[0].content.media_parts().len(), 1);
    }

    /// Audio wins over an image: one attachment only, and it is the audio.
    #[test]
    fn audio_takes_precedence_over_image() {
        let messages = vec![message("user", "")];
        let turn = ChatTurn::text(messages)
            .with_image("QUJD")
            .with_audio("UklGRg==");
        let rendered = turn.render();
        let parts = rendered[0].content.media_parts();
        assert_eq!(parts.len(), 1);
        assert!(matches!(parts[0], ContentPart::InputAudio { .. }));
    }

    /// The image turn is `[text, image_url]` with the shipped PNG data URL, on the
    /// LAST user message only — earlier messages keep plain content.
    #[test]
    fn an_image_turn_attaches_text_and_image_url_to_the_last_user_message() {
        let turn = ChatTurn::text(conversation()).with_image("QUJD");
        let rendered = turn.render();

        let RenderedContent::Parts(parts) = &rendered[3].content else {
            panic!("the last user message must be the part array");
        };
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[0],
            ContentPart::Text {
                text: "look at this".to_string()
            }
        );
        assert_eq!(
            parts[1],
            ContentPart::ImageUrl {
                url: "data:image/png;base64,QUJD".to_string()
            }
        );
        assert_eq!(IMAGE_DATA_URL_PREFIX, "data:image/png;base64,");

        // Every earlier message keeps plain string content.
        for (index, expected) in ["be terse", "first", "ok"].iter().enumerate() {
            assert_eq!(
                rendered[index].content,
                RenderedContent::Text(expected.to_string())
            );
        }
    }

    /// A turn with no user message never panics and never fabricates an
    /// attachment.
    #[test]
    fn a_turn_without_a_user_message_leaves_every_content_plain() {
        let messages = vec![message("system", "be terse")];
        let turn = ChatTurn::text(messages)
            .with_image("QUJD")
            .with_audio("UklGRg==");
        assert_eq!(
            turn.render(),
            vec![RenderedMessage {
                role: "system".to_string(),
                content: RenderedContent::Text("be terse".to_string()),
            }]
        );
    }

    /// The template projection is TEXT ONLY: media bytes never reach a prompt.
    #[test]
    fn the_template_projection_is_text_only() {
        let turn = ChatTurn::text(conversation()).with_image("QUJD");
        let json = turn.template_messages_json();
        assert!(
            !json.contains("QUJD"),
            "image bytes must not reach the prompt"
        );
        assert!(!json.contains("image_url"));
        assert!(json.contains("look at this"));

        let parsed: Value = serde_json::from_str(&json).expect("valid messages JSON");
        assert_eq!(parsed.as_array().map(Vec::len), Some(4));
        assert_eq!(parsed[0]["role"], "system");
        assert_eq!(parsed[3]["content"], "look at this");
    }

    /// ST-5's media projection places the projector marker EXACTLY where the media
    /// part sits: the image turn is `text + marker` on the last user message, and
    /// the empty marker reproduces the text-only projection byte for byte.
    #[test]
    fn the_media_projection_places_the_marker_where_the_part_sits() {
        let marker = "<__media__>";
        let turn = ChatTurn::text(conversation()).with_image("QUJD");
        let json = turn.template_messages_json_with_media(marker);
        let parsed: Value = serde_json::from_str(&json).expect("valid messages JSON");

        // The image turn is `[text, image_url]` ⇒ `text\nmarker`.
        assert_eq!(parsed[3]["content"], "look at this<__media__>");
        // The markers appear in the PROMPT, never the media bytes.
        assert!(!json.contains("QUJD"));
        assert_eq!(json.matches(marker).count(), 1);
        // Every earlier message keeps plain content.
        assert_eq!(parsed[0]["content"], "be terse");
        assert_eq!(parsed[1]["content"], "first");
        assert_eq!(parsed[2]["content"], "ok");

        // The text-only projection is the empty-marker form, byte for byte.
        assert_eq!(
            turn.template_messages_json_with_media(""),
            turn.template_messages_json()
        );
    }

    /// An AUDIO turn's media projection is exactly ONE marker and no transcript
    /// text — the shipped one-`input_audio`-part rule carried into the prompt.
    #[test]
    fn the_audio_media_projection_is_one_marker_and_no_text() {
        let marker = "<__media__>";
        let messages = vec![
            message("system", "be terse"),
            message("user", "this text must be discarded"),
        ];
        let turn = ChatTurn::text(messages).with_audio("UklGRg==");
        let json = turn.template_messages_json_with_media(marker);
        let parsed: Value = serde_json::from_str(&json).expect("valid messages JSON");

        assert_eq!(parsed[1]["content"], marker);
        assert_eq!(json.matches(marker).count(), 1);
        assert!(
            !json.contains("this text must be discarded"),
            "the audio turn never carries transcript text: {json}"
        );
        assert!(!json.contains("UklGRg=="));
    }

    /// `has_media` is the gate ST-5's media path is entered on.
    #[test]
    fn has_media_is_true_only_for_an_attachment() {
        let messages = conversation();
        assert!(!ChatTurn::text(messages.clone()).has_media());
        assert!(ChatTurn::text(messages.clone()).with_image("QUJD").has_media());
        assert!(ChatTurn::text(messages).with_audio("UklGRg==").has_media());
    }

    /// The default budget mirrors the retired `max_tokens`.
    #[test]
    fn the_default_token_budget_matches_the_retired_contract() {
        assert_eq!(ChatTurn::text(Vec::new()).max_tokens, MAX_TOKENS);
        assert_eq!(ChatTurn::text(Vec::new()).max_tokens, 1024);
        assert_eq!(
            ChatTurn::text(Vec::new()).with_max_tokens(16).max_tokens,
            16
        );
    }
}
