#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use tauri::{Emitter, Manager, RunEvent};
use tauri::menu::{Menu, MenuItem};
use mdnote_lib::PENDING_FILE;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("no 'main' window found");
            eprintln!("[MDnote] Window URL: {:?}", window.url());

            // ─── 自定义 macOS 菜单 ───
            // 拦截 About 菜单，让前端打开自定义 About 对话框
            let about_item = MenuItem::with_id(app, "about", "About MDnote", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let hide = tauri::menu::PredefinedMenuItem::hide(app, None)?;
            let hide_others = tauri::menu::PredefinedMenuItem::hide_others(app, None)?;
            let show_all = tauri::menu::PredefinedMenuItem::show_all(app, None)?;
            let quit = tauri::menu::PredefinedMenuItem::quit(app, None)?;

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

            let menu = Menu::with_items(app, &[&app_name_menu])?;
            app.set_menu(menu)?;

            // 监听 About 菜单点击，emit 事件给前端
            app.on_menu_event(move |app_handle, event| {
                if event.id() == "about" {
                    let _ = app_handle.emit("show-about-dialog", ());
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
