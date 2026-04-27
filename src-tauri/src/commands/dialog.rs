use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_dialog::FileDialogBuilder;

/// Open file dialog with .md/.txt/.markdown filter.
#[tauri::command]
pub async fn open_dialog(app: AppHandle) -> Result<Option<String>, String> {
    let result = FileDialogBuilder::new(app.dialog().clone())
        .add_filter("Markdown", &["md", "txt", "markdown"])
        .blocking_pick_file();

    match result {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// Save file dialog with default name suggestion.
/// Supports both Markdown and HTML filters.
#[tauri::command]
pub async fn save_dialog(app: AppHandle, default_name: String) -> Result<Option<String>, String> {
    // 根据 default_name 后缀决定过滤器
    let is_html = default_name.to_lowercase().ends_with(".html") || default_name.to_lowercase().ends_with(".htm");
    
    let builder = FileDialogBuilder::new(app.dialog().clone())
        .set_file_name(&default_name);
    
    let result = if is_html {
        builder
            .add_filter("HTML", &["html", "htm"])
            .add_filter("All Files", &["*"])
            .blocking_save_file()
    } else {
        builder
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("All Files", &["*"])
            .blocking_save_file()
    };

    match result {
        Some(path) => Ok(Some(path.to_string())),
        None => Ok(None),
    }
}

/// Show a confirmation dialog for unsaved changes on window close.
/// Returns true if user wants to close (Don't Save), false if cancelled.
/// NOTE: This uses blocking_show_with_result() which MUST be called from
/// a non-async context (spawn_blocking). Using it directly in an async
/// Tauri command will deadlock on some platforms.
#[tauri::command]
pub async fn confirm_close(app: AppHandle, _has_unsaved_changes: bool) -> Result<bool, String> {
    // Run the blocking dialog in a separate thread to avoid deadlocking
    // the Tauri async runtime
    let result = tokio::task::spawn_blocking(move || {
        app.dialog()
            .message("You have unsaved changes. Close without saving?")
            .title("MarkFlow — Unsaved Changes")
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show_with_result()
    })
    .await
    .map_err(|e| format!("Dialog task failed: {}", e))?;

    match result {
        MessageDialogResult::Yes => Ok(true),   // Close without saving
        MessageDialogResult::No => Ok(false),    // Cancel close
        _ => Ok(false),
    }
}
