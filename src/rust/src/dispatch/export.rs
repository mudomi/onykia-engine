//! Export / render / archive handlers.

use std::collections::HashSet;
use std::num::NonZeroUsize;

use ecow::EcoVec;
use serde::{Deserialize, Serialize};
use typst::diag::SourceDiagnostic;
use typst::layout::PageRanges;
use typst::syntax::VirtualRoot;
use typst::utils::Scalar;
use typst_html::HtmlDocument;
use typst_layout::{Page, PagedDocument};
use typst_pdf::{PdfStandard, PdfStandards};
use wasm_bindgen::prelude::*;

use crate::protocol::{from_js, to_js};
use crate::state::State;
use crate::world::OnykiaWorld;

// Joins each diagnostic's message with its hints so callers see the actual
// reason (e.g. a PDF/A font-embedding requirement) rather than just a count.
fn format_errors(prefix: &str, errors: EcoVec<SourceDiagnostic>) -> String {
    let detail = errors
        .iter()
        .map(|d| {
            let hints = d
                .hints
                .iter()
                .map(|h| format!(" (hint: {})", h.v))
                .collect::<String>();
            format!("{}{hints}", d.message)
        })
        .collect::<Vec<_>>()
        .join("; ");

    format!("{prefix}: {detail}")
}

// Page selection for every page-based format. `index` picks one page; otherwise
// `from`/`to` are an inclusive 0-based range (each defaulting to first/last, so
// an omitted range means the whole document). `index` wins if both are given.
#[derive(Deserialize, Default)]
pub struct PageSelection {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    from: Option<usize>,
    #[serde(default)]
    to: Option<usize>,
}

impl PageSelection {
    // Lowers the 0-based selection to typst's 1-based `PageRanges` (`None` = every
    // page). Out-of-range values aren't rejected: export skips them, as typst does.
    fn to_page_ranges(&self) -> Option<PageRanges> {
        let one_based = |n: usize| NonZeroUsize::new(n + 1).expect("n + 1 is nonzero");

        if let Some(index) = self.index {
            let page = Some(one_based(index));
            return Some(PageRanges::new(vec![page..=page]));
        }

        match (self.from, self.to) {
            (None, None) => None,
            (from, to) => Some(PageRanges::new(vec![
                from.map(one_based)..=to.map(one_based),
            ])),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum ExportArgs {
    Pdf {
        #[serde(default)]
        standards: Vec<PdfStandard>,
        #[serde(flatten)]
        pages: PageSelection,
    },
    Svg {
        #[serde(flatten)]
        pages: PageSelection,
    },
    Png {
        #[serde(flatten)]
        pages: PageSelection,
        #[serde(default)]
        ppi: Option<f32>,
    },
    Html,
}

#[derive(Serialize)]
pub struct ExportResponse {
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub mime: &'static str,
}

pub fn export(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: ExportArgs = from_js(args)?;

    let response = match args {
        ExportArgs::Pdf { standards, pages } => {
            export_pdf(require_paged(state)?, &standards, &pages)?
        }
        ExportArgs::Svg { pages } => export_svg(require_paged(state)?, &pages)?,
        ExportArgs::Png { pages, ppi } => export_png(require_paged(state)?, &pages, ppi)?,
        ExportArgs::Html => export_html(state)?,
    };

    to_js(&response)
}

fn require_paged(state: &State) -> Result<&PagedDocument, String> {
    state
        .last_document
        .as_ref()
        .ok_or_else(|| "no document compiled".to_string())
}

fn page_at(doc: &PagedDocument, index: usize) -> Result<&Page, String> {
    doc.pages()
        .get(index)
        .ok_or_else(|| "page out of range".to_string())
}

// The 0-based page indices a selection resolves to, mirroring typst's PDF filter.
fn selected_pages(doc: &PagedDocument, ranges: &Option<PageRanges>) -> Vec<usize> {
    (0..doc.pages().len())
        .filter(|&i| ranges.as_ref().map_or(true, |r| r.includes_page_index(i)))
        .collect()
}

// Renders each page via `render`, returning the lone image directly or a ZIP of
// `page-N.<ext>` files when more than one page is selected.
fn bundle(
    pages: &[usize],
    extension: &str,
    single_mime: &'static str,
    render: impl Fn(usize) -> Result<Vec<u8>, String>,
) -> Result<ExportResponse, String> {
    if let [only] = pages {
        return Ok(ExportResponse {
            data: render(*only)?,
            mime: single_mime,
        });
    }

    // Pad numbers to a fixed width so the files sort naturally in archive tools.
    let width = pages.last().map_or(1, |&last| (last + 1).to_string().len());

    let files = pages
        .iter()
        .map(|&index| {
            let name = format!("page-{:0width$}.{extension}", index + 1, width = width);
            render(index).map(|bytes| (name, bytes))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ExportResponse {
        data: crate::zip::build(&files)?,
        mime: "application/zip",
    })
}

// Accessible PDF standards (PDF/UA, plus the "a" conformance level of PDF/A)
// mandate a fully tagged document, so they can't be restricted to a page range.
fn standards_require_tagging(standards: &[PdfStandard]) -> bool {
    standards.iter().any(|s| {
        matches!(
            s,
            PdfStandard::Ua_1 | PdfStandard::A_1a | PdfStandard::A_2a | PdfStandard::A_3a
        )
    })
}

fn export_pdf(
    doc: &PagedDocument,
    standards: &[PdfStandard],
    selection: &PageSelection,
) -> Result<ExportResponse, String> {
    let page_ranges = selection.to_page_ranges();

    // typst hard-errors when tagged PDF meets a page range, so drop tagging for
    // ranges. Accessible standards mandate tagging, so that combination can't be
    // papered over - reject it with a clear message instead of typst's terse one.
    if page_ranges.is_some() && standards_require_tagging(standards) {
        return Err("pdf: an accessible standard (PDF/UA-1 or PDF/A-*a) requires a fully \
                    tagged document and can't be combined with a page range - export the \
                    whole document or choose a non-accessible standard"
            .to_string());
    }
    let tagged = page_ranges.is_none();

    let standards = PdfStandards::new(standards).map_err(|e| format!("pdf: {}", e.message()))?;
    let options = typst_pdf::PdfOptions {
        standards,
        page_ranges,
        tagged,
        ..Default::default()
    };
    let bytes = typst_pdf::pdf(doc, &options).map_err(|errs| format_errors("pdf", errs))?;
    Ok(ExportResponse {
        data: bytes,
        mime: "application/pdf",
    })
}

fn render_svg(page: &Page) -> Vec<u8> {
    typst_svg::svg(page, &typst_svg::SvgOptions::default()).into_bytes()
}

fn export_svg(doc: &PagedDocument, selection: &PageSelection) -> Result<ExportResponse, String> {
    let pages = selected_pages(doc, &selection.to_page_ranges());
    bundle(&pages, "svg", "image/svg+xml", |index| {
        Ok(render_svg(page_at(doc, index)?))
    })
}

// Matches the typst CLI default for raster export.
const DEFAULT_PNG_PPI: f32 = 144.0;
// Typst measures lengths in points; typst_render takes pixels-per-pt.
const PT_PER_INCH: f32 = 72.0;

fn render_options(pixels_per_pt: f32) -> typst_render::RenderOptions {
    typst_render::RenderOptions {
        pixel_per_pt: Scalar::new(pixels_per_pt as f64),
        ..Default::default()
    }
}

fn render_png(page: &Page, pixels_per_pt: f32) -> Result<Vec<u8>, String> {
    typst_render::render(page, &render_options(pixels_per_pt))
        .encode_png()
        .map_err(|e| format!("png encode: {e}"))
}

fn export_png(
    doc: &PagedDocument,
    selection: &PageSelection,
    ppi: Option<f32>,
) -> Result<ExportResponse, String> {
    let pixels_per_pt = ppi.unwrap_or(DEFAULT_PNG_PPI) / PT_PER_INCH;
    let pages = selected_pages(doc, &selection.to_page_ranges());
    bundle(&pages, "png", "image/png", |index| {
        render_png(page_at(doc, index)?, pixels_per_pt)
    })
}

// HtmlDocument has a different layout than PagedDocument, so the cached
// `state.last_document` is unusable here - compile fresh on demand.
fn export_html(state: &State) -> Result<ExportResponse, String> {
    let doc = typst::compile::<HtmlDocument>(&state.world)
        .output
        .map_err(|errs| format_errors("html", errs))?;
    let html = typst_html::html(&doc, &typst_html::HtmlOptions::default())
        .map_err(|errs| format_errors("html", errs))?;
    Ok(ExportResponse {
        data: html.into_bytes(),
        mime: "text/html",
    })
}

//  render()

#[derive(Deserialize)]
pub struct RenderArgs {
    pub index: usize,
    pub zoom: f32,
}

#[derive(Serialize)]
pub struct RenderResponse {
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
    pub width: u32,
}

pub fn render(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: RenderArgs = from_js(args)?;
    let page = page_at(require_paged(state)?, args.index)?;

    let pixmap = typst_render::render(page, &render_options(args.zoom));
    let width = pixmap.width();
    let rgba = pixmap.data().to_vec();

    to_js(&RenderResponse { data: rgba, width })
}

//  archive()

#[derive(Deserialize, Default)]
pub struct ArchiveArgs {
    #[serde(default)]
    fonts: bool,
    #[serde(default)]
    packages: bool,
}

pub fn archive(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: ArchiveArgs = from_js(args)?;
    let entries = archive_entries(&state.world, &args);
    let response = ExportResponse {
        data: crate::zip::build(&entries)?,
        mime: "application/zip",
    };
    to_js(&response)
}

// Collects the `(path, bytes)` archive entries. Project files sit at the root
// when nothing else is bundled, but get a `project/` prefix once fonts/packages
// are added alongside them so the groups don't collide.
fn archive_entries(world: &OnykiaWorld, args: &ArchiveArgs) -> Vec<(String, Vec<u8>)> {
    let namespaced = args.fonts || args.packages;
    let mut entries = Vec::new();

    for (path, file) in world.vfs.project_files() {
        let path = path.trim_start_matches('/');
        let name = if namespaced {
            format!("project/{path}")
        } else {
            path.to_string()
        };
        entries.push((name, file.bytes.as_ref().to_vec()));
    }

    if args.fonts {
        collect_user_fonts(world, &mut entries);
    }

    if args.packages {
        for (id, entry) in world.vfs.package_files() {
            let VirtualRoot::Package(spec) = id.root() else {
                continue;
            };
            let vpath = id.vpath().get_without_slash();
            let name = format!(
                "packages/{}/{}/{}/{}",
                spec.namespace, spec.name, spec.version, vpath
            );
            entries.push((name, entry.bytes.as_ref().to_vec()));
        }
    }

    entries
}

fn collect_user_fonts(world: &OnykiaWorld, entries: &mut Vec<(String, Vec<u8>)>) {
    // A TTC yields one `Font` per face sharing the same backing `Bytes`, so
    // dedupe on the buffer's identity to emit each file once.
    let mut seen_files = HashSet::new();
    let mut used_names = HashSet::new();

    for font in world.user_fonts() {
        let bytes = font.data().as_ref();
        if !seen_files.insert((bytes.as_ptr() as usize, bytes.len())) {
            continue;
        }

        let stem = sanitize_filename(font.info().family.as_str());
        let extension = font_extension(bytes);
        let name = unique_name(&format!("fonts/{stem}"), extension, &mut used_names);
        entries.push((name, bytes.to_vec()));
    }
}

// Sniffs the sfnt magic so the archived file gets a truthful extension.
fn font_extension(bytes: &[u8]) -> &'static str {
    match bytes.get(0..4) {
        Some(b"ttcf") => ".ttc",
        Some(b"OTTO") => ".otf",
        _ => ".ttf",
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "font".to_string()
    } else {
        trimmed.to_string()
    }
}

// Disambiguates fonts that share a family name (e.g. several weights in
// separate files) with a numeric suffix: `Inter.ttf`, `Inter-1.ttf`, ...
fn unique_name(stem: &str, extension: &str, used: &mut HashSet<String>) -> String {
    let mut name = format!("{stem}{extension}");
    let mut counter = 1;
    while !used.insert(name.clone()) {
        name = format!("{stem}-{counter}{extension}");
        counter += 1;
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    use typst::syntax::package::PackageSpec;

    fn names(entries: &[(String, Vec<u8>)]) -> HashSet<&str> {
        entries.iter().map(|(name, _)| name.as_str()).collect()
    }

    #[test]
    fn archive_project_only_keeps_files_at_root() {
        let mut world = OnykiaWorld::new();
        world
            .vfs
            .create("/main.typ".into(), "text/x-typst".into(), b"= Hi".to_vec());
        world.vfs.create(
            "/chapters/intro.typ".into(),
            "text/x-typst".into(),
            b"intro".to_vec(),
        );

        let entries = archive_entries(&world, &ArchiveArgs::default());
        let names = names(&entries);

        assert!(names.contains("main.typ"));
        assert!(names.contains("chapters/intro.typ"));
        assert!(!names.iter().any(|n| n.starts_with("project/")));
    }

    #[test]
    fn archive_with_extras_namespaces_and_excludes_builtin_fonts() {
        let mut world = OnykiaWorld::new();
        world
            .vfs
            .create("/main.typ".into(), "text/x-typst".into(), b"= Hi".to_vec());

        // A real bundled face stands in for a host-uploaded font.
        let face = typst_assets::fonts()
            .next()
            .expect("bundled fonts present")
            .to_vec();
        world.add_font(face);

        let spec = PackageSpec::from_str("@preview/example:0.1.0").unwrap();
        world
            .vfs
            .install_package_file(&spec, "/lib.typ", b"#let x = 1".to_vec());

        let entries = archive_entries(
            &world,
            &ArchiveArgs {
                fonts: true,
                packages: true,
            },
        );
        let names = names(&entries);

        assert!(names.contains("project/main.typ"));
        assert!(names.contains("packages/preview/example/0.1.0/lib.typ"));

        // Only the uploaded font is emitted; the bundled typst-assets faces,
        // which precede it in the slot list, are excluded.
        let font_files = names.iter().filter(|n| n.starts_with("fonts/")).count();
        assert_eq!(font_files, 1);
    }

    #[test]
    fn accessible_standards_require_tagging() {
        assert!(standards_require_tagging(&[PdfStandard::Ua_1]));
        assert!(standards_require_tagging(&[PdfStandard::A_2a]));
        assert!(standards_require_tagging(&[PdfStandard::A_2b, PdfStandard::A_3a]));

        assert!(!standards_require_tagging(&[]));
        assert!(!standards_require_tagging(&[PdfStandard::A_2b]));
        assert!(!standards_require_tagging(&[PdfStandard::A_4]));
    }

    #[test]
    fn font_extension_sniffs_sfnt_magic() {
        assert_eq!(font_extension(b"OTTO\0\0\0\0"), ".otf");
        assert_eq!(font_extension(b"ttcf\0\0\0\0"), ".ttc");
        assert_eq!(font_extension(&[0x00, 0x01, 0x00, 0x00]), ".ttf");
    }

    // Confirms the flattened `PageSelection` deserializes alongside the
    // internally-tagged `format` discriminator, for each page-based format.
    fn selection(json: &str) -> PageSelection {
        match serde_json::from_str::<ExportArgs>(json).unwrap() {
            ExportArgs::Pdf { pages, .. } => pages,
            ExportArgs::Svg { pages } => pages,
            ExportArgs::Png { pages, .. } => pages,
            _ => panic!("expected a page-based format"),
        }
    }

    #[test]
    fn parses_single_index() {
        let sel = selection(r#"{"format":"svg","index":3}"#);
        assert_eq!(sel.index, Some(3));
        assert_eq!((sel.from, sel.to), (None, None));
    }

    #[test]
    fn parses_range() {
        let sel = selection(r#"{"format":"png","from":1,"to":4}"#);
        assert_eq!((sel.from, sel.to), (Some(1), Some(4)));
        assert_eq!(sel.index, None);
    }

    #[test]
    fn parses_omitted_range() {
        let sel = selection(r#"{"format":"svg"}"#);
        assert_eq!((sel.index, sel.from, sel.to), (None, None, None));
    }

    #[test]
    fn parses_pdf_with_range() {
        let sel = selection(r#"{"format":"pdf","standards":[],"from":2,"to":5}"#);
        assert_eq!((sel.from, sel.to), (Some(2), Some(5)));
    }

    // The lowered ranges drive both PDF and image export, so verifying their
    // 0-based -> 1-based membership pins the selection semantics for every
    // format at once.
    #[test]
    fn omitted_selection_means_whole_document() {
        assert!(PageSelection::default().to_page_ranges().is_none());
    }

    #[test]
    fn index_selects_exactly_one_page() {
        let ranges = PageSelection {
            index: Some(2),
            ..Default::default()
        }
        .to_page_ranges()
        .unwrap();
        assert!(!ranges.includes_page_index(1));
        assert!(ranges.includes_page_index(2));
        assert!(!ranges.includes_page_index(3));
    }

    #[test]
    fn range_is_inclusive_on_both_ends() {
        let ranges = PageSelection {
            from: Some(1),
            to: Some(3),
            ..Default::default()
        }
        .to_page_ranges()
        .unwrap();
        assert!(!ranges.includes_page_index(0));
        assert!(ranges.includes_page_index(1));
        assert!(ranges.includes_page_index(3));
        assert!(!ranges.includes_page_index(4));
    }

    #[test]
    fn open_ended_range_runs_to_the_document_edges() {
        let from_two = PageSelection {
            from: Some(2),
            ..Default::default()
        }
        .to_page_ranges()
        .unwrap();
        assert!(!from_two.includes_page_index(1));
        assert!(from_two.includes_page_index(999));

        let up_to_two = PageSelection {
            to: Some(2),
            ..Default::default()
        }
        .to_page_ranges()
        .unwrap();
        assert!(up_to_two.includes_page_index(0));
        assert!(!up_to_two.includes_page_index(3));
    }
}
