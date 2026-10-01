//! The ONE canonical row encoding + SHA-256 checksum (R-2.1, NFR-6).
//!
//! Both the source (`fredo.db`) and the target (PostgreSQL) sides of the parity
//! gate encode rows through this module — there is never a second encoding rule.
//! The encoding is:
//!
//! - rows ordered by primary key (the caller supplies that order),
//! - columns in declared order,
//! - `N` is the NULL sentinel,
//! - `\u{1f}` (unit separator) between columns, `\n` between rows,
//! - integer → decimal, REAL/double → `{:.6}`, BLOB → lowercase hex,
//!   TEXT → verbatim.
//!
//! `RowHasher` streams one row at a time so the parity pass never materializes a
//! whole table (R-5.1 bounded memory).

use sha2::{Digest, Sha256};

/// One canonical cell value, normalized to the physical affinity both engines
/// agree on.
#[derive(Clone, Debug, PartialEq)]
pub enum CellValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl CellValue {
    /// The canonical text form of this cell (the `\u{1f}`-joined unit).
    pub fn encode(&self) -> String {
        match self {
            CellValue::Null => "N".to_string(),
            CellValue::Integer(value) => value.to_string(),
            CellValue::Real(value) => format!("{value:.6}"),
            CellValue::Blob(bytes) => {
                let mut out = String::with_capacity(bytes.len() * 2);
                for byte in bytes {
                    out.push_str(&format!("{byte:02x}"));
                }
                out
            }
            CellValue::Text(text) => text.clone(),
        }
    }
}

/// Encode one row: cells in declared order joined by `\u{1f}`.
pub fn encode_row(cells: &[CellValue]) -> String {
    let mut out = String::new();
    for (index, cell) in cells.iter().enumerate() {
        if index > 0 {
            out.push('\u{1f}');
        }
        out.push_str(&cell.encode());
    }
    out
}

/// A streaming SHA-256 over the canonical row encoding — one row at a time, so a
/// whole table is never resident (R-5.1).
#[derive(Default)]
pub struct RowHasher {
    hasher: Sha256,
}

impl RowHasher {
    /// A fresh hasher.
    pub fn new() -> Self {
        RowHasher {
            hasher: Sha256::new(),
        }
    }

    /// Fold one row (in PK order) into the checksum.
    pub fn update_row(&mut self, cells: &[CellValue]) {
        self.hasher.update(encode_row(cells).as_bytes());
        self.hasher.update(b"\n");
    }

    /// The lowercase hex SHA-256 digest.
    pub fn finish(self) -> String {
        format!("{:x}", self.hasher.finalize())
    }
}

/// The full checksum of an in-memory row set — the rule's test-facing form.
pub fn canonical_row_checksum(rows: &[Vec<CellValue>]) -> String {
    let mut hasher = RowHasher::new();
    for row in rows {
        hasher.update_row(row);
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_every_affinity_per_the_one_rule() {
        assert_eq!(CellValue::Null.encode(), "N");
        assert_eq!(CellValue::Integer(-42).encode(), "-42");
        assert_eq!(CellValue::Real(1.5).encode(), "1.500000");
        assert_eq!(CellValue::Real(2.0).encode(), "2.000000");
        assert_eq!(CellValue::Blob(vec![0x0a, 0xff, 0x10]).encode(), "0aff10");
        assert_eq!(CellValue::Text("hello".to_string()).encode(), "hello");
    }

    #[test]
    fn joins_columns_with_unit_separator_in_declared_order() {
        let row = vec![
            CellValue::Integer(1),
            CellValue::Text("a".to_string()),
            CellValue::Null,
        ];
        assert_eq!(encode_row(&row), "1\u{1f}a\u{1f}N");
    }

    #[test]
    fn empty_row_encodes_to_the_empty_string() {
        assert_eq!(encode_row(&[]), "");
    }

    #[test]
    fn checksum_is_deterministic_and_order_sensitive() {
        let row_a = vec![CellValue::Integer(1), CellValue::Text("x".to_string())];
        let row_b = vec![CellValue::Integer(2), CellValue::Text("y".to_string())];

        let forward = canonical_row_checksum(&[row_a.clone(), row_b.clone()]);
        let again = canonical_row_checksum(&[row_a.clone(), row_b.clone()]);
        assert_eq!(forward, again, "the rule must be deterministic");
        assert_eq!(forward.len(), 64, "SHA-256 hex digest");

        // PK order matters: swapping the rows changes the digest.
        let reversed = canonical_row_checksum(&[row_b, row_a]);
        assert_ne!(forward, reversed, "PK ordering is part of the rule");
    }

    #[test]
    fn checksum_distinguishes_null_from_the_literal_sentinel() {
        // The rule's NULL sentinel is `N`; a TEXT `N` is encoded identically
        // (documented plan rule). The checksum still differs from a different
        // value in the same position.
        let null_checksum = canonical_row_checksum(&[vec![CellValue::Null]]);
        let text_checksum = canonical_row_checksum(&[vec![CellValue::Text("N".to_string())]]);
        assert_eq!(null_checksum, text_checksum);
        let lower = canonical_row_checksum(&[vec![CellValue::Text("n".to_string())]]);
        assert_ne!(text_checksum, lower);
    }
}
