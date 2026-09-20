//! Bounded `/health` readiness polling for the managed `llama-server`
//! (Spec #2857, ST-3; EARS R-2, R-4).
//!
//! Readiness is the server's own HTTP verdict — never a fixed delay:
//!
//! * `GET /health` → **HTTP 200** (`{"status":"ok"}`) = ready,
//! * **HTTP 503** (`Loading model`) = keep polling,
//! * connection refused = keep polling (the process is still coming up).
//!
//! The whole poll is bounded by the caller-supplied timeout, so a launch can
//! never hang (R-4.2). The probe is abstracted behind [`HealthProbeSource`] so
//! the bounded-wait logic is unit-testable without a running server. The
//! production probe uses `reqwest` with a per-request timeout strictly below the
//! poll budget.

use std::time::Duration;

use async_trait::async_trait;

/// Path of the llama.cpp server health endpoint.
pub const HEALTH_PATH: &str = "/health";

/// Default interval between health probes.
pub const DEFAULT_HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The health URL for a bound host/port (localhost only in the reference deployment).
pub fn health_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}{HEALTH_PATH}")
}

/// The outcome of a single health probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HealthProbe {
    /// HTTP 2xx — the server is ready to serve chat.
    Ready,
    /// The server answered, but is not ready (e.g. HTTP 503 while loading).
    NotReady(String),
    /// No HTTP response yet (connection refused / reset while coming up).
    Unreachable,
}

impl HealthProbe {
    /// Ready iff the server answered `2xx`.
    pub fn is_ready(&self) -> bool {
        matches!(self, HealthProbe::Ready)
    }

    /// Human-readable description used in the timeout error (R-4 actionable error).
    pub fn describe(&self) -> String {
        match self {
            HealthProbe::Ready => "healthy".to_string(),
            HealthProbe::NotReady(detail) => format!("not ready ({detail})"),
            HealthProbe::Unreachable => "not reachable".to_string(),
        }
    }
}

/// A single health probe. Abstracted so [`wait_until_healthy`] is testable with
/// a scripted source — no real HTTP listener required in unit tests.
#[async_trait]
pub trait HealthProbeSource: Send + Sync {
    async fn probe(&self, url: &str) -> HealthProbe;
}

/// Production health probe backed by `reqwest`.
pub struct ReqwestHealthClient {
    client: reqwest::Client,
}

impl ReqwestHealthClient {
    /// Build a client whose request timeout is strictly below the default poll
    /// budget, so an individual probe can never outlast a bounded wait.
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .map(|client| Self { client })
            .map_err(|e| format!("failed to build the health HTTP client: {e}"))
    }
}

#[async_trait]
impl HealthProbeSource for ReqwestHealthClient {
    async fn probe(&self, url: &str) -> HealthProbe {
        match self.client.get(url).send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    HealthProbe::Ready
                } else if status.as_u16() == 503 {
                    HealthProbe::NotReady("model still loading".to_string())
                } else {
                    HealthProbe::NotReady(format!("HTTP {}", status.as_u16()))
                }
            }
            Err(_) => HealthProbe::Unreachable,
        }
    }
}

/// Poll `url` until it answers ready or `timeout` elapses — whichever first.
///
/// Every probe (including the source future itself) is bounded by the remaining
/// budget, so the function ALWAYS resolves within ~`timeout` and never hangs.
/// `Err` carries an actionable description of the last observed probe.
pub async fn wait_until_healthy<S: HealthProbeSource + ?Sized>(
    source: &S,
    url: &str,
    timeout: Duration,
    interval: Duration,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut last = HealthProbe::Unreachable;

    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(timeout_error(timeout, &last));
        }

        match tokio::time::timeout(remaining, source.probe(url)).await {
            Ok(probe) if probe.is_ready() => return Ok(()),
            Ok(probe) => last = probe,
            Err(_) => return Err(timeout_error(timeout, &last)),
        }

        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(timeout_error(timeout, &last));
        }
        tokio::time::sleep(interval.min(remaining)).await;
    }
}

fn timeout_error(timeout: Duration, last: &HealthProbe) -> String {
    format!(
        "health check timed out after {}s — server {}",
        timeout.as_secs(),
        last.describe()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scripted probe source: returns the queued probes in order, repeating the
    /// last one once the queue is exhausted.
    struct ScriptedProbe {
        probes: Vec<HealthProbe>,
        calls: AtomicUsize,
    }

    impl ScriptedProbe {
        fn new(probes: Vec<HealthProbe>) -> Self {
            Self {
                probes,
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl HealthProbeSource for ScriptedProbe {
        async fn probe(&self, _url: &str) -> HealthProbe {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            self.probes
                .get(index)
                .cloned()
                .unwrap_or_else(|| self.probes.last().cloned().unwrap_or(HealthProbe::Unreachable))
        }
    }

    #[test]
    fn health_url_is_the_localhost_health_endpoint() {
        assert_eq!(health_url("127.0.0.1", 8080), "http://127.0.0.1:8080/health");
    }

    #[tokio::test]
    async fn returns_ok_once_a_later_probe_is_ready() {
        let source = ScriptedProbe::new(vec![
            HealthProbe::NotReady("model still loading".to_string()),
            HealthProbe::Unreachable,
            HealthProbe::Ready,
        ]);
        let result = wait_until_healthy(
            &source,
            "http://127.0.0.1:1/health",
            Duration::from_secs(2),
            Duration::from_millis(1),
        )
        .await;
        assert!(result.is_ok(), "expected ready, got {result:?}");
    }

    #[tokio::test]
    async fn times_out_within_the_bound_when_never_ready() {
        let source = ScriptedProbe::new(vec![HealthProbe::NotReady("model still loading".to_string())]);
        let timeout = Duration::from_millis(40);
        let started = std::time::Instant::now();
        let result = wait_until_healthy(
            &source,
            "http://127.0.0.1:1/health",
            timeout,
            Duration::from_millis(5),
        )
        .await;
        assert!(result.is_err(), "a never-ready probe must time out");
        // Bounded: the wait must not overshoot the budget by more than a scheduling margin.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "poll must be bounded by the timeout"
        );
    }

    #[test]
    fn describe_covers_each_probe_state() {
        assert_eq!(HealthProbe::Ready.describe(), "healthy");
        assert!(HealthProbe::NotReady("HTTP 500".to_string())
            .describe()
            .contains("HTTP 500"));
        assert_eq!(HealthProbe::Unreachable.describe(), "not reachable");
    }
}
