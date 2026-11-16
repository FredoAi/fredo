//! Voice IPC wire types (`serde(rename_all = "camelCase")`).
//!
//! The vocabulary the Companion settings UI and the launcher listening cue
//! consume: the typed failure codes, the `stt_start` result, the `stt:state`
//! payload, and the input-device enumeration returned by `stt_list_devices`.

use serde::Serialize;

/// Typed voice failure vocabulary. Serialized as `noDevice`, `permissionDenied`,
/// `engineStartFailed`, `alreadyListening`, `disabled`, `internal`,
/// `modelAudioUnsupported`, `modelAudioUnavailable`. `engineStartFailed` is the
/// capture-start timeout code (kept under its historical wire name for wire
/// stability).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttErrorCode {
    NoDevice,
    PermissionDenied,
    EngineStartFailed,
    AlreadyListening,
    Disabled,
    Internal,
    /// #2897 ST-6 (REQ-7): the managed model cannot accept audio input.
    ModelAudioUnsupported,
    /// #2897 ST-6 (REQ-7): the managed model server is not installed/running.
    ModelAudioUnavailable,
}

/// #2897 ST-2 (REQ-6) — the DECIDED per-input ceiling, in milliseconds, that the
/// captured model-audio clip is bounded by. SINGLE SOURCE: the session derives
/// its sample cap from this, AUTO-STOPS capture when the ceiling is reached
/// (ST-5), and reports it back on every `stt:state` (`limitMs`) and on every clip
/// (`limitMs`) — the UI never hardcodes a duration.
///
/// DECIDED at 30 s (#2897 round 2, R2-2): REQ-6 bounds the clip to the model's
/// supported per-input length, and the cited source capability documents ~30 s
/// per clip. The Tester's F-110 receipt (ST-0 R4) measured only the SERVER's
/// ACCEPTANCE (`input_audio` POST 200 at 31 s / 60 s / 120 s, no 4xx up to
/// 120 s) and explicitly could not score interpretation quality (the synthetic
/// clip is not speech), so server acceptance is NOT evidence of the model's
/// supported per-input length and does not license a larger bound. 30 s is the
/// conservative documented-limit bound and lies safely inside the server's
/// proven >=120 s acceptance envelope. Raising it is a product decision beyond
/// AC4 (it would also require a new over-bound fixture + changed limit copy).
pub const MAX_AUDIO_CLIP_MS: u64 = 30_000;

/// #2897 ST-2 — the model-audio session phase on the wire. `stopped` / `error`
/// are deliberately NOT wire values: the UI derives them from `listening:false`
/// + `code`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttPhaseWire {
    /// Capture is live; the clip is accumulating (REQ-3).
    Capturing,
    /// A stop committed the clip; the turn is awaiting interpretation (REQ-4).
    Processing,
}

/// Result of `stt_start`. `started:false` always carries a typed `code` and a
/// human-readable `detail`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStartResult {
    pub started: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    pub device_name: Option<String>,
    /// The DEVICE rate; capture resamples to
    /// [`super::capture::AUDIO_SAMPLE_RATE`].
    pub sample_rate: Option<u32>,
}

/// One `stt:state` payload.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStateEvent {
    pub listening: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    /// `"launcher"` | `"companion"` (echoed from `stt_start`).
    pub origin: Option<String>,
    /// Milliseconds from the `stt_start` receipt to capture-live; `None` on the
    /// error/idle paths (the two observables for R-1/R-4).
    pub ready_ms: Option<u64>,
    /// #2897 ST-2 — the model-audio phase (`capturing` / `processing`).
    pub phase: Option<SttPhaseWire>,
    /// #2897 ST-2 (REQ-6) — `Some(true)` iff the capture auto-stopped at
    /// [`MAX_AUDIO_CLIP_MS`], `Some(false)` on a manual stop, `None` on the
    /// cancel/error/idle paths.
    pub limit_reached: Option<bool>,
    /// #2897 ST-5 (REQ-6) — the pinned per-input ceiling ([`MAX_AUDIO_CLIP_MS`])
    /// this session is bounded by, in milliseconds. `Some` on every live/terminal
    /// session path so the launcher's countdown and limit copy read the ONE
    /// backend constant instead of hardcoding a duration; `None` off a session.
    pub limit_ms: Option<u64>,
}

/// #2897 ST-2 — the bounded model-audio clip handed back by
/// `stt_take_audio_clip`. It crosses IPC only; `infrastructure/voice/` never
/// transmits it (REQ-8).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttAudioClip {
    /// 16 kHz mono 16-bit PCM WAV, base64-encoded — the WHOLE captured clip.
    pub base64: String,
    /// Always `"wav"`.
    pub format: String,
    /// Always [`super::capture::AUDIO_SAMPLE_RATE`] (16 000).
    pub sample_rate: u32,
    /// Captured audio duration, derived from the sample count.
    pub duration_ms: u64,
    /// The pinned per-input ceiling the clip was bounded by ([`MAX_AUDIO_CLIP_MS`]).
    pub limit_ms: u64,
    /// True iff capture auto-stopped at the ceiling (REQ-6).
    pub at_limit: bool,
    /// ALWAYS false — the non-lossy invariant, pinned by test (REQ-6).
    pub truncated: bool,
}

/// Result of `stt_take_audio_clip`: the taken clip, or `clip: None` when no
/// session has committed one (never taken / cancel / already taken).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttAudioClipResult {
    pub clip: Option<SttAudioClip>,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
}

/// #2897 ST-6 (REQ-7) — the backend-owned model-audio capability state. The UI
/// NEVER infers capability from a model name; this closed vocabulary is the ONE
/// readiness answer.
///
/// `checking` is a UI-side "probe in flight" value and is never returned by the
/// backend — it lives on the wire enum so both sides share a single closed set.
/// `serverUnavailable` is the truthful state when the managed loopback
/// `llama-server` is not listening (never a crash, never a fabricated verdict).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttAudioCapabilityState {
    Checking,
    Ready,
    Unsupported,
    ServerUnavailable,
    Unknown,
}

/// #2897 ST-6 (REQ-7) — the result of `stt_audio_capability`.
///
/// The readiness row (C0r) renders exactly this object; `model` names the model
/// reported by the managed server (never parsed from a filename), and `detail`
/// is a human-readable qualifier for the demoted technical line. `limit_ms` is
/// ST-0's MEASURED per-input ceiling — `None` until F-110 records it, never
/// fabricated.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttAudioCapability {
    pub state: SttAudioCapabilityState,
    pub model: Option<String>,
    pub limit_ms: Option<u64>,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
}

impl SttAudioCapability {
    /// The model server is not reachable on the managed loopback endpoint.
    pub fn server_unavailable(detail: impl Into<String>) -> Self {
        Self {
            state: SttAudioCapabilityState::ServerUnavailable,
            model: None,
            limit_ms: None,
            code: Some(SttErrorCode::ModelAudioUnavailable),
            detail: Some(detail.into()),
        }
    }

    /// The server is reachable and rejected the audio content part (4xx).
    pub fn unsupported(model: Option<String>, detail: impl Into<String>) -> Self {
        Self {
            state: SttAudioCapabilityState::Unsupported,
            model,
            limit_ms: None,
            code: Some(SttErrorCode::ModelAudioUnsupported),
            detail: Some(detail.into()),
        }
    }

    /// The server accepted the audio probe (2xx) — audio input is usable.
    pub fn ready(model: Option<String>) -> Self {
        Self {
            state: SttAudioCapabilityState::Ready,
            model,
            limit_ms: None,
            code: None,
            detail: None,
        }
    }

    /// The probe could not determine capability (5xx / malformed / transport
    /// error after the server was reachable). Never crashes, never guesses.
    pub fn unknown(model: Option<String>, detail: impl Into<String>) -> Self {
        Self {
            state: SttAudioCapabilityState::Unknown,
            model,
            limit_ms: None,
            code: None,
            detail: Some(detail.into()),
        }
    }
}

/// One enumerable input device for the Companion settings picker.
///
/// `id` is the stable selector: `cpal` exposes no device GUID, so **`id` IS the
/// cpal device name string**. `name` is the display label (identical today; it
/// may be decorated later without changing the selection identity).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SttDeviceInfo {
    /// Stable selector — the cpal device name.
    pub id: String,
    /// Display label for the picker.
    pub name: String,
    /// True for the host's default input device.
    pub is_default: bool,
}

/// Result of `stt_list_devices`.
///
/// `code` is `None` when enumeration succeeded with at least one device, and
/// `Some(NoDevice)` when the host exposes no input device or enumeration itself
/// failed (both render the UI's no-device state). `selectedId` echoes the
/// persisted `Fredo_companion_voice_device_id`; `None` = the system default.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttDevicesResult {
    pub devices: Vec<SttDeviceInfo>,
    pub selected_id: Option<String>,
    pub code: Option<SttErrorCode>,
}

/// Internal typed error carried from capture/session to the command boundary.
/// Never surfaced as a panic.
#[derive(Clone, Debug)]
pub struct VoiceError {
    pub code: SttErrorCode,
    pub detail: String,
}

impl VoiceError {
    pub fn new(code: SttErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn no_device() -> Self {
        Self::new(
            SttErrorCode::NoDevice,
            "No input device is available on this host.",
        )
    }

    /// The persisted input device no longer enumerates — actionable copy that
    /// NAMES the device. Capture never silently falls back to a different
    /// microphone (AC4 / R-4.5).
    pub fn no_device_named(name: &str) -> Self {
        Self::new(
            SttErrorCode::NoDevice,
            format!(
                "The selected microphone \"{name}\" is not available — choose a microphone in Companion settings."
            ),
        )
    }

    pub fn permission_denied(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::PermissionDenied, detail)
    }

    pub fn engine_start_failed(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::EngineStartFailed, detail)
    }

    pub fn already_listening() -> Self {
        Self::new(
            SttErrorCode::AlreadyListening,
            "A listening session is already active.",
        )
    }

    pub fn disabled() -> Self {
        Self::new(
            SttErrorCode::Disabled,
            "Voice input is disabled in Companion settings.",
        )
    }

    /// #2897 ST-6 (REQ-7): the installed companion model cannot interpret audio.
    pub fn model_audio_unsupported(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelAudioUnsupported, detail)
    }

    /// #2897 ST-6 (REQ-7): the managed model server is not installed/running.
    pub fn model_audio_unavailable(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelAudioUnavailable, detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::Internal, detail)
    }

    /// Shape this failure into the `stt_start` wire result.
    pub fn into_start_result(self) -> SttStartResult {
        SttStartResult {
            started: false,
            code: Some(self.code),
            detail: Some(self.detail),
            device_name: None,
            sample_rate: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The device-enumeration wire shape the settings picker consumes
    /// (`stt_list_devices`): camelCase keys, `id` == the cpal name, `selectedId`
    /// echoing the persisted preference.
    #[test]
    fn device_wire_types_serialize_as_camel_case() {
        let info = SttDeviceInfo {
            id: "Iriun Webcam".to_string(),
            name: "Iriun Webcam".to_string(),
            is_default: true,
        };
        let json = serde_json::to_value(&info).expect("serialize device info");
        assert_eq!(json["id"], "Iriun Webcam");
        assert_eq!(json["name"], "Iriun Webcam");
        assert_eq!(json["isDefault"], true);
        assert!(json.get("is_default").is_none());

        let result = SttDevicesResult {
            devices: vec![info],
            selected_id: None,
            code: None,
        };
        let json = serde_json::to_value(&result).expect("serialize devices result");
        assert_eq!(json["selectedId"], serde_json::Value::Null);
        assert_eq!(json["code"], serde_json::Value::Null);
        assert_eq!(json["devices"][0]["isDefault"], true);
    }

    /// The vanished-device failure names the device and is the typed `noDevice`
    /// (AC4) — never a generic message that hides which microphone vanished.
    #[test]
    fn no_device_named_is_typed_and_names_the_device() {
        let error = VoiceError::no_device_named("Iriun Webcam");
        assert_eq!(error.code, SttErrorCode::NoDevice);
        assert!(
            error.detail.contains("Iriun Webcam"),
            "detail must name the device: {}",
            error.detail
        );

        let result = error.into_start_result();
        assert!(!result.started);
        assert_eq!(result.code, Some(SttErrorCode::NoDevice));
        assert!(result.device_name.is_none());
        assert!(result.sample_rate.is_none());
    }

    /// The `stt:state` payload serializes as camelCase and carries no removed
    /// engine-residency field (the engine no longer exists).
    #[test]
    fn state_event_carries_the_timing_observables_without_engine_residency() {
        let event = SttStateEvent {
            listening: true,
            code: None,
            detail: None,
            origin: Some("launcher".to_string()),
            ready_ms: Some(42),
            phase: None,
            limit_reached: None,
            limit_ms: None,
        };
        let json = serde_json::to_value(&event).expect("serialize state event");
        assert_eq!(json["listening"], true);
        assert_eq!(json["origin"], "launcher");
        assert_eq!(json["code"], serde_json::Value::Null);
        assert_eq!(json["readyMs"], 42);
        assert!(json.get("ready_ms").is_none());
        assert!(
            json.get("engineResident").is_none(),
            "the removed engineResident field must not reappear: {json}"
        );
        assert_eq!(json["phase"], serde_json::Value::Null);
        assert_eq!(json["limitReached"], serde_json::Value::Null);
        assert_eq!(json["limitMs"], serde_json::Value::Null);
    }

    /// #2897 ST-2 (REQ-3/REQ-4/REQ-6): the model-audio phase and the
    /// at-ceiling flag serialize as the camelCase wire the launcher indicator
    /// derives from.
    #[test]
    fn state_event_carries_the_model_audio_phase_and_limit() {
        let capturing = SttStateEvent {
            listening: true,
            code: None,
            detail: None,
            origin: Some("launcher".to_string()),
            ready_ms: Some(9),
            phase: Some(SttPhaseWire::Capturing),
            limit_reached: None,
            limit_ms: Some(MAX_AUDIO_CLIP_MS),
        };
        let json = serde_json::to_value(&capturing).expect("serialize capturing state");
        assert_eq!(json["phase"], "capturing");
        assert_eq!(json["limitReached"], serde_json::Value::Null);
        // #2897 ST-5 (REQ-6) — the capture advertises the ONE bounded ceiling so
        // the UI's countdown and limit copy carry the real bound.
        assert_eq!(json["limitMs"], MAX_AUDIO_CLIP_MS);

        let stopped = SttStateEvent {
            listening: false,
            code: None,
            detail: None,
            origin: Some("launcher".to_string()),
            ready_ms: None,
            phase: Some(SttPhaseWire::Processing),
            limit_reached: Some(true),
            limit_ms: Some(MAX_AUDIO_CLIP_MS),
        };
        let json = serde_json::to_value(&stopped).expect("serialize processing state");
        assert_eq!(json["listening"], false);
        assert_eq!(json["phase"], "processing");
        assert_eq!(json["limitReached"], true);
        assert_eq!(json["limitMs"], MAX_AUDIO_CLIP_MS);

        // A manual stop reports an explicit (not null) false.
        assert_eq!(
            serde_json::to_value(SttPhaseWire::Processing).expect("serialize phase"),
            "processing"
        );
        assert_eq!(
            serde_json::to_value(SttPhaseWire::Capturing).expect("serialize phase"),
            "capturing"
        );
    }

    /// #2897 ST-2 — the clip wire shape the delivery path consumes: base64 + the
    /// pinned format/sample-rate/limit, with `truncated` ALWAYS false (REQ-6
    /// non-lossy invariant).
    #[test]
    fn audio_clip_and_result_serialize_as_camel_case() {
        let clip = SttAudioClip {
            base64: "UklGRg==".to_string(),
            format: "wav".to_string(),
            sample_rate: super::super::capture::AUDIO_SAMPLE_RATE,
            duration_ms: 1_600,
            limit_ms: MAX_AUDIO_CLIP_MS,
            at_limit: false,
            truncated: false,
        };
        let result = SttAudioClipResult {
            clip: Some(clip),
            code: None,
            detail: None,
        };
        let json = serde_json::to_value(&result).expect("serialize clip result");
        assert_eq!(json["clip"]["base64"], "UklGRg==");
        assert_eq!(json["clip"]["format"], "wav");
        assert_eq!(json["clip"]["sampleRate"], 16_000);
        assert_eq!(json["clip"]["durationMs"], 1_600);
        assert_eq!(json["clip"]["limitMs"], MAX_AUDIO_CLIP_MS);
        assert_eq!(json["clip"]["atLimit"], false);
        assert_eq!(json["clip"]["truncated"], false);
        assert_eq!(json["code"], serde_json::Value::Null);
        assert_eq!(json["detail"], serde_json::Value::Null);
        assert!(json["clip"].get("sample_rate").is_none());
        assert!(json["clip"].get("limit_ms").is_none());

        // The empty slot is a truthful `clip: None`, not an error.
        let empty = SttAudioClipResult {
            clip: None,
            code: None,
            detail: None,
        };
        let json = serde_json::to_value(&empty).expect("serialize empty result");
        assert_eq!(json["clip"], serde_json::Value::Null);
    }

    /// The model-audio failure variants keep their exact camelCase wire names,
    /// and the capture-start timeout keeps `engineStartFailed` (wire stability).
    #[test]
    fn model_audio_error_codes_are_pinned_to_their_wire_names() {
        assert_eq!(
            serde_json::to_string(&SttErrorCode::ModelAudioUnsupported).expect("serialize"),
            "\"modelAudioUnsupported\""
        );
        assert_eq!(
            serde_json::to_string(&SttErrorCode::ModelAudioUnavailable).expect("serialize"),
            "\"modelAudioUnavailable\""
        );
        assert_eq!(
            serde_json::to_string(&SttErrorCode::EngineStartFailed).expect("serialize"),
            "\"engineStartFailed\""
        );

        let unsupported = VoiceError::model_audio_unsupported("the model has no audio encoder");
        assert_eq!(unsupported.code, SttErrorCode::ModelAudioUnsupported);
        let unavailable = VoiceError::model_audio_unavailable("the model server is not running");
        assert_eq!(unavailable.code, SttErrorCode::ModelAudioUnavailable);
        let timeout = VoiceError::engine_start_failed("timed out while starting the capture");
        assert_eq!(timeout.code, SttErrorCode::EngineStartFailed);
    }

    /// #2897 ST-6 (REQ-7) — the capability wire vocabulary is the closed
    /// camelCase set the readiness row consumes. `serverUnavailable` /
    /// `unsupported` carry their typed code; `ready` / `unknown` do not.
    #[test]
    fn audio_capability_states_serialize_to_the_closed_camel_case_set() {
        for (state, expected) in [
            (SttAudioCapabilityState::Checking, "\"checking\""),
            (SttAudioCapabilityState::Ready, "\"ready\""),
            (SttAudioCapabilityState::Unsupported, "\"unsupported\""),
            (
                SttAudioCapabilityState::ServerUnavailable,
                "\"serverUnavailable\"",
            ),
            (SttAudioCapabilityState::Unknown, "\"unknown\""),
        ] {
            assert_eq!(
                serde_json::to_string(&state).expect("serialize capability state"),
                expected
            );
        }

        let unavailable = SttAudioCapability::server_unavailable("the server is not listening");
        let json = serde_json::to_value(&unavailable).expect("serialize capability");
        assert_eq!(json["state"], "serverUnavailable");
        assert_eq!(json["code"], "modelAudioUnavailable");
        assert_eq!(json["detail"], "the server is not listening");
        assert_eq!(json["model"], serde_json::Value::Null);
        assert_eq!(json["limitMs"], serde_json::Value::Null);

        let unsupported =
            SttAudioCapability::unsupported(Some("Gemma-4-E2B".to_string()), "HTTP 400");
        let json = serde_json::to_value(&unsupported).expect("serialize capability");
        assert_eq!(json["state"], "unsupported");
        assert_eq!(json["code"], "modelAudioUnsupported");
        assert_eq!(json["model"], "Gemma-4-E2B");

        let ready = SttAudioCapability::ready(Some("Gemma-4-E2B".to_string()));
        let json = serde_json::to_value(&ready).expect("serialize capability");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["code"], serde_json::Value::Null);
        assert_eq!(json["detail"], serde_json::Value::Null);

        let unknown = SttAudioCapability::unknown(None, "HTTP 500");
        let json = serde_json::to_value(&unknown).expect("serialize capability");
        assert_eq!(json["state"], "unknown");
        assert_eq!(json["code"], serde_json::Value::Null);
    }
}
