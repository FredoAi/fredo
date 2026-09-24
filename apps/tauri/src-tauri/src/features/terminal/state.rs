use std::sync::{Arc, Mutex};

/// Live output retained per session (bytes). The terminal window replays this on
/// mount; it is trimmed oldest-first once the cap is exceeded.
pub const OUTPUT_BUFFER_CAP: usize = 256 * 1024;

/// Which CLI a session runs. Wire form is lowercase (`"opencode"` / `"copilot"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalCli {
    OpenCode,
    Copilot,
}

impl TerminalCli {
    /// Parse the wire value sent by `spawn_terminal_session`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "opencode" => Some(Self::OpenCode),
            "copilot" => Some(Self::Copilot),
            _ => None,
        }
    }
}

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
    /// The CLI reported an authentication failure on its first output.
    Auth,
    /// PTY open / command build / spawn failed.
    Launch,
    /// Fallback when an error is present without a more specific kind.
    Generic,
}

/// One live terminal session: its process handles, PID, per-session output
/// buffer, and lifecycle metadata.
pub struct TerminalSession {
    pub id: String,
    pub cli: TerminalCli,
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
}

impl TerminalSession {
    /// A freshly allocated session before any process exists.
    pub fn starting(id: String, cli: TerminalCli, work_dir: String, cols: u16, rows: u16) -> Self {
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
        cli: TerminalCli,
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
        Some(session) if session.status != TerminalSessionStatus::Exited => {
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

    // ── TerminalCli wire parsing ────────────────────────────────────────────

    #[test]
    fn cli_parse_accepts_the_wire_values() {
        assert_eq!(TerminalCli::parse("opencode"), Some(TerminalCli::OpenCode));
        assert_eq!(TerminalCli::parse("copilot"), Some(TerminalCli::Copilot));
    }

    #[test]
    fn cli_parse_rejects_anything_else() {
        assert_eq!(TerminalCli::parse("legacy-cli"), None);
        assert_eq!(TerminalCli::parse("OpenCode"), None);
        assert_eq!(TerminalCli::parse(""), None);
    }

    #[test]
    fn cli_serializes_lowercase() {
        assert_eq!(serde_json::to_value(TerminalCli::OpenCode).unwrap(), serde_json::json!("opencode"));
        assert_eq!(serde_json::to_value(TerminalCli::Copilot).unwrap(), serde_json::json!("copilot"));
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
        assert_eq!(serde_json::to_value(TerminalErrorKind::Auth).unwrap(), serde_json::json!("auth"));
        assert_eq!(serde_json::to_value(TerminalErrorKind::Launch).unwrap(), serde_json::json!("launch"));
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
            TerminalCli::OpenCode,
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

    fn state_with(id: &str, cli: TerminalCli) -> TerminalState {
        let mut state = TerminalState::new();
        state.insert_starting(id.to_string(), cli, "~".into(), 80, 24);
        state
    }

    #[test]
    fn insert_starting_creates_a_starting_session_and_marks_it_active() {
        let state = state_with("s1", TerminalCli::Copilot);
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.active.as_deref(), Some("s1"));
        let session = state.get("s1").unwrap();
        assert_eq!(session.cli, TerminalCli::Copilot);
        assert_eq!(session.status, TerminalSessionStatus::Starting);
        assert_eq!(session.cols, 80);
        assert_eq!(session.rows, 24);
        assert!(session.started_at > 0);
        assert!(session.pid.is_none());
        assert!(session.launch_error.is_none());
    }

    #[test]
    fn sessions_are_keyed_independently() {
        let mut state = state_with("a", TerminalCli::OpenCode);
        state.insert_starting("b".into(), TerminalCli::Copilot, "~".into(), 80, 24);
        assert_eq!(state.sessions.len(), 2);
        assert_eq!(state.active.as_deref(), Some("b"));
        assert_eq!(state.get("a").unwrap().cli, TerminalCli::OpenCode);
        assert_eq!(state.get("b").unwrap().cli, TerminalCli::Copilot);
        assert!(state.get("missing").is_none());
    }

    #[test]
    fn fail_marks_error_with_a_typed_kind() {
        let mut state = state_with("s1", TerminalCli::Copilot);
        state.get_mut("s1").unwrap().fail(TerminalErrorKind::Prereq, "pwsh too old".into());
        let session = state.get("s1").unwrap();
        assert_eq!(session.status, TerminalSessionStatus::Error);
        assert_eq!(session.error_kind, Some(TerminalErrorKind::Prereq));
        assert_eq!(session.launch_error.as_deref(), Some("pwsh too old"));
    }

    #[test]
    fn remove_returns_the_session_and_clears_active() {
        let mut state = state_with("s1", TerminalCli::OpenCode);
        let removed = state.remove("s1");
        assert!(removed.is_some());
        assert!(state.sessions.is_empty());
        assert!(state.active.is_none());
        assert!(state.remove("s1").is_none());
    }

    #[test]
    fn drain_sessions_empties_the_map_and_active() {
        let mut state = state_with("a", TerminalCli::OpenCode);
        state.insert_starting("b".into(), TerminalCli::Copilot, "~".into(), 80, 24);
        let drained = state.drain_sessions();
        assert_eq!(drained.len(), 2);
        assert!(state.sessions.is_empty());
        assert!(state.active.is_none());
    }

    // ── FX-4: idempotent exit finalization (RC-2) ───────────────────────────

    #[test]
    fn finalize_exited_transitions_once_and_retains_the_buffer() {
        let state = Mutex::new(state_with("s1", TerminalCli::Copilot));
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
        let state = Mutex::new(state_with("s1", TerminalCli::OpenCode));
        {
            let mut guard = state.lock().unwrap();
            guard.get_mut("s1").unwrap().status = TerminalSessionStatus::Exited;
        }
        assert!(!finalize_exited(&state, "s1"));
    }
}
