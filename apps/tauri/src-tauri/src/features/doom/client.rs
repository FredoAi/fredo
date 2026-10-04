//! Doom engine HTTP control client (Spec #2968, ST-5).
//!
//! The webview CSP forbids the webview from reaching the engine, so ALL engine
//! HTTP is Rust-side. This module performs exactly ONE request per operation:
//!
//! * `GET  /api/state` → the whole observation as an **opaque JSON passthrough**
//!   (`serde_json::Value`), so an upstream field addition never breaks the client.
//! * `POST /api/step`  → body `{ "tics": <int>, "actions": <json> }` (ST-1
//!   corrected the plan's guessed `{action, tic}`), answering the post-step state.
//! * `GET  /api/frame` → the **indexed8 + palette JSON** frame (ST-1 corrected the
//!   plan's guessed `image/png`), decoded to RGBA and re-encoded as a base64 PNG
//!   so the CU-4 canvas keeps the binding `DoomFrame { png_base64 }` shape.
//!
//! Every request is bounded by [`DOOM_REQUEST_TIMEOUT_S`]; any non-2xx, timeout,
//! connection failure, or decode failure maps to [`DoomErrorCode::RequestFailed`].
//! The client NEVER polls — the caller drives the cadence.
//!
//! [`DoomErrorCode::RequestFailed`]: super::state::DoomErrorCode::RequestFailed

use std::time::Duration;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::state::{DoomErrorCode, DoomRuntimeState, DOOM_REQUEST_TIMEOUT_S};

// ── Wire models (camelCase, IPC) ─────────────────────────────────────────────

/// The whole engine observation, verbatim (shape-agnostic passthrough).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStateView {
    /// The engine's `/api/state` JSON, unmodified.
    pub raw: serde_json::Value,
}

/// The post-step observation returned by `doom_step`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStepResult {
    /// The engine's post-step state JSON, unmodified.
    pub state: serde_json::Value,
}

/// A renderable frame: the engine's indexed8 framebuffer expanded to a base64
/// PNG the webview can draw (`data:image/png;base64,…`, CSP `img-src data:`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomFrame {
    /// Base64-encoded PNG bytes (no data-URI prefix).
    pub png_base64: String,
}

/// A typed engine request failure (the command error surface).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomRequestError {
    /// Always [`DoomErrorCode::RequestFailed`] for this client.
    pub code: DoomErrorCode,
    /// Human-readable detail (safe to log/show).
    pub message: String,
}

impl DoomRequestError {
    /// A `requestFailed` error with `message`.
    pub fn request_failed(message: impl Into<String>) -> Self {
        Self {
            code: DoomErrorCode::RequestFailed,
            message: message.into(),
        }
    }

    /// A **transient** `frameNotReady` error: the engine answered `GET /api/frame`
    /// with HTTP 503 ("graphics are not up yet"). The frame loop keeps polling.
    pub fn frame_not_ready(message: impl Into<String>) -> Self {
        Self {
            code: DoomErrorCode::FrameNotReady,
            message: message.into(),
        }
    }
}

// ── Transport (abstracted for deterministic unit tests) ──────────────────────

/// A transport-level failure. `status` is the HTTP status when a response was
/// received (`None` for a connection/timeout/decode failure), which lets the
/// frame path distinguish the engine's transient `503` from a hard failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportError {
    /// The HTTP status code, when a response was received.
    pub status: Option<u16>,
    /// Human-readable detail (safe to log/show).
    pub message: String,
}

impl TransportError {
    /// A failure with no HTTP status (connection / timeout / decode).
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }

    /// A failure carrying the non-2xx HTTP status.
    pub fn with_status(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
        }
    }

    /// Whether this is the engine's transient "graphics not up yet" response.
    pub fn is_frame_not_ready(&self) -> bool {
        self.status == Some(503)
    }
}

/// The minimal HTTP surface the client needs. Abstracted so the request mapping
/// and the frame decode are unit-testable without a live engine.
#[async_trait]
pub trait DoomHttpTransport: Send + Sync {
    /// One GET returning parsed JSON (any non-2xx is an `Err`).
    async fn get_json(&self, url: &str) -> Result<serde_json::Value, TransportError>;
    /// One POST with a JSON body returning parsed JSON (any non-2xx is an `Err`).
    async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, TransportError>;
}

/// Production transport backed by `reqwest`, bounded by
/// [`DOOM_REQUEST_TIMEOUT_S`] for both connect and the whole request.
pub struct ReqwestDoomTransport {
    client: reqwest::Client,
}

impl ReqwestDoomTransport {
    /// Build a client whose connect + total timeouts are strictly bounded.
    pub fn new() -> Result<Self, String> {
        let timeout = Duration::from_secs(DOOM_REQUEST_TIMEOUT_S);
        reqwest::Client::builder()
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .map(|client| Self { client })
            .map_err(|e| format!("failed to build the Doom HTTP client: {e}"))
    }
}

#[async_trait]
impl DoomHttpTransport for ReqwestDoomTransport {
    async fn get_json(&self, url: &str) -> Result<serde_json::Value, TransportError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| TransportError::message(format!("GET {url} failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(TransportError::with_status(
                status.as_u16(),
                format!("GET {url} returned HTTP {}", status.as_u16()),
            ));
        }
        response
            .json()
            .await
            .map_err(|e| TransportError::message(format!("GET {url} did not return JSON: {e}")))
    }

    async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, TransportError> {
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|e| TransportError::message(format!("POST {url} failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Err(TransportError::with_status(
                status.as_u16(),
                format!("POST {url} returned HTTP {}", status.as_u16()),
            ));
        }
        response
            .json()
            .await
            .map_err(|e| TransportError::message(format!("POST {url} did not return JSON: {e}")))
    }
}

// ── URLs + request bodies ────────────────────────────────────────────────────

/// `http://127.0.0.1:<port>/api/state`.
pub fn state_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/state")
}

/// `http://127.0.0.1:<port>/api/step`.
pub fn step_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/step")
}

/// `http://127.0.0.1:<port>/api/frame`.
pub fn frame_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/frame")
}

/// The corrected `POST /api/step` body: `{ "tics": <int>, "actions": <json> }`.
/// `actions` is passed through verbatim (the engine takes action objects).
pub fn build_step_body(tics: i64, actions: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "tics": tics, "actions": actions })
}

// ── Frame decoding (indexed8 + palette → RGBA → base64 PNG) ──────────────────

/// Expand an `indexed8` framebuffer + palette into an RGBA byte buffer.
///
/// The palette is 256 entries of RGB (768 bytes) or RGBA (1024 bytes); a shorter
/// palette is rejected. Each index selects a palette entry; RGB entries get an
/// opaque alpha.
pub fn indexed8_to_rgba(
    width: u32,
    height: u32,
    pixels: &[u8],
    palette: &[u8],
) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "frame dimensions overflow".to_string())?;
    if pixels.len() != expected {
        return Err(format!(
            "frame pixel count {} does not match {}x{}",
            pixels.len(),
            width,
            height
        ));
    }
    let entry = if palette.len() >= 256 * 4 {
        4
    } else if palette.len() >= 256 * 3 {
        3
    } else {
        return Err(format!(
            "frame palette is too short: {} bytes (need 768 or 1024)",
            palette.len()
        ));
    };

    let mut rgba = Vec::with_capacity(expected * 4);
    for &index in pixels {
        let base = index as usize * entry;
        let (r, g, b, a) = if entry == 4 {
            (palette[base], palette[base + 1], palette[base + 2], palette[base + 3])
        } else {
            (palette[base], palette[base + 1], palette[base + 2], 255)
        };
        rgba.extend_from_slice(&[r, g, b, a]);
    }
    Ok(rgba)
}

/// Decode an `/api/frame` JSON payload (`{width,height,format:"indexed8",pixels,
/// palette}` — base64) into a base64 PNG string.
pub fn indexed8_frame_to_png_base64(frame: &serde_json::Value) -> Result<String, String> {
    let width = frame
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "frame is missing 'width'".to_string())? as u32;
    let height = frame
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "frame is missing 'height'".to_string())? as u32;
    let format = frame
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("indexed8");
    if format != "indexed8" {
        return Err(format!("unsupported frame format '{format}' (expected indexed8)"));
    }
    let pixels_b64 = frame
        .get("pixels")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "frame is missing 'pixels'".to_string())?;
    let palette_b64 = frame
        .get("palette")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "frame is missing 'palette'".to_string())?;

    let pixels = STANDARD
        .decode(pixels_b64)
        .map_err(|e| format!("frame 'pixels' is not valid base64: {e}"))?;
    let palette = STANDARD
        .decode(palette_b64)
        .map_err(|e| format!("frame 'palette' is not valid base64: {e}"))?;

    let rgba = indexed8_to_rgba(width, height, &pixels, &palette)?;
    let buffer = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba)
        .ok_or_else(|| "frame buffer has an inconsistent size".to_string())?;
    let dynamic = image::DynamicImage::ImageRgba8(buffer);
    let mut png = std::io::Cursor::new(Vec::new());
    dynamic
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("frame PNG encode failed: {e}"))?;
    Ok(STANDARD.encode(png.into_inner()))
}

// ── One-request operations ───────────────────────────────────────────────────

/// One `GET /api/state`.
pub async fn read_state_with(
    transport: &dyn DoomHttpTransport,
    port: u16,
) -> Result<DoomStateView, DoomRequestError> {
    let raw = transport
        .get_json(&state_url(port))
        .await
        .map_err(|e| DoomRequestError::request_failed(e.message))?;
    Ok(DoomStateView { raw })
}

/// One `POST /api/step` with `{tics, actions}`.
pub async fn step_with(
    transport: &dyn DoomHttpTransport,
    port: u16,
    tics: i64,
    actions: &serde_json::Value,
) -> Result<DoomStepResult, DoomRequestError> {
    let body = build_step_body(tics, actions);
    let state = transport
        .post_json(&step_url(port), &body)
        .await
        .map_err(|e| DoomRequestError::request_failed(e.message))?;
    Ok(DoomStepResult { state })
}

/// One `GET /api/frame`, decoded to a base64 PNG.
///
/// An HTTP **503** ("graphics are not up yet") is the engine's transient
/// pre-graphics-init response and maps to [`DoomErrorCode::FrameNotReady`] so the
/// frame loop keeps polling instead of latching the `error` phase; every other
/// failure maps to `requestFailed`.
pub async fn frame_with(
    transport: &dyn DoomHttpTransport,
    port: u16,
) -> Result<DoomFrame, DoomRequestError> {
    let frame = transport.get_json(&frame_url(port)).await.map_err(|e| {
        if e.is_frame_not_ready() {
            DoomRequestError::frame_not_ready(e.message)
        } else {
            DoomRequestError::request_failed(e.message)
        }
    })?;
    let png_base64 = indexed8_frame_to_png_base64(&frame)
        .map_err(DoomRequestError::request_failed)?;
    Ok(DoomFrame { png_base64 })
}

/// The loopback port of the live managed engine, or `None` when not running.
///
/// A child that has already exited is reaped out of the state, so a read against
/// a dead engine never issues a request.
pub fn active_port(app: &AppHandle) -> Option<u16> {
    let state = app.state::<DoomRuntimeState>();
    let mut guard = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.as_mut() {
        Some(managed) => {
            if matches!(managed.child.try_wait(), Ok(None)) {
                Some(managed.port)
            } else {
                None
            }
        }
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A scripted transport: returns queued results per endpoint and records the
    /// exact requests it saw.
    #[derive(Default)]
    struct ScriptedTransport {
        get_results: Mutex<Vec<Result<serde_json::Value, TransportError>>>,
        post_results: Mutex<Vec<Result<serde_json::Value, TransportError>>>,
        calls: Mutex<Vec<String>>,
    }

    impl ScriptedTransport {
        fn with_get(self, value: serde_json::Value) -> Self {
            self.get_results.lock().unwrap().push(Ok(value));
            self
        }
        fn with_get_err(self, message: &str) -> Self {
            self.get_results
                .lock()
                .unwrap()
                .push(Err(TransportError::message(message)));
            self
        }
        fn with_get_status_err(self, status: u16, message: &str) -> Self {
            self.get_results
                .lock()
                .unwrap()
                .push(Err(TransportError::with_status(status, message)));
            self
        }
        fn with_post(self, value: serde_json::Value) -> Self {
            self.post_results.lock().unwrap().push(Ok(value));
            self
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl DoomHttpTransport for ScriptedTransport {
        async fn get_json(&self, url: &str) -> Result<serde_json::Value, TransportError> {
            self.calls.lock().unwrap().push(format!("GET {url}"));
            self.get_results
                .lock()
                .unwrap()
                .remove(0)
        }
        async fn post_json(
            &self,
            url: &str,
            body: &serde_json::Value,
        ) -> Result<serde_json::Value, TransportError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("POST {url} {}", body));
            self.post_results.lock().unwrap().remove(0)
        }
    }

    fn sample_frame(width: u32, height: u32) -> serde_json::Value {
        let pixels: Vec<u8> = (0..(width * height) as usize)
            .map(|i| (i % 256) as u8)
            .collect();
        let mut palette = vec![0u8; 768];
        for i in 0..256 {
            palette[i * 3] = i as u8;
            palette[i * 3 + 1] = (255 - i) as u8;
            palette[i * 3 + 2] = ((i * 2) % 256) as u8;
        }
        serde_json::json!({
            "width": width,
            "height": height,
            "format": "indexed8",
            "pixels": STANDARD.encode(&pixels),
            "palette": STANDARD.encode(&palette),
        })
    }

    #[test]
    fn urls_and_step_body_are_pinned_to_the_corrected_contract() {
        assert_eq!(state_url(6666), "http://127.0.0.1:6666/api/state");
        assert_eq!(step_url(6666), "http://127.0.0.1:6666/api/step");
        assert_eq!(frame_url(6666), "http://127.0.0.1:6666/api/frame");

        // ST-1 correction: the body is {tics, actions}, NOT {action, tic}.
        let body = build_step_body(4, &serde_json::json!([{ "type": "shoot" }]));
        assert_eq!(body["tics"], 4);
        assert_eq!(body["actions"][0]["type"], "shoot");
        assert!(body.get("action").is_none());
        assert!(body.get("tic").is_none());
    }

    #[test]
    fn indexed8_expands_to_rgba_with_opaque_alpha() {
        let pixels = [0u8, 1];
        let palette = {
            let mut p = vec![0u8; 768];
            p[0] = 10;
            p[1] = 20;
            p[2] = 30;
            p[3] = 40;
            p[4] = 50;
            p[5] = 60;
            p
        };
        let rgba = indexed8_to_rgba(2, 1, &pixels, &palette).expect("expand");
        assert_eq!(rgba, vec![10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn indexed8_rejects_mismatched_pixels_and_short_palettes() {
        assert!(indexed8_to_rgba(2, 2, &[0, 1], &[0u8; 768]).is_err());
        assert!(indexed8_to_rgba(1, 1, &[0], &[0u8; 10]).is_err());
    }

    #[test]
    fn frame_payload_decodes_to_a_png_with_the_right_dimensions() {
        let frame = sample_frame(4, 3);
        let png_b64 = indexed8_frame_to_png_base64(&frame).expect("decode");
        let png = STANDARD.decode(png_b64).expect("base64 png");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "PNG magic");
        let decoded = image::load_from_memory(&png).expect("decode png");
        assert_eq!((decoded.width(), decoded.height()), (4, 3));
    }

    #[test]
    fn frame_payload_rejects_bad_shapes() {
        assert!(indexed8_frame_to_png_base64(&serde_json::json!({})).is_err());
        assert!(indexed8_frame_to_png_base64(&serde_json::json!({
            "width": 1, "height": 1, "format": "png", "pixels": "", "palette": ""
        }))
        .is_err());
    }

    #[tokio::test]
    async fn read_state_is_one_get_and_a_verbatim_passthrough() {
        let raw = serde_json::json!({"tic": 7, "player": {"health": 100}});
        let transport = ScriptedTransport::default().with_get(raw.clone());
        let view = read_state_with(&transport, 6666).await.expect("read");
        assert_eq!(view.raw, raw);
        assert_eq!(transport.calls(), vec!["GET http://127.0.0.1:6666/api/state"]);
    }

    #[tokio::test]
    async fn step_is_one_post_with_the_documented_body() {
        let state = serde_json::json!({"tic": 8});
        let transport = ScriptedTransport::default().with_post(state.clone());
        let result = step_with(&transport, 6666, 1, &serde_json::json!([]))
            .await
            .expect("step");
        assert_eq!(result.state, state);
        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].starts_with("POST http://127.0.0.1:6666/api/step"));
        assert!(calls[0].contains("\"tics\":1"));
        assert!(calls[0].contains("\"actions\":[]"));
    }

    #[tokio::test]
    async fn non_2xx_maps_to_request_failed() {
        let transport = ScriptedTransport::default().with_get_err("GET ... returned HTTP 500");
        let error = read_state_with(&transport, 6666).await.expect_err("must fail");
        assert_eq!(error.code, DoomErrorCode::RequestFailed);
        assert!(error.message.contains("HTTP 500"));
    }

    #[tokio::test]
    async fn frame_503_maps_to_the_transient_frame_not_ready() {
        // R-1.4: the engine's "graphics are not up yet" 503 is transient.
        let transport = ScriptedTransport::default()
            .with_get_status_err(503, "GET http://127.0.0.1:6666/api/frame returned HTTP 503");
        let error = frame_with(&transport, 6666).await.expect_err("must fail");
        assert_eq!(error.code, DoomErrorCode::FrameNotReady);
        assert!(error.message.contains("HTTP 503"));
    }

    #[tokio::test]
    async fn frame_non_503_failure_maps_to_request_failed() {
        let transport = ScriptedTransport::default()
            .with_get_status_err(500, "GET http://127.0.0.1:6666/api/frame returned HTTP 500");
        let error = frame_with(&transport, 6666).await.expect_err("must fail");
        assert_eq!(error.code, DoomErrorCode::RequestFailed);
    }

    #[tokio::test]
    async fn state_503_is_not_treated_as_frame_not_ready() {
        // The transient 503 mapping is FRAME-specific; a state read still fails hard.
        let transport = ScriptedTransport::default()
            .with_get_status_err(503, "GET http://127.0.0.1:6666/api/state returned HTTP 503");
        let error = read_state_with(&transport, 6666).await.expect_err("must fail");
        assert_eq!(error.code, DoomErrorCode::RequestFailed);
    }

    #[tokio::test]
    async fn frame_is_one_get_and_maps_decode_failures_to_request_failed() {
        // A valid frame decodes.
        let transport = ScriptedTransport::default().with_get(sample_frame(2, 2));
        let frame = frame_with(&transport, 6666).await.expect("frame");
        assert!(!frame.png_base64.is_empty());

        // A malformed frame is a typed requestFailed, never a panic.
        let bad = ScriptedTransport::default().with_get(serde_json::json!({"width": 2}));
        let error = frame_with(&bad, 6666).await.expect_err("must fail");
        assert_eq!(error.code, DoomErrorCode::RequestFailed);
    }
}
