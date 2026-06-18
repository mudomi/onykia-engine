//! Export / render / archive handlers.

use ecow::EcoVec;
use serde::{Deserialize, Serialize};
use typst::diag::SourceDiagnostic;
use typst::utils::Scalar;
use typst_html::HtmlDocument;
use typst_layout::{Page, PagedDocument};
use typst_pdf::{PdfStandard, PdfStandards};
use wasm_bindgen::prelude::*;

use crate::protocol::{from_js, to_js};
use crate::state::State;

// Joins each diagnostic's message with its hints so callers see the actual
// reason (e.g. a PDF/A font-embedding requirement) rather than just a count.
fn format_errors(prefix: &str, errors: EcoVec<SourceDiagnostic>) -> String {
    let detail = errors
        .iter()
        .map(|d| {
            let hints = d.hints.iter().map(|h| format!(" (hint: {})", h.v)).collect::<String>();
            format!("{}{hints}", d.message)
        })
        .collect::<Vec<_>>()
        .join("; ");

    format!("{prefix}: {detail}")
}

#[derive(Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum ExportArgs {
    Pdf {
        #[serde(default)]
        standards: Vec<PdfStandard>,
    },
    Svg {
        index: usize,
    },
    Png {
        index: usize,
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
        ExportArgs::Pdf { standards } => export_pdf(require_paged(state)?, &standards)?,
        ExportArgs::Svg { index } => export_svg(page_at(require_paged(state)?, index)?),
        ExportArgs::Png { index, ppi } => export_png(page_at(require_paged(state)?, index)?, ppi)?,
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

fn export_pdf(doc: &PagedDocument, standards: &[PdfStandard]) -> Result<ExportResponse, String> {
    let standards =
        PdfStandards::new(standards).map_err(|e| format!("pdf: {}", e.message()))?;
    let options = typst_pdf::PdfOptions {
        standards,
        ..Default::default()
    };
    let bytes = typst_pdf::pdf(doc, &options).map_err(|errs| format_errors("pdf", errs))?;
    Ok(ExportResponse {
        data: bytes,
        mime: "application/pdf",
    })
}

fn export_svg(page: &Page) -> ExportResponse {
    let svg = typst_svg::svg(page, &typst_svg::SvgOptions::default());
    ExportResponse {
        data: svg.into_bytes(),
        mime: "image/svg+xml",
    }
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

fn export_png(page: &Page, ppi: Option<f32>) -> Result<ExportResponse, String> {
    let pixels_per_pt = ppi.unwrap_or(DEFAULT_PNG_PPI) / PT_PER_INCH;
    let pixmap = typst_render::render(page, &render_options(pixels_per_pt));
    let png = pixmap
        .encode_png()
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(ExportResponse {
        data: png,
        mime: "image/png",
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

pub fn archive(_state: &mut State, _args: JsValue) -> Result<JsValue, String> {
    Err("archive not implemented".into())
}
