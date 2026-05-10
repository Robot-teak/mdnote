#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use tauri::{Emitter, Manager, RunEvent};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use mdnote_lib::PENDING_FILE;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("no 'main' window found");
            eprintln!("[MDnote] Window URL: {:?}", window.url());

            // ─── 自定义 macOS 菜单 ───
            let about_item = MenuItem::with_id(app, "about", "About MDnote", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let hide = PredefinedMenuItem::hide(app, None)?;
            let hide_others = PredefinedMenuItem::hide_others(app, None)?;
            let show_all = PredefinedMenuItem::show_all(app, None)?;
            let quit = PredefinedMenuItem::quit(app, None)?;

            let app_name_menu = tauri::menu::Submenu::with_items(
                app,
                "MDnote",
                true,
                &[
                    &about_item,
                    &separator,
                    &hide,
                    &hide_others,
                    &show_all,
                    &separator,
                    &quit,
                ],
            )?;

            // ─── Edit 菜单（修复 Bug 5/6：macOS 需要 Edit 菜单才能让 WebView 中的剪贴板快捷键正常工作）───
            let undo_item = MenuItem::with_id(app, "undo", "Undo", true, None::<&str>)?;
            let redo_item = MenuItem::with_id(app, "redo", "Redo", true, None::<&str>)?;
            let cut_item = MenuItem::with_id(app, "cut", "Cut", true, None::<&str>)?;
            let copy_item = MenuItem::with_id(app, "copy", "Copy", true, None::<&str>)?;
            let paste_item = MenuItem::with_id(app, "paste", "Paste", true, None::<&str>)?;
            let select_all_item = MenuItem::with_id(app, "select-all", "Select All", true, None::<&str>)?;
            let edit_separator1 = PredefinedMenuItem::separator(app)?;
            let edit_separator2 = PredefinedMenuItem::separator(app)?;

            let edit_menu = tauri::menu::Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &undo_item,
                    &redo_item,
                    &edit_separator1,
                    &cut_item,
                    &copy_item,
                    &paste_item,
                    &edit_separator2,
                    &select_all_item,
                ],
            )?;

            let menu = Menu::with_items(app, &[&app_name_menu, &edit_menu])?;
            app.set_menu(menu)?;

            // 监听菜单事件
            app.on_menu_event(move |app_handle, event| {
                match event.id().as_ref() {
                    "about" => {
                        let _ = app_handle.emit("show-about-dialog", ());
                    }
                    // Edit 菜单事件：通过 JS 在 WebView 中执行对应操作
                    "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let cmd = event.id().as_ref();
                            let js = format!(
                                "if(window.__handleEditCommand)window.__handleEditCommand('{}')",
                                cmd
                            );
                            let _ = window.eval(&js);
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::export_pdf,
            commands::file::get_cli_args,
            commands::dialog::open_dialog,
            commands::dialog::save_dialog,
            commands::dialog::confirm_close,
            commands::file::get_pending_file,
            commands::file::reveal_in_finder,
            commands::file::set_window_title,
            commands::file::create_new_window,
            commands::file::open_file_in_new_window,
            commands::file::read_clipboard,
            commands::file::write_clipboard,
            commands::shell::open_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Opened { urls } = event {
                eprintln!("[MDnote] RunEvent::Opened: {:?}", urls);
                if !urls.is_empty() {
                    let url = urls[0].to_string();
                    eprintln!("[MDnote] Opening file: {}", url);

                    // 缓存文件路径
                    if let Ok(mut pending) = PENDING_FILE.lock() {
                        *pending = Some(url.clone());
                    }

                    // 方式1：emit 事件给前端
                    let _ = app_handle.emit("open-file-path", &url);

                    // 方式2：直接通过 webview eval 注入 JS（最可靠）
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let js = format!(
                            "if(window.__openFileByPath){{window.__openFileByPath({:?})}}else{{console.warn('[MDnote] __openFileByPath not registered yet')}}",
                            url
                        );
                        let _ = window.eval(&js);
                    }
                }
            }
        });
}
