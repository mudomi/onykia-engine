//! IDE features: tags / highlight / autocomplete / tooltip / definition / jump.

use serde::{Deserialize, Serialize};
use typst::syntax::{Side, SyntaxKind, SyntaxNode};
use wasm_bindgen::prelude::*;

use crate::protocol::{from_js, to_js};
use crate::state::State;

// ─── tags() ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TagsResponse {
    pub names: Vec<&'static str>,
}

/// Static list of token type names, in the order returned by `highlight()`.
pub const TAG_NAMES: &[&str] = &[
    "typ-comment",
    "typ-punct",
    "typ-escape",
    "typ-strong",
    "typ-emph",
    "typ-link",
    "typ-raw",
    "typ-label",
    "typ-ref",
    "typ-heading",
    "typ-marker",
    "typ-term",
    "typ-math-delim",
    "typ-math-op",
    "typ-key",
    "typ-op",
    "typ-num",
    "typ-str",
    "typ-func",
    "typ-pol",
    "typ-error",
];

pub fn tags(_state: &mut State) -> Result<JsValue, String> {
    to_js(&TagsResponse {
        names: TAG_NAMES.to_vec(),
    })
}

// ─── highlight() ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct HighlightArgs {
    pub path: String,
}

#[derive(Serialize)]
pub struct HighlightResponse {
    pub data: Vec<u32>,
}

pub fn highlight(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: HighlightArgs = from_js(args)?;
    let file = state
        .world
        .vfs
        .get(&args.path)
        .ok_or_else(|| format!("no such file: {}", args.path))?;
    let source = file
        .source()
        .ok_or_else(|| format!("file is not a Typst source: {}", args.path))?;

    let mut data = Vec::with_capacity(source.text().len() / 8);
    walk(source.root(), 0, &mut data);
    to_js(&HighlightResponse { data })
}

fn walk(node: &SyntaxNode, offset: usize, out: &mut Vec<u32>) {
    let len = node.len();
    if node.children().next().is_none() {
        if let Some(tag_idx) = map_kind(node.kind()) {
            out.push(offset as u32);
            out.push((offset + len) as u32);
            out.push(tag_idx);
        }
    } else {
        let mut cursor = offset;
        for child in node.children() {
            walk(child, cursor, out);
            cursor += child.len();
        }
    }
}

fn map_kind(kind: SyntaxKind) -> Option<u32> {
    use SyntaxKind as K;
    let idx: u32 = match kind {
        K::LineComment | K::BlockComment => 0, // typ-comment
        K::LeftParen
        | K::RightParen
        | K::LeftBracket
        | K::RightBracket
        | K::LeftBrace
        | K::RightBrace
        | K::Comma
        | K::Semicolon
        | K::Colon => 1, // typ-punct
        K::Escape | K::Shorthand => 2,         // typ-escape
        K::Strong => 3,                        // typ-strong
        K::Emph => 4,                          // typ-emph
        K::Link => 5,                          // typ-link
        K::Raw | K::RawLang | K::RawTrimmed | K::RawDelim => 6, // typ-raw
        K::Label => 7,                         // typ-label
        K::Ref | K::RefMarker => 8,            // typ-ref
        K::Heading | K::HeadingMarker => 9,    // typ-heading
        K::ListMarker | K::EnumMarker | K::TermMarker => 10, // typ-marker
        K::Dollar | K::MathDelimited => 12,    // typ-math-delim
        K::Underscore | K::Hat | K::Prime => 13, // typ-math-op
        K::Let
        | K::Set
        | K::Show
        | K::If
        | K::Else
        | K::For
        | K::While
        | K::Return
        | K::Break
        | K::Continue
        | K::Import
        | K::Include
        | K::As
        | K::In
        | K::Not
        | K::And
        | K::Or
        | K::None
        | K::Auto
        | K::Context => 14, // typ-key
        K::Plus
        | K::Minus
        | K::Star
        | K::Slash
        | K::Eq
        | K::EqEq
        | K::ExclEq
        | K::Lt
        | K::LtEq
        | K::Gt
        | K::GtEq
        | K::PlusEq
        | K::HyphEq
        | K::StarEq
        | K::SlashEq
        | K::Dots
        | K::Arrow => 15, // typ-op
        K::Numeric | K::Int | K::Float => 16,  // typ-num
        K::Str => 17,                          // typ-str
        K::FuncCall => 18,                     // typ-func
        K::Ident | K::MathIdent => 19,         // typ-pol
        K::Error => 20,                        // typ-error
        _ => return None,
    };
    Some(idx)
}

// ─── syntaxTree() ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SyntaxTreeArgs {
    pub path: String,
}

#[derive(Serialize)]
pub struct CstNode {
    pub kind: String,
    pub start: u32,
    pub end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<CstNode>,
}

pub fn syntax_tree(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: SyntaxTreeArgs = from_js(args)?;
    let file = state
        .world
        .vfs
        .get(&args.path)
        .ok_or_else(|| format!("no such file: {}", args.path))?;
    let source = file
        .source()
        .ok_or_else(|| format!("not a Typst source: {}", args.path))?
        .clone();
    let node = cst_node(source.root(), source.text(), 0);
    to_js(&node)
}

fn cst_node(node: &SyntaxNode, src: &str, offset: usize) -> CstNode {
    let len = node.len();
    let mut children = Vec::new();
    let mut cursor = offset;
    for child in node.children() {
        let start = cursor;
        cursor += child.len();
        // Skip bare whitespace - it's noise in a structural view.
        if child.kind() == SyntaxKind::Space {
            continue;
        }
        children.push(cst_node(child, src, start));
    }
    CstNode {
        kind: format!("{:?}", node.kind()),
        start: offset as u32,
        end: (offset + len) as u32,
        text: if children.is_empty() {
            src.get(offset..offset + len).map(|s| s.to_owned())
        } else {
            None
        },
        children,
    }
}

// ─── autocomplete() / tooltip() / definition() ────────────────────────────

#[derive(Deserialize)]
pub struct AutocompleteArgs {
    pub path: String,
    pub cursor: usize,
    #[serde(default)]
    pub explicit: bool,
}

#[derive(Serialize)]
pub struct AutocompleteResponse {
    pub from: usize,
    pub completions: Vec<Completion>,
}

#[derive(Serialize)]
pub struct Completion {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apply: Option<String>,
    pub kind: String,
}

pub fn autocomplete(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: AutocompleteArgs = from_js(args)?;
    let source_clone = {
        let file = state
            .world
            .vfs
            .get(&args.path)
            .ok_or_else(|| format!("no such file: {}", args.path))?;
        file.source()
            .ok_or_else(|| format!("file is not a Typst source: {}", args.path))?
            .clone()
    };

    let doc = state.last_document.as_ref();
    let Some((from, raw)) =
        typst_ide::autocomplete(&state.world, doc, &source_clone, args.cursor, args.explicit)
    else {
        return Ok(JsValue::NULL);
    };

    let completions = raw
        .into_iter()
        .map(|c| Completion {
            label: c.label.to_string(),
            detail: c.detail.map(|d| d.to_string()),
            apply: c.apply.map(|a| a.to_string()),
            kind: completion_kind_str(&c.kind).to_string(),
        })
        .collect();

    to_js(&AutocompleteResponse { from, completions })
}

fn completion_kind_str(kind: &typst_ide::CompletionKind) -> &'static str {
    use typst_ide::CompletionKind::*;
    match kind {
        Syntax => "syntax",
        Func => "func",
        Type => "type",
        Param => "param",
        Constant => "constant",
        Symbol(_) => "symbol",
        Path => "path",
        Package => "package",
        Label => "label",
        Font => "font",
    }
}

// ─── tooltip() ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TooltipArgs {
    pub path: String,
    pub cursor: usize,
    #[serde(default = "default_side")]
    pub side: i8,
}
fn default_side() -> i8 {
    1
}

#[derive(Serialize)]
pub struct TooltipResponse {
    pub html: String,
}

pub fn tooltip(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: TooltipArgs = from_js(args)?;
    let source_clone = {
        let file = state
            .world
            .vfs
            .get(&args.path)
            .ok_or_else(|| format!("no such file: {}", args.path))?;
        file.source()
            .ok_or_else(|| format!("file is not a Typst source: {}", args.path))?
            .clone()
    };

    let side = typst_side(args.side);
    let Some(tip) = typst_ide::tooltip(
        &state.world,
        state.last_document.as_ref(),
        &source_clone,
        args.cursor,
        side,
    ) else {
        return Ok(JsValue::NULL);
    };

    let html = match tip {
        typst_ide::Tooltip::Text(s) => escape_html(&s),
        typst_ide::Tooltip::Code(s) => format!("<code>{}</code>", escape_html(&s)),
    };
    to_js(&TooltipResponse { html })
}

fn typst_side(side: i8) -> Side {
    if side < 0 {
        Side::Before
    } else {
        Side::After
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

// ─── definition() ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct DefinitionArgs {
    pub path: String,
    pub cursor: usize,
    #[serde(default = "default_side")]
    pub side: i8,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DefinitionResponse {
    Source { path: String, pos: usize },
}

pub fn definition(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: DefinitionArgs = from_js(args)?;
    let source_clone = {
        let file = state
            .world
            .vfs
            .get(&args.path)
            .ok_or_else(|| format!("no such file: {}", args.path))?;
        file.source()
            .ok_or_else(|| format!("file is not a Typst source: {}", args.path))?
            .clone()
    };
    let side = typst_side(args.side);

    let Some(def) = typst_ide::definition(
        &state.world,
        state.last_document.as_ref(),
        &source_clone,
        args.cursor,
        side,
    ) else {
        return Ok(JsValue::NULL);
    };

    if let typst_ide::Definition::Span(span) = def {
        if let Some(id) = span.id() {
            if let Some((path, file)) = state.world.vfs.find_by_id(id) {
                if let Some(src) = file.source() {
                    if let Some(range) = src.range(span) {
                        return to_js(&DefinitionResponse::Source {
                            path: path.to_string(),
                            pos: range.start,
                        });
                    }
                }
            }
        }
    }
    // `Definition::Std(value)` - returns the definition of a built-in. We
    // don't yet emit a URL pointing at docs.typst.app, so report null.
    Ok(JsValue::NULL)
}

// ─── jumpFromCursor ──────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct JumpCursorArgs {
    pub path: String,
    pub cursor: usize,
}

pub fn jump_from_cursor(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: JumpCursorArgs = from_js(args)?;
    let Some(doc) = state.last_document.as_ref() else {
        return to_js(&Vec::<serde_json::Value>::new());
    };
    let source_clone = {
        let Some(file) = state.world.vfs.get(&args.path) else {
            return to_js(&Vec::<serde_json::Value>::new());
        };
        let Some(source) = file.source() else {
            return to_js(&Vec::<serde_json::Value>::new());
        };
        source.clone()
    };

    let jumps = typst_ide::jump_from_cursor(doc, &source_clone, args.cursor);
    let out: Vec<serde_json::Value> = jumps
        .into_iter()
        .map(|p| {
            serde_json::json!({
                "kind": "position",
                "page": p.page.get() - 1,
                "x": p.point.x.to_pt(),
                "y": p.point.y.to_pt(),
            })
        })
        .collect();
    to_js(&out)
}

// ─── jumpFromClick ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct JumpClickArgs {
    pub index: usize,
    pub x: f64,
    pub y: f64,
}

pub fn jump_from_click(state: &mut State, args: JsValue) -> Result<JsValue, String> {
    let args: JumpClickArgs = from_js(args)?;
    let Some(doc) = state.last_document.as_ref() else {
        return Ok(JsValue::NULL);
    };
    let Some(page) = doc.pages.get(args.index) else {
        return Ok(JsValue::NULL);
    };

    let point = typst::layout::Point::new(
        typst::layout::Abs::pt(args.x),
        typst::layout::Abs::pt(args.y),
    );
    let Some(jump) = typst_ide::jump_from_click(&state.world, doc, &page.frame, point) else {
        return Ok(JsValue::NULL);
    };

    match jump {
        typst_ide::Jump::File(id, pos) => {
            let Some((path, _)) = state.world.vfs.find_by_id(id) else {
                return Ok(JsValue::NULL);
            };
            to_js(&serde_json::json!({ "kind": "source", "path": path, "pos": pos }))
        }
        typst_ide::Jump::Url(url) => {
            to_js(&serde_json::json!({ "kind": "url", "url": url.to_string() }))
        }
        typst_ide::Jump::Position(p) => to_js(&serde_json::json!({
            "kind": "position",
            "page": p.page.get() - 1,
            "x": p.point.x.to_pt(),
            "y": p.point.y.to_pt(),
        })),
    }
}
