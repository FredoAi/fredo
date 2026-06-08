use rmcp::ErrorData;
use serde_json::{json, Value};

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
