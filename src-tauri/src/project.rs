use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{State, Webview};

use crate::windows::Windows;

const SKIPPED_DIRS: [&str; 2] = ["node_modules", "target"];
// ponytail: flat cap on project size; switch to lazy loading if people open huge folders.
const MAX_FILES: usize = 5000;
/// The webview never loads bigger files, so they are never written either.
pub const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;

/// Modification time and length, used to notice edits made outside Typster.
type Stamp = (Option<SystemTime>, u64);

/// What a window has open. File commands only work on a folder and are
/// confined to it.
#[derive(Default)]
pub struct Project(Mutex<Mode>);

#[derive(Default)]
enum Mode {
    #[default]
    Closed,
    Folder(Open),
    /// An in-memory copy of someone else's shared project.
    Guest,
}

struct Open {
    root: PathBuf,
    known: HashMap<String, Stamp>,
}

/// What a window shows, for routing files opened from the OS.
#[derive(Debug, Clone, PartialEq)]
pub enum Workspace {
    Empty,
    Folder(PathBuf),
    Guest,
}

impl Project {
    fn with<T>(&self, f: impl FnOnce(&mut Open) -> Result<T, String>) -> Result<T, String> {
        match &mut *self.0.lock().unwrap() {
            Mode::Folder(open) => f(open),
            _ => Err("No project folder is open.".into()),
        }
    }

    fn set(&self, mode: Mode) {
        *self.0.lock().unwrap() = mode;
    }

    pub fn workspace(&self) -> Workspace {
        match &*self.0.lock().unwrap() {
            Mode::Closed => Workspace::Empty,
            Mode::Folder(open) => Workspace::Folder(open.root.clone()),
            Mode::Guest => Workspace::Guest,
        }
    }
}

#[derive(Serialize)]
pub struct FileMeta {
    path: String,
    size: u64,
}

#[derive(Serialize)]
pub struct ProjectInfo {
    root: String,
    name: String,
    main: Option<String>,
    files: Vec<FileMeta>,
}

#[derive(Serialize, Default)]
pub struct DiskChanges {
    changed: Vec<String>,
    added: Vec<FileMeta>,
    removed: Vec<String>,
}

/// Opens a folder, or the folder around a file which then becomes the main file.
#[tauri::command]
pub async fn open_project(webview: Webview, windows: State<'_, Windows>, path: String) -> Result<ProjectInfo, String> {
    let window = windows.of(&webview);
    let path = std::path::absolute(&path).map_err(|e| format!("{path}: {e}"))?;
    let (root, main) = if path.is_dir() {
        (path, None)
    } else if path.is_file() {
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned());
        (path.parent().ok_or("This file has no parent folder.")?.to_path_buf(), name)
    } else {
        return Err(format!("{} doesn't exist.", path.display()));
    };
    let (files, _) = walk(&root);
    let main = main.or_else(|| pick_main(&files));
    let info = ProjectInfo {
        root: root.display().to_string(),
        name: root.file_name().map_or_else(|| root.display().to_string(), |n| n.to_string_lossy().into_owned()),
        main: main.clone(),
        files: files.iter().map(|(path, meta)| FileMeta { path: path.clone(), size: meta.len() }).collect(),
    };
    window.engine.open(Some(root.clone()), main, files.iter().map(|(path, _)| path.clone()).collect());
    // Files the webview skips stay unknown, so nothing can overwrite them.
    let known = files
        .iter()
        .filter(|(_, meta)| meta.len() <= MAX_FILE_SIZE)
        .map(|(path, meta)| (path.clone(), stamp(meta)))
        .collect();
    window.project.set(Mode::Folder(Open { root, known }));
    Ok(info)
}

/// Switches to an in-memory project, used when joining someone else's session.
#[tauri::command]
pub fn open_guest(webview: Webview, windows: State<'_, Windows>) {
    let window = windows.of(&webview);
    window.project.set(Mode::Guest);
    window.engine.open(None, None, vec![]);
}

#[tauri::command]
pub fn close_project(webview: Webview, windows: State<'_, Windows>) {
    let window = windows.of(&webview);
    window.project.set(Mode::Closed);
    window.engine.open(None, None, vec![]);
}

#[tauri::command]
pub async fn read_file(webview: Webview, windows: State<'_, Windows>, path: String) -> Result<Response, String> {
    windows.of(&webview).project.with(|open| {
        let full = resolve(&open.root, &path)?;
        let data = fs::read(&full).map_err(|e| format!("{path}: {e}"))?;
        if let Ok(meta) = fs::metadata(&full) {
            open.known.insert(path, stamp(&meta));
        }
        Ok(Response::new(data))
    })
}

/// Body: a path frame (see [`split_frame`]). See [`check_overwrite`] for the
/// files it refuses to replace.
#[tauri::command]
pub async fn write_file(webview: Webview, windows: State<'_, Windows>, request: Request<'_>) -> Result<(), String> {
    let (path, data) = split_frame(request.body())?;
    if data.len() as u64 > MAX_FILE_SIZE {
        return Err(format!("{path} is over 20 MB."));
    }
    let force = request.headers().contains_key("x-force");
    windows.of(&webview).project.with(|open| {
        let full = resolve(&open.root, &path)?;
        check_overwrite(open.known.get(&path), &full, force)?;
        write_atomic(&full, data).map_err(|e| format!("{path}: {e}"))?;
        if let Ok(meta) = fs::metadata(&full) {
            open.known.insert(path, stamp(&meta));
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_file(webview: Webview, windows: State<'_, Windows>, path: String) -> Result<(), String> {
    windows.of(&webview).project.with(|open| {
        let full = resolve(&open.root, &path)?;
        // Collaborators can delete files too, so deletions must be recoverable,
        // and limited to files Typster loaded.
        if full.exists() && open.known.contains_key(&path) {
            trash::delete(&full).map_err(|e| format!("Couldn't move {path} to the trash: {e}"))?;
        }
        open.known.remove(&path);
        Ok(())
    })
}

#[tauri::command]
pub async fn rename_file(webview: Webview, windows: State<'_, Windows>, from: String, to: String) -> Result<(), String> {
    windows.of(&webview).project.with(|open| {
        let source = resolve(&open.root, &from)?;
        let target = resolve(&open.root, &to)?;
        if target.exists() {
            return Err(format!("{to} already exists."));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{to}: {e}"))?;
        }
        fs::rename(&source, &target).map_err(|e| format!("{from}: {e}"))?;
        open.known.remove(&from);
        if let Ok(meta) = fs::metadata(&target) {
            open.known.insert(to, stamp(&meta));
        }
        Ok(())
    })
}

/// Lists what changed on disk since files were last read or written.
#[tauri::command]
pub async fn scan_disk(webview: Webview, windows: State<'_, Windows>) -> Result<DiskChanges, String> {
    let window = windows.of(&webview);
    let project = &window.project;
    let root = project.with(|open| Ok(open.root.clone()))?;
    let (files, complete) = walk(&root);
    project.with(|open| {
        let mut changes = DiskChanges::default();
        if open.root != root {
            return Ok(changes);
        }
        for (path, meta) in &files {
            match open.known.get(path) {
                Some(known) if *known == stamp(meta) => {}
                Some(_) => changes.changed.push(path.clone()),
                None if meta.len() > MAX_FILE_SIZE => {}
                None => {
                    open.known.insert(path.clone(), stamp(meta));
                    changes.added.push(FileMeta { path: path.clone(), size: meta.len() });
                }
            }
        }
        // A truncated listing can't tell removed files from unlisted ones.
        if complete {
            let present: HashSet<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
            changes.removed = open.known.keys().filter(|path| !present.contains(path.as_str())).cloned().collect();
            for path in &changes.removed {
                open.known.remove(path);
            }
        }
        Ok(changes)
    })
}

/// Raw command bodies carry a file path and its data:
/// `[path length: u32 big-endian][path: UTF-8][data]`.
pub fn split_frame(body: &InvokeBody) -> Result<(String, &[u8]), String> {
    let InvokeBody::Raw(bytes) = body else { return Err("Expected a binary body.".into()) };
    let malformed = || "Malformed file frame.".to_string();
    let len = u32::from_be_bytes(bytes.get(..4).ok_or_else(malformed)?.try_into().unwrap()) as usize;
    let path = bytes.get(4..4 + len).ok_or_else(malformed)?;
    let path = String::from_utf8(path.to_vec()).map_err(|_| malformed())?;
    Ok((path, &bytes[4 + len..]))
}

/// Joins a project-relative path to the root. Paths come from collaborators
/// too, so this rejects anything that could point outside the root (`..`,
/// absolute paths, drive prefixes, symlinks) and anything [`walk`] skips.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let invalid = || format!("Invalid path: {rel}");
    if rel.is_empty() {
        return Err(invalid());
    }
    let mut full = root.to_path_buf();
    for component in Path::new(rel).components() {
        let Component::Normal(name) = component else { return Err(invalid()) };
        if is_skipped(&name.to_string_lossy()) {
            return Err(invalid());
        }
        full.push(name);
        if fs::symlink_metadata(&full).is_ok_and(|meta| meta.is_symlink()) {
            return Err(invalid());
        }
    }
    Ok(full)
}

/// Hidden entries and dependency folders are not part of a project.
fn is_skipped(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

/// Project files as `/`-separated relative paths. Skips hidden entries,
/// dependency folders and symlinks. Returns whether the listing is complete.
fn walk(root: &Path) -> (Vec<(String, fs::Metadata)>, bool) {
    let mut files = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(root.join(&dir)) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if is_skipped(name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let rel = dir.join(name);
            if meta.is_dir() {
                stack.push(rel);
            } else if meta.is_file() {
                files.push((posix(&rel), meta));
                if files.len() >= MAX_FILES {
                    return (files, false);
                }
            }
        }
    }
    (files, true)
}

fn posix(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// `main.typ` if present, otherwise the shallowest `.typ` file.
fn pick_main(files: &[(String, fs::Metadata)]) -> Option<String> {
    let typ = || files.iter().map(|(path, _)| path).filter(|path| path.ends_with(".typ"));
    typ()
        .find(|path| *path == "main.typ")
        .or_else(|| typ().min_by_key(|path| (path.matches('/').count(), path.as_str())))
        .cloned()
}

fn stamp(meta: &fs::Metadata) -> Stamp {
    (meta.modified().ok(), meta.len())
}

/// Never replaces a file Typster didn't load (`exists`): a collaborator could
/// otherwise overwrite a file the host never shared. Refuses one that changed
/// on disk since Typster last read or wrote it (`conflict`) unless forced.
fn check_overwrite(known: Option<&Stamp>, full: &Path, force: bool) -> Result<(), &'static str> {
    let Ok(meta) = fs::metadata(full) else { return Ok(()) };
    match known {
        None => Err("exists"),
        Some(known) if !force && *known != stamp(&meta) => Err("conflict"),
        Some(_) => Ok(()),
    }
}

/// Writes through a temporary file so a crash never leaves a half-written file.
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path.file_name().ok_or_else(|| io::Error::other("missing file name"))?;
    let tmp = path.with_file_name(format!(".{}.typster-tmp", name.to_string_lossy()));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_inside_root() {
        let root = Path::new("/project");
        assert_eq!(resolve(root, "a/b.typ").unwrap(), root.join("a/b.typ"));
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "./a", ".git/config", "a/.vscode/tasks.json", "node_modules/x.js", "target/x"] {
            assert!(resolve(root, bad).is_err(), "{bad} should be rejected");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_refuses_symlinks() {
        let dir = std::env::temp_dir().join(format!("typster-links-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("outside")).unwrap();
        assert!(resolve(&dir, "outside/x.typ").is_err());
        assert!(resolve(&dir, "outside").is_err());
        assert_eq!(resolve(&dir, "inside/x.typ").unwrap(), dir.join("inside/x.typ"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn frames_round_trip() {
        let name = "a/é.typ";
        let mut body = (name.len() as u32).to_be_bytes().to_vec();
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(b"data");
        let body = InvokeBody::Raw(body);
        let (path, data) = split_frame(&body).unwrap();
        assert_eq!((path.as_str(), data), ("a/é.typ", &b"data"[..]));
        assert!(split_frame(&InvokeBody::Raw(vec![0, 0, 0, 9, b'x'])).is_err());
    }

    #[test]
    fn conflicts_and_atomic_writes() {
        let dir = std::env::temp_dir().join(format!("typster-test-{}", std::process::id()));
        let file = dir.join("sub/main.typ");
        write_atomic(&file, b"one").unwrap();
        let known = stamp(&fs::metadata(&file).unwrap());
        assert_eq!(check_overwrite(Some(&known), &file, false), Ok(()));
        assert_eq!(check_overwrite(None, &file, true), Err("exists"), "files Typster didn't load are never replaced");
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&file, b"changed elsewhere").unwrap();
        assert_eq!(check_overwrite(Some(&known), &file, false), Err("conflict"));
        assert_eq!(check_overwrite(Some(&known), &file, true), Ok(()));
        assert_eq!(check_overwrite(None, &dir.join("missing.typ"), false), Ok(()));
        assert_eq!(fs::read(&file).unwrap(), b"changed elsewhere");
        let _ = fs::remove_dir_all(&dir);
    }
}
