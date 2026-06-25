//! CompleteWhen expression parser and evaluator.
//!
//! Parses a string DSL into a CompleteWhenExpr AST and evaluates it
//! against accumulated contract state.
//!
//! Supported operators:
//! - `field.path === "value"` — equality (string or number)
//! - `field.path !== "value"` — inequality
//! - `field.path exists` — field is present and non-null
//! - `field.path !exists` — field is absent or null

use std::collections::HashMap;
use serde_json::Value;

use super::types::CompleteWhenExpr;

/// Parse a `completeWhen` DSL string into a CompleteWhenExpr AST.
///
/// # Grammar
///
/// ```text
/// expr     = equality | not_equality | exists | not_exists
/// equality = field "===" value
/// not_eq   = field "!==" value
/// exists   = field "exists"
/// not_ex   = field "!exists"
/// field    = [a-zA-Z0-9_.]+
/// value    = '"' [^"]* '"' | [0-9.]+
/// ```
pub fn parse_complete_when(input: &str) -> Result<CompleteWhenExpr, String> {
    let trimmed = input.trim();

    // Try to find the last occurrence of operators in order (longest first)
    if let Some(pos) = trimmed.rfind("!==") {
        let field = trimmed[..pos].trim();
        let value = trimmed[pos + 3..].trim().trim_matches('"');
        if field.is_empty() {
            return Err("Empty field path in '!==' expression".to_string());
        }
        return Ok(CompleteWhenExpr::NotEquals(field.to_string(), value.to_string()));
    }

    if let Some(pos) = trimmed.rfind("===") {
        let field = trimmed[..pos].trim();
        let value = trimmed[pos + 3..].trim().trim_matches('"');
        if field.is_empty() {
            return Err("Empty field path in '===' expression".to_string());
        }
        return Ok(CompleteWhenExpr::Equals(field.to_string(), value.to_string()));
    }

    if trimmed.ends_with("!exists") {
        let field = trimmed[..trimmed.len() - "!exists".len()].trim();
        if field.is_empty() {
            return Err("Empty field path in '!exists' expression".to_string());
        }
        return Ok(CompleteWhenExpr::NotExists(field.to_string()));
    }

    if trimmed.ends_with("exists") {
        let field = trimmed[..trimmed.len() - "exists".len()].trim();
        if field.is_empty() {
            return Err("Empty field path in 'exists' expression".to_string());
        }
        return Ok(CompleteWhenExpr::Exists(field.to_string()));
    }

    Err(format!(
        "Unrecognized completeWhen expression: '{}'. Expected one of: ===, !==, exists, !exists",
        trimmed
    ))
}

/// Evaluate a CompleteWhenExpr against the accumulated fields.
///
/// The field path is resolved as a dot-path into the accumulated fields map
/// (not into the original FredoEvent).
pub fn evaluate_complete_when(
    expr: &CompleteWhenExpr,
    fields: &HashMap<String, Value>,
) -> bool {
    match expr {
        CompleteWhenExpr::Equals(path, expected) => {
            match resolve_field(fields, path) {
                Some(Value::String(s)) => &s == expected,
                Some(Value::Number(n)) => n.to_string() == *expected,
                Some(Value::Bool(b)) => b.to_string() == *expected,
                _ => false,
            }
        }
        CompleteWhenExpr::NotEquals(path, expected) => {
            !evaluate_complete_when(&CompleteWhenExpr::Equals(path.clone(), expected.clone()), fields)
        }
        CompleteWhenExpr::Exists(path) => {
            resolve_field(fields, path).is_some()
        }
        CompleteWhenExpr::NotExists(path) => {
            resolve_field(fields, path).is_none()
        }
    }
}

/// Resolve a dot-path into a HashMap of field values.
///
/// The path is relative to the top-level keys of the HashMap.
/// E.g. "status.state" would look up fields["status"] and then
/// try to navigate into it as a nested object.
fn resolve_field(fields: &HashMap<String, Value>, path: &str) -> Option<Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current: Option<&Value> = None;

    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            current = fields.get(*part);
        } else {
            match current? {
                Value::Object(map) => {
                    current = map.get(*part);
                }
                _ => return None,
            }
        }
    }

    current.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_equals_with_quoted_value() {
        let expr = parse_complete_when(r#"status === "complete""#).unwrap();
        assert_eq!(expr, CompleteWhenExpr::Equals("status".into(), "complete".into()));
    }

    #[test]
    fn parse_equals_with_numeric_value() {
        let expr = parse_complete_when("progress === 100").unwrap();
        assert_eq!(expr, CompleteWhenExpr::Equals("progress".into(), "100".into()));
    }

    #[test]
    fn parse_not_equals() {
        let expr = parse_complete_when(r#"state !== "error""#).unwrap();
        assert_eq!(expr, CompleteWhenExpr::NotEquals("state".into(), "error".into()));
    }

    #[test]
    fn parse_exists() {
        let expr = parse_complete_when("result exists").unwrap();
        assert_eq!(expr, CompleteWhenExpr::Exists("result".into()));
    }

    #[test]
    fn parse_not_exists() {
        let expr = parse_complete_when("error !exists").unwrap();
        assert_eq!(expr, CompleteWhenExpr::NotExists("error".into()));
    }

    #[test]
    fn parse_dot_path_field() {
        let expr = parse_complete_when(r#"status.state === "done""#).unwrap();
        assert_eq!(
            expr,
            CompleteWhenExpr::Equals("status.state".into(), "done".into())
        );
    }

    #[test]
    fn parse_empty_field_returns_error() {
        assert!(parse_complete_when("=== \"value\"").is_err());
        assert!(parse_complete_when("exists").is_err());
        assert!(parse_complete_when("!exists").is_err());
    }

    #[test]
    fn parse_invalid_expression() {
        assert!(parse_complete_when("foo bar baz").is_err());
        assert!(parse_complete_when("").is_err());
    }

    #[test]
    fn evaluate_equals_string_match() {
        let mut fields = HashMap::new();
        fields.insert("status".into(), Value::String("complete".into()));
        let expr = CompleteWhenExpr::Equals("status".into(), "complete".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_equals_string_no_match() {
        let mut fields = HashMap::new();
        fields.insert("status".into(), Value::String("error".into()));
        let expr = CompleteWhenExpr::Equals("status".into(), "complete".into());
        assert!(!evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_equals_number_match() {
        let mut fields = HashMap::new();
        fields.insert("progress".into(), Value::Number(serde_json::Number::from(100)));
        let expr = CompleteWhenExpr::Equals("progress".into(), "100".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_not_equals() {
        let mut fields = HashMap::new();
        fields.insert("state".into(), Value::String("running".into()));
        let expr = CompleteWhenExpr::NotEquals("state".into(), "error".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_exists_true() {
        let mut fields = HashMap::new();
        fields.insert("result".into(), Value::String("ok".into()));
        let expr = CompleteWhenExpr::Exists("result".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_exists_false() {
        let fields = HashMap::new();
        let expr = CompleteWhenExpr::Exists("result".into());
        assert!(!evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_not_exists_false() {
        let mut fields = HashMap::new();
        fields.insert("result".into(), Value::String("ok".into()));
        let expr = CompleteWhenExpr::NotExists("result".into());
        assert!(!evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_not_exists_true() {
        let fields = HashMap::new();
        let expr = CompleteWhenExpr::NotExists("error".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_dot_path_resolves_nested() {
        let mut fields = HashMap::new();
        let mut inner = serde_json::Map::new();
        inner.insert("state".into(), Value::String("done".into()));
        fields.insert("status".into(), Value::Object(inner));
        let expr = CompleteWhenExpr::Equals("status.state".into(), "done".into());
        assert!(evaluate_complete_when(&expr, &fields));
    }

    #[test]
    fn evaluate_field_not_found_returns_false() {
        let fields = HashMap::new();
        let expr = CompleteWhenExpr::Equals("nonexistent".into(), "value".into());
        assert!(!evaluate_complete_when(&expr, &fields));
    }
}
