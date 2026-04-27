pub mod commands;

use std::sync::Mutex;

/// Cache for pending file path (macOS "Open With" may fire file-open before frontend is ready)
pub static PENDING_FILE: Mutex<Option<String>> = Mutex::new(None);
