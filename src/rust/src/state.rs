//! Per-compiler-instance state.

use std::cell::Cell;
use std::collections::HashSet;

use ecow::EcoVec;
use typst::diag::SourceDiagnostic;
use typst::layout::PagedDocument;
use typst::syntax::package::PackageSpec;
use wasm_bindgen::prelude::*;

use crate::world::OnykiaWorld;

/// Export target - which backend runs after a successful compile.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Target {
    #[default]
    None,
    Pdf,
    Svg,
    Png,
    Html,
}

impl Target {
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "pdf" => Self::Pdf,
            "svg" => Self::Svg,
            "png" => Self::Png,
            "html" => Self::Html,
            "none" => Self::None,
            _ => return None,
        })
    }
}

/// Exposed to JS as the wasm-bindgen `State` handle.
#[wasm_bindgen]
pub struct State {
    pub(crate) world: OnykiaWorld,
    pub(crate) target: Target,
    pub(crate) subscriptions: HashSet<String>,
    pub(crate) last_document: Option<PagedDocument>,
    pub(crate) last_diagnostics: EcoVec<SourceDiagnostic>,
    pub(crate) silent_next_compile: Cell<bool>,
    pub(crate) in_flight_packages: HashSet<PackageSpec>,
    pub(crate) in_flight_fonts: HashSet<usize>,
}

#[wasm_bindgen]
impl State {
    #[wasm_bindgen(constructor)]
    pub fn new() -> State {
        State {
            world: OnykiaWorld::new(),
            target: Target::None,
            subscriptions: HashSet::new(),
            last_document: None,
            last_diagnostics: EcoVec::new(),
            silent_next_compile: Cell::new(false),
            in_flight_packages: HashSet::new(),
            in_flight_fonts: HashSet::new(),
        }
    }
}

impl Default for State {
    fn default() -> Self {
        Self::new()
    }
}
