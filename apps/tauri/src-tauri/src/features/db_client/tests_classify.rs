//! ST-4 classification + splitting tests (Spec #2950).
//!
//! Pure and DB-free (G-222): the splitter, the `sqlparser` classifier, the
//! confirmation hash and the preview are exercised directly. The scanner's
//! statement count is cross-checked against `sqlparser` on well-formed batches;
//! the live query/result behaviour is the tester's QA-3/QA-5/QA-8/QA-9 receipt.

use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use super::{classify_statement, preview, split_statements, statement_hash, PREVIEW_LIMIT};
use crate::features::db_client::types::StatementClass;

// ── Splitting ─────────────────────────────────────────────────────────────────

#[test]
fn splits_multiple_statements_with_exact_offsets() {
    let sql = "SELECT 1; SELECT 2;";
    let spans = split_statements(sql);
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].sql, "SELECT 1");
    assert_eq!(spans[0].start, 0);
    assert_eq!(spans[0].end, 8);
    assert_eq!(&sql[spans[0].start..spans[0].end], "SELECT 1");
    assert_eq!(spans[1].sql, "SELECT 2");
    assert_eq!(&sql[spans[1].start..spans[1].end], "SELECT 2");
}

#[test]
fn ignores_blank_statements_and_comment_only_tails() {
    assert!(split_statements("   ").is_empty());
    assert!(split_statements(";;;").is_empty());
    assert!(split_statements("-- only a comment\n").is_empty());
    assert_eq!(split_statements("SELECT 1; -- trailing").len(), 1);
    assert_eq!(split_statements("-- lead\nSELECT 1").len(), 1);
}

#[test]
fn offsets_track_multiline_positions() {
    let sql = "SELECT 1\n;\nSELECT 2";
    let spans = split_statements(sql);
    assert_eq!(spans.len(), 2);
    assert_eq!(&sql[spans[0].start..spans[0].end], "SELECT 1");
    assert_eq!(&sql[spans[1].start..spans[1].end], "SELECT 2");
}

#[test]
fn does_not_split_semicolons_inside_strings_and_identifiers() {
    let sql = "SELECT 'a;b', \"c;d\" FROM t; SELECT 2";
    let spans = split_statements(sql);
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].sql, "SELECT 'a;b', \"c;d\" FROM t");
    assert_eq!(spans[1].sql, "SELECT 2");
}

#[test]
fn handles_doubled_and_escaped_quotes() {
    assert_eq!(split_statements("SELECT 'it''s; fine'; SELECT 2").len(), 2);
    assert_eq!(split_statements("SELECT E'it\\'s; fine'; SELECT 2").len(), 2);
    assert_eq!(split_statements("SELECT \"we;\"\"ird\"; SELECT 2").len(), 2);
}

#[test]
fn does_not_split_semicolons_inside_dollar_quoted_bodies() {
    let sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END; $$ LANGUAGE plpgsql; SELECT 1";
    let spans = split_statements(sql);
    assert_eq!(spans.len(), 2);
    assert!(spans[0].sql.contains("PERFORM 1; PERFORM 2;"));
    assert_eq!(spans[1].sql, "SELECT 1");

    let tagged = "SELECT $body$ a; b $body$; SELECT 2";
    assert_eq!(split_statements(tagged).len(), 2);
}

#[test]
fn does_not_split_inside_comments() {
    assert_eq!(split_statements("SELECT 1 -- ; not a split\n; SELECT 2").len(), 2);
    assert_eq!(split_statements("SELECT /* ; */ 1; SELECT 2").len(), 2);
    assert_eq!(
        split_statements("SELECT /* a /* nested ; */ b */ 1; SELECT 2").len(),
        2
    );
}

#[test]
fn positional_parameters_are_not_dollar_quotes() {
    assert_eq!(split_statements("SELECT $1, $2 FROM t; SELECT 2").len(), 2);
}

#[test]
fn splitter_count_matches_sqlparser_on_wellformed_batches() {
    let dialect = PostgreSqlDialect {};
    for batch in [
        "SELECT 1; SELECT 2; SELECT 3",
        "INSERT INTO t VALUES (1); UPDATE t SET a = 1 WHERE b = 2; DELETE FROM t WHERE c = 3",
        "WITH x AS (SELECT 1) SELECT * FROM x; DROP TABLE t",
    ] {
        let ours = split_statements(batch).len();
        let theirs = Parser::parse_sql(&dialect, batch)
            .expect("batch parses")
            .len();
        assert_eq!(ours, theirs, "batch: {batch}");
    }
}

// ── Classification ────────────────────────────────────────────────────────────

#[test]
fn classifies_reads() {
    for sql in [
        "SELECT 1",
        "select * from t",
        "VALUES (1)",
        "SHOW server_version",
        "EXPLAIN SELECT 1",
        "WITH x AS (SELECT 1) SELECT * FROM x",
    ] {
        assert_eq!(classify_statement(sql), StatementClass::Read, "{sql}");
    }
}

#[test]
fn classifies_writes() {
    for sql in ["INSERT INTO t VALUES (1)", "COPY t FROM STDIN"] {
        assert_eq!(classify_statement(sql), StatementClass::Write, "{sql}");
    }
}

#[test]
fn classifies_destructive_statements() {
    for sql in [
        "UPDATE t SET a = 1 WHERE b = 2",
        "DELETE FROM t WHERE c = 3",
        "DROP TABLE t",
        "TRUNCATE t",
        "ALTER TABLE t ADD COLUMN c int",
    ] {
        assert_eq!(classify_statement(sql), StatementClass::Destructive, "{sql}");
    }
}

#[test]
fn classifies_ddl() {
    for sql in [
        "CREATE TABLE t (id int)",
        "CREATE INDEX i ON t (id)",
        "GRANT SELECT ON t TO u",
        "REVOKE SELECT ON t FROM u",
        "COMMENT ON TABLE t IS 'x'",
        "SET search_path TO public",
    ] {
        assert_eq!(classify_statement(sql), StatementClass::Ddl, "{sql}");
    }
}

#[test]
fn cte_wrapped_dml_is_destructive_not_read() {
    assert_eq!(
        classify_statement("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"),
        StatementClass::Destructive
    );
    assert_eq!(
        classify_statement("WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u"),
        StatementClass::Destructive
    );
}

#[test]
fn unknown_on_parse_failure_multi_statement_and_explain_analyze() {
    assert_eq!(classify_statement("SELCT 1"), StatementClass::Unknown);
    assert_eq!(classify_statement(""), StatementClass::Unknown);
    assert_eq!(
        classify_statement("SELECT 1; SELECT 2"),
        StatementClass::Unknown
    );
    // `EXPLAIN ANALYZE` executes its inner statement — fail-safe.
    assert_eq!(
        classify_statement("EXPLAIN ANALYZE DELETE FROM t"),
        StatementClass::Unknown
    );
}

#[test]
fn keywords_are_case_insensitive_and_leading_comments_are_ignored() {
    assert_eq!(classify_statement("  select 1  "), StatementClass::Read);
    assert_eq!(
        classify_statement("/* hi */ INSERT INTO t VALUES (1)"),
        StatementClass::Write
    );
    assert_eq!(
        classify_statement("-- hi\nDROP TABLE t"),
        StatementClass::Destructive
    );
}

#[test]
fn select_into_is_never_a_read() {
    assert_ne!(
        classify_statement("SELECT a INTO new_table FROM t"),
        StatementClass::Read
    );
    // A column whose name merely starts with `into` is still a read.
    assert_eq!(
        classify_statement("SELECT into_col FROM t"),
        StatementClass::Read
    );
}

// ── Hash + preview ────────────────────────────────────────────────────────────

#[test]
fn statement_hash_is_stable_and_discriminating() {
    assert_eq!(statement_hash("SELECT 1"), statement_hash("SELECT 1"));
    assert_ne!(statement_hash("SELECT 1"), statement_hash("SELECT 2"));
    assert_eq!(statement_hash("DROP TABLE t").len(), 16);
}

#[test]
fn preview_trims_and_ellipsizes() {
    assert_eq!(preview("  SELECT 1  "), "SELECT 1");
    let long = "a".repeat(PREVIEW_LIMIT + 10);
    let bounded = preview(&long);
    assert!(bounded.ends_with('…'));
    assert_eq!(bounded.chars().count(), PREVIEW_LIMIT + 1);
}
