//! Implementation of the [`typst::World`] and `typst_ide::IdeWorld` traits
//! backed by the VFS.

use ecow::EcoString;
use rayon::prelude::*;
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
        let mut world = Self {
            vfs: Vfs::new(),
            main_path: None,
            today: None,
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
        let parsed: Vec<Font> = files
            .into_par_iter()
            .flat_map(parse_font_file)
            .collect();
        self.font_slots.extend(parsed);
        self.rebuild_book();
    }

    /// Rebuild the `FontBook` from the current `font_slots`. Call after one or
    /// more font additions to commit them to the world.
    fn rebuild_book(&mut self) {
        let mut book = FontBook::new();
        for font in &self.font_slots {
            book.push(font.info().clone());
        }
        self.fonts = LazyHash::new(book);
    }

    /// Add a single font file (may contain multiple faces) and commit.
    pub fn add_font(&mut self, bytes: Vec<u8>) {
        self.add_font_files(vec![Bytes::new(bytes)]);
    }

    /// Add multiple font files in one shot, rebuilding the book only once.
    pub fn add_fonts(&mut self, files: Vec<Vec<u8>>) {
        self.add_font_files(files.into_iter().map(Bytes::new).collect());
    }

    fn main_id(&self) -> Option<FileId> {
        let path = self.main_path.as_deref()?;
        Some(FileId::new(None, VirtualPath::new(path)))
    }
}

/// Parse every face inside one font file. Free function so rayon's worker
/// closures don't capture `&mut self`.
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
