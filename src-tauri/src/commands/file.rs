use std::fs;
use std::path::Path;
use std::process::Command;

/// Read a file from disk, return its content as String.
#[tauri::command]
pub fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(Path::new(path)).map_err(|e| e.to_string())
}

/// Write content to a file on disk.
#[tauri::command]
pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    fs::write(Path::new(path), content).map_err(|e| e.to_string())
}

/// Export as PDF: writes HTML to temp file and opens in system browser.
/// User can use the browser's "Print → Save as PDF" feature.
#[tauri::command]
pub fn export_pdf(html: &str, _output_path: &str) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join("markflow-export.html");

    // Add print-trigger script to the HTML
    let print_html = html.replace(
        "</body>",
        r#"<script>
window.onload = function() {
  setTimeout(function() { window.print(); }, 500);
};
</script>
</body>"#,
    );

    fs::write(&temp_file, print_html).map_err(|e| e.to_string())?;

    // Open in default browser
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&temp_file)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(temp_file.to_string_lossy().to_string())
}

/// Get CLI arguments (for opening files from command line)
#[tauri::command]
pub fn get_cli_args() -> Vec<String> {
    std::env::args().collect()
}

/// Get and clear the pending file path (from macOS "Open With" / file association).
/// Returns the file path if the app was launched by opening a file, None otherwise.
#[tauri::command]
pub fn get_pending_file() -> Option<String> {
    if let Ok(mut pending) = crate::PENDING_FILE.lock() {
        let result = pending.take();
        eprintln!("[MDnote] get_pending_file called, returning: {:?}", result);
        result
    } else {
        eprintln!("[MDnote] get_pending_file: PENDING_FILE lock failed");
        None
    }
}

/// Reveal a file in macOS Finder (select the file in its parent folder)
#[tauri::command]
pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path; // suppress unused warning
    }
    Ok(())
}

/// Set the window title dynamically
#[tauri::command]
pub fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}
