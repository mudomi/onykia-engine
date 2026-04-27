//! Full compilation pipeline. Runs after every state-changing request.

use ecow::EcoVec;
use typst::diag::{Severity, SourceDiagnostic};
use typst::layout::PagedDocument;
use typst::syntax::FileId;

use super::notify::{
    self, Diagnostic, DiagnosticsNotification, OutlineEntry, OutlineNotification,
    PageInfo, PagesNotification, Range, StatusNotification,
};
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
        &StatusNotification { status: "busy", message: None },
    );

    let result = typst::compile::<PagedDocument>(&state.world);
    let warnings = result.warnings;
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

fn emit_success(state: &State, warnings: &EcoVec<SourceDiagnostic>) {
    notify::emit(
        state,
        "status",
        &StatusNotification { status: "ok", message: None },
    );
    notify::emit(state, "diagnostics", &diagnostics_notif(state, warnings));
    notify::emit(state, "pages", &pages_notif(state));
    notify::emit(state, "outline", &outline_notif(state));
}

fn emit_failure(state: &State, diags: &EcoVec<SourceDiagnostic>) {
    notify::emit(
        state,
        "status",
        &StatusNotification { status: "error", message: None },
    );
    notify::emit(state, "diagnostics", &diagnostics_notif(state, diags));
}

fn diagnostics_notif(
    state: &State,
    diags: &EcoVec<SourceDiagnostic>,
) -> DiagnosticsNotification {
    let mut out = Vec::with_capacity(diags.len());
    for diag in diags {
        let (path, range) = resolve_span(state, diag.span);
        out.push(Diagnostic {
            severity: severity_str(diag.severity).to_string(),
            message: diag.message.to_string(),
            range,
            path,
            package: None,
            id: None,
            hints: diag.hints.iter().map(|h| h.to_string()).collect(),
        });
    }
    DiagnosticsNotification { diagnostics: out }
}

fn resolve_span(
    state: &State,
    span: typst::syntax::Span,
) -> (Option<String>, Option<Range>) {
    let Some(id) = span.id() else { return (None, None) };
    let Some((path, _)) = state.world.vfs.find_by_id(id) else {
        return (None, None);
    };
    let range = source_range_for(state, id, span);
    (Some(path.to_string()), range)
}

fn source_range_for(
    state: &State,
    id: FileId,
    span: typst::syntax::Span,
) -> Option<Range> {
    let (_, file) = state.world.vfs.find_by_id(id)?;
    let source = file.source()?;
    let range = source.range(span)?;
    Some(Range { start: range.start, end: range.end })
}

fn pages_notif(state: &State) -> PagesNotification {
    let Some(doc) = state.last_document.as_ref() else {
        return PagesNotification { pages: Vec::new() };
    };
    let pages = doc
        .pages
        .iter()
        .map(|p| PageInfo {
            width: p.frame.width().to_pt(),
            height: p.frame.height().to_pt(),
        })
        .collect();
    PagesNotification { pages }
}

fn outline_notif(state: &State) -> OutlineNotification {
    // Walking Typst's heading structure requires introspecting the frame tree
    // for the first paged-output pass; we ship a stub until that pass lands.
    let _ = state;
    OutlineNotification { entries: Vec::<OutlineEntry>::new() }
}

fn severity_str(sev: Severity) -> &'static str {
    match sev {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}
