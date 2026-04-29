//! Implementation of the [`typst::World`] and `typst_ide::IdeWorld` traits
//! backed by the VFS.

use ecow::EcoString;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_library::{Feature, Features};

use crate::vfs::Vfs;

pub struct OnykiaWorld {
    pub vfs: Vfs,
    pub main_path: Option<String>,
    pub today: Option<Datetime>,

    library: LazyHash<Library>,
    fonts: LazyHash<FontBook>,
    font_slots: Vec<Font>,
}

impl OnykiaWorld {
    pub fn new() -> Self {
        let mut book = FontBook::new();
        let mut font_slots: Vec<Font> = Vec::new();

        for data in typst_assets::fonts() {
            let bytes = Bytes::new(data.to_vec());
            for face_idx in 0u32.. {
                match Font::new(bytes.clone(), face_idx) {
                    Some(font) => {
                        book.push(font.info().clone());
                        font_slots.push(font);
                    }
                    None => break,
                }
            }
        }

        Self {
            vfs: Vfs::new(),
            main_path: None,
            today: None,
            // Enable Feature::Html
            library: LazyHash::new(
                Library::builder()
                    .with_features(Features::from_iter([Feature::Html]))
                    .build(),
            ),
            fonts: LazyHash::new(book),
            font_slots,
        }
    }

    /// Parse one font file into `font_slots` without rebuilding the book.
    fn push_font_file(&mut self, bytes: Vec<u8>) {
        let bytes = Bytes::new(bytes);
        for face_idx in 0u32.. {
            match Font::new(bytes.clone(), face_idx) {
                Some(font) => self.font_slots.push(font),
                None => break,
            }
        }
    }

    /// Rebuild the `FontBook` from the current `font_slots`. Call after one or
    /// more `push_font_file` calls to commit the new fonts to the world.
    fn rebuild_book(&mut self) {
        let mut book = FontBook::new();
        for font in &self.font_slots {
            book.push(font.info().clone());
        }
        self.fonts = LazyHash::new(book);
    }

    /// Add a single font file (may contain multiple faces) and commit.
    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.push_font_file(bytes);
        self.rebuild_book();
    }

    /// Add multiple font files in one shot, rebuilding the book only once.
    pub fn add_fonts(&mut self, files: Vec<Vec<u8>>) {
        for bytes in files {
            self.push_font_file(bytes);
        }
        self.rebuild_book();
    }

    fn main_id(&self) -> Option<FileId> {
        let path = self.main_path.as_deref()?;
        Some(FileId::new(None, VirtualPath::new(path)))
    }
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
        self.today
    }
}

impl IdeWorld for OnykiaWorld {
    fn upcast(&self) -> &dyn World {
        self
    }

    fn packages(&self) -> &[(PackageSpec, Option<EcoString>)] {
        &[]
    }

    fn files(&self) -> Vec<FileId> {
        self.vfs.known_ids()
    }
}
