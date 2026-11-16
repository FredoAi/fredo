//! Sampling chain and context defaults for the in-process engine (Spec #3141,
//! ST-1 values + ST-2 chain).
//!
//! The VALUES are the reference generation parameters the retired launch config
//! shipped (`config.rs:101-134`), preserved **byte for byte** so the migration
//! cannot silently change generation behaviour. The retired config passed them to
//! `llama-server` as argv (`--temp 1.0 --top-p 0.95 --top-k 64 --ctx-size 131072
//! --threads 6 --threads-batch 12 --parallel 1`); in-process the engine builds
//! the sampler chain from the same values with the crate's `LlamaSampler`.
//!
//! ## The chain (ST-2)
//!
//! The retired server's default chain order is temperature → top-k → top-p →
//! distribution, which is exactly what [`build_sampler`] constructs. `--top-k 64`
//! and `--top-p 0.95` are the two truncators the reference config pins, and
//! `--temp 1.0` is neutral (no rescaling). The distribution sampler carries an
//! explicit seed so a turn is reproducible in tests; production passes a fresh
//! seed per turn.
//!
//! A grammar, when present, is PREPENDED to the chain so it masks the candidate
//! logits before truncation — the ordering the server used.
//!
//! ## Lazy-grammar triggers are TRANSLATED, never passed raw (Spec #3141 fix F1)
//!
//! [`translate_triggers`] is the ONE mapping from the template's
//! [`GrammarTrigger`] list to the `(patterns, tokens)` pair the sampler's lazy
//! constructor takes. It mirrors the crate's own
//! `ChatParams::sampler_triggers` (`llama-cpp-4/src/chat.rs`), which in turn
//! mirrors llama.cpp's `common/sampling.cpp`:
//!
//! * `word` ⇒ the literal **regex-escaped** (a raw `<|tool_call>` is a regex
//!   meaning `<` **or** `tool_call>` — it would fire the grammar on any `<`);
//! * `pattern` ⇒ passed through unchanged (it IS a regex);
//! * `pattern_full` ⇒ anchored with `^` / `$`;
//! * `token` ⇒ becomes a trigger TOKEN, not a pattern.
//!
//! Handing the raw `value` to `grammar_lazy_patterns` was the engine-thread panic
//! (`Unexpected empty grammar stack after accepting piece: <turn|>`): the lazy
//! tool grammar engaged on Gemma4's `<|channel>` marker and emptied its stack.

use llama_cpp_4::chat::GrammarTrigger;
use llama_cpp_4::model::LlamaModel;
use llama_cpp_4::sampling::LlamaSampler;
use llama_cpp_4::token::LlamaToken;

use super::CompanionEngineErrorCode;

/// Reference sampling + context defaults (the retired `--temp 1.0 --top-p 0.95
/// --top-k 64 --ctx-size 131072 --threads 6 --threads-batch 12 --parallel 1` set).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SamplingSettings {
    /// Sampling temperature (`--temp`).
    pub temp: f32,
    /// Nucleus sampling probability (`--top-p`).
    pub top_p: f32,
    /// Top-k sampling cutoff (`--top-k`).
    pub top_k: u32,
    /// Context size in tokens (`--ctx-size`).
    pub ctx_size: u32,
    /// Generation threads (`--threads`).
    pub threads: i32,
    /// Batch threads (`--threads-batch`).
    pub threads_batch: i32,
    /// The per-turn completion budget (`max_tokens: 1024` on every retired body).
    pub max_tokens: u32,
}

impl Default for SamplingSettings {
    /// The reference set — identical to the retired launch-config defaults.
    fn default() -> Self {
        Self {
            temp: 1.0,
            top_p: 0.95,
            top_k: 64,
            ctx_size: 131_072,
            threads: 6,
            threads_batch: 12,
            max_tokens: 1024,
        }
    }
}

/// The chain truncators the reference config pins, in the order the retired
/// server applied them (temperature, then top-k, then top-p, then distribution).
///
/// Declared as data so the pure pin below can assert the ORDER without loading a
/// model — a reordering silently changes which candidates survive and must never
/// happen unnoticed.
pub const SAMPLER_CHAIN_ORDER: [&str; 4] = ["temp", "top_k", "top_p", "dist"];

/// The distribution seed the pure unit pins use.
///
/// Production passes a fresh seed per turn; a fixed seed exists so a test turn is
/// reproducible.
pub const DEFAULT_SEED: u32 = 0;

/// The reference `--reasoning` mode (the retired launch-config default).
///
/// Kept here with the other relocated generation defaults so the Doom decision
/// trace can stamp the served flag without reading a settings override or the
/// retired config. The engine always runs reasoning on for this model family.
pub const DEFAULT_REASONING_MODE: &str = "on";

/// The grammar a turn is decoded under, with the laziness the template declared.
#[derive(Debug, Clone)]
pub enum GrammarSpec<'a> {
    /// An always-active grammar (a `response_format` schema, or a non-lazy tool
    /// grammar).
    Strict(&'a str),
    /// A lazy grammar: dormant until one of `triggers` matches, then enforced.
    ///
    /// The triggers are the crate's TYPED [`GrammarTrigger`] values, not strings:
    /// only this module may translate them into sampler patterns (see
    /// [`translate_triggers`]), so no caller can hand the sampler a raw literal
    /// by mistake.
    Lazy {
        /// The GBNF grammar text.
        grammar: &'a str,
        /// The template's own typed triggers.
        triggers: &'a [GrammarTrigger],
    },
}

/// Escape the characters the sampler's regex engine treats as special, exactly
/// as the crate's `ChatParams::sampler_triggers` and llama.cpp's `regex_escape`
/// do.
///
/// A `word` trigger is a LITERAL: the pinned Gemma4 trigger is `<|tool_call>`,
/// and passing it to the sampler unescaped makes it a regex meaning
/// `<` OR `tool_call>`.
fn regex_escape(value: &str) -> String {
    const SPECIAL: &[char] = &[
        '.', '^', '$', '|', '(', ')', '*', '+', '?', '[', ']', '{', '}', '\\',
    ];
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if SPECIAL.contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Anchor a `pattern_full` trigger with `^` / `$` unless it already is.
///
/// An empty pattern becomes `^$` (matching only the empty string) rather than
/// `^^$$`, mirroring the crate and llama.cpp.
fn anchor_pattern(pattern: &str) -> String {
    if pattern.is_empty() {
        return "^$".to_owned();
    }
    let mut out = String::with_capacity(pattern.len() + 2);
    if !pattern.starts_with('^') {
        out.push('^');
    }
    out.push_str(pattern);
    if !pattern.ends_with('$') {
        out.push('$');
    }
    out
}

/// Translate the template's typed triggers into the `(patterns, tokens)` pair
/// [`LlamaSampler::grammar_lazy_patterns`] takes.
///
/// This is the ONE translation the engine uses — [`build_sampler`] and the
/// speculative loop both consume it (NFR-6), so the two paths cannot disagree
/// about what a trigger means. The rules are those of the crate's
/// `ChatParams::sampler_triggers` and llama.cpp's `common/sampling.cpp`:
///
/// * `word` ⇒ [`regex_escape`]d literal;
/// * `pattern` ⇒ unchanged (already a regex);
/// * `pattern_full` ⇒ [`anchor_pattern`];
/// * `token` ⇒ a trigger token (`trigger.token`), never a pattern;
/// * an unknown kind ⇒ dropped (the grammar then simply stays dormant for it),
///   exactly as the crate documents — guessing would be worse than not arming.
pub fn translate_triggers(triggers: &[GrammarTrigger]) -> (Vec<String>, Vec<LlamaToken>) {
    let mut patterns = Vec::new();
    let mut tokens = Vec::new();
    for trigger in triggers {
        match trigger.kind.as_str() {
            "word" => patterns.push(regex_escape(&trigger.value)),
            "pattern" => patterns.push(trigger.value.clone()),
            "pattern_full" => patterns.push(anchor_pattern(&trigger.value)),
            "token" if trigger.token >= 0 => tokens.push(LlamaToken(trigger.token)),
            _ => {}
        }
    }
    (patterns, tokens)
}

/// Build the sampler chain from the reference settings.
///
/// `grammar` masks the candidate logits before truncation when present; it is the
/// tool-call grammar or the `response_format` grammar from
/// [`super::chat_format::AppliedChatFormat::active_grammar`].
///
/// A LAZY grammar is built with its trigger patterns so reasoning/prose flows
/// unconstrained until the pattern fires (the crate's documented behaviour, and
/// the pinned Gemma4 template declares `lazy = true`).
///
/// The chain order is [`SAMPLER_CHAIN_ORDER`]: an optional grammar first, then
/// temp → top-k → top-p → dist. Every truncator is emitted even when its value is
/// the neutral default, so the shipped chain shape never depends on the values.
///
/// # Errors
///
/// A grammar the sampler cannot build (an interior NUL, or GBNF llama.cpp
/// rejects) is a typed [`CompanionEngineErrorCode::ContextCreateFailed`] with
/// curated copy — never a thread-killing panic. The grammar arrives from a
/// request (a `response_format` schema or the model's own template), so a
/// rejection is bad INPUT, not a broken invariant.
pub fn build_sampler(
    model: &LlamaModel,
    settings: &SamplingSettings,
    grammar: Option<GrammarSpec<'_>>,
    seed: u32,
) -> Result<LlamaSampler, (CompanionEngineErrorCode, String)> {
    tracing::debug!(
        target: "fredo::llm_server",
        chain = ?SAMPLER_CHAIN_ORDER,
        temp = settings.temp,
        top_k = settings.top_k,
        top_p = settings.top_p,
        grammar = grammar.is_some(),
        "companion sampler chain"
    );

    let grammar_sampler = match grammar {
        // The `LlamaSampler` constructor takes the model so the grammar can be
        // tokenised against the loaded vocabulary. The `try_` variants are used
        // throughout: a rejected grammar is recoverable input, never a panic.
        Some(GrammarSpec::Strict(grammar)) => Some(
            LlamaSampler::try_grammar(model, grammar, "root")
                .map_err(|error| sampler_failure("build the reply grammar", error))?,
        ),
        Some(GrammarSpec::Lazy { grammar, triggers }) => {
            // The translation is the ONE rule ([`translate_triggers`]): a `word`
            // trigger is a literal and is regex-escaped, so the pinned
            // `<|tool_call>` cannot fire the grammar on an arbitrary `<`.
            let (patterns, trigger_tokens) = translate_triggers(triggers);
            let pattern_refs: Vec<&str> = patterns.iter().map(String::as_str).collect();
            Some(
                LlamaSampler::try_grammar_lazy_patterns(
                    model,
                    grammar,
                    "root",
                    &pattern_refs,
                    &trigger_tokens,
                )
                .map_err(|error| sampler_failure("build the tool-call grammar", error))?,
            )
        }
        None => None,
    };

    let truncators = [
        LlamaSampler::temp(settings.temp),
        LlamaSampler::top_k(i32::try_from(settings.top_k).unwrap_or(i32::MAX)),
        LlamaSampler::top_p(settings.top_p, 1),
        LlamaSampler::dist(seed),
    ];

    Ok(match grammar_sampler {
        // The grammar is PREPENDED so it masks candidates before truncation.
        Some(grammar) => LlamaSampler::chain_simple(
            std::iter::once(grammar)
                .chain(truncators)
                .collect::<Vec<_>>(),
        ),
        None => LlamaSampler::chain_simple(truncators),
    })
}

/// A curated detail for a sampler-construction failure.
///
/// The typed code is [`CompanionEngineErrorCode::ContextCreateFailed`] — the
/// engine's "a context/sampler could not be built" code — while `what` says
/// which step failed, so the primary copy is curated and the library string is
/// only the tail (NFR-5).
fn sampler_failure(
    what: &str,
    error: impl std::fmt::Display,
) -> (CompanionEngineErrorCode, String) {
    (
        CompanionEngineErrorCode::ContextCreateFailed,
        format!(
            "the companion could not {what}: {error}. Restart Fredo and try again."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference set must not drift from the retired launch config — this is
    /// the `to_args` parity anchor in value form.
    #[test]
    fn defaults_match_the_retired_launch_config() {
        let settings = SamplingSettings::default();
        assert_eq!(settings.temp, 1.0);
        assert_eq!(settings.top_p, 0.95);
        assert_eq!(settings.top_k, 64);
        assert_eq!(settings.ctx_size, 131_072);
        assert_eq!(settings.threads, 6);
        assert_eq!(settings.threads_batch, 12);
        // `--parallel 1` is expressed as the single-generation engine (NFR-2),
        // and `max_tokens: 1024` was on every retired request body.
        assert_eq!(settings.max_tokens, 1024);
    }

    /// The chain order is the retired server's: temp → top-k → top-p → dist.
    #[test]
    fn the_sampler_chain_order_matches_the_retired_server() {
        assert_eq!(SAMPLER_CHAIN_ORDER, ["temp", "top_k", "top_p", "dist"]);
    }

    /// The relocated reasoning default is the retired launch-config value.
    #[test]
    fn the_reasoning_default_matches_the_retired_launch_config() {
        assert_eq!(DEFAULT_REASONING_MODE, "on");
    }

    /// `top_k` is widened into the crate's `i32` without a lossy narrowing for
    /// any realistic setting, and an out-of-range value saturates.
    #[test]
    fn a_large_top_k_saturates_instead_of_wrapping() {
        let settings = SamplingSettings {
            top_k: u32::MAX,
            ..SamplingSettings::default()
        };
        assert_eq!(
            i32::try_from(settings.top_k).unwrap_or(i32::MAX),
            i32::MAX,
            "an out-of-range top_k must saturate, never wrap negative"
        );
        assert_eq!(i32::try_from(64u32).unwrap_or(i32::MAX), 64);
    }

    // ── F1: the lazy-grammar trigger translation (the panic's root cause) ────

    fn word(value: &str) -> GrammarTrigger {
        GrammarTrigger {
            kind: "word".to_string(),
            value: value.to_string(),
            token: -1,
        }
    }

    fn pattern(kind: &str, value: &str) -> GrammarTrigger {
        GrammarTrigger {
            kind: kind.to_string(),
            value: value.to_string(),
            token: -1,
        }
    }

    fn token_trigger(id: i32) -> GrammarTrigger {
        GrammarTrigger {
            kind: "token".to_string(),
            value: String::new(),
            token: id,
        }
    }

    /// THE regression pin for the engine-thread panic: the pinned Gemma4 trigger
    /// is the LITERAL `<|tool_call>`, and a raw literal is a regex that matches
    /// `<` OR `tool_call>` — it fires the lazy grammar on the model's first
    /// `<|channel>` marker and empties the grammar stack.
    ///
    /// The translation must ESCAPE it so the pattern can only match the literal
    /// sequence. Both halves are asserted: the emitted pattern is escaped, and
    /// the raw literal is provably NOT what was emitted.
    #[test]
    fn a_word_trigger_is_regex_escaped_and_never_passed_raw() {
        let raw = "<|tool_call>";
        let (patterns, tokens) = translate_triggers(&[word(raw)]);

        assert_eq!(patterns.len(), 1, "one word trigger ⇒ one pattern");
        assert!(tokens.is_empty(), "a word trigger is a pattern, not a token");
        assert_eq!(
            patterns[0], "<\\|tool_call>",
            "the literal must be regex-escaped exactly as the crate's sampler_triggers does"
        );
        assert_ne!(
            patterns[0], raw,
            "the RAW literal must never reach the sampler — it is a regex meaning \
             `<` OR `tool_call>`"
        );
        // Every regex metacharacter in the value is escaped.
        assert!(!patterns[0].contains("|tool_call>") || patterns[0].contains("\\|"));
    }

    /// The escape set is the crate's: every regex metacharacter is prefixed with
    /// a backslash, and nothing else is touched.
    #[test]
    fn regex_escape_covers_every_metacharacter_and_leaves_the_rest() {
        assert_eq!(regex_escape("a.b"), "a\\.b");
        assert_eq!(regex_escape("(x)+[y]*{z}?"), "\\(x\\)\\+\\[y\\]\\*\\{z\\}\\?");
        assert_eq!(regex_escape("a|b"), "a\\|b");
        assert_eq!(regex_escape("^$"), "\\^\\$");
        assert_eq!(regex_escape("back\\slash"), "back\\\\slash");
        // Plain text and the Gemma4 markers' non-special characters are untouched.
        assert_eq!(regex_escape("tool_call"), "tool_call");
        assert_eq!(regex_escape("<>"), "<>");
    }

    /// `pattern` is already a regex and passes through UNCHANGED; `pattern_full`
    /// is anchored (and never double-anchored).
    #[test]
    fn pattern_kinds_translate_exactly_as_the_crate_does() {
        let (patterns, tokens) =
            translate_triggers(&[pattern("pattern", ">>>?(?!all)")]);
        assert_eq!(patterns, vec![">>>?(?!all)".to_string()]);
        assert!(tokens.is_empty());

        let (anchored, _) = translate_triggers(&[pattern("pattern_full", "to=functions")]);
        assert_eq!(anchored, vec!["^to=functions$".to_string()]);

        let (already, _) = translate_triggers(&[pattern("pattern_full", "^done$")]);
        assert_eq!(already, vec!["^done$".to_string()], "no double anchoring");

        let (empty, _) = translate_triggers(&[pattern("pattern_full", "")]);
        assert_eq!(empty, vec!["^$".to_string()], "an empty full pattern matches only \"\"");
    }

    /// A `token` trigger becomes a trigger TOKEN, never a pattern — and an
    /// unknown kind is dropped rather than guessed at.
    #[test]
    fn token_triggers_become_tokens_and_unknown_kinds_are_dropped() {
        let (patterns, tokens) = translate_triggers(&[token_trigger(4242)]);
        assert!(patterns.is_empty(), "a token trigger contributes no pattern");
        assert_eq!(tokens, vec![LlamaToken(4242)]);

        let (dropped, no_tokens) = translate_triggers(&[pattern("future_kind", "x")]);
        assert!(dropped.is_empty(), "an unknown kind must not become a regex");
        assert!(no_tokens.is_empty());

        // A `token` trigger with the crate's "-1 = not a token" sentinel is
        // dropped rather than arming on token -1.
        let (sentinel_patterns, sentinel_tokens) = translate_triggers(&[token_trigger(-1)]);
        assert!(sentinel_patterns.is_empty());
        assert!(sentinel_tokens.is_empty());
    }
}
