//! Pure launch-configuration model for the companion `llama-server` (Spec #2857, ST-2).
//!
//! This module is deliberately side-effect free: it owns the reference parameter
//! set (the human-provided `.bat` defaults), a single deterministic argv builder,
//! and the Windows `.bat` renderer. It performs NO process spawn, NO HTTP, NO
//! Tauri command work, and NEVER touches `AppStore` — the caller (ST-3/ST-4)
//! reads persisted settings and fills [`LlamaServerConfig`] before calling
//! [`LlamaServerConfig::to_args`] / [`LlamaServerConfig::to_bat`].
//!
//! There is exactly ONE argv builder ([`LlamaServerConfig::to_args`]). The `.bat`
//! text and the spawned process both derive from it, so the two can never drift
//! (the NFR-6 "one shared builder" rule).

use serde::{Deserialize, Serialize};

/// The launch parameters for an out-of-process `llama-server`.
///
/// Field defaults (see [`Default`]) are the human reference configuration. The
/// executable and the three model paths are intentionally left EMPTY by
/// [`Default`]; the caller fills them from the resolved settings / model
/// manifest (absolute paths).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerConfig {
    /// Absolute path to `llama-server.exe`.
    pub executable: String,
    /// Bind host (localhost only in the reference deployment).
    pub host: String,
    /// Bind port.
    pub port: u16,
    /// Absolute path to the main quantized model (GGUF).
    pub model: String,
    /// Absolute path to the multimodal projector (GGUF); vision support.
    pub mmproj: String,
    /// Absolute path to the MTP draft model (GGUF); speculative decoding.
    pub model_draft: String,
    /// Speculative-decoding type (`draft-mtp` for the reference set).
    pub spec_type: String,
    /// Maximum number of speculative draft tokens.
    pub spec_draft_n_max: u32,
    /// `--fit` mode (`off` for the reference set).
    pub fit: String,
    /// `--load-mode` (`none` for the reference set).
    pub load_mode: String,
    /// GPU layers to offload (`all` for the reference set).
    pub gpu_layers: String,
    /// Generation threads.
    pub threads: u32,
    /// Batch threads.
    pub threads_batch: u32,
    /// `--reasoning` mode (`on` for the reference set).
    pub reasoning: String,
    /// Context size.
    pub ctx_size: u32,
    /// Sampling temperature.
    pub temp: f32,
    /// Nucleus sampling probability.
    pub top_p: f32,
    /// Top-k sampling cutoff.
    pub top_k: u32,
    /// Parallel sequences.
    pub parallel: u32,
    /// Unified KV cache. `true` emits `--kv-unified 1`; `false` emits
    /// `--kv-unified 0` (the flag is ALWAYS present so the generated config is
    /// deterministic and self-describing — never silently omitted).
    pub kv_unified: bool,
    /// Log verbosity level.
    pub log_verbosity: u32,
    /// Server model alias reported to clients.
    pub alias: String,
}

impl Default for LlamaServerConfig {
    /// The reference parameter defaults. `executable` / `model` / `mmproj` /
    /// `model_draft` are empty strings — the caller fills them from resolved
    /// settings and the #2856 model manifest.
    fn default() -> Self {
        Self {
            executable: String::new(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            model: String::new(),
            mmproj: String::new(),
            model_draft: String::new(),
            spec_type: "draft-mtp".to_string(),
            spec_draft_n_max: 2,
            fit: "off".to_string(),
            load_mode: "none".to_string(),
            gpu_layers: "all".to_string(),
            threads: 6,
            threads_batch: 12,
            reasoning: "on".to_string(),
            ctx_size: 131072,
            temp: 1.0,
            top_p: 0.95,
            top_k: 64,
            parallel: 1,
            kv_unified: true,
            log_verbosity: 4,
            alias: "Gemma-4-E2B".to_string(),
        }
    }
}

impl LlamaServerConfig {
    /// THE single argv builder.
    ///
    /// Emits exactly these flags in a fixed deterministic order, one value per
    /// element (the flag and its value are SEPARATE elements — no shell
    /// splitting, so a path containing spaces stays one token):
    ///
    /// `--model`, `--mmproj`, `--model-draft`, `--spec-type`, `--spec-draft-n-max`,
    /// `--fit`, `--load-mode`, `--gpu-layers`, `--threads`, `--threads-batch`,
    /// `--reasoning`, `--ctx-size`, `--temp`, `--top-p`, `--top-k`, `--parallel`,
    /// `--kv-unified`, `--log-verbosity`, `--alias`, plus the server binding
    /// `--host` and `--port` appended last.
    ///
    /// `kv_unified` maps to `--kv-unified 1` when `true` and `--kv-unified 0`
    /// when `false` (documented above).
    pub fn to_args(&self) -> Vec<String> {
        vec![
            "--model".to_string(),
            self.model.clone(),
            "--mmproj".to_string(),
            self.mmproj.clone(),
            "--model-draft".to_string(),
            self.model_draft.clone(),
            "--spec-type".to_string(),
            self.spec_type.clone(),
            "--spec-draft-n-max".to_string(),
            self.spec_draft_n_max.to_string(),
            "--fit".to_string(),
            self.fit.clone(),
            "--load-mode".to_string(),
            self.load_mode.clone(),
            "--gpu-layers".to_string(),
            self.gpu_layers.clone(),
            "--threads".to_string(),
            self.threads.to_string(),
            "--threads-batch".to_string(),
            self.threads_batch.to_string(),
            "--reasoning".to_string(),
            self.reasoning.clone(),
            "--ctx-size".to_string(),
            self.ctx_size.to_string(),
            "--temp".to_string(),
            format_float(self.temp),
            "--top-p".to_string(),
            format_float(self.top_p),
            "--top-k".to_string(),
            self.top_k.to_string(),
            "--parallel".to_string(),
            self.parallel.to_string(),
            "--kv-unified".to_string(),
            if self.kv_unified { "1".to_string() } else { "0".to_string() },
            "--log-verbosity".to_string(),
            self.log_verbosity.to_string(),
            "--alias".to_string(),
            self.alias.clone(),
            "--host".to_string(),
            self.host.clone(),
            "--port".to_string(),
            self.port.to_string(),
        ]
    }

    /// Render a runnable Windows `.bat` referencing the SAME argv as
    /// [`Self::to_args`].
    ///
    /// Shape: `@echo off`, then the quoted executable and each `flag value`
    /// pair, one per line, CRLF-terminated. Every non-final line ends with
    /// ` ^` (batch line continuation). The executable is ALWAYS quoted and an
    /// argument is quoted when it contains whitespace, so a path with spaces
    /// remains a single command token.
    pub fn to_bat(&self) -> String {
        let mut lines = vec!["@echo off".to_string()];

        // The executable is always quoted so a spaced path is one token.
        let mut command_lines = vec![quote_token(&self.executable)];

        let args = self.to_args();
        let mut index = 0;
        while index < args.len() {
            if index + 1 < args.len() {
                command_lines.push(format!(
                    "{} {}",
                    render_token(&args[index]),
                    render_token(&args[index + 1])
                ));
                index += 2;
            } else {
                command_lines.push(render_token(&args[index]));
                index += 1;
            }
        }

        let last = command_lines.len().saturating_sub(1);
        for (i, line) in command_lines.iter().enumerate() {
            if i == last {
                lines.push(line.clone());
            } else {
                lines.push(format!("{line} ^"));
            }
        }

        lines.join("\r\n") + "\r\n"
    }
}

/// Render an f32 with at least one decimal place (`1.0`, not `1`) so the
/// generated flag matches the reference `.bat` (`--temp 1.0`). Values that
/// already carry a fractional part are emitted as-is (`0.95`).
fn format_float(value: f32) -> String {
    let rendered = format!("{value}");
    if rendered.contains('.') || rendered.contains('e') || rendered.contains('E') {
        rendered
    } else {
        format!("{rendered}.0")
    }
}

/// Quote a token unconditionally (used for the executable).
fn quote_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', "\"\""))
}

/// Quote a token only when required (whitespace); flags and plain values stay
/// bare for readability, matching the reference `.bat`.
fn render_token(token: &str) -> String {
    if token.chars().any(char::is_whitespace) {
        quote_token(token)
    } else {
        token.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fully-populated config mirroring the human reference `.bat` with
    /// resolved absolute paths (spaces included) for F-33.
    fn reference_config() -> LlamaServerConfig {
        LlamaServerConfig {
            executable: r"C:\Program Files\llama.cpp\llama-server.exe".to_string(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            model: r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf"
                .to_string(),
            mmproj: r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\mmproj-BF16.gguf".to_string(),
            model_draft: r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\MTP\mtp-gemma-4-E2B-it-Q4_0.gguf"
                .to_string(),
            spec_type: "draft-mtp".to_string(),
            spec_draft_n_max: 2,
            fit: "off".to_string(),
            load_mode: "none".to_string(),
            gpu_layers: "all".to_string(),
            threads: 6,
            threads_batch: 12,
            reasoning: "on".to_string(),
            ctx_size: 131072,
            temp: 1.0,
            top_p: 0.95,
            top_k: 64,
            parallel: 1,
            kv_unified: true,
            log_verbosity: 4,
            alias: "Gemma-4-E2B".to_string(),
        }
    }

    /// Parse the generated `.bat` back into command tokens (respecting the
    /// double-quote grouping) so a test can prove it references the same argv.
    fn parse_bat_tokens(bat: &str) -> Vec<String> {
        let mut logical = String::new();
        for (i, line) in bat.lines().enumerate() {
            if i == 0 {
                // `@echo off`
                continue;
            }
            let trimmed = line.trim_end();
            let without_caret = trimmed.strip_suffix('^').unwrap_or(trimmed).trim();
            logical.push_str(without_caret);
            logical.push(' ');
        }

        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        for ch in logical.chars() {
            match ch {
                '"' if !in_quotes => in_quotes = true,
                '"' if in_quotes => in_quotes = false,
                c if c.is_whitespace() && !in_quotes => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    #[test]
    fn default_matches_the_reference_parameter_set() {
        let config = LlamaServerConfig::default();
        assert_eq!(config.executable, "");
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 8080);
        assert_eq!(config.model, "");
        assert_eq!(config.mmproj, "");
        assert_eq!(config.model_draft, "");
        assert_eq!(config.spec_type, "draft-mtp");
        assert_eq!(config.spec_draft_n_max, 2);
        assert_eq!(config.fit, "off");
        assert_eq!(config.load_mode, "none");
        assert_eq!(config.gpu_layers, "all");
        assert_eq!(config.threads, 6);
        assert_eq!(config.threads_batch, 12);
        assert_eq!(config.reasoning, "on");
        assert_eq!(config.ctx_size, 131_072);
        assert_eq!(config.temp, 1.0);
        assert_eq!(config.top_p, 0.95);
        assert_eq!(config.top_k, 64);
        assert_eq!(config.parallel, 1);
        assert!(config.kv_unified);
        assert_eq!(config.log_verbosity, 4);
        assert_eq!(config.alias, "Gemma-4-E2B");
    }

    #[test]
    fn to_args_emits_the_exact_fixed_order() {
        let config = reference_config();
        let expected: Vec<String> = vec![
            "--model",
            r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf",
            "--mmproj",
            r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\mmproj-BF16.gguf",
            "--model-draft",
            r"C:\Users\me\fredo-models\gemma-4-e2b-it-qat\MTP\mtp-gemma-4-E2B-it-Q4_0.gguf",
            "--spec-type",
            "draft-mtp",
            "--spec-draft-n-max",
            "2",
            "--fit",
            "off",
            "--load-mode",
            "none",
            "--gpu-layers",
            "all",
            "--threads",
            "6",
            "--threads-batch",
            "12",
            "--reasoning",
            "on",
            "--ctx-size",
            "131072",
            "--temp",
            "1.0",
            "--top-p",
            "0.95",
            "--top-k",
            "64",
            "--parallel",
            "1",
            "--kv-unified",
            "1",
            "--log-verbosity",
            "4",
            "--alias",
            "Gemma-4-E2B",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(config.to_args(), expected);
    }

    #[test]
    fn to_args_contains_all_18_ac1_flags_with_non_empty_values() {
        let config = reference_config();
        let args = config.to_args();
        let pairs: Vec<(&str, &str)> = args
            .chunks_exact(2)
            .map(|pair| (pair[0].as_str(), pair[1].as_str()))
            .collect();

        let expected: [(&str, &str); 18] = [
            ("--model", config.model.as_str()),
            ("--mmproj", config.mmproj.as_str()),
            ("--model-draft", config.model_draft.as_str()),
            ("--spec-type", "draft-mtp"),
            ("--spec-draft-n-max", "2"),
            ("--fit", "off"),
            ("--load-mode", "none"),
            ("--gpu-layers", "all"),
            ("--threads", "6"),
            ("--threads-batch", "12"),
            ("--reasoning", "on"),
            ("--ctx-size", "131072"),
            ("--temp", "1.0"),
            ("--top-p", "0.95"),
            ("--top-k", "64"),
            ("--parallel", "1"),
            ("--kv-unified", "1"),
            ("--log-verbosity", "4"),
        ];

        for (flag, value) in expected {
            let found = pairs.iter().find(|(f, _)| *f == flag);
            assert!(found.is_some(), "missing flag {flag}");
            let (_, actual) = found.expect("flag present");
            assert!(!actual.is_empty(), "flag {flag} has an empty value");
            assert_eq!(*actual, value, "flag {flag} value mismatch");
        }

        // 21 flag/value pairs total (18 AC-1 flags + --host/--port + --alias).
        assert_eq!(pairs.len(), 21);
    }

    #[test]
    fn kv_unified_false_emits_zero() {
        let mut config = reference_config();
        config.kv_unified = false;
        let args = config.to_args();
        let index = args
            .iter()
            .position(|arg| arg == "--kv-unified")
            .expect("--kv-unified present");
        assert_eq!(args[index + 1], "0");
    }

    #[test]
    fn to_bat_is_a_runnable_windows_batch_of_the_same_argv() {
        let config = reference_config();
        let bat = config.to_bat();

        assert!(bat.starts_with("@echo off\r\n"), "bat: {bat:?}");

        let mut lines: Vec<&str> = bat.lines().collect();
        let last = lines.pop().expect("at least @echo off + command");
        assert!(!last.trim_end().ends_with('^'), "final line must not end with ^");
        for line in lines.iter().skip(1) {
            assert!(
                line.trim_end().ends_with('^'),
                "non-final command line must end with ^: {line:?}"
            );
        }

        let tokens = parse_bat_tokens(&bat);
        let mut expected = vec![config.executable.clone()];
        expected.extend(config.to_args());
        assert_eq!(tokens, expected);
    }

    #[test]
    fn to_bat_keeps_a_path_with_spaces_as_one_token() {
        let mut config = reference_config();
        config.mmproj = r"C:\Users\me\fredo models\mmproj BF16.gguf".to_string();
        let bat = config.to_bat();

        assert!(
            bat.contains(r#""C:\Program Files\llama.cpp\llama-server.exe""#),
            "executable not quoted: {bat:?}"
        );
        assert!(
            bat.contains(r#""C:\Users\me\fredo models\mmproj BF16.gguf""#),
            "spaced model path not quoted: {bat:?}"
        );
        // The tokenizer proves the spaced path stayed one element.
        let tokens = parse_bat_tokens(&bat);
        assert!(tokens.contains(&r"C:\Program Files\llama.cpp\llama-server.exe".to_string()));
        assert!(tokens.contains(&config.mmproj));
    }

    #[test]
    fn default_config_round_trips_through_serde_json() {
        let temp_root = std::env::temp_dir().join("fredo llama server config test");
        let config = LlamaServerConfig {
            executable: temp_root.join("llama-server.exe").to_string_lossy().into_owned(),
            model: temp_root.join("model file.gguf").to_string_lossy().into_owned(),
            mmproj: temp_root.join("mmproj file.gguf").to_string_lossy().into_owned(),
            model_draft: temp_root.join("mtp file.gguf").to_string_lossy().into_owned(),
            ..LlamaServerConfig::default()
        };

        let json = serde_json::to_string(&config).expect("serialize");
        let restored: LlamaServerConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, config);
    }

    #[test]
    fn appstore_keys_and_defaults_match_the_plan() {
        use crate::features::llm_server::{
            DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S, DEFAULT_LLAMA_SERVER_HOST,
            DEFAULT_LLAMA_SERVER_PORT, LLAMA_SERVER_ACTIVE_PORT_KEY, LLAMA_SERVER_ARGS_KEY,
            LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY, LLAMA_SERVER_HOST_KEY, LLAMA_SERVER_LOG_PATH_KEY,
            LLAMA_SERVER_MMPROJ_PATH_KEY, LLAMA_SERVER_MODEL_PATH_KEY, LLAMA_SERVER_MTP_PATH_KEY,
            LLAMA_SERVER_PATH_KEY, LLAMA_SERVER_PID_KEY, LLAMA_SERVER_PORT_KEY,
            LLAMA_SERVER_STARTED_AT_KEY,
        };

        assert_eq!(LLAMA_SERVER_PATH_KEY, "llama_server_path");
        assert_eq!(LLAMA_SERVER_PORT_KEY, "llama_server_port");
        assert_eq!(LLAMA_SERVER_ACTIVE_PORT_KEY, "llama_server_active_port");
        assert_eq!(LLAMA_SERVER_HOST_KEY, "llama_server_host");
        assert_eq!(LLAMA_SERVER_MODEL_PATH_KEY, "llama_server_model_path");
        assert_eq!(LLAMA_SERVER_MMPROJ_PATH_KEY, "llama_server_mmproj_path");
        assert_eq!(LLAMA_SERVER_MTP_PATH_KEY, "llama_server_mtp_path");
        assert_eq!(LLAMA_SERVER_ARGS_KEY, "llama_server_args");
        assert_eq!(LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY, "llama_server_health_timeout_s");
        assert_eq!(LLAMA_SERVER_PID_KEY, "llama_server_pid");
        assert_eq!(LLAMA_SERVER_STARTED_AT_KEY, "llama_server_started_at");
        assert_eq!(LLAMA_SERVER_LOG_PATH_KEY, "llama_server_log_path");

        assert_eq!(DEFAULT_LLAMA_SERVER_HOST, "127.0.0.1");
        assert_eq!(DEFAULT_LLAMA_SERVER_PORT, 8080);
        assert_eq!(DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S, 180);
    }

    #[test]
    fn serializes_with_camel_case_field_names() {
        let config = LlamaServerConfig::default();
        let value = serde_json::to_value(&config).expect("serialize");
        assert!(value.get("specDraftNMax").is_some());
        assert!(value.get("modelDraft").is_some());
        assert!(value.get("ctxSize").is_some());
        assert!(value.get("kvUnified").is_some());
        assert!(value.get("logVerbosity").is_some());
        assert!(value.get("spec_draft_n_max").is_none());
    }
}
