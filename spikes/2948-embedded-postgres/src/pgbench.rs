//! Synchronous embedded-PostgreSQL workload runner.
//!
//! The `postgres` sync client drives its own Tokio runtime, so it must not be
//! called from within an async task; callers invoke this via
//! `tokio::task::spawn_blocking`.

use crate::{schema, workload};
use anyhow::{Context, Result};
use postgres::NoTls;
use std::time::Instant;

pub struct PgOutcome {
    pub cold_start_ms: f64,
    pub upsert_ms: f64,
    pub point_read_ms: f64,
    pub range_read_ms: f64,
    pub rows_final: i64,
    pub written: usize,
    pub round_trip_ok: bool,
    pub unicode_ok: bool,
    pub settings_ok: bool,
}

pub fn run_workload(url: &str, rows: &[workload::Row], process_start: Instant) -> Result<PgOutcome> {
    let mut client =
        postgres::Client::connect(url, NoTls).context("connect to embedded postgres")?;
    client.simple_query("SELECT 1").context("first query")?;
    let cold_start_ms = process_start.elapsed().as_secs_f64() * 1000.0;

    client
        .batch_execute(schema::PG_DDL)
        .context("create postgres representative schema")?;

    let lo = rows.iter().map(|r| r.started_at_ns).min().unwrap_or(0);
    let hi = rows.iter().map(|r| r.started_at_ns).max().unwrap_or(0) + 1;

    // Batch upsert: one transaction per 512 rows (mirrors RTDB chunking).
    let mut written = 0usize;
    let upsert_ms = {
        let t0 = Instant::now();
        let stmt = client.prepare(schema::PG_UPSERT)?;
        for chunk in rows.chunks(workload::BATCH) {
            let mut tx = client.transaction()?;
            for row in chunk {
                let params: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![
                    &row.session_id,
                    &row.correlation_id,
                    &row.seq,
                    &row.started_at_ns,
                    &row.ended_at_ns,
                    &row.updated_at,
                    &row.state,
                    &row.user_message,
                    &row.agent_reply,
                    &row.prompt_tokens,
                    &row.completion_tokens,
                    &row.cache_read_tokens,
                    &row.cost_usd,
                    &row.model,
                    &row.parent_session_id,
                    &row.composited_child_session_id,
                    &row.raw_json,
                    &row.provider,
                ];
                tx.execute(&stmt, &params)?;
                written += 1;
            }
            tx.commit()?;
        }
        t0.elapsed().as_secs_f64() * 1000.0
    };

    // Point-read verification must compare against the FINAL write for each key
    // (10% of ops are re-upserts of earlier keys).
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut check_rows: Vec<&workload::Row> = Vec::new();
    for row in rows.iter().rev() {
        if seen.insert((row.session_id.clone(), row.correlation_id.clone())) {
            check_rows.push(row);
        }
        if check_rows.len() >= 1000 {
            break;
        }
    }

    let point_stmt = client.prepare(schema::PG_POINT_READ)?;
    let point_read_ms = {
        let t0 = Instant::now();
        let mut mismatches = 0usize;
        for row in &check_rows {
            let got = client.query_one(&point_stmt, &[&row.session_id, &row.correlation_id])?;
            let raw: String = got.get(0);
            if raw != row.raw_json {
                mismatches += 1;
            }
        }
        anyhow::ensure!(mismatches == 0, "point-read mismatches: {mismatches}");
        t0.elapsed().as_secs_f64() * 1000.0
    };

    let range_read_ms = {
        let t0 = Instant::now();
        let stmt = client.prepare(schema::PG_RANGE_READ)?;
        let _row = client.query_one(&stmt, &[&lo, &hi])?;
        t0.elapsed().as_secs_f64() * 1000.0
    };

    let sample = check_rows[0];
    let read = client.query_one(&point_stmt, &[&sample.session_id, &sample.correlation_id])?;
    let read_raw: String = read.get(0);
    let round_trip_ok = read_raw == sample.raw_json;

    let unicode_ok = match check_rows
        .iter()
        .find(|r| r.user_message.as_deref().map(|m| m.contains("漢字")).unwrap_or(false))
    {
        Some(r) => {
            let got = client.query_one(&point_stmt, &[&r.session_id, &r.correlation_id])?;
            let raw: String = got.get(0);
            raw == r.raw_json
        }
        None => false,
    };

    let rows_final: i64 = client.query_one("SELECT count(*) FROM chat_rows", &[])?.get(0);

    client
        .batch_execute(
            "INSERT INTO settings (key, value) VALUES ('spike', 'ok') \
             ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
        )
        .context("settings KV write")?;
    let settings_ok: String = client
        .query_one("SELECT value FROM settings WHERE key = 'spike'", &[])?
        .get(0);

    Ok(PgOutcome {
        cold_start_ms,
        upsert_ms,
        point_read_ms,
        range_read_ms,
        rows_final,
        written,
        round_trip_ok,
        unicode_ok,
        settings_ok: settings_ok == "ok",
    })
}
