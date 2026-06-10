use rmcp::ErrorData;
use serde_json::{json, Value};

#[allow(dead_code)]
fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub async fn execute(
    http: &reqwest::Client,
    sandbox_url: &str,
    code: &str,
    language: &str,
    libraries: Option<&[String]>,
    timeout_ms: Option<u32>,
    session_id: Option<&str>,
) -> Result<String, ErrorData> {
    let supported = ["python", "javascript", "typescript", "go", "java", "r"];
    if !supported.contains(&language) {
        return Err(ErrorData::invalid_params(
            format!("Unsupported language '{language}'. Supported: {}", supported.join(", ")),
            None,
        ));
    }

    let body = json!({
        "code": code,
        "language": language,
        "libraries": libraries.unwrap_or(&[]),
        "timeout_ms": timeout_ms.unwrap_or(30_000),
        "session_id": session_id.unwrap_or("mcp-session"),
    });

    let resp = http
        .post(format!("{sandbox_url}/execute"))
        .json(&body)
        .send()
        .await
        .map_err(|e| ie(format!("Sandbox unreachable: {e}")))?;

    if !resp.status().is_success() {
        return Err(ie(format!(
            "Sandbox error {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        )));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    serde_json::to_string_pretty(&data).map_err(ie)
}

#[cfg(test)]
mod tests {
    use crate::features::mcp::server::CodeExecuteParams;
    use serde_json::json;

    #[test]
    fn code_execute_params_full_json_deserializes() {
        let p: CodeExecuteParams = serde_json::from_value(json!({
            "code": "print('hello')",
            "language": "python",
            "libraries": ["numpy"],
            "timeout_ms": 30000,
            "session_id": "sess-1"
        }))
        .unwrap();
        // Verify the struct was populated (field access uses Debug output)
        let debug = format!("{:?}", p);
        assert!(debug.contains("print('hello')"), "code field should be present");
        assert!(debug.contains("python"), "language field should be present");
    }

    #[test]
    fn code_execute_params_minimal_json_deserializes() {
        let p: CodeExecuteParams = serde_json::from_value(json!({
            "code": "print(1)",
            "language": "python"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("print(1)"));
    }

    #[test]
    fn code_execute_params_missing_language_fails() {
        let result: Result<CodeExecuteParams, _> =
            serde_json::from_value(json!({ "code": "print(1)" }));
        assert!(result.is_err(), "missing 'language' must fail");
    }

    #[test]
    fn code_execute_params_invalid_types_fails() {
        let result: Result<CodeExecuteParams, _> =
            serde_json::from_value(json!({
                "code": "print(1)",
                "language": 42
            }));
        assert!(result.is_err(), "language as integer must fail");
    }
}
