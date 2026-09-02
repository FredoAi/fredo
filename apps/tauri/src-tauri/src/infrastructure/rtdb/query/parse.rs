//! Hand-rolled recursive-descent parser for the RTDB query language
//! (Spec #2788, P2.1, R-3a) — zero new crate dependencies.
//!
//! Grammar:
//! ```text
//! query     := root args? selection
//! root      := "chat" | "toolUse" | "agentSession"
//! args      := "(" arg ("," arg)* ")"
//! arg       := path op value
//! path      := ident ("." ident)*          ; ANY depth — validated later
//! op        := "=" | ">=" | "<=" | ">" | "<"
//! value     := string | number | "true" | "false" | "null"
//! selection := "{" path ("," path)* "}"    ; 1..N paths, ANY depth
//! ```
//!
//! Dotted paths of any depth are legal SYNTACTICALLY; the schema registry
//! ([`super::schema`]) validates them against row field metadata. Every
//! failure is a [`QueryParseError`] carrying the offending query text so a
//! developer can one-glance-locate the typo.

use super::{CompareOp, EventTypeArg, QueryArg, QuerySpec};

/// Parse failure — carries the offending query text (R-3a).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryParseError {
    pub message: String,
    pub query: String,
}

impl std::fmt::Display for QueryParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} — in: {}", self.message, self.query)
    }
}

impl std::error::Error for QueryParseError {}

/// Parse a query string into a [`QuerySpec`].
pub fn parse(query_text: &str) -> Result<QuerySpec, QueryParseError> {
    Parser::new(query_text).parse_query()
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
    query: String,
}

impl Parser {
    fn new(query_text: &str) -> Self {
        Parser {
            chars: query_text.chars().collect(),
            pos: 0,
            query: query_text.to_string(),
        }
    }

    fn err(&self, message: impl Into<String>) -> QueryParseError {
        QueryParseError {
            message: message.into(),
            query: self.query.clone(),
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), QueryParseError> {
        if self.eat(expected) {
            Ok(())
        } else {
            Err(self.err(format!(
                "expected '{}' at position {}, found {}",
                expected,
                self.pos,
                match self.peek() {
                    Some(c) => format!("'{}'", c),
                    None => "end of query".to_string(),
                }
            )))
        }
    }

    /// Precondition: not at whitespace. Returns the raw keyword.
    fn read_ident(&mut self) -> Result<String, QueryParseError> {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '_') {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(self.err(format!(
                "expected identifier at position {}, found {}",
                start,
                match self.peek() {
                    Some(c) => format!("'{}'", c),
                    None => "end of query".to_string(),
                }
            )));
        }
        Ok(self.chars[start..self.pos].iter().collect())
    }

    /// `path := ident ("." ident)*` — dotted, any depth.
    fn read_path(&mut self) -> Result<Vec<String>, QueryParseError> {
        let mut segments = vec![self.read_ident()?];
        while self.peek() == Some('.') {
            self.pos += 1;
            segments.push(self.read_ident()?);
        }
        Ok(segments)
    }

    /// Two-char ops first (`>=`, `<=`), then single-char (`=`, `>`, `<`).
    fn read_op(&mut self) -> Result<CompareOp, QueryParseError> {
        let op = match self.peek() {
            Some('=') => CompareOp::Eq,
            Some('>') if self.chars.get(self.pos + 1) == Some(&'=') => CompareOp::Gte,
            Some('>') => CompareOp::Gt,
            Some('<') if self.chars.get(self.pos + 1) == Some(&'=') => CompareOp::Lte,
            Some('<') => CompareOp::Lt,
            other => {
                return Err(self.err(format!(
                    "expected comparison operator (=, >, >=, <, <=) at position {}, found {}",
                    self.pos,
                    match other {
                        Some(c) => format!("'{}'", c),
                        None => "end of query".to_string(),
                    }
                )))
            }
        };
        self.pos += if op == CompareOp::Gte || op == CompareOp::Lte {
            2
        } else {
            1
        };
        Ok(op)
    }

    fn parse_query(&mut self) -> Result<QuerySpec, QueryParseError> {
        self.skip_ws();
        let root_ident = self.read_ident()?;
        let event_type = match root_ident.as_str() {
            "chat" => EventTypeArg::Chat,
            "toolUse" => EventTypeArg::ToolUse,
            "agentSession" => EventTypeArg::AgentSession,
            other => {
                return Err(self.err(format!(
                    "unknown root type '{}' (expected chat, toolUse, or agentSession)",
                    other
                )))
            }
        };

        let mut args = Vec::new();
        self.skip_ws();
        if self.peek() == Some('(') {
            self.pos += 1;
            loop {
                self.skip_ws();
                let field = self.read_path()?;
                self.skip_ws();
                let op = self.read_op()?;
                self.skip_ws();
                let value = self.read_value()?;
                args.push(QueryArg { field, op, value });
                self.skip_ws();
                if self.eat(',') {
                    continue;
                }
                self.expect(')')?;
                break;
            }
        }

        self.skip_ws();
        if self.peek() != Some('{') {
            return Err(self.err(
                "missing selection set '{ field, ... }' after the root type and args",
            ));
        }
        let selection = self.read_selection()?;

        self.skip_ws();
        if self.pos != self.chars.len() {
            return Err(self.err(format!(
                "unexpected trailing input at position {}",
                self.pos
            )));
        }

        Ok(QuerySpec {
            event_type,
            args,
            selection,
        })
    }

    /// `selection := "{" path ("," path)* "}"` — 1..N paths, trailing comma OK.
    fn read_selection(&mut self) -> Result<Vec<Vec<String>>, QueryParseError> {
        self.expect('{')?;
        let mut selection = Vec::new();
        loop {
            self.skip_ws();
            if self.eat('}') {
                break;
            }
            selection.push(self.read_path()?);
            self.skip_ws();
            if self.eat(',') {
                continue;
            }
            self.expect('}')?;
            break;
        }
        if selection.is_empty() {
            return Err(self.err("selection set must name at least one field path"));
        }
        Ok(selection)
    }

    fn read_value(&mut self) -> Result<serde_json::Value, QueryParseError> {
        match self.peek() {
            Some('"') => self.read_string().map(serde_json::Value::String),
            Some(c) if c == '-' || c.is_ascii_digit() => self.read_number(),
            Some('t') => self.expect_keyword("true").map(|_| serde_json::Value::Bool(true)),
            Some('f') => self
                .expect_keyword("false")
                .map(|_| serde_json::Value::Bool(false)),
            Some('n') => self.expect_keyword("null").map(|_| serde_json::Value::Null),
            other => Err(self.err(format!(
                "expected a string, number, true/false, or null literal at position {}, found {}",
                self.pos,
                match other {
                    Some(c) => format!("'{}'", c),
                    None => "end of query".to_string(),
                }
            ))),
        }
    }

    /// Consume the exact keyword and enforce a word boundary.
    fn expect_keyword(&mut self, keyword: &'static str) -> Result<(), QueryParseError> {
        for expected in keyword.chars() {
            if self.bump() != Some(expected) {
                return Err(self.err(format!(
                    "invalid literal at position {} (expected '{}')",
                    self.pos, keyword
                )));
            }
        }
        if matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '_') {
            return Err(self.err(format!(
                "invalid literal at position {} (expected '{}')",
                self.pos, keyword
                )));
        }
        Ok(())
    }

    /// Double-quoted string with JSON-style escapes (\" \\ \/ \b \f \n \r \t
    /// \uXXXX; lone surrogates are rejected).
    fn read_string(&mut self) -> Result<String, QueryParseError> {
        self.expect('"')?;
        let mut out = String::new();
        loop {
            match self.bump() {
                None => return Err(self.err("unterminated string literal")),
                Some('"') => return Ok(out),
                Some('\\') => match self.bump() {
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some('/') => out.push('/'),
                    Some('b') => out.push('\u{0008}'),
                    Some('f') => out.push('\u{000C}'),
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some('u') => {
                        let mut code = 0u32;
                        for _ in 0..4 {
                            let c = self
                                .bump()
                                .and_then(|c| c.to_digit(16))
                                .ok_or_else(|| self.err("invalid \\u escape (need 4 hex digits)"))?;
                            code = code * 16 + c;
                        }
                        let ch = char::from_u32(code)
                            .ok_or_else(|| self.err("invalid \\u escape (lone surrogate)"))?;
                        out.push(ch);
                    }
                    _ => return Err(self.err("invalid escape sequence in string literal")),
                },
                Some(c) => out.push(c),
            }
        }
    }

    /// Bare number: integer (`i64`) or float (`f64`) — `-?\d+(\.\d+)?([eE][+-]?\d+)?`.
    fn read_number(&mut self) -> Result<serde_json::Value, QueryParseError> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        let mut saw_digit = false;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
            saw_digit = true;
        }
        if !saw_digit {
            return Err(self.err(format!(
                "invalid number at position {} (expected digits after '-')",
                start
            )));
        }
        let mut is_float = false;
        if self.peek() == Some('.') {
            is_float = true;
            self.pos += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            is_float = true;
            self.pos += 1;
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '.') {
            return Err(self.err(format!(
                "invalid number at position {} (unexpected character after numeric literal)",
                self.pos
            )));
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        if !is_float {
            if let Ok(i) = text.parse::<i64>() {
                return Ok(serde_json::Value::Number(serde_json::Number::from(i)));
            }
        }
        let f = text
            .parse::<f64>()
            .map_err(|_| self.err(format!("invalid number literal '{}'", text)))?;
        serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .ok_or_else(|| self.err(format!("number literal '{}' out of range", text)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_err_includes(query: &str, needle: &str) {
        let err = parse(query).expect_err(query);
        assert!(
            err.message.contains(needle),
            "query {:?} → message {:?} missing {:?}",
            query,
            err.message,
            needle
        );
        assert_eq!(err.query, query, "error must carry the offending query text");
        assert!(
            err.to_string().contains(query),
            "Display must include the query text for one-glance location"
        );
    }

    #[test]
    fn parses_chat_with_args_and_selection() {
        let spec = parse(
            "chat(sessionId = \"ses_x\", promptTokens > 0) { userMessage, agentReply, promptTokens }",
        )
        .expect("valid query");
        assert_eq!(spec.event_type, EventTypeArg::Chat);
        assert_eq!(spec.args.len(), 2);
        assert_eq!(spec.args[0].field, vec!["sessionId"]);
        assert_eq!(spec.args[0].op, CompareOp::Eq);
        assert_eq!(spec.args[0].value, json!("ses_x"));
        assert_eq!(spec.args[1].op, CompareOp::Gt);
        assert_eq!(spec.args[1].value, json!(0));
        assert_eq!(
            spec.selection,
            vec![
                vec!["userMessage"],
                vec!["agentReply"],
                vec!["promptTokens"]
            ]
        );
    }

    #[test]
    fn parses_tool_use_root() {
        let spec = parse("toolUse(sessionId = \"s\") { toolName, durationMs }").expect("valid query");
        assert_eq!(spec.event_type, EventTypeArg::ToolUse);
        assert_eq!(spec.selection, vec![vec!["toolName"], vec!["durationMs"]]);
    }

    #[test]
    fn parses_agent_session_root_with_numeric_ops() {
        let spec = parse("agentSession(totalTokens >= 10, totalCostUsd <= 2.5) { totalTokens }")
            .expect("valid query");
        assert_eq!(spec.event_type, EventTypeArg::AgentSession);
        assert_eq!(spec.args[0].op, CompareOp::Gte);
        assert_eq!(spec.args[1].op, CompareOp::Lte);
        assert_eq!(spec.args[1].value, json!(2.5));
    }

    #[test]
    fn parses_deep_paths_any_depth() {
        // Dotted paths at ANY depth are legal syntactically — schema validates.
        let spec = parse("chat { rawJson.a.b.c, key.sessionId, promptTokens }").expect("valid query");
        assert_eq!(
            spec.selection,
            vec![
                vec!["rawJson", "a", "b", "c"],
                vec!["key", "sessionId"],
                vec!["promptTokens"]
            ]
        );
    }

    #[test]
    fn parses_without_args_and_allows_whitespace_and_trailing_comma() {
        let spec = parse("chat  { sessionId , }").expect("valid query");
        assert!(spec.args.is_empty());
        assert_eq!(spec.selection, vec![vec!["sessionId"]]);
    }

    #[test]
    fn parses_string_number_bool_null_literals() {
        let spec = parse(
            "chat(userMessage = \"hi\\n\", seq = 3, costUsd < 1.5, startedAtNs > -5, endedAtNs = null) { seq }",
        )
        .expect("valid query");
        assert_eq!(spec.args[0].value, json!("hi\n"));
        assert_eq!(spec.args[1].value, json!(3));
        assert_eq!(spec.args[2].value, json!(1.5));
        assert_eq!(spec.args[3].value, json!(-5));
        assert_eq!(spec.args[4].value, json!(null));
    }

    #[test]
    fn parses_bool_literals_and_escapes() {
        let spec = parse(
            "toolUse(toolSuccess = true, isSubagent = false, toolName = \"a\\\"b\") { toolName }",
        )
        .expect("valid query");
        assert_eq!(spec.args[0].value, json!(true));
        assert_eq!(spec.args[1].value, json!(false));
        assert_eq!(spec.args[2].value, json!("a\"b"));
    }

    #[test]
    fn error_unknown_root_includes_query_text() {
        assert_err_includes("chatx(sessionId = \"s\") { sessionId }", "unknown root type 'chatx'");
        assert_err_includes("CHAT { sessionId }", "unknown root type 'CHAT'");
    }

    #[test]
    fn error_missing_selection() {
        assert_err_includes("chat(sessionId = \"x\")", "missing selection set");
        assert_err_includes("chat", "missing selection set");
    }

    #[test]
    fn error_empty_selection() {
        assert_err_includes("chat { }", "at least one field path");
    }

    #[test]
    fn error_unexpected_characters_and_trailing_input() {
        assert_err_includes("chat { sessionId extra }", "expected");
        assert_err_includes("chat { sessionId } extra", "unexpected trailing input");
        assert_err_includes("chat(seq != 1) { seq }", "expected comparison operator");
        assert_err_includes("chat(seq = 1.2.3) { seq }", "invalid number");
        assert_err_includes("chat(sessionId = \"unterminated) { sessionId }", "unterminated string");
        assert_err_includes("chat(seq = tru) { seq }", "invalid literal");
        assert_err_includes("chat() { sessionId }", "expected identifier");
    }

    #[test]
    fn error_requires_word_boundary_on_keyword() {
        assert_err_includes("chat(seq = trueish) { seq }", "invalid literal");
    }
}
