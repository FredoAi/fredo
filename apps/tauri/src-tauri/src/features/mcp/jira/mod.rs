use base64::Engine;
use rmcp::ErrorData;
use serde_json::{json, Value};

#[allow(dead_code)]
fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

#[allow(dead_code)]
fn basic_auth(email: &str, token: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}"));
    format!("Basic {encoded}")
}

#[allow(dead_code)]
pub async fn get_issue(
    http: &reqwest::Client,
    base_url: &str,
    email: &str,
    token: &str,
    issue_key: &str,
) -> Result<String, ErrorData> {
    let url = format!("{base_url}/rest/api/3/issue/{issue_key}");
    let resp = http
        .get(&url)
        .header("Authorization", basic_auth(email, token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!("Jira error {}: {}", resp.status(), resp.text().await.unwrap_or_default())));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let fields = &data["fields"];
    let result = json!({
        "key": data["key"],
        "summary": fields["summary"],
        "status": fields["status"]["name"],
        "type": fields["issuetype"]["name"],
        "priority": fields["priority"]["name"],
        "assignee": fields["assignee"]["displayName"],
        "reporter": fields["reporter"]["displayName"],
        "created": fields["created"],
        "updated": fields["updated"],
        "description": fields["description"],
        "labels": fields["labels"],
        "url": format!("{base_url}/browse/{issue_key}"),
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

#[allow(dead_code)]
pub async fn get_my_issues(
    http: &reqwest::Client,
    base_url: &str,
    email: &str,
    token: &str,
    max_results: Option<u32>,
    status: Option<&str>,
) -> Result<String, ErrorData> {
    let mut jql = "assignee = currentUser() ORDER BY updated DESC".to_string();
    if let Some(s) = status {
        let statuses: Vec<String> = s.split(',').map(|x| format!("\"{}\"", x.trim())).collect();
        jql = format!(
            "assignee = currentUser() AND status in ({}) ORDER BY updated DESC",
            statuses.join(", ")
        );
    }

    let url = format!("{base_url}/rest/api/3/search");
    let resp = http
        .get(&url)
        .header("Authorization", basic_auth(email, token))
        .header("Accept", "application/json")
        .query(&[
            ("jql", jql.as_str()),
            ("maxResults", &max_results.unwrap_or(20).to_string()),
            ("fields", "summary,status,issuetype,priority,updated,assignee"),
        ])
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!("Jira error {}: {}", resp.status(), resp.text().await.unwrap_or_default())));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let issues: Vec<Value> = data["issues"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|i| {
            json!({
                "key": i["key"],
                "summary": i["fields"]["summary"],
                "status": i["fields"]["status"]["name"],
                "type": i["fields"]["issuetype"]["name"],
                "priority": i["fields"]["priority"]["name"],
                "updated": i["fields"]["updated"],
                "url": format!("{base_url}/browse/{}", i["key"].as_str().unwrap_or("")),
            })
        })
        .collect();

    serde_json::to_string_pretty(&issues).map_err(ie)
}

#[allow(clippy::too_many_arguments)]
#[allow(dead_code)]
pub async fn create_issue(
    http: &reqwest::Client,
    base_url: &str,
    email: &str,
    token: &str,
    project_key: &str,
    summary: &str,
    issue_type: Option<&str>,
    description: Option<&str>,
    priority: Option<&str>,
    labels: Option<&str>,
) -> Result<String, ErrorData> {
    let mut fields = json!({
        "project": { "key": project_key },
        "summary": summary,
        "issuetype": { "name": issue_type.unwrap_or("Task") },
    });

    if let Some(desc) = description {
        fields["description"] = json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": desc }]
            }]
        });
    }
    if let Some(p) = priority {
        fields["priority"] = json!({ "name": p });
    }
    if let Some(l) = labels {
        let label_list: Vec<&str> = l.split(',').map(str::trim).collect();
        fields["labels"] = json!(label_list);
    }

    let body = json!({ "fields": fields });
    let url = format!("{base_url}/rest/api/3/issue");
    let resp = http
        .post(&url)
        .header("Authorization", basic_auth(email, token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(ie)?;

    if !resp.status().is_success() {
        return Err(ie(format!("Jira error {}: {}", resp.status(), resp.text().await.unwrap_or_default())));
    }

    let data: Value = resp.json().await.map_err(ie)?;
    let key = data["key"].as_str().unwrap_or("unknown");
    let result = json!({
        "key": key,
        "url": format!("{base_url}/browse/{key}"),
        "message": format!("Issue {key} created successfully"),
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── REQ-6: basic_auth produces valid Basic auth header ────────────────

    #[test]
    fn basic_auth_produces_valid_basic_header() {
        let result = basic_auth("user@example.com", "token123");
        assert!(result.starts_with("Basic "), "should start with 'Basic '");

        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        assert_eq!(decoded_str, "user@example.com:token123");
    }

    #[test]
    fn basic_auth_handles_empty_email() {
        let result = basic_auth("", "token");
        assert!(result.starts_with("Basic "));

        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        assert_eq!(decoded_str, ":token");
    }

    #[test]
    fn basic_auth_handles_empty_token() {
        let result = basic_auth("admin", "");
        assert!(result.starts_with("Basic "));

        let encoded = result.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("should be valid base64");
        let decoded_str = String::from_utf8(decoded).expect("should be valid UTF-8");

        assert_eq!(decoded_str, "admin:");
    }
}
