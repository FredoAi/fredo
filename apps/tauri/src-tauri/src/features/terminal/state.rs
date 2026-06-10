use std::sync::{Arc, Mutex};

pub struct RunCliState {
    pub writer: Option<Box<dyn std::io::Write + Send>>,
    pub killer: Option<Box<dyn portable_pty::Child + Send>>,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    pub correlation_id: Option<String>,
    /// Buffered PTY output so the terminal window can replay on mount.
    pub output_buffer: Arc<Mutex<Vec<u8>>>,
}

impl RunCliState {
    pub fn new() -> Self {
        Self {
            writer: None,
            killer: None,
            master: None,
            correlation_id: None,
            output_buffer: Arc::new(Mutex::new(Vec::new())),
        }
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
        assert_eq!(*default_state.output_buffer.lock().unwrap(), Vec::<u8>::new());

        assert!(new_state.writer.is_none());
        assert!(new_state.killer.is_none());
        assert!(new_state.master.is_none());
        assert!(new_state.correlation_id.is_none());
        assert_eq!(*new_state.output_buffer.lock().unwrap(), Vec::<u8>::new());
    }
}
