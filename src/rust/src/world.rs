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
use typst::text::{
    Coverage, Font, FontBook, FontFlags, FontInfo, FontStretch, FontStyle, FontVariant, FontWeight,
};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_library::{Feature, Features};
use wasm_bindgen::JsValue;

use crate::packages;
use crate::vfs::Vfs;

pub struct OnykiaWorld {
    pub vfs: Vfs,
    pub main_path: Option<String>,

    package_indices: HashMap<EcoString, Vec<u8>>,
    indexed_packages: Vec<(PackageSpec, Option<EcoString>)>,
    installed_packages: HashSet<PackageSpec>,
    failed_packages: HashMap<PackageSpec, u8>,
    pending_packages: Mutex<HashSet<PackageSpec>>,

    library: LazyHash<Library>,
    fonts: LazyHash<FontBook>,
    /// `None` slots are stubs whose binary has not been delivered yet.
    font_slots: Vec<Option<Font>>,
    /// Parallel to `font_slots`, used to rebuild the `FontBook` cheaply.
    font_infos: Vec<FontInfo>,
    /// Slot index -> opaque key the JS host uses to look up the binary.
    font_stubs: HashMap<usize, EcoString>,
    pending_fonts: Mutex<HashSet<usize>>,
    failed_fonts: HashMap<usize, u8>,
}

impl OnykiaWorld {
    const MAX_PACKAGE_FETCH_RETRIES: u8 = 3;
    const MAX_FONT_FETCH_RETRIES: u8 = 3;

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
            font_infos: Vec::new(),
            font_stubs: HashMap::new(),
            pending_fonts: Mutex::new(HashSet::new()),
            failed_fonts: HashMap::new(),
        };
        // Embed typst-cli's default fonts (Libertinus Serif, New Computer
        // Modern, NCM Math, DejaVu Sans Mono) directly into the WASM binary
        // via `typst-assets`. Hosts can still register additional fonts at
        // runtime via the `addFont` / `addFonts` dispatch calls.
        world.add_static_fonts(typst_assets::fonts());
        world
    }

    // Avoids the heap copy that add_font performs.
    fn add_static_fonts(&mut self, files: impl IntoIterator<Item = &'static [u8]>) {
        self.add_font_files(files.into_iter().map(Bytes::new).collect());
    }

    // Parses all faces in parallel; commits to font_slots and FontBook in one rebuild.
    fn add_font_files(&mut self, files: Vec<Bytes>) {
        let parsed: Vec<Font> = files.into_par_iter().flat_map(parse_font_file).collect();
        for font in parsed {
            self.font_infos.push(font.info().clone());
            self.font_slots.push(Some(font));
        }
        self.rebuild_book();
    }

    fn rebuild_book(&mut self) {
        let mut book = FontBook::new();
        for info in &self.font_infos {
            book.push(info.clone());
        }
        self.fonts = LazyHash::new(book);
    }

    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.add_font_files(vec![Bytes::new(bytes)]);
    }

    pub fn add_fonts(&mut self, files: Vec<Vec<u8>>) {
        self.add_font_files(files.into_iter().map(Bytes::new).collect());
    }

    // Stubs appear in autocomplete immediately; bytes fetched lazily.
    pub fn add_font_stubs(&mut self, stubs: Vec<FontStub>) {
        for stub in stubs {
            let info = FontInfo {
                family: stub.family,
                variant: FontVariant {
                    style: stub.style.unwrap_or_default(),
                    weight: stub.weight.unwrap_or_default(),
                    stretch: stub.stretch.unwrap_or_default(),
                },
                flags: FontFlags::empty(),
                coverage: Coverage::from_vec(Vec::new()),
            };
            let index = self.font_slots.len();
            self.font_infos.push(info);
            self.font_slots.push(None);
            self.font_stubs.insert(index, stub.key);
        }
        self.rebuild_book();
    }

    pub fn take_pending_fonts(&mut self) -> Vec<(usize, EcoString)> {
        let drained: Vec<usize> = self
            .pending_fonts
            .get_mut()
            .expect("pending_fonts mutex poisoned")
            .drain()
            .collect();
        drained
            .into_iter()
            .filter(|i| self.can_retry_font(*i))
            .filter(|i| matches!(self.font_slots.get(*i), Some(None)))
            .filter_map(|i| self.font_stubs.get(&i).map(|k| (i, k.clone())))
            .collect()
    }

    pub fn install_font(&mut self, index: usize, bytes: Vec<u8>) -> Result<(), String> {
        let font = Font::new(Bytes::new(bytes), 0)
            .ok_or_else(|| format!("font slot {index}: failed to parse bytes"))?;
        let slot = self
            .font_slots
            .get_mut(index)
            .ok_or_else(|| format!("font slot {index}: out of bounds"))?;
        self.font_infos[index] = font.info().clone();
        *slot = Some(font);
        self.failed_fonts.remove(&index);
        self.rebuild_book();
        Ok(())
    }

    pub fn mark_font_failed(&mut self, index: usize) {
        let attempts = self.failed_fonts.entry(index).or_insert(0);
        *attempts = attempts.saturating_add(1);
    }

    fn can_retry_font(&self, index: usize) -> bool {
        self.failed_fonts
            .get(&index)
            .is_none_or(|attempts| *attempts < Self::MAX_FONT_FETCH_RETRIES)
    }

    // Empty bytes clear the namespace; JS sends that for forbidden private scopes.
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
            .is_none_or(|attempts| *attempts < Self::MAX_PACKAGE_FETCH_RETRIES)
    }
}

pub struct FontStub {
    pub family: String,
    pub key: EcoString,
    pub style: Option<FontStyle>,
    pub weight: Option<FontWeight>,
    pub stretch: Option<FontStretch>,
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
        match self.font_slots.get(index)? {
            Some(font) => Some(font.clone()),
            None => {
                if self.can_retry_font(index) && self.font_stubs.contains_key(&index) {
                    self.pending_fonts
                        .lock()
                        .expect("pending_fonts mutex poisoned")
                        .insert(index);
                }
                None
            }
        }
    }

    fn today(&self, offset: Option<i64>) -> Option<Datetime> {
        let (year, month, day) = match offset {
            None => {
                let now = js_sys::Date::new_0();
                (
                    now.get_full_year() as i32,
                    now.get_month() as u8 + 1, // JS months are 0-based.
                    now.get_date() as u8,
                )
            }
            Some(hours) => {
                let shifted = js_sys::Date::new(&JsValue::from_f64(
                    js_sys::Date::now() + hours as f64 * 3_600_000.0,
                ));
                (
                    shifted.get_utc_full_year() as i32,
                    shifted.get_utc_month() as u8 + 1,
                    shifted.get_utc_date() as u8,
                )
            }
        };

        Datetime::from_ymd(year, month, day)
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
