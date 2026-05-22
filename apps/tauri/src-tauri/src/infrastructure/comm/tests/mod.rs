//! Comm Infrastructure Tests
//!
//! Tests for the Communication Layer Foundation (Spec 1, GitHub issue #26)
//! and OpenCode Adapter Consolidation (Spec 2, GitHub issue #43).
//!
//! This module aggregates all unit tests for the comm infrastructure:
//! - FredoEvent and its enums (event_tests.rs)
//! - EventBus emit behavior (bus_tests.rs)
//! - InternalAdapter validation and enrichment (adapter_tests.rs)
//! - IPC CliCommand::EmitEvent (ipc_tests.rs)
//! - OpenCodeAdapter transform (opencode_adapter_tests.rs)
//! - OpenCodeAdapter wiring in IPC/OTLP callers (opencode_adapter_wiring_tests.rs)
//! - infrastructure/events/mod.rs deletion (events_deletion_tests.rs)
//! - Feature module migration to FredoEvent (feature_migration_tests.rs)

mod event_tests;
mod bus_tests;
mod adapter_tests;
mod ipc_tests;
mod opencode_adapter_tests;
mod opencode_adapter_wiring_tests;
mod events_deletion_tests;
mod feature_migration_tests;