use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use typst::diag::{FileError, FileResult};
use typst::ecow::EcoString;
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_kit::datetime::Time;
use typst_kit::files::{FileLoader, FileStore, FsRoot};
use typst_kit::fonts::{FontPath, FontStore};
use typst_kit::packages::SystemPackages;

const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "ttc", "otc"];

/// Embedded and system fonts. Scanning the system is slow, so it happens once
/// and every project reuses the result.
pub struct BaseFonts {
    embedded: Vec<(Font, FontInfo)>,
    system: Vec<(PathBuf, u32, FontInfo)>,
}

static BASE_FONTS: OnceLock<Arc<BaseFonts>> = OnceLock::new();

impl BaseFonts {
    /// Loaded by the first window's compiler; later windows reuse it.
    pub fn shared() -> Arc<Self> {
        BASE_FONTS.get_or_init(|| Arc::new(Self::load())).clone()
    }

    pub fn load() -> Self {
        Self {
            embedded: typst_kit::fonts::embedded().collect(),
            system: typst_kit::fonts::system()
                .map(|(font, info)| (font.path, font.index, info))
                .collect(),
        }
    }

    /// Project fonts come first so they win over same-named system fonts.
    fn store<'a>(&self, project: impl Iterator<Item = &'a Font>) -> FontStore {
        let mut store = FontStore::new();
        store.extend(project.map(|font| (font.clone(), font.info().clone())));
        store.extend(self.system.iter().map(|(path, index, info)| {
            (FontPath { path: path.clone(), index: *index }, info.clone())
        }));
        store.extend(self.embedded.iter().cloned());
        store
    }
}

/// Serves in-memory buffers first, then the project folder or a package.
struct Loader {
    root: Option<FsRoot>,
    packages: SystemPackages,
    overlay: HashMap<FileId, Bytes>,
    disk: Mutex<HashMap<FileId, Bytes>>,
}

impl FileLoader for Loader {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(bytes) = self.overlay.get(&id) {
            return Ok(bytes.clone());
        }
        if let Some(bytes) = self.disk.lock().unwrap().get(&id) {
            return Ok(bytes.clone());
        }
        // Errors are not cached so a failed package download is retried.
        let bytes = match id.root() {
            VirtualRoot::Project => match &self.root {
                Some(root) => root.load(id.vpath())?,
                None => return Err(FileError::NotFound(id.vpath().get_without_slash().into())),
            },
            VirtualRoot::Package(spec) => self.packages.obtain(spec)?.load(id.vpath())?,
        };
        self.disk.lock().unwrap().insert(id, bytes.clone());
        Ok(bytes)
    }
}

pub struct TypsterWorld {
    library: LazyHash<Library>,
    base_fonts: Arc<BaseFonts>,
    project_fonts: HashMap<FileId, Vec<Font>>,
    fonts: FontStore,
    files: FileStore<Loader>,
    known: HashSet<FileId>,
    main: Option<FileId>,
    time: Time,
}

impl TypsterWorld {
    /// A project rooted in a folder, or a purely in-memory one when `root` is
    /// `None` (a shared session joined as guest).
    pub fn new(base_fonts: Arc<BaseFonts>, packages: SystemPackages, root: Option<PathBuf>) -> Self {
        let loader = Loader {
            root: root.map(FsRoot::new),
            packages,
            overlay: HashMap::new(),
            disk: Mutex::new(HashMap::new()),
        };
        Self {
            library: LazyHash::new(Library::default()),
            fonts: base_fonts.store(std::iter::empty()),
            base_fonts,
            project_fonts: HashMap::new(),
            files: FileStore::new(loader),
            known: HashSet::new(),
            main: None,
            time: Time::system(),
        }
    }

    pub fn has_main(&self) -> bool {
        self.main.is_some()
    }

    pub fn set_main(&mut self, path: Option<&str>) {
        self.main = path.and_then(project_id);
    }

    /// Registers files that exist on disk, so path completion knows them and
    /// fonts shipped with the project are usable.
    pub fn add_disk_files(&mut self, paths: &[String]) {
        for path in paths {
            let Some(id) = project_id(path) else { continue };
            self.known.insert(id);
            if is_font(path)
                && let Ok(bytes) = self.files.file(id)
            {
                self.project_fonts.insert(id, Font::iter(bytes).collect());
            }
        }
        self.rebuild_fonts();
    }

    pub fn set_file(&mut self, path: &str, data: Bytes) {
        let Some(id) = project_id(path) else { return };
        if is_font(path) {
            self.project_fonts.insert(id, Font::iter(data.clone()).collect());
            self.rebuild_fonts();
        }
        self.files.loader_mut().overlay.insert(id, data);
        self.known.insert(id);
        self.files.reset();
    }

    pub fn remove_file(&mut self, path: &str) {
        let Some(id) = project_id(path) else { return };
        let loader = self.files.loader_mut();
        loader.overlay.remove(&id);
        loader.disk.get_mut().unwrap().remove(&id);
        self.known.remove(&id);
        if self.project_fonts.remove(&id).is_some() {
            self.rebuild_fonts();
        }
        self.files.reset();
    }

    /// Project files held in memory (unsaved buffers, or everything for a guest).
    pub fn overlay(&self) -> impl Iterator<Item = (FileId, &Bytes)> {
        self.files.loader().overlay.iter().map(|(id, bytes)| (*id, bytes))
    }

    pub fn source_at(&self, path: &str) -> Option<Source> {
        self.source(project_id(path)?).ok()
    }

    /// Marks cached files stale before a compilation. Unchanged files are
    /// served again from memory and sources are re-parsed incrementally.
    pub fn prepare(&mut self) {
        self.files.reset();
        self.time.reset();
    }

    fn rebuild_fonts(&mut self) {
        self.fonts = self.base_fonts.store(self.project_fonts.values().flatten());
    }
}

impl World for TypsterWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main.or_else(|| project_id("main.typ")).expect("main.typ is a valid path")
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

impl IdeWorld for TypsterWorld {
    fn upcast(&self) -> &dyn World {
        self
    }

    fn packages(&self) -> &[(PackageSpec, Option<EcoString>)] {
        crate::packages::index()
    }

    fn files(&self) -> Vec<FileId> {
        self.known.iter().copied().collect()
    }
}

/// The id of a file inside the project, rejecting paths that escape it.
pub fn project_id(path: &str) -> Option<FileId> {
    let vpath = VirtualPath::new(path).ok().filter(|vpath| !vpath.is_root())?;
    Some(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

/// How a file is shown to the user: project-relative, or prefixed with its
/// package for files inside packages.
pub fn display_path(id: FileId) -> String {
    let path = id.vpath().get_without_slash();
    match id.root() {
        VirtualRoot::Project => path.to_string(),
        VirtualRoot::Package(spec) => format!("{spec}/{path}"),
    }
}

fn is_font(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| FONT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst_kit::downloader::SystemDownloader;
    use typst_layout::PagedDocument;

    /// An in-memory project, like a guest's: buffers only, no folder.
    #[test]
    fn compiles_buffers_and_answers_ide_requests() {
        let packages = SystemPackages::new(SystemDownloader::new("typster-test"));
        let mut world = TypsterWorld::new(Arc::new(BaseFonts::load()), packages, None);
        world.set_main(Some("main.typ"));
        world.set_file("main.typ", Bytes::from_string("= Hello\n#include \"chapter.typ\"\n"));
        world.set_file("chapter.typ", Bytes::from_string("World"));

        world.prepare();
        let doc = typst::compile::<PagedDocument>(&world).output.expect("project should compile");
        assert_eq!(doc.pages().len(), 1);

        world.set_file("main.typ", Bytes::from_string("= Hello\n#include \"chapter.typ\"\n#te"));
        let source = world.source_at("main.typ").unwrap();
        let (_, completions) =
            typst_ide::autocomplete(&world, Some(&doc), &source, source.text().len(), false).expect("completions after #te");
        assert!(completions.iter().any(|c| c.label == "text"));

        world.remove_file("chapter.typ");
        world.prepare();
        let errors = typst::compile::<PagedDocument>(&world).output.expect_err("include of a removed file fails");
        assert_eq!(errors[0].span.id().map(display_path).as_deref(), Some("main.typ"));
    }
}
