use rmcp::ErrorData;
use serde_json::{json, Value};

#[allow(dead_code)]
fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

#[allow(dead_code)]
const OPTIMIZELY_API: &str = "https://api.optimizely.com/flags/v1";

#[allow(dead_code)]
pub async fn get_flags(
    http: &reqwest::Client,
    project_id: &str,
    sdk_key: &str,
    environment: Option<&str>,
) -> Result<String, ErrorData> {
    let url = format!("{OPTIMIZELY_API}/projects/{project_id}/flags");
    let resp = http
        .get(&url)
        .header("Authorization", format!("Bearer {sdk_key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!(
            "Optimizely error {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        )));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let empty = vec![];
    let items = data["items"].as_array().unwrap_or(&empty);

    let flags: Vec<Value> = items
        .iter()
        .map(|flag| {
            let envs = flag["environments"].as_object();
            let env_statuses: Value = if let Some(env_filter) = environment {
                if let Some(env_data) = envs.and_then(|e| e.get(env_filter)) {
                    json!({ env_filter: env_data["is_enabled"] })
                } else {
                    json!({})
                }
            } else {
                envs.map(|e| {
                    let map: serde_json::Map<String, Value> = e
                        .iter()
                        .map(|(k, v)| (k.clone(), v["is_enabled"].clone()))
                        .collect();
                    Value::Object(map)
                })
                .unwrap_or(json!({}))
            };

            json!({
                "key": flag["key"],
                "name": flag["name"],
                "description": flag["description"],
                "environments": env_statuses,
            })
        })
        .collect();

    serde_json::to_string_pretty(&flags).map_err(ie)
}

#[allow(dead_code)]
pub async fn update_flag(
    http: &reqwest::Client,
    project_id: &str,
    sdk_key: &str,
    flag_key: &str,
    environment: &str,
    enabled: bool,
) -> Result<String, ErrorData> {
    let state = if enabled { "enabled" } else { "disabled" };
    let url = format!(
        "{OPTIMIZELY_API}/projects/{project_id}/flags/{flag_key}/environments/{environment}/ruleset/{state}"
    );
    let resp = http
        .post(&url)
        .header("Authorization", format!("Bearer {sdk_key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!(
            "Optimizely error {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        )));
    }

    Ok(format!(
        "Flag '{flag_key}' in environment '{environment}' is now {state}."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    // ── ie() helper ───────────────────────────────────────────────────

    #[test]
    fn ie_creates_internal_error_with_message() {
        let err = ie("optimizely error");
        assert_eq!(err.message, "optimizely error");
    }

    // ── OPTIMIZELY_API constant ───────────────────────────────────────

    #[test]
    fn optimizely_api_url_is_correct() {
        assert_eq!(OPTIMIZELY_API, "https://api.optimizely.com/flags/v1");
    }

    // ── Tool parameter struct deserialization ─────────────────────────

    #[derive(Debug, Deserialize)]
    struct TestGetFlagsParams {
        environment: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct TestUpdateFlagParams {
        flag_key: String,
        environment: String,
        enabled: bool,
    }

    #[test]
    fn get_flags_params_deserializes_with_environment() {
        let params: TestGetFlagsParams =
            serde_json::from_str(r#"{"environment": "production"}"#).unwrap();
        assert_eq!(params.environment, Some("production".to_string()));
    }

    #[test]
    fn get_flags_params_deserializes_without_environment() {
        let params: TestGetFlagsParams = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(params.environment, None);
    }

    #[test]
    fn update_flag_params_deserializes_valid_json() {
        let params: TestUpdateFlagParams = serde_json::from_str(
            r#"{"flag_key": "my-flag", "environment": "staging", "enabled": true}"#,
        )
        .unwrap();
        assert_eq!(params.flag_key, "my-flag");
        assert_eq!(params.environment, "staging");
        assert_eq!(params.enabled, true);
    }

    #[test]
    fn update_flag_params_rejects_missing_required_field() {
        let result: Result<TestUpdateFlagParams, _> =
            serde_json::from_str(r#"{"environment": "prod"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn update_flag_params_rejects_wrong_type() {
        let result: Result<TestUpdateFlagParams, _> =
            serde_json::from_str(r#"{"flag_key": 42, "environment": "prod", "enabled": true}"#);
        assert!(result.is_err());
    }
}
