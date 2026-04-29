//! Export / render / archive handlers.

use serde::{Deserialize, Serialize};
use typst::layout::PagedDocument;
use typst_html::HtmlDocument;
use wasm_bindgen::prelude::*;

use crate::protocol::{from_js, to_js};
use crate::state::State;

#[derive(Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum ExportArgs {
    Pdf,
    Svg,
    Png {
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
        ExportArgs::Pdf => export_pdf(require_paged(state)?)?,
        ExportArgs::Svg => export_svg(require_paged(state)?),
        ExportArgs::Png { ppi } => export_png(require_paged(state)?, ppi)?,
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

fn export_pdf(doc: &PagedDocument) -> Result<ExportResponse, String> {
    let options = typst_pdf::PdfOptions::default();
    let bytes =
        typst_pdf::pdf(doc, &options).map_err(|errs| format!("pdf: {} error(s)", errs.len()))?;
    Ok(ExportResponse {
        data: bytes,
        mime: "application/pdf",
    })
}

fn export_svg(doc: &PagedDocument) -> ExportResponse {
    // svg_merged writes all pages into a single SVG document.
    let svg = typst_svg::svg_merged(doc, typst::layout::Abs::pt(0.0));
    ExportResponse {
        data: svg.into_bytes(),
        mime: "image/svg+xml",
    }
}

// Default DPI matches typst CLI's default for raster export.
const DEFAULT_PNG_PPI: f32 = 144.0;
// Typst's render pixels-per-pt unit; 72 pt = 1 inch.
const PT_PER_INCH: f32 = 72.0;

fn export_png(doc: &PagedDocument, ppi: Option<f32>) -> Result<ExportResponse, String> {
    let page = doc.pages.first().ok_or_else(|| "no pages".to_string())?;
    let pixels_per_pt = ppi.unwrap_or(DEFAULT_PNG_PPI) / PT_PER_INCH;
    let pixmap = typst_render::render(page, pixels_per_pt);
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
        .map_err(|errs| format!("html: {} error(s)", errs.len()))?;
    let html = typst_html::html(&doc).map_err(|errs| format!("html: {} error(s)", errs.len()))?;
    Ok(ExportResponse {
        data: html.into_bytes(),
        mime: "text/html",
    })
}

// ─── render() ────────────────────────────────────────────────────────────

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
    let doc = require_paged(state)?;
    let page = doc
        .pages
        .get(args.index)
        .ok_or_else(|| "page out of range".to_string())?;
    let pixmap = typst_render::render(page, args.zoom);
    let width = pixmap.width();
    let rgba = pixmap.data().to_vec();
    to_js(&RenderResponse { data: rgba, width })
}

// ─── archive() ───────────────────────────────────────────────────────────

pub fn archive(_state: &mut State, _args: JsValue) -> Result<JsValue, String> {
    Err("archive not implemented".into())
}
