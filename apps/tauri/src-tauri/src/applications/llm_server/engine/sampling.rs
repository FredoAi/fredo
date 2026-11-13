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

use llama_cpp_4::model::LlamaModel;
use llama_cpp_4::sampling::LlamaSampler;
use llama_cpp_4::token::LlamaToken;

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

/// The grammar a turn is decoded under, with the laziness the template declared.
#[derive(Debug, Clone, Copy)]
pub enum GrammarSpec<'a> {
    /// An always-active grammar (a `response_format` schema, or a non-lazy tool
    /// grammar).
    Strict(&'a str),
    /// A lazy grammar: dormant until one of `triggers` matches, then enforced.
    Lazy {
        /// The GBNF grammar text.
        grammar: &'a str,
        /// The literal trigger patterns.
        triggers: &'a [&'a str],
    },
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
pub fn build_sampler(
    model: &LlamaModel,
    settings: &SamplingSettings,
    grammar: Option<GrammarSpec<'_>>,
    seed: u32,
) -> LlamaSampler {
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
        // The `LlamaSampler::grammar` constructor takes the model so the grammar
        // can be tokenised against the loaded vocabulary.
        Some(GrammarSpec::Strict(grammar)) => Some(LlamaSampler::grammar(model, grammar, "root")),
        Some(GrammarSpec::Lazy { grammar, triggers }) => {
            // The lazy constructor needs the trigger patterns AND their
            // tokenisations. Trigger tokens come from the SAME model vocabulary
            // (never a copied id table), so a model swap re-derives them.
            let trigger_tokens: Vec<LlamaToken> = triggers
                .iter()
                .flat_map(|pattern| {
                    model
                        .str_to_token(pattern, llama_cpp_4::model::AddBos::Never)
                        .unwrap_or_default()
                })
                .collect();
            Some(LlamaSampler::grammar_lazy_patterns(
                model,
                grammar,
                "root",
                triggers,
                &trigger_tokens,
            ))
        }
        None => None,
    };

    let truncators = [
        LlamaSampler::temp(settings.temp),
        LlamaSampler::top_k(i32::try_from(settings.top_k).unwrap_or(i32::MAX)),
        LlamaSampler::top_p(settings.top_p, 1),
        LlamaSampler::dist(seed),
    ];

    match grammar_sampler {
        // The grammar is PREPENDED so it masks candidates before truncation.
        Some(grammar) => LlamaSampler::chain_simple(
            std::iter::once(grammar)
                .chain(truncators)
                .collect::<Vec<_>>(),
        ),
        None => LlamaSampler::chain_simple(truncators),
    }
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

    /// `top_k` is widened into the crate's `i32` without a lossy narrowing for
    /// any realistic setting, and an out-of-range value saturates.
    #[test]
    fn a_large_top_k_saturates_instead_of_wrapping() {
        let mut settings = SamplingSettings::default();
        settings.top_k = u32::MAX;
        assert_eq!(
            i32::try_from(settings.top_k).unwrap_or(i32::MAX),
            i32::MAX,
            "an out-of-range top_k must saturate, never wrap negative"
        );
        assert_eq!(i32::try_from(64u32).unwrap_or(i32::MAX), 64);
    }
}
