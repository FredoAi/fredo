use rmcp::ErrorData;
use serde_json::{json, Value};
use sqlx::{Column, PgPool};
use std::sync::Arc;

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

fn validate_select_only(query: &str) -> Result<(), ErrorData> {
    let trimmed = query.trim().to_lowercase();
    if !trimmed.starts_with("select") {
        return Err(ErrorData::invalid_params(
            "Only SELECT queries are allowed",
            None,
        ));
    }
    // Reject dangerous keywords
    for keyword in &["drop ", "delete ", "truncate ", "insert ", "update ", "alter ", "create "] {
        if trimmed.contains(keyword) {
            return Err(ErrorData::invalid_params(
                format!("Query contains forbidden keyword: {keyword}"),
                None,
            ));
        }
    }
    Ok(())
}

pub async fn logs_query(
    pool: &Arc<PgPool>,
    query: &str,
    timeout_ms: Option<u32>,
) -> Result<String, ErrorData> {
    validate_select_only(query)?;
    let timeout = timeout_ms.unwrap_or(10_000);

    let rows = sqlx::query(
        &format!("SET LOCAL statement_timeout = {timeout}; {query}"),
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(ie)?;

    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            use sqlx::Row;
            let cols = row.columns();
            let mut obj = serde_json::Map::new();
            for col in cols {
                let val: Value = row
                    .try_get::<serde_json::Value, _>(col.ordinal())
                    .unwrap_or(Value::Null);
                obj.insert(col.name().to_string(), val);
            }
            Value::Object(obj)
        })
        .collect();

    let result = json!({
        "row_count": results.len(),
        "rows": results,
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

pub async fn metrics_query(
    pool: &Arc<PgPool>,
    metric_name: Option<&str>,
    start_time: Option<&str>,
    end_time: Option<&str>,
    limit: Option<u32>,
) -> Result<String, ErrorData> {
    let mut conditions: Vec<String> = Vec::new();
    if let Some(name) = metric_name {
        conditions.push(format!("name ILIKE '%{}%'", name.replace('\'', "''")));
    }
    if let Some(start) = start_time {
        conditions.push(format!("timestamp >= '{start}'"));
    }
    if let Some(end) = end_time {
        conditions.push(format!("timestamp <= '{end}'"));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let lim = limit.unwrap_or(100);
    let query = format!(
        "SELECT * FROM metrics {where_clause} ORDER BY timestamp DESC LIMIT {lim}"
    );

    let rows = sqlx::query(&query)
        .fetch_all(pool.as_ref())
        .await
        .map_err(ie)?;

    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            use sqlx::Row;
            let cols = row.columns();
            let mut obj = serde_json::Map::new();
            for col in cols {
                let val: Value = row
                    .try_get::<serde_json::Value, _>(col.ordinal())
                    .unwrap_or(Value::Null);
                obj.insert(col.name().to_string(), val);
            }
            Value::Object(obj)
        })
        .collect();

    let result = json!({
        "row_count": results.len(),
        "rows": results,
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

pub async fn traces_query(
    pool: &Arc<PgPool>,
    trace_id: Option<&str>,
    operation_name: Option<&str>,
    status: Option<&str>,
    min_duration_ms: Option<u64>,
    limit: Option<u32>,
) -> Result<String, ErrorData> {
    let mut conditions: Vec<String> = Vec::new();
    if let Some(id) = trace_id {
        conditions.push(format!("trace_id = '{}'", id.replace('\'', "''")));
    }
    if let Some(op) = operation_name {
        conditions.push(format!("operation_name ILIKE '%{}%'", op.replace('\'', "''")));
    }
    if let Some(s) = status {
        conditions.push(format!("status = '{}'", s.replace('\'', "''")));
    }
    if let Some(min_dur) = min_duration_ms {
        conditions.push(format!("duration_ms >= {min_dur}"));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let lim = limit.unwrap_or(50);
    let query = format!(
        "SELECT * FROM traces {where_clause} ORDER BY start_time DESC LIMIT {lim}"
    );

    let rows = sqlx::query(&query)
        .fetch_all(pool.as_ref())
        .await
        .map_err(ie)?;

    let results: Vec<Value> = rows
        .iter()
        .map(|row| {
            use sqlx::Row;
            let cols = row.columns();
            let mut obj = serde_json::Map::new();
            for col in cols {
                let val: Value = row
                    .try_get::<serde_json::Value, _>(col.ordinal())
                    .unwrap_or(Value::Null);
                obj.insert(col.name().to_string(), val);
            }
            Value::Object(obj)
        })
        .collect();

    let result = json!({
        "row_count": results.len(),
        "rows": results,
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}
