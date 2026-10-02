//! Statement splitting + classification (Spec #2950, ST-4).
//!
//! Two pure, DB-free operations back the safety gates:
//!
//! # Splitting
//!
//! [`split_statements`] is a quote/comment/dollar-quote-aware scanner over the
//! raw SQL. It returns each statement's **original** text with exact byte
//! offsets, so the statement that reaches the server is byte-identical to what
//! the user authored or selected (R-3.2). The scanner understands:
//!
//! * single-quoted strings (`''` doubling and backslash escapes — covers `E'…'`),
//! * double-quoted identifiers (`""` doubling),
//! * dollar-quoted bodies (`$tag$ … $tag$`) — semicolons inside a PL/pgSQL body
//!   are **not** statement separators,
//! * line (`--`) and nested block (`/* … */`) comments.
//!
//! Trailing separators, blank statements and comment-only tails are dropped, so
//! `SELECT 1; -- done` is exactly one statement.
//!
//! # Classification
//!
//! [`classify_statement`] parses **one** statement with `sqlparser`'s PostgreSQL
//! dialect and maps it onto the frozen [`StatementClass`] vocabulary. A
//! `WITH` statement is inspected recursively, so a CTE-wrapped data-modifying
//! statement (`WITH d AS (DELETE … RETURNING *) SELECT …`) classifies as
//! `destructive`, never `read`. Anything the parser cannot represent is
//! [`StatementClass::Unknown`] — the fail-safe class (refused outright on a
//! read-only connection and confirmation-gated on a read-write one, R-5.2/R-5.3).
//!
//! `sqlparser` is authoritative for classification and for the statement grammar;
//! the scanner supplies the byte-exact spans. `tests_classify.rs` cross-checks the
//! scanner's statement count against `sqlparser` on well-formed batches.

use sqlparser::ast::Statement;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use crate::features::db_client::types::StatementClass;

#[cfg(test)]
#[path = "tests_classify.rs"]
mod tests_classify;

/// Maximum characters kept in a [`preview`] before it is ellipsized.
pub const PREVIEW_LIMIT: usize = 200;

/// One statement located in the source SQL, with byte offsets into that source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatementSpan {
    /// The exact (trimmed) statement text.
    pub sql: String,
    /// Byte offset of the first character of [`StatementSpan::sql`].
    pub start: usize,
    /// Byte offset one past the last character of [`StatementSpan::sql`].
    pub end: usize,
}

/// Split raw SQL into statements at top-level semicolons (R-5.4/R-3.6).
///
/// Empty/comment-only fragments are skipped; the returned spans carry the exact
/// original text so execution never re-serializes user SQL.
pub fn split_statements(sql: &str) -> Vec<StatementSpan> {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut spans = Vec::new();
    let mut start = 0usize;
    let mut has_code = false;
    let mut i = 0usize;

    while i < len {
        match bytes[i] {
            b'-' if i + 1 < len && bytes[i + 1] == b'-' => {
                i += 2;
                while i < len && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < len && bytes[i + 1] == b'*' => {
                let mut depth = 1usize;
                i += 2;
                while i < len && depth > 0 {
                    if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                        depth += 1;
                        i += 2;
                    } else if i + 1 < len && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            b'\'' => {
                has_code = true;
                i += 1;
                while i < len {
                    if bytes[i] == b'\\' && i + 1 < len {
                        i += 2;
                    } else if bytes[i] == b'\'' {
                        if i + 1 < len && bytes[i + 1] == b'\'' {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'"' => {
                has_code = true;
                i += 1;
                while i < len {
                    if bytes[i] == b'"' {
                        if i + 1 < len && bytes[i + 1] == b'"' {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b'$' => {
                if let Some(tag_end) = dollar_tag_end(bytes, i) {
                    has_code = true;
                    let tag = &sql[i..tag_end];
                    i = tag_end;
                    match find_subslice(&bytes[i..], tag.as_bytes()) {
                        Some(offset) => i += offset + tag.len(),
                        None => i = len,
                    }
                } else {
                    has_code = true;
                    i += 1;
                }
            }
            b';' => {
                if has_code {
                    push_span(sql, &mut spans, start, i);
                }
                i += 1;
                start = i;
                has_code = false;
            }
            byte => {
                if !byte.is_ascii_whitespace() {
                    has_code = true;
                }
                i += 1;
            }
        }
    }

    if has_code {
        push_span(sql, &mut spans, start, len);
    }
    spans
}

/// Classify one statement into the frozen [`StatementClass`] vocabulary
/// (R-5.2/R-5.3). A parse failure, a multi-statement string, or an unmodelled
/// statement is [`StatementClass::Unknown`] (fail-safe).
pub fn classify_statement(sql: &str) -> StatementClass {
    let dialect = PostgreSqlDialect {};
    match Parser::parse_sql(&dialect, sql) {
        Ok(statements) if statements.len() == 1 => classify_ast(&statements[0]),
        _ => StatementClass::Unknown,
    }
}

/// Deterministic statement hash used by the confirmation round-trip (R-5.3).
///
/// FNV-1a 64-bit over the exact statement bytes; stable across processes and
/// Rust versions (unlike the std `DefaultHasher`).
pub fn statement_hash(sql: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in sql.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// A bounded, single-line-ish preview of a statement for the confirmation UI.
pub fn preview(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.chars().count() <= PREVIEW_LIMIT {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(PREVIEW_LIMIT).collect();
    out.push('…');
    out
}

// ── Internals ─────────────────────────────────────────────────────────────────

fn classify_ast(statement: &Statement) -> StatementClass {
    // `EXPLAIN ANALYZE` executes its inner statement; `EXPLAIN` alone does not.
    // The former is fail-safe `unknown`; the latter is a read.
    if let Statement::Explain { analyze, .. } = statement {
        return if *analyze {
            StatementClass::Unknown
        } else {
            StatementClass::Read
        };
    }

    // A `WITH` statement: a data-modifying CTE wins over the outer body, so a
    // CTE-wrapped DML is never mistaken for a read.
    if let Statement::Query(query) = statement {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                let class = classify_statement(&cte.query.to_string());
                if class != StatementClass::Read {
                    return class;
                }
            }
        }
        return classify_keyword(&query.body.to_string());
    }

    classify_keyword(&statement.to_string())
}

fn classify_keyword(sql: &str) -> StatementClass {
    match first_keyword(sql).as_deref() {
        // `SELECT … INTO <table>` creates a table — a non-read, never allowed on
        // a read-only connection (R-5.2).
        Some("SELECT") => {
            if contains_word(sql, "INTO") {
                StatementClass::Ddl
            } else {
                StatementClass::Read
            }
        }
        Some("VALUES") | Some("TABLE") | Some("SHOW") | Some("FETCH") => StatementClass::Read,
        Some("INSERT") | Some("COPY") => StatementClass::Write,
        Some("UPDATE") | Some("DELETE") | Some("DROP") | Some("TRUNCATE") | Some("ALTER")
        | Some("MERGE") => StatementClass::Destructive,
        Some("CREATE") | Some("GRANT") | Some("REVOKE") | Some("COMMENT") | Some("ANALYZE")
        | Some("VACUUM") | Some("REINDEX") | Some("CLUSTER") | Some("REFRESH")
        | Some("SECURITY") | Some("SET") | Some("RESET") | Some("DISCARD") | Some("BEGIN")
        | Some("START") | Some("COMMIT") | Some("ROLLBACK") | Some("SAVEPOINT")
        | Some("RELEASE") => StatementClass::Ddl,
        _ => StatementClass::Unknown,
    }
}

/// Whether `word` appears in `sql` on identifier boundaries (case-insensitive).
fn contains_word(sql: &str, word: &str) -> bool {
    let upper = sql.to_ascii_uppercase();
    let mut start = 0usize;
    while let Some(offset) = upper[start..].find(word) {
        let index = start + offset;
        let after = index + word.len();
        let before_ok = index == 0 || !is_ident_byte(upper.as_bytes()[index - 1]);
        let after_ok = after >= upper.len() || !is_ident_byte(upper.as_bytes()[after]);
        if before_ok && after_ok {
            return true;
        }
        start = after;
    }
    false
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The first keyword of `sql`, skipping leading whitespace and comments.
fn first_keyword(sql: &str) -> Option<String> {
    let trimmed = skip_trivia(sql);
    let word: String = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_alphabetic() || *ch == '_')
        .collect();
    if word.is_empty() {
        None
    } else {
        Some(word.to_ascii_uppercase())
    }
}

/// Skip leading whitespace, `--` line comments and `/* … */` block comments.
fn skip_trivia(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            match after.find('\n') {
                Some(index) => {
                    rest = after[index + 1..].trim_start();
                    continue;
                }
                None => return "",
            }
        }
        if let Some(after) = rest.strip_prefix("/*") {
            match after.find("*/") {
                Some(index) => {
                    rest = after[index + 2..].trim_start();
                    continue;
                }
                None => return "",
            }
        }
        return rest;
    }
}

/// If a `$tag$` dollar-quote opener starts at `start`, return the byte index one
/// past its closing `$`. Returns `None` for a positional parameter (`$1`).
fn dollar_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    // An empty tag (`$$`) is valid; a non-empty tag must start with a letter or
    // underscore (so `$1` is a parameter, never a quote).
    if i < bytes.len() && bytes[i].is_ascii_digit() {
        return None;
    }
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'$' {
            return Some(i + 1);
        }
        if byte.is_ascii_alphanumeric() || byte == b'_' {
            i += 1;
        } else {
            return None;
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn push_span(sql: &str, spans: &mut Vec<StatementSpan>, start: usize, end: usize) {
    let slice = &sql[start..end];
    let leading = slice.len() - slice.trim_start().len();
    let trailing = slice.trim_end().len();
    let trimmed_start = start + leading;
    let trimmed_end = start + trailing;
    if trimmed_end <= trimmed_start {
        return;
    }
    spans.push(StatementSpan {
        sql: sql[trimmed_start..trimmed_end].to_string(),
        start: trimmed_start,
        end: trimmed_end,
    });
}
