//! Shared companion runtime helpers (Spec #2857).
//!
//! The `llama-server` executable resolver is consumed by BOTH `features/setup`
//! (the readiness check) and `features/llm_server` (launch). Cross-feature
//! imports are forbidden (`AGENTS.md`), so it lives here in the shared
//! infrastructure layer — one implementation, one resolution order.

pub mod resolver;

pub use resolver::{
    resolve_llama_server, resolve_llama_server_order, LLAMA_SERVER_BIN,
    LLAMA_SERVER_SETTING_KEY,
};
