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
pub fn telemetry_get_stats(
    span_store: tauri::State<'_, Arc<SpanStore>>,
) -> Result<TelemetryStatsExt, String> {
    span_store.stats_ext().map_err(|e| e.to_string())
}

/// REQ-12: Delete all rows from telemetry_spans.
/// Returns the number of deleted spans.
#[tauri::command]
pub fn telemetry_purge(
    span_store: tauri::State<'_, Arc<SpanStore>>,
) -> Result<u64, String> {
    span_store.purge_all().map_err(|e| e.to_string())
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
        .set("tracing.enabled", value)
        .map_err(|e| e.to_string())?;
    collector.refresh_enabled();
    Ok(())
}

/// REQ-15: Enable or disable metrics collection.
/// Writes the `tracing.metrics_enabled` key to AppStore and refreshes the cache.
#[tauri::command]
pub fn telemetry_metrics_toggle(
    enabled: bool,
    app_store: tauri::State<'_, Arc<AppStore>>,
    metric_collector: tauri::State<'_, Arc<MetricCollector>>,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    app_store
        .set("tracing.metrics_enabled", value)
        .map_err(|e| e.to_string())?;
    if enabled {
        metric_collector.refresh_enabled();
    } else {
        metric_collector.disable_and_flush();
    }
    Ok(())
}

/// REQ-7: Enable or disable log collection.
/// Writes the `tracing.logging_enabled` key to AppStore and refreshes the cache.
/// When toggling off, flushes buffered records before stopping.
#[tauri::command]
pub fn telemetry_logging_toggle(
    enabled: bool,
    app_store: tauri::State<'_, Arc<AppStore>>,
    log_collector: tauri::State<'_, Arc<LogCollector>>,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    app_store
        .set("tracing.logging_enabled", value)
        .map_err(|e| e.to_string())?;
    if enabled {
        log_collector.refresh_enabled();
    } else {
        log_collector.disable_and_flush();
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
        .set("tracing.logging_level", &level)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::infrastructure::telemetry::metrics_collector::SpanStoreMetricsExt;
    use crate::infrastructure::storage::span_store::SpanStore;
    use crate::infrastructure::storage::AppStore;
    use crate::infrastructure::telemetry::SpanCollector;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn test_toggle_enables_and_disables() {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        let collector = Arc::new(SpanCollector::new(store.clone(), app_store.clone()));

        // Initially enabled (default)
        assert_eq!(
            app_store.get("tracing.enabled").unwrap(),
            None,
            "no default set"
        );

        // Toggle off
        app_store.set("tracing.enabled", "false").unwrap();
        collector.refresh_enabled();

        let val = app_store.get("tracing.enabled").unwrap();
        assert_eq!(val, Some("false".to_string()));

        // Toggle on
        app_store.set("tracing.enabled", "true").unwrap();
        collector.refresh_enabled();

        let val = app_store.get("tracing.enabled").unwrap();
        assert_eq!(val, Some("true".to_string()));
    }

    #[test]
    fn test_stats_returns_zero_for_empty_store() {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0);
        assert_eq!(stats.storage_bytes, 0);
    }

    #[test]
    fn test_purge_clears_all_spans() {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        // Insert a span
        let span = crate::infrastructure::telemetry::TelemetrySpan {
            trace_id: "t".to_string(),
            span_id: "purge-test".to_string(),
            parent_span_id: None,
            span_name: "test".to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: 1000,
            end_time_ns: None,
            status_code: "OK".to_string(),
            status_message: None,
            session_id: "s".to_string(),
            attributes_json: None,
            events_json: None,
            provider: None,
            transport: None,
            event_type: None,
            ingested_at: chrono::Utc::now().to_rfc3339(),
        };
        store.insert_spans(&[span]).unwrap();

        let count = store.purge_all().unwrap();
        assert_eq!(count, 1);

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0);
    }
}
