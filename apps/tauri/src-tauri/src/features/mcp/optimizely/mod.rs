use rmcp::ErrorData;
use serde_json::{json, Value};

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

const OPTIMIZELY_API: &str = "https://api.optimizely.com/flags/v1";

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
