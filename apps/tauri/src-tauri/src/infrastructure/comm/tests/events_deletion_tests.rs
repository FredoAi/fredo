//! Unit tests for infrastructure/events/mod.rs deletion verification.
//!
//! Tests REQ-2.7:
//! - infrastructure/events/mod.rs is deleted
//! - No code references StreamEvent or emit_stream_event()
//!
//! REQ-2.7: infrastructure/events/mod.rs is deleted and no import references it

use std::fs;
use std::path::Path;

/// REQ-2.7: infrastructure/events/mod.rs must NOT exist after refactoring
#[test]
fn events_module_is_deleted() {
    let events_path = Path::new("src/infrastructure/events/mod.rs");

    // The file should NOT exist (or the path should not be a module)
    // This test verifies the file doesn't exist as part of the source tree
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));

    // Check if the file exists in the actual source tree
    let full_path = source_root.join("src/infrastructure/events/mod.rs");

    // If the file exists, fail the test
    // This test will PASS once the file is deleted
    assert!(
        !full_path.exists(),
        "infrastructure/events/mod.rs should be deleted per REQ-2.7, but it still exists at {:?}",
        full_path
    );
}

/// REQ-2.7: infrastructure/events directory should NOT exist (or be empty/renamed)
#[test]
fn events_directory_is_removed() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let events_dir = source_root.join("src/infrastructure/events");

    // Directory should not exist or should not contain mod.rs
    if events_dir.exists() && events_dir.is_dir() {
        let mod_rs = events_dir.join("mod.rs");
        assert!(
            !mod_rs.exists(),
            "infrastructure/events/mod.rs should be deleted per REQ-2.7"
        );
    }
}

/// REQ-2.7: No source files should import from infrastructure::events
/// NOTE: This is a compile-time check - if any file imports infrastructure::events,
/// the crate won't compile. These tests document the expected state.
#[test]
fn events_module_not_imported_in_ipc() {
    // After refactoring, ipc.rs should NOT have:
    // use crate::infrastructure::events::{emit_stream_event, EventState, StreamEvent};
    //
    // Instead it should use:
    // use crate::infrastructure::comm::adapters::opencode::OpenCodeAdapter;
    //
    // This test will be enforced by cargo build failure if the import still exists.
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ipc_path = source_root.join("src/infrastructure/ipc.rs");

    if ipc_path.exists() {
        let content = fs::read_to_string(&ipc_path).unwrap();
        assert!(
            !content.contains("infrastructure::events"),
            "ipc.rs should not import from infrastructure::events per REQ-2.7"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "ipc.rs should not use emit_stream_event per REQ-2.7"
        );
    }
}

/// REQ-2.7: otlp/grpc.rs should not import from infrastructure::events
#[test]
fn events_module_not_imported_in_otlp_grpc() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let grpc_path = source_root.join("src/infrastructure/otlp/grpc.rs");

    if grpc_path.exists() {
        let content = fs::read_to_string(&grpc_path).unwrap();
        assert!(
            !content.contains("infrastructure::events"),
            "otlp/grpc.rs should not import from infrastructure::events per REQ-2.7"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "otlp/grpc.rs should not use emit_stream_event per REQ-2.7"
        );
    }
}

/// REQ-2.7: otlp/http.rs should not import from infrastructure::events
#[test]
fn events_module_not_imported_in_otlp_http() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let http_path = source_root.join("src/infrastructure/otlp/http.rs");

    if http_path.exists() {
        let content = fs::read_to_string(&http_path).unwrap();
        assert!(
            !content.contains("infrastructure::events"),
            "otlp/http.rs should not import from infrastructure::events per REQ-2.7"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "otlp/http.rs should not use emit_stream_event per REQ-2.7"
        );
    }
}

/// REQ-2.7: infrastructure/otlp/mapping.rs should be deleted
#[test]
fn otlp_mapping_module_is_deleted() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mapping_path = source_root.join("src/infrastructure/otlp/mapping.rs");

    assert!(
        !mapping_path.exists(),
        "infrastructure/otlp/mapping.rs should be deleted per REQ-2.7 (logic moved to OpenCodeAdapter)"
    );
}

/// REQ-2.7: otlp/mod.rs should not contain pub mod mapping
#[test]
fn otlp_mod_does_not_export_mapping() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let otlp_mod_path = source_root.join("src/infrastructure/otlp/mod.rs");

    if otlp_mod_path.exists() {
        let content = fs::read_to_string(&otlp_mod_path).unwrap();
        assert!(
            !content.contains("pub mod mapping"),
            "otlp/mod.rs should not export mapping module per REQ-2.7"
        );
    }
}

/// REQ-2.7: infrastructure/mod.rs should not have pub mod events
#[test]
fn infrastructure_mod_does_not_export_events() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let infra_mod_path = source_root.join("src/infrastructure/mod.rs");

    if infra_mod_path.exists() {
        let content = fs::read_to_string(&infra_mod_path).unwrap();
        assert!(
            !content.contains("pub mod events"),
            "infrastructure/mod.rs should not export events module per REQ-2.7"
        );
    }
}