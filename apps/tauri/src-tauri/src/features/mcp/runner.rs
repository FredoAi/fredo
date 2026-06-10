use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

use super::server::FredoMcpServer;
use crate::infrastructure::storage::AppStore;

/// Return the OS-standard Fredo data directory so the CLI can load AppStore
/// settings (API credentials, DB URLs, etc.) without a running Tauri process.
#[allow(dead_code)]
fn cli_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("com.fredo.app")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".local/share/com.fredo.app")
    }
}

/// Start the Fredo MCP server over **stdio** (default, used when spawned by an
/// AI agent like OpenCode).
#[allow(dead_code)]
pub async fn run_stdio() -> Result<()> {
    let store = Arc::new(AppStore::open(cli_data_dir())?);
    let server = FredoMcpServer::new(store, None).await;

    eprintln!("[fredo/mcp] Starting stdio transport");

    use rmcp::{ServiceExt, transport::stdio};
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Start the Fredo MCP server over **Streamable HTTP** on the given port.
/// Endpoints: `POST /mcp` (initialize + tool calls), `GET /mcp` (SSE stream).
#[allow(dead_code)]
pub async fn run_sse(port: u16) -> Result<()> {
    use rmcp::transport::{
        StreamableHttpService, StreamableHttpServerConfig,
        streamable_http_server::session::local::LocalSessionManager,
    };
    use axum::{Router, body::Body, extract::Request, routing::any};
    use std::sync::Arc as SArc;

    let store = Arc::new(AppStore::open(cli_data_dir())?);
    let addr = format!("127.0.0.1:{port}");
    eprintln!("[fredo/mcp] Starting HTTP MCP server on http://{addr}/mcp");

    // Pre-connect to PostgreSQL so the factory is sync.
    let db = match store.get("mcp.db.url") {
        Ok(Some(url)) => sqlx::PgPool::connect(&url).await.ok().map(Arc::new),
        _ => None,
    };

    let mcp_service = {
        let store = store.clone();
        let db = db.clone();
        StreamableHttpService::new(
            move || {
                Ok(FredoMcpServer::new_with_db(store.clone(), None, db.clone()))
            },
            SArc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        )
    };

    let mcp_service = SArc::new(mcp_service);
    let app = Router::new().route(
        "/mcp",
        any(move |req: Request<Body>| {
            let svc = mcp_service.clone();
            async move { svc.handle(req).await }
        }),
    );

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn cli_data_dir_uses_appdata_on_windows() {
        unsafe {
            std::env::set_var("APPDATA", "C:\\Users\\test\\AppData\\Roaming");
        }
        let dir = cli_data_dir();
        assert_eq!(
            dir,
            PathBuf::from("C:\\Users\\test\\AppData\\Roaming").join("com.fredo.app")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn cli_data_dir_uses_home_on_unix() {
        unsafe {
            std::env::set_var("HOME", "/home/test");
        }
        let dir = cli_data_dir();
        assert_eq!(
            dir,
            PathBuf::from("/home/test").join(".local/share/com.fredo.app")
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_data_dir_falls_back_to_empty_appdata() {
        unsafe {
            std::env::remove_var("APPDATA");
        }
        let dir = cli_data_dir();
        assert_eq!(dir, PathBuf::from("").join("com.fredo.app"));
    }

    #[cfg(not(windows))]
    #[test]
    fn cli_data_dir_falls_back_to_empty_home() {
        unsafe {
            std::env::remove_var("HOME");
        }
        let dir = cli_data_dir();
        assert_eq!(dir, PathBuf::from("").join(".local/share/com.fredo.app"));
    }
}
