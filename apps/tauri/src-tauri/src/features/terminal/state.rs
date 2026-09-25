use std::sync::{Arc, Mutex};

/// Live output retained per session (bytes). The terminal window replays this on
/// mount; it is trimmed oldest-first once the cap is exceeded.
pub const OUTPUT_BUFFER_CAP: usize = 256 * 1024;

/// Which kind of session a terminal runs. Wire form is lowercase
/// (`"opencode"` / `"copilot"` / `"shell"`). Spec #2942 renamed the former
/// 2-variant `TerminalCli` so a NON-CLI member (a plain OS shell) can live here
/// without the "CLI" misnomer; the persisted column stays `cli` and the two
/// existing wire values are unchanged (G-242 — no record rewrite).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    OpenCode,
    Copilot,
    /// A plain OS shell — the OS default terminal (PowerShell on Windows,
    /// `$SHELL` elsewhere) with NO agent. Wire `"shell"`, label "Terminal".
    Shell,
}

/// The session kind a new session defaults to: a plain Terminal (Spec #2942
/// R-3.1/R-3.4). Mirrors the UI's `DEFAULT_KIND` (`sessionModel.ts`).
pub const DEFAULT_KIND: SessionKind = SessionKind::Shell;

impl SessionKind {
    /// Parse the wire value sent by `spawn_terminal_session`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "opencode" => Some(Self::OpenCode),
            "copilot" => Some(Self::Copilot),
            "shell" => Some(Self::Shell),
            _ => None,
        }
    }

    /// The lowercase wire value — the inverse of [`Self::parse`], used when
    /// persisting a record column.
    pub fn wire(self) -> &'static str {
        match self {
            Self::OpenCode => "opencode",
            Self::Copilot => "copilot",
            Self::Shell => "shell",
        }
    }

    /// The human label, matching `CLI_LABEL` in the UI (`sessionModel.ts`).
    /// Used to mint a stable record title. The shell's user-facing label is
    /// "Terminal" (Spec #2942 R-3.1).
    pub fn label(self) -> &'static str {
        match self {
            Self::OpenCode => "OpenCode",
            Self::Copilot => "GitHub Copilot",
            Self::Shell => "Terminal",
        }
    }
}

/// The Terminal presentation mode (Spec #2947): whether Terminal opens inside
/// the main Fredo window or in its own native window. Wire form is kebab-case
/// (`"same-window"` / `"new-window"`), persisted under
/// [`TERMINAL_PRESENTATION_KEY`] (AppStore KV, via the frontend
/// `settingsService`). This is the ONE naming authority for the feature (ST-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalPresentation {
    /// Terminal renders inside the main Fredo window's in-window kernel.
    SameWindow,
    /// Terminal opens in the single native `terminal` window (shipped behaviour).
    NewWindow,
}

impl TerminalPresentation {
    /// The kebab-case wire value — the inverse of [`Self::parse`].
    pub fn wire(self) -> &'static str {
        match self {
            Self::SameWindow => "same-window",
            Self::NewWindow => "new-window",
        }
    }

    /// Parse a persisted wire value. `None` for an absent / blank / unrecognized
    /// value — the caller falls back to [`DEFAULT_PRESENTATION`] (R-4.1).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "same-window" => Some(Self::SameWindow),
            "new-window" => Some(Self::NewWindow),
            _ => None,
        }
    }
}

/// The presentation mode used for an absent/unrecognized stored value (R-4.1):
/// `new-window` preserves the shipped behaviour on upgrade (adjudication 2).
pub const DEFAULT_PRESENTATION: TerminalPresentation = TerminalPresentation::NewWindow;

/// AppStore KV key holding the persisted presentation wire value (the
/// Settings → Terminal "Presentation" control).
pub const TERMINAL_PRESENTATION_KEY: &str = "terminal_presentation_mode";

/// Event emitted to the active Terminal host when a same-window CLI launch has
/// armed an intent and an already-mounted workspace should drain it.
pub const TERMINAL_INTENT_AVAILABLE_EVENT: &str = "terminal-intent-available";

/// Compile-time witness that the ST-1 producer contract stays compiled and
/// warning-free while its runtime consumers land in later waves: ST-2's
/// `terminal_host_label` reads [`TERMINAL_PRESENTATION_KEY`] +
/// [`TerminalPresentation::parse`], and ST-5 emits
/// [`TERMINAL_INTENT_AVAILABLE_EVENT`]. This reference has no runtime effect; it
/// is removed once those consumers exist.
const _: () = {
    let _ = TerminalPresentation::SameWindow;
    let _ = TerminalPresentation::NewWindow;
    let _ = TerminalPresentation::wire;
    let _ = TerminalPresentation::parse;
    let _ = DEFAULT_PRESENTATION;
    let _ = TERMINAL_PRESENTATION_KEY;
    let _ = TERMINAL_INTENT_AVAILABLE_EVENT;
};

/// Lifecycle status of a single session (wire: lowercase).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalSessionStatus {
    /// Session row created, process not yet spawned.
    Starting,
    /// Process spawned and streaming.
    Running,
    /// Resolve / validation / prereq / spawn failed; `launch_error` carries the
    /// message and `error_kind` the cause.
    Error,
    /// Process ended on its own; row + buffer are retained.
    Exited,
}

/// Typed launch-failure kind (wire: kebab-case) so each in-window error state is
/// selected by cause, never by parsing message text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalErrorKind {
    /// The CLI binary could not be resolved on PATH (or the override is absent).
    MissingBinary,
    /// The PowerShell 6+ prerequisite for Copilot is unmet.
    Prereq,
    /// The working directory does not exist / is not a directory.
    InvalidCwd,
    /// The requested CLI name is not a known CLI (`opencode`/`copilot`) —
    /// refused before any process started (R-4.1).
    InvalidCli,
    /// The CLI reported an authentication failure on its first output.
    Auth,
    /// PTY open / command build / spawn failed.
    Launch,
    /// A persisted-record resume could not start (or reconnect to) its CLI
    /// session. Never substituted by a fresh session (R-4.3).
    ResumeFailed,
    /// Fallback when an error is present without a more specific kind.
    Generic,
}

/// One live terminal session: its process handles, PID, per-session output
/// buffer, and lifecycle metadata.
pub struct TerminalSession {
    pub id: String,
    pub cli: SessionKind,
    pub writer: Option<Box<dyn std::io::Write + Send>>,
    pub killer: Option<Box<dyn portable_pty::Child + Send>>,
    /// `child.process_id()` captured at spawn — the whole-tree kill anchor (AC5).
    pub pid: Option<u32>,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    /// PER-SESSION buffered output so routing and replay are session-scoped.
    pub output_buffer: Arc<Mutex<Vec<u8>>>,
    pub status: TerminalSessionStatus,
    pub error_kind: Option<TerminalErrorKind>,
    pub launch_error: Option<String>,
    pub work_dir: String,
    /// Epoch milliseconds — proves a session switch did not re-spawn.
    pub started_at: u64,
    pub cols: u16,
    pub rows: u16,
    /// This session was started by resuming a persisted record. A non-zero exit
    /// of such a session is a typed `resume-failed` (R-4.3), not a clean exit.
    pub resumed: bool,
}

impl TerminalSession {
    /// A freshly allocated session before any process exists.
    pub fn starting(id: String, cli: SessionKind, work_dir: String, cols: u16, rows: u16) -> Self {
        Self {
            id,
            cli,
            writer: None,
            killer: None,
            pid: None,
            master: None,
            output_buffer: Arc::new(Mutex::new(Vec::new())),
            status: TerminalSessionStatus::Starting,
            error_kind: None,
            launch_error: None,
            work_dir,
            started_at: now_ms(),
            cols,
            rows,
            resumed: false,
        }
    }

    /// Record a pre-spawn (or spawn) failure. Nothing is spawned on a failure
    /// path, so no orphan can exist.
    pub fn fail(&mut self, kind: TerminalErrorKind, message: String) {
        self.status = TerminalSessionStatus::Error;
        self.error_kind = Some(kind);
        self.launch_error = Some(message);
    }

}

/// Append `data`, trimming the oldest bytes so the buffer never exceeds `cap`.
pub fn append_capped(buffer: &Arc<Mutex<Vec<u8>>>, data: &[u8], cap: usize) {
    let mut buf = buffer.lock().unwrap();
    buf.extend_from_slice(data);
    if buf.len() > cap {
        let overflow = buf.len() - cap;
        buf.drain(..overflow);
    }
}

/// Epoch milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The session-keyed terminal state — replaces the former singleton.
#[derive(Default)]
pub struct TerminalState {
    pub sessions: Vec<TerminalSession>,
    pub active: Option<String>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<&TerminalSession> {
        self.sessions.iter().find(|s| s.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut TerminalSession> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    /// Insert a new `starting` session and mark it active.
    pub fn insert_starting(
        &mut self,
        id: String,
        cli: SessionKind,
        work_dir: String,
        cols: u16,
        rows: u16,
    ) {
        self.sessions
            .push(TerminalSession::starting(id.clone(), cli, work_dir, cols, rows));
        self.active = Some(id);
    }

    /// Remove a session and return it so its handles can be killed OUTSIDE the
    /// state lock.
    pub fn remove(&mut self, id: &str) -> Option<TerminalSession> {
        let idx = self.sessions.iter().position(|s| s.id == id)?;
        let removed = self.sessions.remove(idx);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        Some(removed)
    }

    /// Drain every session (window teardown) and clear the active selection.
    pub fn drain_sessions(&mut self) -> Vec<TerminalSession> {
        self.active = None;
        std::mem::take(&mut self.sessions)
    }
}

/// Self-exit message for a resumed session whose CLI could not reconnect.
pub const RESUME_FAILED_MESSAGE: &str =
    "Could not resume this session. Nothing was started; the saved session is unchanged.";

/// Mark a LIVE session as resumed, so a non-zero child exit is classified as a
/// typed `resume-failed` rather than a clean exit (R-4.3).
pub fn mark_resumed(state: &Mutex<TerminalState>, id: &str) {
    let mut guard = state.lock().unwrap();
    if let Some(session) = guard.get_mut(id) {
        session.resumed = true;
    }
}

/// Finalize a resumed session whose child exited NON-ZERO: a typed
/// `resume-failed` ERROR, never a silent fresh session. Idempotent with
/// [`finalize_exited`] — whichever runs first owns the one transition.
pub fn finalize_resume_failed(state: &Mutex<TerminalState>, id: &str) -> bool {
    let mut guard = state.lock().unwrap();
    match guard.get_mut(id) {
        Some(session)
            if session.status != TerminalSessionStatus::Exited
                && session.status != TerminalSessionStatus::Error =>
        {
            session.status = TerminalSessionStatus::Error;
            session.error_kind = Some(TerminalErrorKind::ResumeFailed);
            session.launch_error = Some(RESUME_FAILED_MESSAGE.to_string());
            session.writer = None;
            session.master = None;
            let _ = session.killer.take();
            true
        }
        _ => false,
    }
}

/// FX-4 (RC-2): the ONE idempotent exit finalization.
///
/// Both the per-session exit watcher and the reader loop's post-loop block call
/// this. It locks the state, requires the session to exist and not already be
/// `Exited`, then flips `status` to `Exited`, releases the PTY handles
/// (`writer`/`master`/`killer`) and returns `true`. Every later caller gets
/// `false`, so the `terminal-exited` + `terminal-sessions-changed` emission
/// happens exactly once per session. The row and its `output_buffer` are
/// retained (R-5.3); the window is never touched here (AC5).
pub fn finalize_exited(state: &Mutex<TerminalState>, id: &str) -> bool {
    let mut guard = state.lock().unwrap();
    match guard.get_mut(id) {
        Some(session)
            if session.status != TerminalSessionStatus::Exited
                && session.status != TerminalSessionStatus::Error =>
        {
            session.status = TerminalSessionStatus::Exited;
            session.writer = None;
            session.master = None;
            let _ = session.killer.take();
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer_with(cap: usize, chunks: &[&[u8]]) -> Vec<u8> {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        for chunk in chunks {
            append_capped(&buffer, chunk, cap);
        }
        let out = buffer.lock().unwrap().clone();
        out
    }

    // ── SessionKind wire parsing ────────────────────────────────────────────

    #[test]
    fn cli_parse_accepts_the_wire_values() {
        assert_eq!(SessionKind::parse("opencode"), Some(SessionKind::OpenCode));
        assert_eq!(SessionKind::parse("copilot"), Some(SessionKind::Copilot));
        assert_eq!(SessionKind::parse("shell"), Some(SessionKind::Shell));
    }

    #[test]
    fn cli_parse_rejects_anything_else() {
        assert_eq!(SessionKind::parse("legacy-cli"), None);
        assert_eq!(SessionKind::parse("OpenCode"), None);
        assert_eq!(SessionKind::parse(""), None);
        // The display label is NEVER a wire value — `shell` is the wire form.
        assert_eq!(SessionKind::parse("Terminal"), None);
    }

    #[test]
    fn cli_serializes_lowercase() {
        assert_eq!(serde_json::to_value(SessionKind::OpenCode).unwrap(), serde_json::json!("opencode"));
        assert_eq!(serde_json::to_value(SessionKind::Copilot).unwrap(), serde_json::json!("copilot"));
        assert_eq!(serde_json::to_value(SessionKind::Shell).unwrap(), serde_json::json!("shell"));
    }

    #[test]
    fn cli_deserializes_from_its_wire_value() {
        // The persisted record round-trips `cli` through its lowercase wire form.
        let opencode: SessionKind = serde_json::from_value(serde_json::json!("opencode")).unwrap();
        let copilot: SessionKind = serde_json::from_value(serde_json::json!("copilot")).unwrap();
        let shell: SessionKind = serde_json::from_value(serde_json::json!("shell")).unwrap();
        assert_eq!(opencode, SessionKind::OpenCode);
        assert_eq!(copilot, SessionKind::Copilot);
        assert_eq!(shell, SessionKind::Shell);
    }

    #[test]
    fn cli_wire_is_the_inverse_of_parse() {
        assert_eq!(SessionKind::OpenCode.wire(), "opencode");
        assert_eq!(SessionKind::Copilot.wire(), "copilot");
        assert_eq!(SessionKind::Shell.wire(), "shell");
        for kind in [SessionKind::OpenCode, SessionKind::Copilot, SessionKind::Shell] {
            assert_eq!(SessionKind::parse(kind.wire()), Some(kind));
        }
    }

    #[test]
    fn cli_labels_match_the_ui() {
        assert_eq!(SessionKind::OpenCode.label(), "OpenCode");
        assert_eq!(SessionKind::Copilot.label(), "GitHub Copilot");
        // Spec #2942 R-3.1 — the plain-shell kind's user-facing label.
        assert_eq!(SessionKind::Shell.label(), "Terminal");
    }

    #[test]
    fn default_kind_is_the_plain_shell() {
        // Spec #2942 R-3.1 — no stored default → a plain Terminal is preselected.
        assert_eq!(DEFAULT_KIND, SessionKind::Shell);
    }

    #[test]
    fn status_serializes_lowercase() {
        assert_eq!(serde_json::to_value(TerminalSessionStatus::Starting).unwrap(), serde_json::json!("starting"));
        assert_eq!(serde_json::to_value(TerminalSessionStatus::Running).unwrap(), serde_json::json!("running"));
        assert_eq!(serde_json::to_value(TerminalSessionStatus::Error).unwrap(), serde_json::json!("error"));
        assert_eq!(serde_json::to_value(TerminalSessionStatus::Exited).unwrap(), serde_json::json!("exited"));
    }

    #[test]
    fn error_kind_serializes_kebab_case() {
        assert_eq!(serde_json::to_value(TerminalErrorKind::MissingBinary).unwrap(), serde_json::json!("missing-binary"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::Prereq).unwrap(), serde_json::json!("prereq"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::InvalidCwd).unwrap(), serde_json::json!("invalid-cwd"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::InvalidCli).unwrap(), serde_json::json!("invalid-cli"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::Auth).unwrap(), serde_json::json!("auth"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::Launch).unwrap(), serde_json::json!("launch"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::ResumeFailed).unwrap(), serde_json::json!("resume-failed"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::Generic).unwrap(), serde_json::json!("generic"));
    }

    // ── Output buffer cap ───────────────────────────────────────────────────

    #[test]
    fn append_capped_keeps_the_newest_bytes_at_the_cap() {
        let buf = buffer_with(8, &[b"ABCD", b"EFGH", b"IJKL"]);
        assert_eq!(buf.len(), 8);
        assert_eq!(&buf, b"EFGHIJKL");
    }

    #[test]
    fn append_capped_handles_a_chunk_larger_than_the_cap() {
        let buf = buffer_with(4, &[b"0123456789"]);
        assert_eq!(buf.len(), 4);
        assert_eq!(&buf, b"6789");
    }

    #[test]
    fn output_buffer_cap_is_256kb() {
        assert_eq!(OUTPUT_BUFFER_CAP, 256 * 1024);
    }

    #[test]
    fn session_append_output_uses_the_live_cap() {
        let session = TerminalSession::starting(
            "s1".into(),
            SessionKind::OpenCode,
            "~".into(),
            80,
            24,
        );
        let chunk = vec![7u8; 4096];
        for _ in 0..70 {
            append_capped(&session.output_buffer, &chunk, OUTPUT_BUFFER_CAP);
        }
        let buf = session.output_buffer.lock().unwrap();
        assert!(buf.len() <= OUTPUT_BUFFER_CAP, "buffer exceeded the live cap: {}", buf.len());
        assert!(!buf.is_empty());
    }

    // ── Session map operations ──────────────────────────────────────────────

    fn state_with(id: &str, cli: SessionKind) -> TerminalState {
        let mut state = TerminalState::new();
        state.insert_starting(id.to_string(), cli, "~".into(), 80, 24);
        state
    }

    #[test]
    fn insert_starting_creates_a_starting_session_and_marks_it_active() {
        let state = state_with("s1", SessionKind::Copilot);
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.active.as_deref(), Some("s1"));
        let session = state.get("s1").unwrap();
        assert_eq!(session.cli, SessionKind::Copilot);
        assert_eq!(session.status, TerminalSessionStatus::Starting);
        assert_eq!(session.cols, 80);
        assert_eq!(session.rows, 24);
        assert!(session.started_at > 0);
        assert!(session.pid.is_none());
        assert!(session.launch_error.is_none());
        assert!(!session.resumed, "a fresh session is not a resume");
    }

    #[test]
    fn sessions_are_keyed_independently() {
        let mut state = state_with("a", SessionKind::OpenCode);
        state.insert_starting("b".into(), SessionKind::Copilot, "~".into(), 80, 24);
        assert_eq!(state.sessions.len(), 2);
        assert_eq!(state.active.as_deref(), Some("b"));
        assert_eq!(state.get("a").unwrap().cli, SessionKind::OpenCode);
        assert_eq!(state.get("b").unwrap().cli, SessionKind::Copilot);
        assert!(state.get("missing").is_none());
    }

    #[test]
    fn fail_marks_error_with_a_typed_kind() {
        let mut state = state_with("s1", SessionKind::Copilot);
        state.get_mut("s1").unwrap().fail(TerminalErrorKind::Prereq, "pwsh too old".into());
        let session = state.get("s1").unwrap();
        assert_eq!(session.status, TerminalSessionStatus::Error);
        assert_eq!(session.error_kind, Some(TerminalErrorKind::Prereq));
        assert_eq!(session.launch_error.as_deref(), Some("pwsh too old"));
    }

    #[test]
    fn remove_returns_the_session_and_clears_active() {
        let mut state = state_with("s1", SessionKind::OpenCode);
        let removed = state.remove("s1");
        assert!(removed.is_some());
        assert!(state.sessions.is_empty());
        assert!(state.active.is_none());
        assert!(state.remove("s1").is_none());
    }

    #[test]
    fn drain_sessions_empties_the_map_and_active() {
        let mut state = state_with("a", SessionKind::OpenCode);
        state.insert_starting("b".into(), SessionKind::Copilot, "~".into(), 80, 24);
        let drained = state.drain_sessions();
        assert_eq!(drained.len(), 2);
        assert!(state.sessions.is_empty());
        assert!(state.active.is_none());
    }

    // ── FX-4: idempotent exit finalization (RC-2) ───────────────────────────

    #[test]
    fn finalize_exited_transitions_once_and_retains_the_buffer() {
        let state = Mutex::new(state_with("s1", SessionKind::Copilot));
        {
            let mut guard = state.lock().unwrap();
            let session = guard.get_mut("s1").unwrap();
            session.status = TerminalSessionStatus::Running;
            append_capped(&session.output_buffer, b"GitHub Copilot CLI", OUTPUT_BUFFER_CAP);
        }

        // The winning caller (watcher or reader) transitions; every later
        // caller gets false and must not emit a second `terminal-exited`.
        assert!(finalize_exited(&state, "s1"));
        assert!(!finalize_exited(&state, "s1"));

        let guard = state.lock().unwrap();
        assert_eq!(guard.sessions.len(), 1, "the row is retained (R-5.3)");
        let session = guard.get("s1").unwrap();
        assert_eq!(session.status, TerminalSessionStatus::Exited);
        assert!(session.writer.is_none());
        assert!(session.master.is_none());
        assert!(session.killer.is_none());
        assert_eq!(
            session.output_buffer.lock().unwrap().as_slice(),
            b"GitHub Copilot CLI",
            "the retained buffer survives the exit transition (R-5.3)"
        );
    }

    #[test]
    fn finalize_exited_returns_false_for_an_unknown_session() {
        let state = Mutex::new(TerminalState::new());
        assert!(!finalize_exited(&state, "missing"));
    }

    #[test]
    fn finalize_exited_is_a_no_op_for_an_already_exited_session() {
        let state = Mutex::new(state_with("s1", SessionKind::OpenCode));
        {
            let mut guard = state.lock().unwrap();
            guard.get_mut("s1").unwrap().status = TerminalSessionStatus::Exited;
        }
        assert!(!finalize_exited(&state, "s1"));
    }

    // ── ST-2: resume-failure finalization ───────────────────────────────────

    #[test]
    fn mark_resumed_flags_the_session() {
        let state = Mutex::new(state_with("s1", SessionKind::OpenCode));
        assert!(!state.lock().unwrap().get("s1").unwrap().resumed);
        mark_resumed(&state, "s1");
        assert!(state.lock().unwrap().get("s1").unwrap().resumed);
    }

    #[test]
    fn finalize_resume_failed_transitions_once_to_a_typed_error() {
        let state = Mutex::new(state_with("s1", SessionKind::OpenCode));
        {
            let mut guard = state.lock().unwrap();
            guard.get_mut("s1").unwrap().status = TerminalSessionStatus::Running;
        }
        mark_resumed(&state, "s1");

        assert!(finalize_resume_failed(&state, "s1"));
        assert!(!finalize_resume_failed(&state, "s1"), "idempotent");
        // A later clean-exit finalization cannot override the failure.
        assert!(!finalize_exited(&state, "s1"));

        let guard = state.lock().unwrap();
        let session = guard.get("s1").unwrap();
        assert_eq!(session.status, TerminalSessionStatus::Error);
        assert_eq!(session.error_kind, Some(TerminalErrorKind::ResumeFailed));
        assert_eq!(session.launch_error.as_deref(), Some(RESUME_FAILED_MESSAGE));
        assert!(session.killer.is_none());
    }

    #[test]
    fn finalize_resume_failed_is_a_no_op_for_an_unknown_session() {
        let state = Mutex::new(TerminalState::new());
        assert!(!finalize_resume_failed(&state, "missing"));
    }

    // ── ST-1 (#2947): the TerminalPresentation shared contract ──────────────

    #[test]
    fn presentation_parse_accepts_the_wire_values() {
        assert_eq!(
            TerminalPresentation::parse("same-window"),
            Some(TerminalPresentation::SameWindow)
        );
        assert_eq!(
            TerminalPresentation::parse("new-window"),
            Some(TerminalPresentation::NewWindow)
        );
    }

    #[test]
    fn presentation_parse_trims_surrounding_whitespace() {
        assert_eq!(
            TerminalPresentation::parse("  same-window\n"),
            Some(TerminalPresentation::SameWindow)
        );
        assert_eq!(
            TerminalPresentation::parse("\tnew-window "),
            Some(TerminalPresentation::NewWindow)
        );
    }

    #[test]
    fn presentation_parse_rejects_absent_or_unrecognized_values() {
        // R-4.1 — the caller falls back to DEFAULT_PRESENTATION for every one.
        assert_eq!(TerminalPresentation::parse(""), None);
        assert_eq!(TerminalPresentation::parse("   "), None);
        assert_eq!(TerminalPresentation::parse("SameWindow"), None);
        assert_eq!(TerminalPresentation::parse("same_window"), None);
        assert_eq!(TerminalPresentation::parse("not-a-mode"), None);
    }

    #[test]
    fn presentation_wire_is_the_inverse_of_parse() {
        assert_eq!(TerminalPresentation::SameWindow.wire(), "same-window");
        assert_eq!(TerminalPresentation::NewWindow.wire(), "new-window");
        for mode in [
            TerminalPresentation::SameWindow,
            TerminalPresentation::NewWindow,
        ] {
            assert_eq!(TerminalPresentation::parse(mode.wire()), Some(mode));
        }
    }

    #[test]
    fn presentation_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(TerminalPresentation::SameWindow).unwrap(),
            serde_json::json!("same-window")
        );
        assert_eq!(
            serde_json::to_value(TerminalPresentation::NewWindow).unwrap(),
            serde_json::json!("new-window")
        );
    }

    #[test]
    fn presentation_deserializes_from_its_wire_value() {
        let same: TerminalPresentation =
            serde_json::from_value(serde_json::json!("same-window")).unwrap();
        let new: TerminalPresentation =
            serde_json::from_value(serde_json::json!("new-window")).unwrap();
        assert_eq!(same, TerminalPresentation::SameWindow);
        assert_eq!(new, TerminalPresentation::NewWindow);
    }

    #[test]
    fn default_presentation_is_new_window() {
        // R-4.1/AC5 — an absent/unrecognized value preserves today's
        // separate-window behaviour on upgrade.
        assert_eq!(DEFAULT_PRESENTATION, TerminalPresentation::NewWindow);
    }

    #[test]
    fn presentation_key_and_event_constants_are_pinned() {
        assert_eq!(TERMINAL_PRESENTATION_KEY, "terminal_presentation_mode");
        assert_eq!(TERMINAL_INTENT_AVAILABLE_EVENT, "terminal-intent-available");
    }
}
