//! Comm Infrastructure Tests
//!
//! Tests for the Communication Layer Foundation (Spec 1, GitHub issue #26).
//!
//! This module aggregates all unit tests for the comm infrastructure:
//! - FredoEvent and its enums (event_tests.rs)
//! - EventBus emit behavior (bus_tests.rs)
//! - InternalAdapter validation and enrichment (adapter_tests.rs)
//! - IPC CliCommand::EmitEvent (ipc_tests.rs)

mod event_tests;
mod bus_tests;
mod adapter_tests;
mod ipc_tests;