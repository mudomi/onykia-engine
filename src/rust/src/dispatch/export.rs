//! Export / render / archive handlers.

use serde::{Deserialize, Serialize};
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
    let doc = state
        .last_document
        .as_ref()
        .ok_or_else(|| "no document compiled".to_string())?;
    let args: ExportArgs = from_js(args)?;

    let response = match args {
        ExportArgs::Pdf => {
            let options = typst_pdf::PdfOptions::default();
            let bytes = typst_pdf::pdf(doc, &options)
                .map_err(|errs| format!("pdf: {} error(s)", errs.len()))?;
            ExportResponse { data: bytes, mime: "application/pdf" }
        }
        ExportArgs::Svg => {
            // `svg_merged` writes all pages into a single SVG document.
            let svg = typst_svg::svg_merged(doc, typst::layout::Abs::pt(0.0));
            ExportResponse { data: svg.into_bytes(), mime: "image/svg+xml" }
        }
        ExportArgs::Png { ppi } => {
            let page = doc.pages.first().ok_or_else(|| "no pages".to_string())?;
            let ppi = ppi.unwrap_or(144.0);
            let pixmap = typst_render::render(page, ppi / 72.0);
            let png =
                pixmap.encode_png().map_err(|e| format!("png encode: {e}"))?;
            ExportResponse { data: png, mime: "image/png" }
        }
        ExportArgs::Html => {
            return Err("html export not yet implemented in onykia-engine".into());
        }
    };

    to_js(&response)
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
    let doc = state
        .last_document
        .as_ref()
        .ok_or_else(|| "no document compiled".to_string())?;
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
