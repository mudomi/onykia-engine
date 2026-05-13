//! Virtual filesystem that backs the [`crate::world::OnykiaWorld`].
//!
//! Project files are keyed by absolute POSIX path ("/main.typ"); package
//! files are keyed by their interned `FileId` (which carries the spec). Text
//! sources are parsed into `typst_syntax::Source` once and cached until the
//! next edit.

use std::collections::HashMap;

use typst::foundations::Bytes;
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, Source, VirtualPath};

pub struct File {
    pub mime: String,
    pub bytes: Bytes,
    source: Option<Source>,
}

impl File {
    pub fn new(path: &str, mime: String, bytes: Bytes) -> Self {
        let id = FileId::new(None, VirtualPath::new(path));
        Self::with_id(id, mime, bytes)
    }

    fn with_id(id: FileId, mime: String, bytes: Bytes) -> Self {
        let source = build_source(id, &mime, &bytes);
        Self {
            mime,
            bytes,
            source,
        }
    }

    pub fn source(&self) -> Option<&Source> {
        self.source.as_ref()
    }
}

// Mime inferred from path extension; tar entries don't carry one.
pub struct PackageEntry {
    pub bytes: Bytes,
    source: Option<Source>,
}

impl PackageEntry {
    fn new(id: FileId, bytes: Bytes) -> Self {
        let mime = mime_for_vpath(id.vpath());
        let source = build_source(id, mime, &bytes);
        Self { bytes, source }
    }

    pub fn source(&self) -> Option<&Source> {
        self.source.as_ref()
    }
}

pub struct Vfs {
    files: HashMap<String, File>,
    file_ids: HashMap<FileId, String>,
    packages: HashMap<FileId, PackageEntry>,
}

impl Vfs {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
            file_ids: HashMap::new(),
            packages: HashMap::new(),
        }
    }

    pub fn create(&mut self, path: String, mime: String, bytes: Vec<u8>) {
        let id = FileId::new(None, VirtualPath::new(&path));
        self.file_ids.insert(id, path.clone());
        let bytes = Bytes::new(bytes);
        self.files
            .insert(path.clone(), File::new(&path, mime, bytes));
    }

    pub fn delete(&mut self, path: &str) -> bool {
        let id = FileId::new(None, VirtualPath::new(path));
        self.file_ids.remove(&id);
        self.files.remove(path).is_some()
    }

    pub fn rename(&mut self, from: &str, to: &str, mime: Option<String>) -> bool {
        let Some(mut file) = self.files.remove(from) else {
            return false;
        };
        if let Some(m) = mime {
            file.mime = m;
        }
        let old_id = FileId::new(None, VirtualPath::new(from));
        self.file_ids.remove(&old_id);
        let new_id = FileId::new(None, VirtualPath::new(to));
        self.file_ids.insert(new_id, to.to_string());
        // Rebuild source with new id.
        let rebuilt = File::new(to, file.mime, file.bytes);
        self.files.insert(to.to_string(), rebuilt);
        true
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.file_ids.clear();
        // Package caches survive a project clear: tarballs are immutable and
        // re-fetching them is expensive.
    }

    pub fn get(&self, path: &str) -> Option<&File> {
        self.files.get(path)
    }

    pub fn known_ids(&self) -> Vec<FileId> {
        self.file_ids.keys().copied().collect()
    }

    pub fn find_by_id(&self, id: FileId) -> Option<(&str, &File)> {
        if id.package().is_some() {
            return None;
        }
        let path = self.file_ids.get(&id)?;
        let file = self.files.get(path)?;
        Some((path.as_str(), file))
    }

    pub fn find_package(&self, id: FileId) -> Option<&PackageEntry> {
        self.packages.get(&id)
    }

    pub fn install_package_file(&mut self, spec: &PackageSpec, vpath: &str, bytes: Vec<u8>) {
        let id = FileId::new(Some(spec.clone()), VirtualPath::new(vpath));
        self.packages
            .insert(id, PackageEntry::new(id, Bytes::new(bytes)));
    }

    pub fn edit(&mut self, path: &str, edits: &[Edit]) -> Result<(), String> {
        let Some(file) = self.files.get_mut(path) else {
            return Err(format!("no such file: {path}"));
        };
        let Some(source) = file.source.as_mut() else {
            return Err(format!("file is not a text source: {path}"));
        };

        // Apply edits in reverse so earlier byte offsets stay valid.
        let mut sorted: Vec<&Edit> = edits.iter().collect();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.range.start));
        for edit in sorted {
            source.edit(edit.range.start..edit.range.end, &edit.replacement);
        }

        // Refresh cached raw bytes so non-text consumers stay in sync.
        let new_bytes = Bytes::new(source.text().to_owned().into_bytes());
        file.bytes = new_bytes;
        Ok(())
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct Edit {
    pub range: Range,
    pub replacement: String,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

fn build_source(id: FileId, mime: &str, bytes: &Bytes) -> Option<Source> {
    if !is_typst_mime(mime) {
        return None;
    }
    let text = std::str::from_utf8(bytes.as_ref()).ok()?.to_string();
    Some(Source::new(id, text))
}

fn is_typst_mime(mime: &str) -> bool {
    matches!(mime, "text/x-typst" | "application/typst" | "text/plain")
}

/// Tar entries don't carry a mime; infer one from the extension so package
/// `.typ`/`.typc` files become parseable Typst sources.
fn mime_for_vpath(vpath: &VirtualPath) -> &'static str {
    let ext = vpath
        .as_rooted_path()
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "typ" | "typc" => "text/x-typst",
        _ => "application/octet-stream",
    }
}
