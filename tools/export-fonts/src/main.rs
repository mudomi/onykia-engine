//! Writes typst's default font set to a directory as individual files, plus a
//! `fonts.json` manifest describing each face as a font stub. The engine ships
//! these next to the wasm instead of embedding them, so the host registers the
//! stubs and the binaries download on demand.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs, io};

use serde::Serialize;
use typst_library::foundations::Bytes;
use typst_library::text::{Font, FontInfo, FontStretch, FontStyle};

const MANIFEST: &str = "fonts.json";

/// Mirrors the `FontStub` shape in `packages/engine/src/types.ts`; `file` is
/// used as the stub key.
#[derive(Serialize)]
struct Stub {
    file: String,
    family: String,
    style: FontStyle,
    weight: u16,
    /// OpenType-style stretch number 1..=9 (5 = normal).
    stretch: u16,
}

fn main() -> ExitCode {
    let Some(out_dir) = env::args().nth(1).map(PathBuf::from) else {
        eprintln!("usage: export-fonts <out-dir>");
        return ExitCode::from(2);
    };

    match export(&out_dir) {
        Ok(count) => {
            println!("Wrote {count} fonts to {}", out_dir.display());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("export-fonts: {err}");
            ExitCode::FAILURE
        }
    }
}

fn export(out_dir: &Path) -> io::Result<usize> {
    fs::create_dir_all(out_dir)?;

    let mut stubs = Vec::new();
    let mut names = HashSet::new();
    for data in typst_assets::fonts() {
        let font = Font::new(Bytes::new(data), 0)
            .ok_or_else(|| io::Error::other("bundled font failed to parse"))?;
        let info = font.info();
        let file = file_name(info, data);

        // A duplicate name would silently overwrite a face.
        if !names.insert(file.clone()) {
            return Err(io::Error::other(format!("two faces map to '{file}'")));
        }

        fs::write(out_dir.join(&file), data)?;
        stubs.push(Stub {
            file,
            family: info.family.clone(),
            style: info.variant.style,
            weight: info.variant.weight.to_number(),
            stretch: stretch_number(info.variant.stretch),
        });
    }

    fs::write(out_dir.join(MANIFEST), serde_json::to_vec_pretty(&stubs)?)?;
    Ok(stubs.len())
}

/// `libertinus-serif-400-italic.otf`: derived from the face's own metadata so
/// the name stays truthful if upstream swaps a file.
fn file_name(info: &FontInfo, data: &[u8]) -> String {
    let family: String = info
        .family
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let style = match info.variant.style {
        FontStyle::Normal => "",
        FontStyle::Italic => "-italic",
        FontStyle::Oblique => "-oblique",
    };
    let extension = if data.starts_with(b"OTTO") {
        "otf"
    } else {
        "ttf"
    };
    format!(
        "{family}-{}{style}.{extension}",
        info.variant.weight.to_number()
    )
}

/// typst stores stretch as a ratio; the stub protocol uses the OpenType
/// 1..=9 scale, so pick the nearest named width.
fn stretch_number(stretch: FontStretch) -> u16 {
    const NAMED: [FontStretch; 9] = [
        FontStretch::ULTRA_CONDENSED,
        FontStretch::EXTRA_CONDENSED,
        FontStretch::CONDENSED,
        FontStretch::SEMI_CONDENSED,
        FontStretch::NORMAL,
        FontStretch::SEMI_EXPANDED,
        FontStretch::EXPANDED,
        FontStretch::EXTRA_EXPANDED,
        FontStretch::ULTRA_EXPANDED,
    ];
    let target = stretch.to_ratio().get();
    let nearest = NAMED
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            let da = (a.to_ratio().get() - target).abs();
            let db = (b.to_ratio().get() - target).abs();
            da.total_cmp(&db)
        })
        .map(|(index, _)| index)
        .unwrap_or(4);
    nearest as u16 + 1
}
