//! Virtual filesystem that backs the [`crate::world::OnykiaWorld`].
//!
//! Paths are stored as absolute POSIX strings ("/main.typ"). File contents
//! are kept as raw bytes; text-mime files are parsed into `typst_syntax::Source`
//! on demand and cached until the next edit.

use std::collections::HashMap;

use typst::foundations::Bytes;
use typst::syntax::{FileId, Source, VirtualPath};

/// A single file tracked by the VFS.
pub struct File {
    pub mime: String,
    pub bytes: Bytes,
    source: Option<Source>,
}

impl File {
    pub fn new(path: &str, mime: String, bytes: Bytes) -> Self {
        let mut file = Self {
            mime,
            bytes,
            source: None,
        };
        file.source = file.build_source(path);
        file
    }

    fn build_source(&self, path: &str) -> Option<Source> {
        if !is_typst_mime(&self.mime) {
            return None;
        }
        let text = std::str::from_utf8(self.bytes.as_ref()).ok()?.to_string();
        let id = FileId::new(None, VirtualPath::new(path));
        Some(Source::new(id, text))
    }

    pub fn source(&self) -> Option<&Source> {
        self.source.as_ref()
    }
}

pub struct Vfs {
    files: HashMap<String, File>,
}

impl Vfs {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    pub fn create(&mut self, path: String, mime: String, bytes: Vec<u8>) {
        let bytes = Bytes::new(bytes);
        self.files
            .insert(path.clone(), File::new(&path, mime, bytes));
    }

    pub fn delete(&mut self, path: &str) -> bool {
        self.files.remove(path).is_some()
    }

    pub fn rename(&mut self, from: &str, to: &str, mime: Option<String>) -> bool {
        let Some(mut file) = self.files.remove(from) else {
            return false;
        };
        if let Some(m) = mime {
            file.mime = m;
        }
        // Rebuild source with new id.
        let rebuilt = File::new(to, file.mime, file.bytes);
        self.files.insert(to.to_string(), rebuilt);
        true
    }

    pub fn clear(&mut self) {
        self.files.clear();
    }

    pub fn get(&self, path: &str) -> Option<&File> {
        self.files.get(path)
    }

    pub fn known_ids(&self) -> Vec<FileId> {
        self.files
            .keys()
            .map(|p| FileId::new(None, VirtualPath::new(p)))
            .collect()
    }

    pub fn find_by_id(&self, id: FileId) -> Option<(&str, &File)> {
        for (path, file) in &self.files {
            if let Some(src) = file.source() {
                if src.id() == id {
                    return Some((path.as_str(), file));
                }
            }
            // Non-text files - match by VirtualPath.
            let vp = VirtualPath::new(path.as_str());
            if FileId::new(None, vp) == id {
                return Some((path.as_str(), file));
            }
        }
        None
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

fn is_typst_mime(mime: &str) -> bool {
    matches!(mime, "text/x-typst" | "application/typst" | "text/plain")
}
