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
