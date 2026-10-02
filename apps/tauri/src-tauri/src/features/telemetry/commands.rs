//! Tauri IPC commands for telemetry management.
//!
//! REQ-12: Exposes telemetry_get_stats, telemetry_purge, and telemetry_toggle
//! commands to the frontend.
//! REQ-15: Exposes telemetry_metrics_toggle command.

use std::sync::Arc;

use crate::infrastructure::telemetry::metrics_collector::{MetricCollector, TelemetryStatsExt};
use crate::infrastructure::storage::AppStore;
use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::telemetry::log::LogCollector;
use crate::infrastructure::telemetry::SpanCollector;

/// REQ-12,15: Return span count, approximate storage size, and metric point count.
#[tauri::command]
pub async fn telemetry_get_stats(
    span_store: tauri::State<'_, Arc<SpanStore>>,
) -> Result<TelemetryStatsExt, String> {
    span_store.stats_ext().await.map_err(|e| e.to_string())
}

/// REQ-12: Delete all rows from telemetry_spans.
/// Returns the number of deleted spans.
#[tauri::command]
pub async fn telemetry_purge(
    span_store: tauri::State<'_, Arc<SpanStore>>,
) -> Result<u64, String> {
    span_store.purge_all().await.map_err(|e| e.to_string())
}

/// REQ-12: Enable or disable span collection.
/// Writes the `tracing.enabled` key to AppStore.
#[tauri::command]
pub fn telemetry_toggle(
    enabled: bool,
    app_store: tauri::State<'_, Arc<AppStore>>,
    collector: tauri::State<'_, Arc<SpanCollector>>,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    app_store
        .control_set("tracing.enabled", value)
        .map_err(|e| e.to_string())?;
    collector.refresh_enabled();
    Ok(())
}

/// REQ-15: Enable or disable metrics collection.
/// Writes the `tracing.metrics_enabled` key to AppStore and refreshes the cache.
#[tauri::command]
pub async fn telemetry_metrics_toggle(
    enabled: bool,
    app_store: tauri::State<'_, Arc<AppStore>>,
    metric_collector: tauri::State<'_, Arc<MetricCollector>>,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    app_store
        .control_set("tracing.metrics_enabled", value)
        .map_err(|e| e.to_string())?;
    if enabled {
        metric_collector.refresh_enabled();
    } else {
        metric_collector.disable_and_flush().await;
    }
    Ok(())
}

/// REQ-7: Enable or disable log collection.
/// Writes the `tracing.logging_enabled` key to AppStore and refreshes the cache.
/// When toggling off, flushes buffered records before stopping.
#[tauri::command]
pub async fn telemetry_logging_toggle(
    enabled: bool,
    app_store: tauri::State<'_, Arc<AppStore>>,
    log_collector: tauri::State<'_, Arc<LogCollector>>,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    app_store
        .control_set("tracing.logging_enabled", value)
        .map_err(|e| e.to_string())?;
    if enabled {
        log_collector.refresh_enabled();
    } else {
        log_collector.disable_and_flush().await;
    }
    Ok(())
}

/// REQ-7: Set minimum log level for the tracing subscriber.
/// Writes the `tracing.logging_level` key to AppStore.
/// Accepted levels: TRACE, DEBUG, INFO, WARN, ERROR.
#[tauri::command]
pub fn telemetry_logging_set_level(
    level: String,
    app_store: tauri::State<'_, Arc<AppStore>>,
) -> Result<(), String> {
    let valid_levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
    if !valid_levels.contains(&level.as_str()) {
        return Err(format!(
            "Invalid level: {level}. Must be one of: TRACE, DEBUG, INFO, WARN, ERROR"
        ));
    }
    app_store
        .control_set("tracing.logging_level", &level)
        .map_err(|e| e.to_string())?;
    Ok(())
}
