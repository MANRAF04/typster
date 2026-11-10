use std::any::Any;
use std::num::NonZeroUsize;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, EventTarget, State, Webview};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use typst::{World, WorldExt};
use typst::diag::{Severity, SourceDiagnostic, Warned};
use typst::foundations::Bytes;
use typst::introspection::PagedPosition;
use typst::layout::{Abs, Point};
use typst::syntax::Side;
use typst::syntax::package::PackageSpec;
use typst::utils::hash128;
use typst_ide::{Completion, CompletionKind, Jump, Tooltip};
use typst_kit::downloader::{Progress, ProgressDownloader, ProgressReporter, SystemDownloader};
use typst_kit::packages::SystemPackages;
use typst_layout::{Page, PagedDocument};
use typst_pdf::PdfOptions;
use typst_svg::SvgOptions;

use crate::windows::Windows;
use crate::world::{BaseFonts, TypsterWorld, display_path};

/// Handle to the compiler thread, which owns the Typst world. Edits are queued
/// and the thread always compiles the newest state, so fast typing coalesces
/// into fewer compilations without a debounce timer.
pub struct Engine(Sender<Msg>);

enum Msg {
    Open { root: Option<PathBuf>, main: Option<String>, files: Vec<String> },
    SetMain(Option<String>),
    SetFile(String, Bytes),
    RemoveFile(String),
    Resend,
    Complete { path: String, offset: usize, explicit: bool, reply: oneshot::Sender<Option<Completions>> },
    Tooltip { path: String, offset: usize, before: bool, reply: oneshot::Sender<Option<Hover>> },
    JumpClick { page: usize, x: f64, y: f64, reply: oneshot::Sender<Option<Target>> },
    JumpCursor { path: String, offset: usize, reply: oneshot::Sender<Vec<Pos>> },
    ExportPdf { path: PathBuf, reply: oneshot::Sender<Result<(), String>> },
    SaveCopy { dir: PathBuf, reply: oneshot::Sender<Result<(), String>> },
}

impl Msg {
    fn is_edit(&self) -> bool {
        matches!(self, Msg::Open { .. } | Msg::SetMain(_) | Msg::SetFile(..) | Msg::RemoveFile(_) | Msg::Resend)
    }
}

#[derive(Serialize, Clone)]
struct Compiled {
    /// `None` when compilation failed and the last good preview should stay.
    pages: Option<Vec<PageOut>>,
    diagnostics: Vec<Diag>,
    ms: u64,
}

#[derive(Serialize, Clone)]
struct PageOut {
    w: f64,
    h: f64,
    /// `None` when the page is unchanged since the previous result.
    svg: Option<String>,
}

/// Offsets are UTF-16 code units, matching the editor.
#[derive(Serialize, Clone)]
struct Diag {
    path: Option<String>,
    from: usize,
    to: usize,
    line: Option<usize>,
    error: bool,
    message: String,
    hints: Vec<String>,
}

#[derive(Serialize)]
pub struct Completions {
    from: usize,
    items: Vec<Item>,
}

#[derive(Serialize)]
struct Item {
    label: String,
    kind: &'static str,
    detail: Option<String>,
    apply: Option<String>,
}

#[derive(Serialize)]
pub struct Hover {
    text: String,
    code: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    File { path: String, offset: usize },
    Position(Pos),
}

#[derive(Serialize)]
pub struct Pos {
    page: usize,
    x: f64,
    y: f64,
}

impl Engine {
    /// Starts the compiler for one window; its results are sent to that window only.
    pub fn spawn(app: AppHandle, window: String) -> Self {
        let (tx, rx) = channel();
        std::thread::Builder::new()
            .name("typst".into())
            // Deeply nested documents recurse deeply during layout.
            .stack_size(64 * 1024 * 1024)
            .spawn(move || run(app, EventTarget::webview_window(window), rx))
            .expect("failed to start the compiler thread");
        Self(tx)
    }

    pub fn open(&self, root: Option<PathBuf>, main: Option<String>, files: Vec<String>) {
        self.send(Msg::Open { root, main, files });
    }

    fn send(&self, msg: Msg) {
        // Fails only if the compiler thread is gone, which the next request reports.
        let _ = self.0.send(msg);
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        self.send(msg(tx));
        rx.await.map_err(|_| "The compiler stopped unexpectedly. Restart Typster.".to_string())
    }
}

struct Compiler {
    app: AppHandle,
    window: EventTarget,
    base_fonts: Arc<BaseFonts>,
    world: TypsterWorld,
    doc: Option<PagedDocument>,
    /// Whether `doc` reflects the current sources.
    fresh: bool,
    hashes: Vec<u128>,
    dirty: bool,
}

fn run(app: AppHandle, window: EventTarget, rx: Receiver<Msg>) {
    let base_fonts = BaseFonts::shared();
    let world = TypsterWorld::new(base_fonts.clone(), packages(&app, &window), None);
    let mut compiler = Compiler { app, window, base_fonts, world, doc: None, fresh: false, hashes: vec![], dirty: false };
    while let Ok(first) = rx.recv() {
        let mut batch: Vec<Msg> = std::iter::once(first).chain(rx.try_iter()).collect();
        // Requests in the same batch should see the newest text.
        batch.sort_by_key(|msg| !msg.is_edit());
        for msg in batch {
            compiler.handle(msg);
        }
        if compiler.dirty {
            compiler.compile();
        }
    }
}

impl Compiler {
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Open { root, main, files } => {
                self.world = TypsterWorld::new(self.base_fonts.clone(), packages(&self.app, &self.window), root);
                self.world.add_disk_files(&files);
                self.world.set_main(main.as_deref());
                self.doc = None;
                self.hashes.clear();
                self.dirty = true;
            }
            Msg::SetMain(path) => {
                self.world.set_main(path.as_deref());
                self.dirty = true;
            }
            Msg::SetFile(path, data) => {
                self.world.set_file(&path, data);
                self.dirty = true;
            }
            Msg::RemoveFile(path) => {
                self.world.remove_file(&path);
                self.dirty = true;
            }
            Msg::Resend => {
                self.hashes.clear();
                self.dirty = true;
            }
            Msg::Complete { path, offset, explicit, reply } => {
                let _ = reply.send(self.guard(|this| this.complete(&path, offset, explicit)).flatten());
            }
            Msg::Tooltip { path, offset, before, reply } => {
                let _ = reply.send(self.guard(|this| this.tooltip(&path, offset, before)).flatten());
            }
            Msg::JumpClick { page, x, y, reply } => {
                let _ = reply.send(self.guard(|this| this.jump_click(page, x, y)).flatten());
            }
            Msg::JumpCursor { path, offset, reply } => {
                let _ = reply.send(self.guard(|this| this.jump_cursor(&path, offset)).unwrap_or_default());
            }
            Msg::ExportPdf { path, reply } => {
                let _ = reply.send(self.export_pdf(&path));
            }
            Msg::SaveCopy { dir, reply } => {
                let _ = reply.send(self.save_copy(&dir));
            }
        }
    }

    /// Typst bugs must not take the compiler thread down with them.
    fn guard<T>(&mut self, f: impl FnOnce(&mut Self) -> T) -> Option<T> {
        catch_unwind(AssertUnwindSafe(|| f(self))).ok()
    }

    fn compile(&mut self) {
        self.dirty = false;
        if !self.world.has_main() {
            self.doc = None;
            self.hashes.clear();
            self.emit(Compiled { pages: Some(vec![]), diagnostics: vec![], ms: 0 });
            return;
        }
        let start = Instant::now();
        let result = self.guard(|this| {
            this.world.prepare();
            let Warned { output, warnings } = typst::compile::<PagedDocument>(&this.world);
            let mut diagnostics: Vec<Diag> = Vec::new();
            let pages = match output {
                Ok(doc) => {
                    let pages = this.diff_pages(&doc);
                    this.doc = Some(doc);
                    this.fresh = true;
                    Some(pages)
                }
                Err(errors) => {
                    this.fresh = false;
                    diagnostics.extend(errors.iter().map(|d| this.diag(d)));
                    None
                }
            };
            diagnostics.extend(warnings.iter().map(|d| this.diag(d)));
            (pages, diagnostics)
        });
        let (pages, diagnostics) = result.unwrap_or_else(|| {
            self.fresh = false;
            (None, vec![detached("Typst crashed while compiling this document. This is a bug in Typst; try changing the document.")])
        });
        self.emit(Compiled { pages, diagnostics, ms: start.elapsed().as_millis() as u64 });
        typst::comemo::evict(10);
    }

    fn emit(&self, compiled: Compiled) {
        let _ = self.app.emit_to(self.window.clone(), "compiled", compiled);
    }

    /// Renders only pages whose content changed since the last result.
    fn diff_pages(&mut self, doc: &PagedDocument) -> Vec<PageOut> {
        let hashes: Vec<u128> = doc.pages().iter().map(hash128).collect();
        let changed: Vec<&Page> = doc
            .pages()
            .iter()
            .zip(&hashes)
            .enumerate()
            .filter(|(i, (_, hash))| self.hashes.get(*i) != Some(*hash))
            .map(|(_, (page, _))| page)
            .collect();
        let mut svgs = render(&changed).into_iter();
        let pages = doc
            .pages()
            .iter()
            .enumerate()
            .map(|(i, page)| PageOut {
                w: page.frame.width().to_pt(),
                h: page.frame.height().to_pt(),
                svg: if self.hashes.get(i) == Some(&hashes[i]) { None } else { svgs.next() },
            })
            .collect();
        self.hashes = hashes;
        pages
    }

    fn diag(&self, diag: &SourceDiagnostic) -> Diag {
        let id = diag.span.id();
        let source = id.and_then(|id| self.world.source(id).ok());
        let range = self.world.range(diag.span);
        let (from, to, line) = match (source, range) {
            (Some(source), Some(range)) => {
                let lines = source.lines();
                (
                    lines.byte_to_utf16(range.start).unwrap_or(0),
                    lines.byte_to_utf16(range.end).unwrap_or(0),
                    lines.byte_to_line(range.start),
                )
            }
            _ => (0, 0, None),
        };
        Diag {
            path: id.map(display_path),
            from,
            to,
            line,
            error: diag.severity == Severity::Error,
            message: diag.message.to_string(),
            hints: diag.hints.iter().map(|hint| hint.v.to_string()).collect(),
        }
    }

    fn complete(&self, path: &str, offset: usize, explicit: bool) -> Option<Completions> {
        let source = self.world.source_at(path)?;
        let cursor = source.lines().utf16_to_byte(offset)?;
        let (from, items) = typst_ide::autocomplete(&self.world, self.doc.as_ref(), &source, cursor, explicit)?;
        Some(Completions {
            from: source.lines().byte_to_utf16(from)?,
            items: items.into_iter().map(item).collect(),
        })
    }

    fn tooltip(&self, path: &str, offset: usize, before: bool) -> Option<Hover> {
        let source = self.world.source_at(path)?;
        let cursor = source.lines().utf16_to_byte(offset)?;
        let side = if before { Side::Before } else { Side::After };
        Some(match typst_ide::tooltip(&self.world, self.doc.as_ref(), &source, cursor, side)? {
            Tooltip::Text(text) => Hover { text: text.into(), code: false },
            Tooltip::Code(text) => Hover { text: text.into(), code: true },
        })
    }

    fn jump_click(&self, page: usize, x: f64, y: f64) -> Option<Target> {
        let doc = self.doc.as_ref()?;
        let click = PagedPosition { page: NonZeroUsize::new(page + 1)?, point: Point::new(Abs::pt(x), Abs::pt(y)) };
        match typst_ide::jump_from_click(&self.world, doc, &click)? {
            Jump::File(id, byte) => {
                let offset = self.world.source(id).ok()?.lines().byte_to_utf16(byte)?;
                Some(Target::File { path: display_path(id), offset })
            }
            Jump::Url(url) => {
                // Shared documents are untrusted: never hand file:// or custom schemes to the OS.
                if ["https://", "http://", "mailto:"].iter().any(|scheme| url.starts_with(scheme)) {
                    let _ = self.app.opener().open_url(url.as_str(), None::<&str>);
                }
                None
            }
            Jump::Position(position) => Some(Target::Position(pos(position))),
        }
    }

    fn jump_cursor(&self, path: &str, offset: usize) -> Vec<Pos> {
        let (Some(doc), Some(source)) = (self.doc.as_ref(), self.world.source_at(path)) else {
            return vec![];
        };
        let Some(cursor) = source.lines().utf16_to_byte(offset) else { return vec![] };
        typst_ide::jump_from_cursor(doc, &source, cursor).into_iter().map(pos).collect()
    }

    fn export_pdf(&mut self, path: &Path) -> Result<(), String> {
        let doc = self.doc.as_ref().filter(|_| self.fresh).ok_or("Fix the errors before exporting.")?;
        let pdf = match catch_unwind(AssertUnwindSafe(|| typst_pdf::pdf(doc, &PdfOptions::default()))) {
            Ok(Ok(pdf)) => pdf,
            Ok(Err(errors)) => return Err(errors.first().map_or("PDF export failed.".into(), |e| e.message.to_string())),
            Err(_) => return Err("Typst crashed while exporting the PDF.".into()),
        };
        std::fs::write(path, pdf).map_err(|e| format!("Couldn't write {}: {e}", path.display()))
    }

    fn save_copy(&self, dir: &Path) -> Result<(), String> {
        for (id, bytes) in self.world.overlay() {
            let path = id.vpath().realize(dir).map_err(|e| format!("{e:?}"))?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, bytes.as_slice()).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(())
    }
}

/// SVG rendering is independent per page, so a fresh document renders on all cores.
fn render(pages: &[&Page]) -> Vec<String> {
    let options = SvgOptions::default();
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    if pages.len() < 4 || threads == 1 {
        return pages.iter().map(|page| typst_svg::svg(page, &options)).collect();
    }
    std::thread::scope(|scope| {
        let workers: Vec<_> = pages
            .chunks(pages.len().div_ceil(threads))
            .map(|chunk| {
                let options = &options;
                scope.spawn(move || chunk.iter().map(|page| typst_svg::svg(page, options)).collect::<Vec<_>>())
            })
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_default()).collect()
    })
}

fn item(completion: Completion) -> Item {
    let kind = match completion.kind {
        CompletionKind::Syntax => "keyword",
        CompletionKind::Func => "function",
        CompletionKind::Type => "type",
        CompletionKind::Param => "property",
        CompletionKind::Constant => "constant",
        CompletionKind::Package => "namespace",
        CompletionKind::Path | CompletionKind::Label | CompletionKind::Font | CompletionKind::Symbol(_) => "text",
    };
    let detail = match &completion.kind {
        CompletionKind::Symbol(symbol) => Some(symbol.to_string()),
        _ => completion.detail.map(Into::into),
    };
    Item { label: completion.label.into(), kind, detail, apply: completion.apply.map(Into::into) }
}

fn pos(position: PagedPosition) -> Pos {
    Pos { page: position.page.get() - 1, x: position.point.x.to_pt(), y: position.point.y.to_pt() }
}

fn detached(message: &str) -> Diag {
    Diag { path: None, from: 0, to: 0, line: None, error: true, message: message.into(), hints: vec![] }
}

/// Package storage that reports downloads, which can take a while on first use.
fn packages(app: &AppHandle, window: &EventTarget) -> SystemPackages {
    let (app, window) = (app.clone(), window.clone());
    let user_agent = concat!("typster/", env!("CARGO_PKG_VERSION"));
    SystemPackages::new(ProgressDownloader::new(SystemDownloader::new(user_agent), move |key: &dyn Any| {
        DownloadStatus {
            app: app.clone(),
            window: window.clone(),
            label: key.downcast_ref::<PackageSpec>().map_or_else(|| "package index".into(), ToString::to_string),
        }
    }))
}

struct DownloadStatus {
    app: AppHandle,
    window: EventTarget,
    label: String,
}

impl ProgressReporter for DownloadStatus {
    fn start(&mut self, _: &Progress) {
        let _ = self.app.emit_to(self.window.clone(), "status", Some(format!("Downloading {}", self.label)));
    }

    fn update(&mut self, _: &Progress) {}

    fn finish(&mut self, _: &Progress) {
        let _ = self.app.emit_to(self.window.clone(), "status", None::<String>);
    }
}

#[tauri::command]
pub fn set_file(webview: Webview, windows: State<'_, Windows>, path: String, text: String) {
    windows.of(&webview).engine.send(Msg::SetFile(path, Bytes::from_string(text)));
}

#[tauri::command]
pub fn set_file_bytes(webview: Webview, windows: State<'_, Windows>, request: Request<'_>) -> Result<(), String> {
    let (path, data) = crate::project::split_frame(request.body())?;
    windows.of(&webview).engine.send(Msg::SetFile(path, Bytes::new(data.to_vec())));
    Ok(())
}

#[tauri::command]
pub fn remove_file(webview: Webview, windows: State<'_, Windows>, path: String) {
    windows.of(&webview).engine.send(Msg::RemoveFile(path));
}

#[tauri::command]
pub fn set_main(webview: Webview, windows: State<'_, Windows>, path: Option<String>) {
    windows.of(&webview).engine.send(Msg::SetMain(path));
}

#[tauri::command]
pub fn resend_preview(webview: Webview, windows: State<'_, Windows>) {
    windows.of(&webview).engine.send(Msg::Resend);
}

#[tauri::command]
pub async fn complete(
    webview: Webview,
    windows: State<'_, Windows>,
    path: String,
    offset: usize,
    explicit: bool,
) -> Result<Option<Completions>, String> {
    windows.of(&webview).engine.ask(|reply| Msg::Complete { path, offset, explicit, reply }).await
}

#[tauri::command]
pub async fn tooltip(webview: Webview, windows: State<'_, Windows>, path: String, offset: usize, before: bool) -> Result<Option<Hover>, String> {
    windows.of(&webview).engine.ask(|reply| Msg::Tooltip { path, offset, before, reply }).await
}

#[tauri::command]
pub async fn jump_click(webview: Webview, windows: State<'_, Windows>, page: usize, x: f64, y: f64) -> Result<Option<Target>, String> {
    windows.of(&webview).engine.ask(|reply| Msg::JumpClick { page, x, y, reply }).await
}

#[tauri::command]
pub async fn jump_cursor(webview: Webview, windows: State<'_, Windows>, path: String, offset: usize) -> Result<Vec<Pos>, String> {
    windows.of(&webview).engine.ask(|reply| Msg::JumpCursor { path, offset, reply }).await
}

#[tauri::command]
pub async fn export_pdf(webview: Webview, windows: State<'_, Windows>, path: PathBuf) -> Result<(), String> {
    windows.of(&webview).engine.ask(|reply| Msg::ExportPdf { path, reply }).await?
}

#[tauri::command]
pub async fn save_copy(webview: Webview, windows: State<'_, Windows>, dir: PathBuf) -> Result<(), String> {
    windows.of(&webview).engine.ask(|reply| Msg::SaveCopy { dir, reply }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::project_id;

    #[test]
    fn project_ids_reject_escapes() {
        assert!(project_id("chapters/a.typ").is_some());
        assert!(project_id("../secret.typ").is_none());
        assert!(project_id("").is_none());
        assert_eq!(display_path(project_id("chapters/a.typ").unwrap()), "chapters/a.typ");
    }
}
