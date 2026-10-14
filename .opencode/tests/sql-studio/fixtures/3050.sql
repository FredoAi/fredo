-- Fixture SQL for spec #3050 — schema-explorer actions submenu (slice C of the
-- #2950 split). Deterministic in-repo test asset (G-172) for the live QA rows
-- F-34..F-49 of the durable `sql-studio` suite.
--
-- Apply through the product's own read-write SQL session or the managed `psql`
-- (see `.opencode/tests/sql-studio/functional.md`). It is IDEMPOTENT: every
-- object is dropped (IF EXISTS) before it is re-created, so re-running yields the
-- exact same baseline (never a 500+ row drift).
--
-- Creates:
--   * schema                      "QA_3050"
--   * table                       "QA_3050"."qa_3050_rows"   (exactly 500 rows)
--   * table (mixed case)          "QA_3050"."Mixed Case"     (1 row)
--   * table (0 rows)              "QA_3050"."qa_3050_empty"  (F-36 empty-grid edge)
--   * view                        "QA_3050"."qa_3050_view"
--   * index                       "QA_3050".qa_3050_rows_label_idx
--   * function                    "QA_3050".qa_3050_double(integer)
--   * column baseline             the four columns of "qa_3050_rows" (+ PK key)
--
-- The negative-node AC (R-5 / F-44) needs a schema, column, index, key and
-- function node to browse; the `"Mixed Case"` relation drives the quoting row
-- (R-2b / F-38). Nothing here is destructive to any object outside "QA_3050".

CREATE SCHEMA IF NOT EXISTS "QA_3050";

-- Drop guards first (view before its base table) so a re-run is deterministic.
DROP VIEW IF EXISTS "QA_3050"."qa_3050_view";
DROP TABLE IF EXISTS "QA_3050"."qa_3050_rows" CASCADE;
DROP TABLE IF EXISTS "QA_3050"."Mixed Case" CASCADE;
DROP TABLE IF EXISTS "QA_3050"."qa_3050_empty" CASCADE;
DROP FUNCTION IF EXISTS "QA_3050".qa_3050_double(integer);

-- ── Table with >= 500 rows (F-36 / F-37: the generated LIMIT is observable) ──
CREATE TABLE "QA_3050"."qa_3050_rows" (
  id         integer      PRIMARY KEY,
  label      text         NOT NULL,
  amount     numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO "QA_3050"."qa_3050_rows" (id, label, amount)
SELECT g, 'row-' || g, (g * 1.5)::numeric(12,2)
FROM generate_series(1, 500) AS g;

-- A secondary index (an `index` node for R-5 / F-44).
CREATE INDEX qa_3050_rows_label_idx ON "QA_3050"."qa_3050_rows" (label);

-- ── Mixed-case relation (F-38: identifiers must be double-quoted) ─────────────
CREATE TABLE "QA_3050"."Mixed Case" (
  "Id"        integer PRIMARY KEY,
  "Full Name" text    NOT NULL
);

INSERT INTO "QA_3050"."Mixed Case" ("Id", "Full Name") VALUES (1, 'Ada Lovelace');

-- ── 0-row relation (F-36 edge: `db-results-empty` "Query returned 0 rows") ────
CREATE TABLE "QA_3050"."qa_3050_empty" (
  id integer PRIMARY KEY
);

-- ── View (a `view` node also offers "Open table data" — positive control) ─────
CREATE VIEW "QA_3050"."qa_3050_view" AS
SELECT id, label, amount
FROM "QA_3050"."qa_3050_rows"
WHERE id <= 10;

-- ── Function baseline (a `function` node for R-5 / F-44) ──────────────────────
CREATE FUNCTION "QA_3050".qa_3050_double(n integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT n * 2 $$;
