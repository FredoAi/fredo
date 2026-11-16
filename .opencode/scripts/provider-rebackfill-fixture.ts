/**
 * #2932 round-2 FIX-R2-5 — provider re-derivation verification lever
 * (pipeline tooling, NOT product code).
 *
 * The round-1 tester could not force the one-shot provider re-derivation pass:
 * the `rtdb.backfill.provider.completed*` marker lives in the PostgreSQL
 * `settings` table and the sanctioned read-only telemetry wrapper refuses DML.
 * This script is the sanctioned single-command lever that makes R5/R6
 * re-runnable on demand (no shell loops / pipelines required).
 *
 * Since Spec #3005 the store is the embedded PostgreSQL cluster (SQLite is
 * gone). This lever talks to the cluster with the managed `psql` at its
 * ephemeral loopback port; there is no DB file to open.
 *
 * Actions (exactly one; `--reset-marker` may be combined with `--print-state`
 * to show the pre-pass state in one call):
 *
 *   bun .opencode/scripts/provider-rebackfill-fixture.ts --reset-marker --pg-port <n>
 *     Deletes EVERY `rtdb.backfill.provider.completed*` key from `settings`
 *     (both the superseded v1 and the corrected v2 marker), so the next app
 *     launch runs the corrected pass. A restart is required for the app to
 *     re-read the marker.
 *
 *   bun .opencode/scripts/provider-rebackfill-fixture.ts --print-state [--session ses_id] --pg-port <n>
 *     Read-only report: the rtdb.backfill* markers, per-table provider
 *     histograms, never-NULL/empty counts, and — when `--session` is given —
 *     that session's unresolved vs span-matched vs parallel-row counts.
 *
 * Params:
 *   --pg-port N       PostgreSQL loopback port (or resolve via --manifest ports.pg)
 *   --manifest PATH   env process-manifest (<env-root>/manifest.json) → ports.pg
 *   --session ID      session id for the per-session block in --print-state
 *   --pg-host/--pg-user/--pg-database  connection fields (defaults 127.0.0.1/postgres/postgres)
 *   --pg-password     password (default $env:PGPASSWORD -> FREDO_PG_PASSWORD_FILE -> loopback fallback)
 *
 * Gate note (the point of `--print-state`): after the corrected pass runs, a
 * pre-existing row whose span is in `telemetry_spans` shows its resolved token
 * (`open_code` for `service.name = 'fredo-opencode-plugin'`) and the per-table
 * row COUNT is unchanged from before the pass — no parallel row appears at a
 * minted key.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// ── CLI params ────────────────────────────────────────────────────────────────

let resetMarker = false;
let printState = false;
let session: string | null = null;
let pgPort = 0;
let manifestPath: string | null = null;
let pgHost = "127.0.0.1";
let pgUser = "postgres";
let pgDatabase = "postgres";
let pgPassword = process.env.PGPASSWORD ?? "";

const FALLBACK_PASSWORD = "fredo-loopback-fallback";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--reset-marker") resetMarker = true;
  else if (argv[i] === "--print-state") printState = true;
  else if (argv[i] === "--session") session = argv[++i] ?? "";
  else if (argv[i] === "--pg-port") pgPort = Number(argv[++i] ?? "0");
  else if (argv[i] === "--manifest") manifestPath = argv[++i] ?? "";
  else if (argv[i] === "--pg-host") pgHost = argv[++i] ?? pgHost;
  else if (argv[i] === "--pg-user") pgUser = argv[++i] ?? pgUser;
  else if (argv[i] === "--pg-database") pgDatabase = argv[++i] ?? pgDatabase;
  else if (argv[i] === "--pg-password") pgPassword = argv[++i] ?? pgPassword;
  else {
    console.error(`Unknown argument: ${argv[i]}`);
    process.exit(1);
  }
}

if (!resetMarker && !printState) {
  console.error(
    "Usage: bun .opencode/scripts/provider-rebackfill-fixture.ts --reset-marker | --print-state [--session <id>] --pg-port <n> | --manifest <path>",
  );
  process.exit(1);
}

// ── Resolve the PG port (G-307) ────────────────────────────────────────────────

if (pgPort <= 0 && manifestPath) {
  if (!existsSync(manifestPath)) {
    console.error(`env manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { ports?: { pg?: number } };
    pgPort = Number(manifest.ports?.pg ?? 0);
  } catch (err) {
    console.error(`env manifest is not valid JSON: ${manifestPath} (${err instanceof Error ? err.message : String(err)})`);
    process.exit(2);
  }
}

if (pgPort <= 0) {
  console.error(
    "PostgreSQL port unresolved (0). Re-resolve it (G-307): read pg_supervisor_status, or re-run dev-env.ps1 -Action Up / Status, then pass the fresh --pg-port (or --manifest with ports.pg).",
  );
  process.exit(2);
}

// ── Password resolution (never logged) ─────────────────────────────────────────

if (!pgPassword && process.env.FREDO_PG_PASSWORD_FILE && existsSync(process.env.FREDO_PG_PASSWORD_FILE)) {
  for (const line of readFileSync(process.env.FREDO_PG_PASSWORD_FILE, "utf8").split(/\r?\n/)) {
    if (line.trim() !== "") {
      pgPassword = line.trim();
      break;
    }
  }
}
if (!pgPassword) pgPassword = FALLBACK_PASSWORD;

// ── psql runner ────────────────────────────────────────────────────────────────

let psqlBin: string | null = null;
{
  const probe = spawnSync("psql", ["--version"], { encoding: "utf8", shell: false });
  if (probe.status === 0) psqlBin = "psql";
}
if (!psqlBin) {
  console.error("psql CLI not found (managed embedded PostgreSQL or PATH).");
  process.exit(2);
}

function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsql(sql: string, readonly: boolean): string {
  const env = { ...process.env, PGPASSWORD: pgPassword, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? "10" };
  if (readonly) env.PGOPTIONS = "-c default_transaction_read_only=on";
  const args = [
    "-X", "-q", "--no-psqlrc", "-w",
    "-h", pgHost, "-p", String(pgPort), "-U", pgUser, "-d", pgDatabase,
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "\t", "-c", sql,
  ];
  const res = spawnSync(psqlBin as string, args, { encoding: "utf8", env, shell: false });
  if (res.status !== 0) {
    const detail = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim();
    throw new Error(`psql failed (exit ${res.status}): ${detail}`);
  }
  return res.stdout ?? "";
}

function scalar(sql: string, readonly: boolean): number {
  const out = runPsql(sql, readonly).trim();
  const first = out.split(/\r?\n/)[0] ?? "";
  return Number(first.split("\t")[0] ?? "0") || 0;
}

function rows(sql: string, readonly: boolean): Array<Record<string, string>> {
  const out = runPsql(sql, readonly).trim();
  if (out === "") return [];
  return out.split(/\r?\n/).map((line) => {
    const cells = line.split("\t");
    return { key: cells[0] ?? "", value: cells[1] ?? "" };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TABLES = ["chat_rows", "tool_use_rows", "agent_session_rows"] as const;

function tableExists(table: string, readonly: boolean): boolean {
  return scalar(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${sqlStr(table)}`, readonly) > 0;
}

console.log(`provider-rebackfill-fixture: pg=${pgHost}:${pgPort}/${pgDatabase}`);

// ── Action: --reset-marker ────────────────────────────────────────────────────

if (resetMarker) {
  try {
    if (!tableExists("settings", false)) {
      console.error("settings table absent — nothing to reset (run the app once).");
      process.exit(2);
    }
    const before = rows(
      "SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%' ORDER BY key",
      false,
    );
    if (before.length === 0) {
      console.log("No rtdb.backfill.provider.completed* marker present — the corrected pass will run on the next launch.");
    } else {
      for (const row of before) console.log(`  clearing ${row.key} = ${row.value}`);
    }
    runPsql("DELETE FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%'", false);
    const after = rows("SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill.provider.completed%'", false);
    console.log(`RESET OK — ${after.length} provider marker(s) remain. Restart the app to run the corrected pass.`);
  } catch (err) {
    console.error(`RESET FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }
}

// ── Action: --print-state ─────────────────────────────────────────────────────

if (printState) {
  try {
    console.log("\n== rtdb.backfill* markers ==");
    if (tableExists("settings", true)) {
      const markers = rows("SELECT key, value FROM settings WHERE key LIKE 'rtdb.backfill%' ORDER BY key", true);
      if (markers.length === 0) console.log("  (none)");
      for (const m of markers) console.log(`  ${m.key} = ${m.value}`);
    } else {
      console.log("  (settings table absent)");
    }

    for (const table of TABLES) {
      console.log(`\n== ${table} ==`);
      if (!tableExists(table, true)) {
        console.log("  (table absent)");
        continue;
      }
      const total = scalar(`SELECT COUNT(*) FROM ${table}`, true);
      const hist = rows(`SELECT COALESCE(provider, '') , COUNT(*) AS n FROM ${table} GROUP BY provider ORDER BY provider`, true);
      const bad = scalar(`SELECT COUNT(*) FROM ${table} WHERE provider IS NULL OR provider = ''`, true);
      console.log(`  rows=${total}  null_or_empty=${bad}`);
      for (const h of hist) console.log(`    ${h.key === "" ? "(NULL)" : h.key}: ${h.value}`);
    }

    if (session) {
      console.log(`\n== session ${session} ==`);
      const sessionLiteral = sqlStr(session);
      const unresolved = scalar(
        `SELECT COUNT(*) FROM chat_rows WHERE session_id = ${sessionLiteral} AND (provider IS NULL OR provider = 'unknown')`,
        true,
      );
      const spansForSession = tableExists("telemetry_spans", true)
        ? scalar(`SELECT COUNT(*) FROM telemetry_spans WHERE session_id = ${sessionLiteral}`, true)
        : -1;
      const matches = scalar(
        `SELECT COUNT(*) FROM chat_rows c JOIN telemetry_spans s ON s.session_id = COALESCE(c.composited_child_session_id, c.session_id) AND s.start_time_ns = c.started_at_ns WHERE c.session_id = ${sessionLiteral} AND (c.provider IS NULL OR c.provider = 'unknown')`,
        true,
      );
      const parallel = scalar(
        `SELECT COUNT(*) FROM chat_rows c WHERE c.session_id = ${sessionLiteral} AND (c.provider IS NULL OR c.provider = 'unknown') AND c.started_at_ns IS NOT NULL AND EXISTS (SELECT 1 FROM chat_rows o WHERE o.session_id = c.session_id AND o.started_at_ns = c.started_at_ns AND o.correlation_id <> c.correlation_id AND o.provider IS NOT NULL AND o.provider <> 'unknown')`,
        true,
      );
      const hist = rows(
        `SELECT COALESCE(provider, ''), COUNT(*) AS n FROM chat_rows WHERE session_id = ${sessionLiteral} GROUP BY provider ORDER BY provider`,
        true,
      );
      console.log(`  telemetry_spans=${spansForSession}`);
      console.log(`  chat unresolved=${unresolved}  span_matched_unresolved=${matches}  parallel_rows=${parallel}`);
      for (const h of hist) console.log(`    ${h.key === "" ? "(NULL)" : h.key}: ${h.value}`);
      console.log(
        "  Gate: after the corrected pass, span_matched_unresolved must be 0, parallel_rows must be 0, and the per-table row count must be unchanged.",
      );
    }
  } catch (err) {
    console.error(`PRINT-STATE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }
}
