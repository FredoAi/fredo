//! REQ-4: completeWhen expression parsing and evaluation.
//!
//! Supports operators: ===, !==, >=, <=, >, <, exists, !exists
//!
//! Expression syntax:
//! - `<field> === '<value>'` — string equality
//! - `<field> !== '<value>'` — string inequality
//! - `<field> >= <number>`   — numeric greater-or-equal
//! - `<field> <= <number>`   — numeric less-or-equal
//! - `<field> > <number>`    — numeric greater-than
//! - `<field> < <number>`    — numeric less-than
//! - `exists <field>`        — field exists (any truthy value)
//! - `!exists <field>`       — field does not exist
//!
//! String values must be single-quoted. Numeric values are plain numbers.
//! The field name is the first whitespace-delimited token before the operator
//! (for comparison ops) or after the operator (for exists/!exists).

use std::collections::HashMap;
use crate::infrastructure::comm::contract::types::CompleteWhenExpr;

/// Parse a `completeWhen` expression string into a `CompleteWhenExpr`.
///
/// # Errors
/// Returns a descriptive error string if the expression cannot be parsed.
pub fn parse_complete_when(expr: &str) -> Result<CompleteWhenExpr, String> {
    let expr = expr.trim();

    if expr.is_empty() {
        return Err("completeWhen expression is empty".to_string());
    }

    // ── exists <field> ────────────────────────────────────────────────────
    if let Some(rest) = expr.strip_prefix("exists ") {
        let field = rest.trim();
        if field.is_empty() || field.contains(' ') {
            return Err(format!("Invalid field name after 'exists': '{rest}'"));
        }
        return Ok(CompleteWhenExpr::Exists {
            field: field.to_string(),
        });
    }

    // ── !exists <field> ────────────────────────────────────────────────────
    if let Some(rest) = expr.strip_prefix("!exists ") {
        let field = rest.trim();
        if field.is_empty() || field.contains(' ') {
            return Err(format!("Invalid field name after '!exists': '{rest}'"));
        }
        return Ok(CompleteWhenExpr::NotExists {
            field: field.to_string(),
        });
    }

    // ── <field> <op> <value> ─────────────────────────────────────────────────
    let operators = ["===", "!==", ">=", "<=", ">", "<"];
    // Find the first operator occurrence
    let mut best_pos: Option<usize> = None;
    let mut best_op: &str = "";
    for op in &operators {
        if let Some(pos) = expr.find(op) {
            // Must not be preceded by an operator character (avoid matching >= in >=3)
            let prev_char = if pos > 0 {
                expr.as_bytes()[pos - 1] as char
            } else {
                ' ' // pretend whitespace before start
            };
            // Only valid if preceded by whitespace or start of string
            if prev_char.is_whitespace() || pos == 0 {
                match best_pos {
                    None => {
                        best_pos = Some(pos);
                        best_op = op;
                    }
                    Some(prev_pos) if pos < prev_pos => {
                        best_pos = Some(pos);
                        best_op = op;
                    }
                    _ => {}
                }
            }
        }
    }

    match best_pos {
        Some(pos) => {
            let field = expr[..pos].trim().to_string();
            if field.is_empty() {
                return Err(format!(
                    "Missing field before operator '{best_op}' in: '{expr}'"
                ));
            }
            let value_str = expr[pos + best_op.len()..].trim().to_string();
            if value_str.is_empty() {
                return Err(format!(
                    "Missing value after operator '{best_op}' in: '{expr}'"
                ));
            }

            // Strip surrounding quotes for string values
            let value = if (value_str.starts_with('\'') && value_str.ends_with('\''))
                || (value_str.starts_with('"') && value_str.ends_with('"'))
            {
                if value_str.len() < 2 {
                    return Err(format!("Empty quoted value in: '{expr}'"));
                }
                value_str[1..value_str.len() - 1].to_string()
            } else {
                value_str
            };

            if best_op == "===" {
                Ok(CompleteWhenExpr::Equals { field, value })
            } else if best_op == "!==" {
                Ok(CompleteWhenExpr::NotEquals { field, value })
            } else if best_op == ">=" {
                Ok(CompleteWhenExpr::GreaterThanOrEqual { field, value })
            } else if best_op == "<=" {
                Ok(CompleteWhenExpr::LessThanOrEqual { field, value })
            } else if best_op == ">" {
                Ok(CompleteWhenExpr::GreaterThan { field, value })
            } else if best_op == "<" {
                Ok(CompleteWhenExpr::LessThan { field, value })
            } else {
                Err(format!("Unknown operator '{best_op}' in: '{expr}'"))
            }
        }
        None => Err(format!(
            "Cannot parse completeWhen expression: '{expr}' — expected \
             <field> <op> <value> or exists/!exists <field>"
        )),
    }
}

/// Evaluate a `CompleteWhenExpr` against the accumulated payload.
pub fn evaluate_complete_when(
    expr: &CompleteWhenExpr,
    payload: &HashMap<String, serde_json::Value>,
) -> bool {
    match expr {
        CompleteWhenExpr::Exists { field } => payload.contains_key(field),
        CompleteWhenExpr::NotExists { field } => !payload.contains_key(field),

        CompleteWhenExpr::Equals { field, value } => payload
            .get(field)
            .and_then(value_as_string)
            .map(|s| s == *value)
            .unwrap_or(false),

        CompleteWhenExpr::NotEquals { field, value } => payload
            .get(field)
            .and_then(value_as_string)
            .map(|s| s != *value)
            .unwrap_or(true), // If field missing, not-equals is considered true

        CompleteWhenExpr::GreaterThan { field, value } => {
            compare_numeric(payload, field, value, |a, b| a > b)
        }
        CompleteWhenExpr::GreaterThanOrEqual { field, value } => {
            compare_numeric(payload, field, value, |a, b| a >= b)
        }
        CompleteWhenExpr::LessThan { field, value } => {
            compare_numeric(payload, field, value, |a, b| a < b)
        }
        CompleteWhenExpr::LessThanOrEqual { field, value } => {
            compare_numeric(payload, field, value, |a, b| a <= b)
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn value_as_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn compare_numeric<F: Fn(f64, f64) -> bool>(
    payload: &HashMap<String, serde_json::Value>,
    field: &str,
    value_str: &str,
    cmp: F,
) -> bool {
    let field_val = match payload.get(field) {
        Some(v) => v,
        None => return false,
    };

    let a = match field_val.as_f64() {
        Some(n) => n,
        None => {
            // Try parsing the string representation
            match value_as_string(field_val) {
                Some(s) => s.parse::<f64>().unwrap_or(f64::NAN),
                None => return false,
            }
        }
    };

    let b = match value_str.parse::<f64>() {
        Ok(n) => n,
        Err(_) => return false,
    };

    cmp(a, b)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_payload(pairs: Vec<(&str, serde_json::Value)>) -> HashMap<String, serde_json::Value> {
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    // ── parse ─────────────────────────────────────────────────────────────

    #[test]
    fn parse_equals_with_quoted_value() {
        let expr = parse_complete_when("state === 'Response'").unwrap();
        match expr {
            CompleteWhenExpr::Equals { field, value } => {
                assert_eq!(field, "state");
                assert_eq!(value, "Response");
            }
            _ => panic!("Expected Equals"),
        }
    }

    #[test]
    fn parse_not_equals_with_quoted_value() {
        let expr = parse_complete_when("state !== 'Init'").unwrap();
        match expr {
            CompleteWhenExpr::NotEquals { field, value } => {
                assert_eq!(field, "state");
                assert_eq!(value, "Init");
            }
            _ => panic!("Expected NotEquals"),
        }
    }

    #[test]
    fn parse_exists() {
        let expr = parse_complete_when("exists payload.result").unwrap();
        match expr {
            CompleteWhenExpr::Exists { field } => {
                assert_eq!(field, "payload.result");
            }
            _ => panic!("Expected Exists"),
        }
    }

    #[test]
    fn parse_not_exists() {
        let expr = parse_complete_when("!exists payload.error").unwrap();
        match expr {
            CompleteWhenExpr::NotExists { field } => {
                assert_eq!(field, "payload.error");
            }
            _ => panic!("Expected NotExists"),
        }
    }

    #[test]
    fn parse_greater_than() {
        let expr = parse_complete_when("progress > 0.5").unwrap();
        match expr {
            CompleteWhenExpr::GreaterThan { field, value } => {
                assert_eq!(field, "progress");
                assert_eq!(value, "0.5");
            }
            _ => panic!("Expected GreaterThan"),
        }
    }

    #[test]
    fn parse_greater_than_or_equal() {
        let expr = parse_complete_when("count >= 10").unwrap();
        match expr {
            CompleteWhenExpr::GreaterThanOrEqual { field, value } => {
                assert_eq!(field, "count");
                assert_eq!(value, "10");
            }
            _ => panic!("Expected GreaterThanOrEqual"),
        }
    }

    #[test]
    fn parse_less_than() {
        let expr = parse_complete_when("temperature < 100").unwrap();
        match expr {
            CompleteWhenExpr::LessThan { field, value } => {
                assert_eq!(field, "temperature");
                assert_eq!(value, "100");
            }
            _ => panic!("Expected LessThan"),
        }
    }

    #[test]
    fn parse_less_than_or_equal() {
        let expr = parse_complete_when("score <= 99.9").unwrap();
        match expr {
            CompleteWhenExpr::LessThanOrEqual { field, value } => {
                assert_eq!(field, "score");
                assert_eq!(value, "99.9");
            }
            _ => panic!("Expected LessThanOrEqual"),
        }
    }

    #[test]
    fn parse_numeric_value_no_quotes() {
        let expr = parse_complete_when("progress >= 0.8").unwrap();
        match expr {
            CompleteWhenExpr::GreaterThanOrEqual { value, .. } => {
                assert_eq!(value, "0.8");
            }
            _ => panic!("Expected GreaterThanOrEqual"),
        }
    }

    #[test]
    fn parse_empty_expression_error() {
        let result = parse_complete_when("");
        assert!(result.is_err());
    }

    #[test]
    fn parse_invalid_expression_error() {
        let result = parse_complete_when("just a field");
        assert!(result.is_err());
    }

    #[test]
    fn parse_no_field_before_op_error() {
        let result = parse_complete_when("=== 'value'");
        assert!(result.is_err());
    }

    // ── evaluate ──────────────────────────────────────────────────────────

    #[test]
    fn evaluate_equals_match() {
        let expr = parse_complete_when("state === 'Response'").unwrap();
        let payload = make_payload(vec![("state", serde_json::json!("Response"))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_equals_no_match() {
        let expr = parse_complete_when("state === 'Response'").unwrap();
        let payload = make_payload(vec![("state", serde_json::json!("Init"))]);
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_not_equals_match() {
        let expr = parse_complete_when("state !== 'Init'").unwrap();
        let payload = make_payload(vec![("state", serde_json::json!("Response"))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_exists_true() {
        let expr = parse_complete_when("exists payload.result").unwrap();
        let payload = make_payload(vec![("payload.result", serde_json::json!("data"))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_exists_false() {
        let expr = parse_complete_when("exists payload.result").unwrap();
        let payload: HashMap<String, serde_json::Value> = HashMap::new();
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_not_exists_match() {
        let expr = parse_complete_when("!exists payload.error").unwrap();
        let payload: HashMap<String, serde_json::Value> = HashMap::new();
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_not_exists_false() {
        let expr = parse_complete_when("!exists payload.error").unwrap();
        let payload = make_payload(vec![("payload.error", serde_json::json!("timeout"))]);
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_greater_than_true() {
        let expr = parse_complete_when("progress > 0.5").unwrap();
        let payload = make_payload(vec![("progress", serde_json::json!(0.8))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_greater_than_false() {
        let expr = parse_complete_when("progress > 0.5").unwrap();
        let payload = make_payload(vec![("progress", serde_json::json!(0.3))]);
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_less_than_true() {
        let expr = parse_complete_when("count < 10").unwrap();
        let payload = make_payload(vec![("count", serde_json::json!(5))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_less_than_false() {
        let expr = parse_complete_when("count < 10").unwrap();
        let payload = make_payload(vec![("count", serde_json::json!(15))]);
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_missing_field_not_equals_treated_true() {
        let expr = parse_complete_when("result !== 'done'").unwrap();
        let payload: HashMap<String, serde_json::Value> = HashMap::new();
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_missing_field_equals_false() {
        let expr = parse_complete_when("result === 'done'").unwrap();
        let payload: HashMap<String, serde_json::Value> = HashMap::new();
        assert!(!evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_greater_or_equal_equal() {
        let expr = parse_complete_when("score >= 100").unwrap();
        let payload = make_payload(vec![("score", serde_json::json!(100))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_less_or_equal_equal() {
        let expr = parse_complete_when("score <= 0").unwrap();
        let payload = make_payload(vec![("score", serde_json::json!(0))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }

    #[test]
    fn evaluate_numeric_from_string_value() {
        let expr = parse_complete_when("progress > 0.5").unwrap();
        let payload = make_payload(vec![("progress", serde_json::json!("0.75"))]);
        assert!(evaluate_complete_when(&expr, &payload));
    }
}
