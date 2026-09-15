//! STT IPC wire types (`serde(rename_all = "camelCase")`).
//!
//! The vocabulary the Companion settings UI, the launcher listening cue and the
//! transcript stream client consume: the typed failure codes, the `stt_start`
//! result, the `stt:transcript` / `stt:state` payloads, and the input-device
//! enumeration returned by `stt_list_devices`.

use serde::Serialize;

/// Typed STT failure vocabulary. Serialized as `noDevice`, `permissionDenied`,
/// `modelMissing`, `modelCorrupt`, `engineStartFailed`, `alreadyListening`,
/// `disabled`, `internal`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttErrorCode {
    NoDevice,
    PermissionDenied,
    ModelMissing,
    ModelCorrupt,
    EngineStartFailed,
    AlreadyListening,
    Disabled,
    Internal,
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
    /// The DEVICE rate; the engine is fed [`super::engine::ENGINE_SAMPLE_RATE`].
    pub sample_rate: Option<u32>,
}

/// One `stt:transcript` payload. `text` is the CUMULATIVE text of the CURRENT
/// segment; `isFinal` is true on endpoint (segment closed).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptEvent {
    pub session_id: String,
    /// Monotonic per session; every emitted partial/final strictly increases it.
    pub revision: u64,
    /// Increments on each endpoint.
    pub segment_id: u32,
    pub text: String,
    pub is_final: bool,
    /// Last `accept_waveform` → this emit, in milliseconds.
    pub latency_ms: u64,
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

/// Internal typed error carried from capture/engine/session to the command
/// boundary. Never surfaced as a panic.
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

    pub fn model_missing(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelMissing, detail)
    }

    pub fn model_corrupt(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelCorrupt, detail)
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
}
