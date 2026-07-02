pub mod cli;
pub mod comm;
pub mod ipc;
pub mod otlp;
pub mod storage;
pub mod telemetry;

#[path = "telemetry/contract_407.rs"]
pub mod contract_407;

// Removed: k8s, llm, store — these have moved to their respective feature modules.
