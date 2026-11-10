// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod packages;
mod project;
mod share;
mod windows;
mod world;

use std::path::Path;

use tauri::{DragDropEvent, Manager, WindowEvent};

use crate::windows::{Windows, paths_from_args};

/// Suggested display name for live sharing.
#[tauri::command]
fn default_name() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// The updater replaces the installed app, which on Linux only an AppImage can do;
/// distribution packages update through the package manager.
#[tauri::command]
fn updates_supported() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

fn main() {
    let app = tauri::Builder::default()
        // Must come first: a second launch hands its files to this process and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let windows = app.state::<Windows>();
            let paths = paths_from_args(args.get(1..).unwrap_or_default(), Path::new(&cwd));
            if paths.is_empty()
                && let Some(window) = app.webview_windows().values().next()
            {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            for path in paths {
                windows.open(app, path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Windows::default())
        .setup(|app| {
            packages::load_in_background(app.path().app_cache_dir().ok());
            let windows = app.state::<Windows>();
            // Register the first window so files from the command line can open in it.
            windows.get(app.handle(), "main");
            let cwd = std::env::current_dir().unwrap_or_default();
            let args: Vec<String> = std::env::args().skip(1).collect();
            for path in paths_from_args(&args, &cwd) {
                windows.open(app.handle(), path);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                window.state::<Windows>().dropped(window.app_handle(), window.label(), paths.clone());
            }
            WindowEvent::Destroyed => window.state::<Windows>().closed(window.label()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            default_name,
            updates_supported,
            windows::new_window,
            windows::take_pending_path,
            windows::read_dropped,
            project::open_project,
            project::open_guest,
            project::close_project,
            project::read_file,
            project::write_file,
            project::delete_file,
            project::rename_file,
            project::scan_disk,
            engine::set_file,
            engine::set_file_bytes,
            engine::remove_file,
            engine::set_main,
            engine::resend_preview,
            engine::complete,
            engine::tooltip,
            engine::jump_click,
            engine::jump_cursor,
            engine::export_pdf,
            engine::save_copy,
            share::share_host,
            share::share_join,
            share::share_send,
            share::share_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Typster");

    app.run(|_app, _event| {
        // macOS hands files opened from Finder to the running app instead of launching it again.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let windows = _app.state::<Windows>();
            for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                windows.open(_app, path);
            }
        }
    });
}
