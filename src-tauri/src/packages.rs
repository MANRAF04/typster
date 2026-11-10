//! The package list behind `#import "@...` autocompletion: everything on
//! Typst Universe plus the user's local packages. Loaded in the background
//! once per launch; completions simply lack packages until it arrives.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use typst::ecow::EcoString;
use typst::syntax::package::PackageSpec;
use typst_kit::downloader::{Downloader, SystemDownloader};
use typst_kit::packages::FsPackages;

const INDEX_URL: &str = "https://packages.typst.org/preview/index.json";
/// The index is a few megabytes, so it is fetched at most once a day.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

type Index = Vec<(PackageSpec, Option<EcoString>)>;

static INDEX: OnceLock<Index> = OnceLock::new();

pub fn index() -> &'static [(PackageSpec, Option<EcoString>)] {
    INDEX.get().map_or(&[], Vec::as_slice)
}

pub fn load_in_background(cache_dir: Option<PathBuf>) {
    std::thread::spawn(move || {
        let cache = cache_dir.map(|dir| dir.join("package-index.json"));
        let mut index = universe(cache.as_deref()).and_then(|data| parse(&data)).unwrap_or_default();
        index.extend(local());
        let _ = INDEX.set(index);
    });
}

/// A fresh cached copy, else a download, else a stale copy when offline.
fn universe(cache: Option<&Path>) -> Option<Vec<u8>> {
    let read_cache = || cache.and_then(|path| std::fs::read(path).ok());
    let fresh = cache
        .and_then(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < MAX_AGE);
    if fresh {
        return read_cache();
    }
    let user_agent = concat!("typster/", env!("CARGO_PKG_VERSION"));
    match SystemDownloader::new(user_agent).download(&"package index", INDEX_URL) {
        Ok(data) => {
            if let Some(path) = cache {
                let _ = path.parent().map(std::fs::create_dir_all);
                let _ = std::fs::write(path, &data);
            }
            Some(data)
        }
        Err(_) => read_cache(),
    }
}

#[derive(Deserialize)]
struct Entry {
    name: String,
    version: String,
    description: Option<String>,
}

fn parse(data: &[u8]) -> Option<Index> {
    let entries: Vec<Entry> = serde_json::from_slice(data).ok()?;
    let index = entries
        .into_iter()
        .filter_map(|entry| {
            let spec = PackageSpec { namespace: "preview".into(), name: entry.name.into(), version: entry.version.parse().ok()? };
            Some((spec, entry.description.map(Into::into)))
        })
        .collect();
    Some(index)
}

/// Packages installed under `<data dir>/typst/packages/<namespace>/<name>/<version>`.
fn local() -> Index {
    let Some(packages) = FsPackages::system_data() else { return vec![] };
    let mut index = Vec::new();
    for namespace in subdirs(packages.path()) {
        for name in subdirs(&namespace) {
            for version in subdirs(&name) {
                let (Some(namespace), Some(name), Some(version)) =
                    (file_name(&namespace), file_name(&name), file_name(&version).and_then(|v| v.parse().ok()))
                else {
                    continue;
                };
                index.push((PackageSpec { namespace: namespace.into(), name: name.into(), version }, None));
            }
        }
    }
    index
}

fn subdirs(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(path) else { return vec![] };
    entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect()
}

fn file_name(path: &Path) -> Option<&str> {
    path.file_name()?.to_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_universe_index() {
        let json = br#"[
            {"name": "cetz", "version": "0.3.4", "description": "Drawing with Typst.", "authors": ["x"]},
            {"name": "broken", "version": "not-a-version"},
            {"name": "oxifmt", "version": "0.2.1"}
        ]"#;
        let index = parse(json).unwrap();
        assert_eq!(index.len(), 2, "entries with invalid versions are skipped");
        assert_eq!(index[0].0.to_string(), "@preview/cetz:0.3.4");
        assert_eq!(index[0].1.as_deref(), Some("Drawing with Typst."));
        assert_eq!(index[1].1, None);
        assert!(parse(b"not json").is_none());
    }
}
