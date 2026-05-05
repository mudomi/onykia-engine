//! Implementation of the [`typst::World`] and `typst_ide::IdeWorld` traits
//! backed by the VFS.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use ecow::EcoString;
use rayon::prelude::*;
use typst::diag::{FileError, FileResult, PackageError};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_library::{Feature, Features};

use crate::packages;
use crate::vfs::Vfs;

pub struct OnykiaWorld {
    pub vfs: Vfs,
    pub main_path: Option<String>,

    /// Raw bytes of `index.json` per namespace
    package_indices: HashMap<EcoString, Vec<u8>>,
    /// Flat catalog
    indexed_packages: Vec<(PackageSpec, Option<EcoString>)>,
    /// Packages whose tarball has been unpacked into `vfs`.
    installed_packages: HashSet<PackageSpec>,
    /// Failed fetch attempts per package.
    failed_packages: HashMap<PackageSpec, u8>,
    pending_packages: Mutex<HashSet<PackageSpec>>,

    library: LazyHash<Library>,
    fonts: LazyHash<FontBook>,
    font_slots: Vec<Font>,
}

impl OnykiaWorld {
    const MAX_PACKAGE_FETCH_RETRIES: u8 = 3;

    pub fn new() -> Self {
        let mut world = Self {
            vfs: Vfs::new(),
            main_path: None,
            package_indices: HashMap::new(),
            indexed_packages: Vec::new(),
            installed_packages: HashSet::new(),
            failed_packages: HashMap::new(),
            pending_packages: Mutex::new(HashSet::new()),
            // Enable Feature::Html
            library: LazyHash::new(
                Library::builder()
                    .with_features(Features::from_iter([Feature::Html]))
                    .build(),
            ),
            fonts: LazyHash::new(FontBook::new()),
            font_slots: Vec::new(),
        };
        // Embed typst-cli's default fonts (Libertinus Serif, New Computer
        // Modern, NCM Math, DejaVu Sans Mono) directly into the WASM binary
        // via `typst-assets`. Hosts can still register additional fonts at
        // runtime via the `addFont` / `addFonts` dispatch calls.
        world.add_static_fonts(typst_assets::fonts());
        world
    }

    /// Register fonts whose bytes live in static memory (typically embedded
    /// via `include_bytes!`). Avoids the heap copy `add_font` performs.
    fn add_static_fonts(&mut self, files: impl IntoIterator<Item = &'static [u8]>) {
        self.add_font_files(files.into_iter().map(Bytes::new).collect());
    }

    /// Parse all faces of every supplied font file in parallel and commit
    /// them to `font_slots` + `FontBook` in one rebuild. Each `Font::new`
    /// is a self-contained sfnt parse, so this scales cleanly across the
    /// rayon pool initialised by `wasm_bindgen_rayon::init_thread_pool`.
    fn add_font_files(&mut self, files: Vec<Bytes>) {
        let parsed: Vec<Font> = files.into_par_iter().flat_map(parse_font_file).collect();
        self.font_slots.extend(parsed);
        self.rebuild_book();
    }

    fn rebuild_book(&mut self) {
        let mut book = FontBook::new();
        for font in &self.font_slots {
            book.push(font.info().clone());
        }
        self.fonts = LazyHash::new(book);
    }

    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.add_font_files(vec![Bytes::new(bytes)]);
    }

    pub fn add_fonts(&mut self, files: Vec<Vec<u8>>) {
        self.add_font_files(files.into_iter().map(Bytes::new).collect());
    }

    /// Replace the catalog for a namespace with the raw `index.json` bytes
    /// and rebuild the flat catalog. Empty bytes (`Uint8Array(0)`) clear the
    /// namespace; JS sends that for forbidden private scopes.
    pub fn set_package_index(&mut self, namespace: EcoString, data: Vec<u8>) {
        if data.is_empty() {
            self.package_indices.remove(&namespace);
        } else {
            self.package_indices.insert(namespace, data);
        }
        self.rebuild_indexed_packages();
    }

    fn rebuild_indexed_packages(&mut self) {
        let mut all = Vec::new();
        for (namespace, bytes) in &self.package_indices {
            all.extend(packages::parse_index(namespace, bytes));
        }
        self.indexed_packages = all;
    }

    /// Drain specs that World::file recorded as unresolved during the last
    /// compile pass. Failed specs are retried up to
    /// `MAX_PACKAGE_FETCH_RETRIES` times.
    pub fn take_pending_packages(&mut self) -> Vec<PackageSpec> {
        let drained: Vec<PackageSpec> = self
            .pending_packages
            .get_mut()
            .expect("pending_packages mutex poisoned")
            .drain()
            .collect();
        drained
            .into_iter()
            .filter(|s| self.can_retry_package(s) && !self.installed_packages.contains(s))
            .collect()
    }

    pub fn mark_package_installed(&mut self, spec: PackageSpec) {
        self.failed_packages.remove(&spec);
        self.installed_packages.insert(spec);
    }

    pub fn mark_package_failed(&mut self, spec: PackageSpec) {
        let attempts = self.failed_packages.entry(spec).or_insert(0);
        *attempts = attempts.saturating_add(1);
    }

    fn main_id(&self) -> Option<FileId> {
        let path = self.main_path.as_deref()?;
        Some(FileId::new(None, VirtualPath::new(path)))
    }

    /// Resolve a file/source FileId that carries a package spec.
    fn package_status(&self, id: FileId, spec: &PackageSpec) -> PackageStatus {
        if !self.can_retry_package(spec) {
            return PackageStatus::FetchFailed;
        }
        if self.installed_packages.contains(spec) {
            return PackageStatus::Installed;
        }
        // First time we see this spec during the current compile - record it
        // so dispatch::compile can fire a fetch and retry.
        if let Ok(mut pending) = self.pending_packages.lock() {
            pending.insert(spec.clone());
        }
        let _ = id;
        PackageStatus::Pending
    }

    fn can_retry_package(&self, spec: &PackageSpec) -> bool {
        self.failed_packages
            .get(spec)
            .map_or(true, |attempts| *attempts < Self::MAX_PACKAGE_FETCH_RETRIES)
    }
}

enum PackageStatus {
    Installed,
    Pending,
    FetchFailed,
}

fn parse_font_file(bytes: Bytes) -> Vec<Font> {
    let mut faces = Vec::new();
    for face_idx in 0u32.. {
        match Font::new(bytes.clone(), face_idx) {
            Some(font) => faces.push(font),
            None => break,
        }
    }
    faces
}

impl World for OnykiaWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.fonts
    }

    fn main(&self) -> FileId {
        self.main_id()
            .unwrap_or_else(|| FileId::new(None, VirtualPath::new("/__empty__.typ")))
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(spec) = id.package() {
            if let Some(entry) = self.vfs.find_package(id) {
                return entry.source().cloned().ok_or(FileError::NotSource);
            }
            return Err(self.package_file_error(id, spec));
        }
        if let Some((_, file)) = self.vfs.find_by_id(id) {
            if let Some(source) = file.source() {
                return Ok(source.clone());
            }
            return Err(FileError::NotSource);
        }
        // Empty sentinel so the compiler doesn't explode before setMain is called.
        if id == FileId::new(None, VirtualPath::new("/__empty__.typ")) {
            return Ok(Source::new(id, String::new()));
        }
        Err(FileError::NotFound(
            id.vpath().as_rooted_path().to_path_buf(),
        ))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(spec) = id.package() {
            if let Some(entry) = self.vfs.find_package(id) {
                return Ok(entry.bytes.clone());
            }
            return Err(self.package_file_error(id, spec));
        }
        if let Some((_, file)) = self.vfs.find_by_id(id) {
            return Ok(file.bytes.clone());
        }
        Err(FileError::NotFound(
            id.vpath().as_rooted_path().to_path_buf(),
        ))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.font_slots.get(index).cloned()
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        None
    }
}

impl OnykiaWorld {
    fn package_file_error(&self, id: FileId, spec: &PackageSpec) -> FileError {
        match self.package_status(id, spec) {
            PackageStatus::Installed => {
                FileError::NotFound(id.vpath().as_rooted_path().to_path_buf())
            }
            PackageStatus::Pending | PackageStatus::FetchFailed => {
                FileError::Package(PackageError::NotFound(spec.clone()))
            }
        }
    }
}

impl IdeWorld for OnykiaWorld {
    fn upcast(&self) -> &dyn World {
        self
    }

    fn packages(&self) -> &[(PackageSpec, Option<EcoString>)] {
        &self.indexed_packages
    }

    fn files(&self) -> Vec<FileId> {
        self.vfs.known_ids()
    }
}
