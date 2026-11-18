//! Chat / vision / audio command surface (Spec #3141; ST-1 created the split,
//! ST-3 re-points it in-process).
//!
//! The IPC names and argument shapes are identical to the pre-split
//! `commands.rs`, so `lib.rs` and `apps/ui` are untouched. The turns run on the
//! in-process engine ([`spawn_chat`] / [`spawn_audio_chat`]), and every path
//! settles through ONE guard: exactly one trailing `llm-done`.

use tauri::{AppHandle, Manager};

use crate::infrastructure::companion::PerformanceModeState;
use crate::infrastructure::voice::VoiceError;

use super::super::chat::LlmMessage;
use super::super::engine::stream::{AppSink, SettledStream};
use super::super::{skills, status};

/// Stream a companion chat message in-process.
#[tauri::command]
pub fn llm_chat(messages: Vec<LlmMessage>, app: AppHandle) -> Result<(), String> {
    spawn_chat(app, messages, None);
    Ok(())
}

/// Stream a companion vision chat: the image is attached to the last user message.
#[tauri::command]
pub fn llm_chat_with_image(
    messages: Vec<LlmMessage>,
    image_base64: String,
    app: AppHandle,
) -> Result<(), String> {
    spawn_chat(app, messages, Some(image_base64));
    Ok(())
}

/// Stream a companion model-audio chat: the captured clip IS the last user
/// message (exactly one `input_audio` part, no transcript text).
///
/// While Doom Mode is active the turn is suppressed through the shipped terminal
/// vocabulary (never a hang), keeping the shipped typed `disabled` code.
#[tauri::command]
pub fn llm_chat_with_audio(
    messages: Vec<LlmMessage>,
    audio_base64: String,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(error) = audio_suppression_refusal(
        app.state::<PerformanceModeState>().is_suppressed(),
    ) {
        let sink = AppSink::new(&app);
        let mut settled = SettledStream::new(&sink);
        for event in skills::plan_stream_error_events(&error.detail) {
            skills::emit_terminal_event(&mut settled, event);
        }
        return Ok(());
    }
    spawn_audio_chat(app, messages, audio_base64);
    Ok(())
}

/// Kick off a text/vision turn on a background task and return immediately.
///
/// `status::run_skill_stream` owns the settle, so no path here can double-settle
/// or hang: the turn emits through the shared terminal plan and its guard
/// guarantees exactly one trailing `llm-done`.
pub fn spawn_chat(app: AppHandle, messages: Vec<LlmMessage>, image_base64: Option<String>) {
    tauri::async_runtime::spawn(async move {
        let registry = status::companion_skill_registry();
        let turn = skills::skill_turn(messages, &registry, None, image_base64.as_deref());
        let _ = skills::run_skill_stream(&app, &registry, turn).await;
    });
}

/// Kick off a model-audio turn on a background task and return immediately.
///
/// The spoken turn offers the SAME registry as the typed path and settles on the
/// SAME channels (`llm-token` per delta, `llm-done` at the end, an ADDITIVE
/// readable `llm-error` before it on failure) — never a hang.
pub fn spawn_audio_chat(app: AppHandle, messages: Vec<LlmMessage>, audio_base64: String) {
    tauri::async_runtime::spawn(async move {
        let registry = status::companion_skill_registry();
        let turn = skills::skill_turn(messages, &registry, Some(&audio_base64), None);
        let _ = skills::run_skill_stream(&app, &registry, turn).await;
    });
}

/// The Doom Mode suppression refusal for the model-audio turn.
///
/// While Doom Mode is active the companion's model-audio turn is suppressed: the
/// refusal yields the shipped typed `disabled` error (no new error enum), so the
/// caller never shapes an audio turn. Pure, so the continuous suppression
/// invariant is hermetically pinned without an `AppHandle` (G-123).
pub(crate) fn audio_suppression_refusal(suppressed: bool) -> Option<VoiceError> {
    suppressed.then(VoiceError::disabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::voice::SttErrorCode;

    /// The suppression gate refuses ONLY while suppressed and reuses the shipped
    /// typed `disabled` code (no new error enum).
    #[test]
    fn audio_suppression_refusal_reuses_the_shipped_disabled_code() {
        assert!(
            audio_suppression_refusal(false).is_none(),
            "mode off must let the audio turn proceed"
        );

        let error =
            audio_suppression_refusal(true).expect("suppressed must refuse the audio turn");
        assert_eq!(error.code, SttErrorCode::Disabled);
        assert_eq!(error.detail, VoiceError::disabled().detail);
        assert_eq!(skills::plan_stream_error_events(&error.detail).len(), 2);
    }

    /// The CONTINUOUS suppression invariant — WHILE Doom Mode is active the
    /// model-audio turn stays refused across the whole window; after exit it is
    /// restored. Scoped to the owned `PerformanceModeState` (no global quantity),
    /// so the pin is deterministic under any suite order.
    #[test]
    fn continuous_suppression_keeps_the_turn_refused_while_active_and_restores_after_exit() {
        let state = PerformanceModeState::default();
        assert!(audio_suppression_refusal(state.is_suppressed()).is_none());

        state.set_suppressed(true);
        for sample in 0..3 {
            let error = audio_suppression_refusal(state.is_suppressed())
                .unwrap_or_else(|| panic!("sample {sample} must be refused while active"));
            assert_eq!(error.code, SttErrorCode::Disabled, "sample {sample}");
        }

        state.set_suppressed(false);
        assert!(
            audio_suppression_refusal(state.is_suppressed()).is_none(),
            "exit restores the model-audio turn"
        );
    }
}
