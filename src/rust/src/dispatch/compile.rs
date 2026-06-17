//! Full compilation pipeline. Runs after every state-changing request.

use ecow::EcoVec;
use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::package::PackageSpec;
use typst::syntax::{DiagSpan, VirtualRoot};
use typst::WorldExt;
use typst_layout::PagedDocument;

use super::notify::{
    self, Diagnostic, DiagnosticsNotification, OutlineEntry, OutlineNotification, OutlinePosition,
    PageInfo, PagesNotification, Range, StatusNotification,
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
    let Some(doc) = state.last_document.as_ref() else {
        return OutlineNotification {
            entries: Vec::new(),
        };
    };
    OutlineNotification {
        entries: extract_outline(doc),
    }
}

fn extract_outline(doc: &PagedDocument) -> Vec<OutlineEntry> {
    // Query every heading the document laid out, in document order. The
    // `Outlinable` trait is what `#outline()` itself consults, so inclusion
    // (`#heading(outlined: false)` opts out) and level resolution match it
    // exactly.
    use typst::foundations::NativeElement;
    use typst::model::{HeadingElem, Outlinable};

    let flat: Vec<OutlineEntry> = doc
        .introspector
        .query(&HeadingElem::ELEM.select())
        .into_iter()
        .filter_map(|elem| {
            let heading = elem.to_packed::<HeadingElem>()?;
            if !heading.outlined() {
                return None;
            }
            let position = elem
                .location()
                .map(|loc| doc.introspector.position(loc))
                .map(|p| OutlinePosition {
                    page: p.page.get() - 1,
                    x: p.point.x.to_pt(),
                    y: p.point.y.to_pt(),
                })?;
            Some(OutlineEntry {
                level: heading.level().get() as u32,
                title: heading.body.plain_text().to_string(),
                position,
                children: Vec::new(),
            })
        })
        .collect();

    nest_by_level(flat)
}

/// Fold a flat, document-ordered list of entries into a tree. Each entry
/// nests under the most recent entry with a strictly smaller level. Level
/// jumps (e.g. `=` then `===`) are tolerated: the deeper entry simply
/// attaches to whatever shallower entry is currently open.
fn nest_by_level(flat: Vec<OutlineEntry>) -> Vec<OutlineEntry> {
    let mut roots: Vec<OutlineEntry> = Vec::new();
    // Stack of indices describing the path from a root down to the last entry.
    let mut path: Vec<usize> = Vec::new();
    let mut levels: Vec<u32> = Vec::new();

    for entry in flat {
        let level = entry.level;
        while levels.last().is_some_and(|&l| l >= level) {
            path.pop();
            levels.pop();
        }
        let siblings = children_at_path(&mut roots, &path);
        siblings.push(entry);
        path.push(siblings.len() - 1);
        levels.push(level);
    }
    roots
}

/// Follow `path` (a list of child indices) into the tree and return the Vec
/// the next entry should be pushed into.
fn children_at_path<'a>(
    roots: &'a mut Vec<OutlineEntry>,
    path: &[usize],
) -> &'a mut Vec<OutlineEntry> {
    let mut current = roots;
    for &idx in path {
        current = &mut current[idx].children;
    }
    current
}

fn severity_str(sev: Severity) -> &'static str {
    match sev {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::OnykiaWorld;

    fn compile_doc(src: &str) -> PagedDocument {
        let mut world = OnykiaWorld::new();
        world.vfs.create(
            "/main.typ".into(),
            "text/x-typst".into(),
            src.as_bytes().to_vec(),
        );
        world.main_path = Some("/main.typ".into());
        typst::compile::<PagedDocument>(&world)
            .output
            .expect("compiles")
    }

    fn entry(level: u32, title: &str) -> OutlineEntry {
        OutlineEntry {
            level,
            title: title.into(),
            position: OutlinePosition {
                page: 0,
                x: 0.0,
                y: 0.0,
            },
            children: Vec::new(),
        }
    }

    #[test]
    fn nest_by_level_builds_tree() {
        let flat = vec![
            entry(1, "A"),
            entry(2, "A.1"),
            entry(2, "A.2"),
            entry(3, "A.2.1"),
            entry(1, "B"),
        ];
        let tree = nest_by_level(flat);

        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].title, "A");
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[0].children[1].title, "A.2");
        assert_eq!(tree[0].children[1].children[0].title, "A.2.1");
        assert_eq!(tree[1].title, "B");
        assert!(tree[1].children.is_empty());
    }

    #[test]
    fn nest_by_level_tolerates_level_jump() {
        // `=` then `===` (skipping level 2): the deeper entry still nests.
        let flat = vec![entry(1, "A"), entry(3, "deep")];
        let tree = nest_by_level(flat);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].title, "deep");
    }

    #[test]
    fn extract_outline_from_document() {
        let doc = compile_doc("= Intro\n== Background\n= Method\n");
        let tree = extract_outline(&doc);

        assert_eq!(tree.len(), 2, "two top-level headings");
        assert_eq!(tree[0].title, "Intro");
        assert_eq!(tree[0].level, 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].title, "Background");
        assert_eq!(tree[0].children[0].level, 2);
        assert_eq!(tree[1].title, "Method");
        // Positions are real page coordinates.
        assert!(tree[0].position.y >= 0.0);
    }

    #[test]
    fn extract_outline_skips_non_outlined() {
        let doc = compile_doc("= Shown\n#heading(outlined: false)[Hidden]\n");
        let tree = extract_outline(&doc);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].title, "Shown");
    }
}
