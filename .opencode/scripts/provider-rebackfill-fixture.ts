/**
 * #2932 round-2 FIX-R2-5 — provider re-derivation verification lever
 * (pipeline tooling, NOT product code).
 *
 * The round-1 tester could not force the one-shot provider re-derivation pass:
 * the `rtdb.backfill.provider.completed*` marker lives in the `settings` table
 * and the sanctioned read-only telemetry wrapper refuses DML. This script is
 * the sanctioned single-command lever that makes R5/R6 re-runnable on demand
 * (no shell loops / pipelines required).
 *
 * Actions (exactly one; `--reset-marker` may be combined with `--print-state`
 * to show the pre-pass state in one call):
 *
 *   bun .opencode/scripts/provider-rebackfill-fixture.ts --reset-marker
 *     Deletes EVERY `rtdb.backfill.provider.completed*` key from `settings`
 *     (both the superseded v1 and the corrected v2 marker), so the next app
 *     launch runs the corrected pass. Requires the app to be STOPPED (SQLite
 *     writer lock) — the script prints a loud error if the DB is locked.
 *
 *   bun .opencode/scripts/provider-rebackfill-fixture.ts --print-state [--session ses_id]
 *     Read-only report: the rtdb.backfill* markers, per-table provider
 *     histograms, never-NULL/empty counts, and — when `--session` is given —
 *     that session's unresolved vs span-matched vs parallel-row counts.
 *
 * Params:
 *   --db PATH        override the fredo.db path (default %APPDATA%/com.fredo.app/fredo.db)
 *   --session ID     session id for the per-session block in --print-state
 *
 * Dependency-free: Bun's built-in `bun:sqlite` (no npm install).
 *
 * Gate note (the point of `--print-state`): after the corrected pass runs, a
 * pre-existing row whose span is in `telemetry_spans` shows its resolved token
 * (`open_code` for `service.name = 'fredo-opencode-plugin'`) and the per-table
 * row COUNT is unchanged from before the pass — no parallel row appears at a
 * minted key.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── CLI params ────────────────────────────────────────────────────────────────

let resetMarker = false;
let printState = false;
let dbOverride: string | null = null;
let session: string | null = null;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--reset-marker") resetMarker = true;
  else if (argv[i] === "--print-state") printState = true;
  else if (argv[i] === "--db") dbOverride = argv[++i] ?? "";
  else if (argv[i] === "--session") session = argv[++i] ?? "";
  else {
    console.error(`Unknown argument: ${argv[i]}`);
    process.exit(1);
  }
}

if (!resetMarker && !printState) {
  console.error(
    "Usage: bun .opencode/scripts/provider-rebackfill-fixture.ts --reset-marker | --print-state [--session <id>] [--db <path>]",
  );
  process.exit(1);
}

// ── Resolve fredo.db ──────────────────────────────────────────────────────────

function resolveDbPath(): string {
  if (dbOverride) {
    if (!existsSync(dbOverride)) {
      console.error(`fredo.db not found at --db path: ${dbOverride}`);
      process.exit(2);
    }
    return dbOverride;
  }
  const candidates: string[] = [];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "com.fredo.app", "fredo.db"));
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "com.fredo.app", "fredo.db"));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  console.error("fredo.db not found. Searched:");
  for (const c of candidates) console.error(`    ${c}`);
  console.error("Run the Fredo app at least once, or pass --db <path>.");
  process.exit(2);
}

const dbPath = resolveDbPath();
console.log(`provider-rebackfill-fixture: db=${dbPath}`);

// ── Helpers ───────────────────────────────────────────────────────────────────

const TABLES = ["chat_rows", "tool_use_rows", "agent_session_rows"] as const;

function open(readonly: boolean): Database {
  try {
    return new Database(dbPath, { readonly });
  } catch (err) {
    console.error(
      `Cannot open fredo.db (${readonly ? "read-only" : "read-write"}): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { n: number } | null;
  return (row?.n ?? 0) > 0;
}

// ── Action: --reset-marker ────────────────────────────────────────────────────

if (resetMarker) {
  const db = open(false);
  try {
    if (!tableExists(db, "settings")) {
      console.error("settings table absent — nothing to reset (run the app once).");
      process.exit(2);
    }
    const before = db
      .query(
        "SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%' ORDER BY key",
      )
      .all() as Array<{ key: string; value: string }>;
    if (before.length === 0) {
      console.log(
        "No rtdb.backfill.provider.completed* marker present — the corrected pass will run on the next launch.",
      );
    } else {
      for (const row of before) console.log(`  clearing ${row.key} = ${row.value}`);
    }
    db.run("DELETE FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%'");
    const after = db
      .query("SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%'")
      .all() as unknown[];
    console.log(`RESET OK — ${after.length} provider marker(s) remain. Restart the app to run the corrected pass.`);
  } catch (err) {
    console.error(
      `RESET FAILED (is the app still running? close it and retry): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(3);
  } finally {
    db.close();
  }
}

// ── Action: --print-state ─────────────────────────────────────────────────────

if (printState) {
  const db = open(true);
  try {
    console.log("\n== rtdb.backfill* markers ==");
    if (tableExists(db, "settings")) {
      const markers = db
        .query("SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill%' ORDER BY key")
        .all() as Array<{ key: string; value: string }>;
      if (markers.length === 0) console.log("  (none)");
      for (const m of markers) console.log(`  ${m.key} = ${m.value}`);
    } else {
      console.log("  (settings table absent)");
    }

    for (const table of TABLES) {
      console.log(`\n== ${table} ==`);
      if (!tableExists(db, table)) {
        console.log("  (table absent)");
        continue;
      }
      const total = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const hist = db
        .query(`SELECT provider, COUNT(*) AS n FROM ${table} GROUP BY provider ORDER BY provider`)
        .all() as Array<{ provider: string | null; n: number }>;
      const bad = (
        db
          .query(`SELECT COUNT(*) AS n FROM ${table} WHERE provider IS NULL OR provider = ''`)
          .get() as { n: number }
      ).n;
      console.log(`  rows=${total}  null_or_empty=${bad}`);
      for (const h of hist) console.log(`    ${h.provider ?? "(NULL)"}: ${h.n}`);
    }

    if (session) {
      console.log(`\n== session ${session} ==`);
      const unresolved = (
        db
          .query(
            "SELECT COUNT(*) AS n FROM chat_rows WHERE session_id = ? AND (provider IS NULL OR provider = 'unknown')",
          )
          .get(session) as { n: number }
      ).n;
      const spansForSession = tableExists(db, "telemetry_spans")
        ? (
            db
              .query("SELECT COUNT(*) AS n FROM telemetry_spans WHERE session_id = ?")
              .get(session) as { n: number }
          ).n
        : -1;
      const matches = (
        db
          .query(
            `SELECT COUNT(*) AS n
               FROM chat_rows c
               JOIN telemetry_spans s
                 ON s.session_id = COALESCE(c.composited_child_session_id, c.session_id)
                AND s.start_time_ns = c.started_at_ns
              WHERE c.session_id = ? AND (c.provider IS NULL OR c.provider = 'unknown')`,
          )
          .get(session) as { n: number }
      ).n;
      const parallel = (
        db
          .query(
            `SELECT COUNT(*) AS n
               FROM chat_rows c
              WHERE c.session_id = ? AND (c.provider IS NULL OR c.provider = 'unknown')
                AND c.started_at_ns IS NOT NULL
                AND EXISTS (
                      SELECT 1 FROM chat_rows o
                       WHERE o.session_id = c.session_id
                         AND o.started_at_ns = c.started_at_ns
                         AND o.correlation_id <> c.correlation_id
                         AND o.provider IS NOT NULL AND o.provider <> 'unknown'
                    )`,
          )
          .get(session) as { n: number }
      ).n;
      const hist = db
        .query("SELECT provider, COUNT(*) AS n FROM chat_rows WHERE session_id = ? GROUP BY provider ORDER BY provider")
        .all(session) as Array<{ provider: string | null; n: number }>;
      console.log(`  telemetry_spans=${spansForSession}`);
      console.log(`  chat unresolved=${unresolved}  span_matched_unresolved=${matches}  parallel_rows=${parallel}`);
      for (const h of hist) console.log(`    ${h.provider ?? "(NULL)"}: ${h.n}`);
      console.log(
        "  Gate: after the corrected pass, span_matched_unresolved must be 0, parallel_rows must be 0, and the per-table row count must be unchanged.",
      );
    }
  } catch (err) {
    console.error(`PRINT-STATE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  } finally {
    db.close();
  }
}
