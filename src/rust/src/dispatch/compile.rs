//! Full compilation pipeline. Runs after every state-changing request.

use ecow::EcoVec;
use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::package::PackageSpec;
use typst::syntax::{DiagSpan, VirtualRoot};
use typst::WorldExt;
use typst_layout::PagedDocument;

use super::notify::{
    self, Diagnostic, DiagnosticsNotification, OutlineEntry, OutlineNotification, PageInfo,
    PagesNotification, Range, StatusNotification,
};
use crate::ask;
use crate::packages;
use crate::state::{State, Target};

pub fn run(state: &mut State) {
    if state.silent_next_compile.replace(false) {
        return;
    }
    if state.world.main_path.is_none() || state.target == Target::None {
        return;
    }

    notify::emit(
        state,
        "status",
        &StatusNotification {
            status: "busy",
            message: None,
        },
    );

    let result = typst::compile::<PagedDocument>(&state.world);
    let warnings = result.warnings;

    if dispatch_pending_fetches(state) {
        // We've issued (or are still waiting on) fetches; results from the
        // current pass are stale - defer emit until the retry compile runs.
        return;
    }

    match result.output {
        Ok(document) => {
            state.last_document = Some(document);
            state.last_diagnostics = warnings.clone();
            emit_success(state, &warnings);
        }
        Err(errors) => {
            state.last_document = None;
            state.last_diagnostics = errors.clone();
            let mut combined = errors;
            combined.extend(warnings);
            emit_failure(state, &combined);
        }
    }
}

fn dispatch_pending_fetches(state: &mut State) -> bool {
    for spec in state.world.take_pending_packages() {
        if state.in_flight_packages.contains(&spec) {
            continue;
        }
        state.in_flight_packages.insert(spec.clone());
        let dispatched = {
            let spec_for_cb = spec.clone();
            ask::request(
                "package",
                &PackageFetchArgs::from(&spec),
                Box::new(move |state, outcome| {
                    handle_package_response(state, spec_for_cb, outcome)
                }),
            )
        };
        if dispatched.is_err() {
            // Couldn't even queue the request - count as a failed attempt so
            // we don't spin forever on a broken host.
            state.in_flight_packages.remove(&spec);
            state.world.mark_package_failed(spec);
        }
    }
    for (index, key) in state.world.take_pending_fonts() {
        if state.in_flight_fonts.contains(&index) {
            continue;
        }
        state.in_flight_fonts.insert(index);
        if ask::request(
            "font",
            &FontFetchArgs {
                key: key.to_string(),
            },
            Box::new(move |state, outcome| handle_font_response(state, index, outcome)),
        )
        .is_err()
        {
            state.in_flight_fonts.remove(&index);
            state.world.mark_font_failed(index);
        }
    }
    !state.in_flight_packages.is_empty() || !state.in_flight_fonts.is_empty()
}

fn handle_package_response(state: &mut State, spec: PackageSpec, outcome: Result<Vec<u8>, String>) {
    state.in_flight_packages.remove(&spec);

    match outcome {
        Ok(bytes) => match packages::install_tarball(&mut state.world.vfs, &spec, &bytes) {
            Ok(()) => state.world.mark_package_installed(spec),
            Err(_) => state.world.mark_package_failed(spec),
        },
        Err(_) => state.world.mark_package_failed(spec),
    }

    // Retry only after the *last* outstanding fetch resolves so multiple
    // missing packages produce one recompile, not N.
    rerun_if_idle(state);
}

fn handle_font_response(state: &mut State, index: usize, outcome: Result<Vec<u8>, String>) {
    state.in_flight_fonts.remove(&index);

    match outcome {
        Ok(bytes) => {
            if state.world.install_font(index, bytes).is_err() {
                state.world.mark_font_failed(index);
            }
        }
        Err(_) => state.world.mark_font_failed(index),
    }

    rerun_if_idle(state);
}

fn rerun_if_idle(state: &mut State) {
    if state.in_flight_packages.is_empty() && state.in_flight_fonts.is_empty() {
        run(state);
    }
}

#[derive(Serialize)]
struct FontFetchArgs {
    key: String,
}

#[derive(Serialize)]
struct PackageFetchArgs {
    namespace: String,
    name: String,
    /// `PackageVersion` formats as `M.m.p`
    version: String,
}

impl From<&PackageSpec> for PackageFetchArgs {
    fn from(spec: &PackageSpec) -> Self {
        Self {
            namespace: spec.namespace.to_string(),
            name: spec.name.to_string(),
            version: spec.version.to_string(),
        }
    }
}

fn emit_success(state: &State, warnings: &EcoVec<SourceDiagnostic>) {
    notify::emit(
        state,
        "status",
        &StatusNotification {
            status: "ok",
            message: None,
        },
    );
    notify::emit(state, "diagnostics", &diagnostics_notif(state, warnings));
    notify::emit(state, "pages", &pages_notif(state));
    notify::emit(state, "outline", &outline_notif(state));
}

fn emit_failure(state: &State, diags: &EcoVec<SourceDiagnostic>) {
    notify::emit(
        state,
        "status",
        &StatusNotification {
            status: "error",
            message: None,
        },
    );
    notify::emit(state, "diagnostics", &diagnostics_notif(state, diags));
}

fn diagnostics_notif(state: &State, diags: &EcoVec<SourceDiagnostic>) -> DiagnosticsNotification {
    let mut out = Vec::with_capacity(diags.len());
    for diag in diags {
        let (path, package, range) = resolve_span(state, diag.span);
        out.push(Diagnostic {
            severity: severity_str(diag.severity).to_string(),
            message: diag.message.to_string(),
            range,
            path,
            package,
            id: None,
            hints: diag.hints.iter().map(|h| h.v.to_string()).collect(),
        });
    }
    DiagnosticsNotification { diagnostics: out }
}

fn resolve_span(state: &State, span: DiagSpan) -> (Option<String>, Option<String>, Option<Range>) {
    let Some(id) = span.id() else {
        return (None, None, None);
    };
    if let VirtualRoot::Package(spec) = id.root() {
        return (None, Some(spec.to_string()), None);
    }
    let Some((path, _)) = state.world.vfs.find_by_id(id) else {
        return (None, None, None);
    };
    let range = state.world.range(span).map(|r| Range {
        start: r.start,
        end: r.end,
    });
    (Some(path.to_string()), None, range)
}

fn pages_notif(state: &State) -> PagesNotification {
    let Some(doc) = state.last_document.as_ref() else {
        return PagesNotification { pages: Vec::new() };
    };
    let pages = doc
        .pages()
        .iter()
        .map(|p| PageInfo {
            width: p.frame.width().to_pt(),
            height: p.frame.height().to_pt(),
        })
        .collect();
    PagesNotification { pages }
}

fn outline_notif(state: &State) -> OutlineNotification {
    // TODO: implement outline extraction.
    let _ = state;
    OutlineNotification {
        entries: Vec::<OutlineEntry>::new(),
    }
}

fn severity_str(sev: Severity) -> &'static str {
    match sev {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}
