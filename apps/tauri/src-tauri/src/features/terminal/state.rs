use std::sync::{Arc, Mutex};

pub struct RunCliState {
    pub writer: Option<Box<dyn std::io::Write + Send>>,
    pub killer: Option<Box<dyn portable_pty::Child + Send>>,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    pub correlation_id: Option<String>,
    /// Buffered PTY output so the terminal window can replay on mount.
    pub output_buffer: Arc<Mutex<Vec<u8>>>,
    /// Resolve/spawn failure message, surfaced in-window via `get_run_cli_status`
    /// instead of a rejected `open_run_cli` invoke (AC5).
    pub launch_error: Option<String>,
    /// Resolved working directory of the running session (for the terminal
    /// window's toolbar title via `get_run_cli_status`).
    pub work_dir: Option<String>,
}

impl RunCliState {
    pub fn new() -> Self {
        Self {
            writer: None,
            killer: None,
            master: None,
            correlation_id: None,
            output_buffer: Arc::new(Mutex::new(Vec::new())),
            launch_error: None,
            work_dir: None,
        }
    }

    /// Append data to the output buffer, capping at 10MB (10,485,760 bytes).
    /// When the cap is exceeded, oldest data is discarded from the front.
    /// Must hold the Mutex during the operation.
    #[cfg(test)]
    pub fn append_output(&self, data: &[u8]) {
        let mut buf = self.output_buffer.lock().unwrap();
        let max_cap: usize = 10_485_760; // 10 MB
        let new_len = buf.len() + data.len();
        if new_len > max_cap {
            let excess = new_len - max_cap;
            if excess >= buf.len() {
                // New data is larger than the entire cap — drain everything
                buf.clear();
            } else {
                buf.drain(..excess);
            }
        }
        buf.extend_from_slice(data);
    }
}

impl Default for RunCliState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_cli_state_new_initializes_output_buffer_empty() {
        let state = RunCliState::new();
        assert!(state.writer.is_none());
        assert!(state.killer.is_none());
        assert!(state.master.is_none());
        assert!(state.correlation_id.is_none());
        assert!(state.launch_error.is_none());
        assert!(state.work_dir.is_none());
        assert_eq!(*state.output_buffer.lock().unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn run_cli_state_default_matches_new() {
        let default_state = RunCliState::default();
        let new_state = RunCliState::new();

        assert!(default_state.writer.is_none());
        assert!(default_state.killer.is_none());
        assert!(default_state.master.is_none());
        assert!(default_state.correlation_id.is_none());
        assert!(default_state.launch_error.is_none());
        assert!(default_state.work_dir.is_none());
        assert_eq!(*default_state.output_buffer.lock().unwrap(), Vec::<u8>::new());

        assert!(new_state.writer.is_none());
        assert!(new_state.killer.is_none());
        assert!(new_state.master.is_none());
        assert!(new_state.correlation_id.is_none());
        assert!(new_state.launch_error.is_none());
        assert!(new_state.work_dir.is_none());
        assert_eq!(*new_state.output_buffer.lock().unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn test_append_output_caps_at_10mb() {
        let state = RunCliState::new();
        let chunk = vec![0u8; 1024]; // 1KB chunk

        // Append 10.5 MB (slightly over the 10MB cap)
        for _ in 0..10_500 {
            state.append_output(&chunk);
        }

        let buf = state.output_buffer.lock().unwrap();
        assert!(buf.len() <= 10_485_760, "buffer exceeded 10MB cap, got {} bytes", buf.len());
        // Most recent data should be preserved
        assert!(!buf.is_empty(), "buffer should not be empty after capping");
    }

    #[test]
    fn test_append_output_preserves_recent_data() {
        let state = RunCliState::new();

        // Fill with marker bytes
        let marker_data = b"RECENT_DATA";
        for _ in 0..2000 {
            state.append_output(&[0u8; 8192]); // 8KB each = ~16MB total
        }
        state.append_output(marker_data);

        let buf = state.output_buffer.lock().unwrap();
        assert!(buf.len() <= 10_485_760, "buffer exceeded 10MB cap");
        // The marker data should be at the end
        assert_eq!(
            &buf[buf.len() - marker_data.len()..],
            marker_data,
            "most recent data should be preserved at end of buffer"
        );
    }
}
