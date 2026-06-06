use base64::Engine;
use rmcp::ErrorData;
use serde_json::{json, Value};

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

fn pat_auth(pat: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"));
    format!("Basic {encoded}")
}

#[allow(clippy::too_many_arguments)]
pub async fn create_workitem(
    http: &reqwest::Client,
    org_url: &str,
    project: &str,
    pat: &str,
    work_item_type: &str,
    title: &str,
    description: Option<&str>,
    priority: Option<u32>,
    assigned_to: Option<&str>,
    iteration_path: Option<&str>,
    area_path: Option<&str>,
) -> Result<String, ErrorData> {
    // Azure DevOps uses JSON Patch format
    let mut patch: Vec<Value> = vec![json!({
        "op": "add",
        "path": "/fields/System.Title",
        "value": title,
    })];

    if let Some(d) = description {
        patch.push(json!({
            "op": "add",
            "path": "/fields/System.Description",
            "value": d,
        }));
    }
    if let Some(p) = priority {
        patch.push(json!({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Common.Priority",
            "value": p,
        }));
    }
    if let Some(a) = assigned_to {
        patch.push(json!({
            "op": "add",
            "path": "/fields/System.AssignedTo",
            "value": a,
        }));
    }
    if let Some(iter) = iteration_path {
        patch.push(json!({
            "op": "add",
            "path": "/fields/System.IterationPath",
            "value": iter,
        }));
    }
    if let Some(area) = area_path {
        patch.push(json!({
            "op": "add",
            "path": "/fields/System.AreaPath",
            "value": area,
        }));
    }

    let url = format!(
        "{org_url}/{project}/_apis/wit/workitems/${type}?api-version=7.1",
        type = work_item_type
    );
    let resp = http
        .post(&url)
        .header("Authorization", pat_auth(pat))
        .header("Content-Type", "application/json-patch+json")
        .json(&patch)
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!(
            "AzDo error {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        )));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let id = data["id"].as_u64().unwrap_or(0);
    let wi_url = data["_links"]["html"]["href"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let result = json!({
        "id": id,
        "url": wi_url,
        "message": format!("Work item #{id} ({work_item_type}: {title}) created"),
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

    pub async fn start_workitem(

    http: &reqwest::Client,
    org_url: &str,
    project: &str,
    pat: &str,
    work_item_id: u64,
) -> Result<String, ErrorData> {
    let patch = json!([{
        "op": "add",
        "path": "/fields/System.State",
        "value": "In Progress",
    }]);

    let url = format!(
        "{org_url}/{project}/_apis/wit/workitems/{work_item_id}?api-version=7.1"
    );
    let resp = http
        .patch(&url)
        .header("Authorization", pat_auth(pat))
        .header("Content-Type", "application/json-patch+json")
        .json(&patch)
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!(
            "AzDo error {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        )));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let state = data["fields"]["System.State"]
        .as_str()
        .unwrap_or("unknown");
    Ok(format!(
        "Work item #{work_item_id} moved to state '{state}'."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── REQ-5: pat_auth produces valid Basic auth header ───────────────────

    #[test]
    fn pat_auth_produces_valid_basic_header() {
        let result = pat_auth("test-pat-123");
        assert!(result.starts_with("Basic "), "should start with 'Basic '");

        // Decode the base64 payload after "Basic "
        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        // PAT is encoded as ":pat" per Azure DevOps convention
        assert_eq!(decoded_str, ":test-pat-123");
    }

    #[test]
    fn pat_auth_handles_empty_pat() {
        let result = pat_auth("");
        assert!(result.starts_with("Basic "));

        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        assert_eq!(decoded_str, ":");
    }

    #[test]
    fn pat_auth_handles_special_characters() {
        let result = pat_auth("pat:with/special+chars==");
        assert!(result.starts_with("Basic "));

        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        assert_eq!(decoded_str, ":pat:with/special+chars==");
    }
}
