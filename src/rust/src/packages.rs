//! Package archive decoding + index parsing.

use std::io::Read;

use ecow::EcoString;
use serde::Deserialize;
use typst::syntax::package::{PackageSpec, PackageVersion};

use crate::vfs::Vfs;

/// Decompress a `.tar.gz` and mount every regular-file entry into the VFS
pub fn install_tarball(vfs: &mut Vfs, spec: &PackageSpec, bytes: &[u8]) -> Result<(), String> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);

    let entries = archive.entries().map_err(|e| format!("untar: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("untar entry: {e}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let path = entry
            .path()
            .map_err(|e| format!("untar path: {e}"))?
            .into_owned();
        let Some(vpath) = vpath_for(&path) else {
            // Skip entries with non-utf8 or absolute/escape paths
            continue;
        };

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("read tar entry: {e}"))?;
        vfs.install_package_file(spec, &vpath, buf);
    }

    Ok(())
}

/// Parse index.json into a flat list of `(spec, description)` pairs.
pub fn parse_index(namespace: &EcoString, bytes: &[u8]) -> Vec<(PackageSpec, Option<EcoString>)> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let entries: Vec<IndexEntry> = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        // Tolerate malformed indices rather than nuking autocomplete entirely.
        Err(_) => return Vec::new(),
    };
    entries
        .into_iter()
        .map(|e| {
            let spec = PackageSpec {
                namespace: namespace.clone(),
                name: e.name,
                version: e.version,
            };
            (spec, e.description)
        })
        .collect()
}

#[derive(Deserialize)]
struct IndexEntry {
    name: EcoString,
    version: PackageVersion,
    #[serde(default)]
    description: Option<EcoString>,
}

/// Convert a tar entry path into a rooted virtual path.
fn vpath_for(path: &std::path::Path) -> Option<String> {
    let s = path.to_str()?;
    if s.is_empty() || s.starts_with('/') {
        return None;
    }
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::RootDir
        )
    }) {
        return None;
    }
    Some(format!("/{s}"))
}
