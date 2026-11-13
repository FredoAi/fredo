//! Sampling and context defaults for the in-process engine (Spec #3141, ST-1).
//!
//! These are the reference generation parameters the retired launch config
//! shipped (`config.rs:101-134`), preserved **byte for byte** so the migration
//! cannot silently change generation behaviour (AC-18 / NFR-6). ST-2 builds the
//! sampler chain from these values; ST-1 only owns the values and their pin.

/// Reference sampling + context defaults (the retired `--temp 1.0 --top-p 0.95
/// --top-k 64 --ctx-size 131072 --threads 6 --threads-batch 12` set).
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
        }
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
    }
}
