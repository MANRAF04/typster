//! Every window is an independent workspace with its own project, compiler
//! and live sharing session. A file opened from the OS goes to the window
//! that already shows its folder, else to an empty window, else to a new one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder};

use crate::engine::Engine;
use crate::project::{MAX_FILE_SIZE, Project, Workspace};
use crate::share::Share;

pub struct WindowState {
    pub engine: Engine,
    pub project: Project,
    pub share: Share,
    /// Files last dropped onto the window: the only outside files it may read.
    dropped: Mutex<Vec<PathBuf>>,
}

#[derive(Default)]
pub struct Windows {
    states: Mutex<HashMap<String, Arc<WindowState>>>,
    /// Paths a window should open once its frontend asks for them.
    pending: Mutex<HashMap<String, PathBuf>>,
    created: AtomicUsize,
}

impl Windows {
    pub fn of(&self, webview: &Webview) -> Arc<WindowState> {
        self.get(webview.app_handle(), webview.label())
    }

    pub fn get(&self, app: &AppHandle, label: &str) -> Arc<WindowState> {
        let mut states = self.states.lock().unwrap();
        let state = states.entry(label.to_string()).or_insert_with(|| {
            Arc::new(WindowState {
                engine: Engine::spawn(app.clone(), label.to_string()),
                project: Project::default(),
                share: Share::default(),
                dropped: Mutex::default(),
            })
        });
        state.clone()
    }

    pub fn closed(&self, label: &str) {
        self.pending.lock().unwrap().remove(label);
        if let Some(state) = self.states.lock().unwrap().remove(label) {
            tauri::async_runtime::spawn(async move { state.share.stop().await });
        }
    }

    pub fn dropped(&self, app: &AppHandle, label: &str, paths: Vec<PathBuf>) {
        *self.get(app, label).dropped.lock().unwrap() = paths;
    }

    /// Opens a folder or file in the most fitting window.
    pub fn open(&self, app: &AppHandle, path: PathBuf) {
        let path = std::path::absolute(&path).unwrap_or(path);
        let label = {
            let states = self.states.lock().unwrap();
            let pending = self.pending.lock().unwrap();
            let windows: Vec<(String, Workspace)> = states
                .iter()
                // A window about to open something isn't empty anymore.
                .filter(|(label, _)| !pending.contains_key(*label))
                .map(|(label, state)| (label.clone(), state.project.workspace()))
                .collect();
            destination(&windows, &path)
        };
        match label {
            Some(label) => {
                self.pending.lock().unwrap().insert(label.clone(), path);
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app.emit_to(EventTarget::webview_window(label), "open-pending", ());
            }
            None => self.create(app, Some(path)),
        }
    }

    pub fn create(&self, app: &AppHandle, path: Option<PathBuf>) {
        let label = format!("window-{}", self.created.fetch_add(1, Ordering::Relaxed) + 1);
        if let Some(path) = path {
            self.pending.lock().unwrap().insert(label.clone(), path);
        }
        let app = app.clone();
        // Building a window from the event loop thread can deadlock on Windows.
        tauri::async_runtime::spawn(async move {
            let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
                .title("Typster")
                .inner_size(1440.0, 900.0)
                .min_inner_size(720.0, 480.0)
                .build();
            if let Err(error) = window {
                eprintln!("Couldn't open a window: {error}");
            }
        });
    }
}

/// The window already showing the path's folder, else an empty one. `None`
/// means a new window is needed.
fn destination(windows: &[(String, Workspace)], path: &Path) -> Option<String> {
    let showing = windows.iter().find(|(_, workspace)| match workspace {
        Workspace::Folder(root) => path.starts_with(root),
        _ => false,
    });
    showing
        .or_else(|| windows.iter().find(|(_, workspace)| *workspace == Workspace::Empty))
        .map(|(label, _)| label.clone())
}

/// Turns command line arguments into absolute paths, skipping flags.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter().filter(|arg| !arg.starts_with('-')).map(|arg| cwd.join(arg)).collect()
}

#[tauri::command]
pub async fn new_window(app: AppHandle, windows: State<'_, Windows>) -> Result<(), String> {
    windows.create(&app, None);
    Ok(())
}

#[tauri::command]
pub fn take_pending_path(webview: Webview, windows: State<'_, Windows>) -> Option<String> {
    let path = windows.pending.lock().unwrap().remove(webview.label())?;
    Some(path.to_string_lossy().into_owned())
}

/// Reads a file dropped onto the window. Anything else is refused, so the
/// webview can't use this to read arbitrary files.
#[tauri::command]
pub async fn read_dropped(webview: Webview, windows: State<'_, Windows>, path: PathBuf) -> Result<Response, String> {
    let window = windows.of(&webview);
    if !window.dropped.lock().unwrap().contains(&path) {
        return Err("Only files dropped onto the window can be added.".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("Folders can't be added. Drop the files inside instead.".into());
    }
    if meta.len() > MAX_FILE_SIZE {
        return Err("Files over 20 MB can't be added.".into());
    }
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_go_to_the_window_showing_their_folder() {
        let windows = vec![
            ("guest".to_string(), Workspace::Guest),
            ("thesis".to_string(), Workspace::Folder(PathBuf::from("/docs/thesis"))),
            ("empty".to_string(), Workspace::Empty),
        ];
        let open = |path: &str| destination(&windows, Path::new(path));
        assert_eq!(open("/docs/thesis/chapters/a.typ").as_deref(), Some("thesis"));
        assert_eq!(open("/docs/thesis").as_deref(), Some("thesis"));
        assert_eq!(open("/docs/thesis-notes/a.typ").as_deref(), Some("empty"), "prefix of the name is not a parent");
        assert_eq!(destination(&windows[..2], Path::new("/elsewhere/a.typ")), None);
    }

    #[test]
    fn arguments_become_absolute_paths() {
        let args = ["-psn_0_1".to_string(), "a.typ".to_string(), "/abs/b.typ".to_string()];
        assert_eq!(paths_from_args(&args, Path::new("/home/me")), [PathBuf::from("/home/me/a.typ"), PathBuf::from("/abs/b.typ")]);
    }
}
