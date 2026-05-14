//! Dispatch table for the named request protocol.

pub mod compile;
mod export;
mod ide;
mod notify;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::protocol::{from_js, post_failure, post_result};
use crate::state::{State, Target};

pub fn dispatch(state: &mut State, id: u32, name: &str, args: JsValue) {
    let result: Result<JsValue, String> = match name {
        "create" => handle_create(state, args).map(|_| JsValue::UNDEFINED),
        "edit" => handle_edit(state, args).map(|_| JsValue::UNDEFINED),
        "move" => handle_move(state, args).map(|_| JsValue::UNDEFINED),
        "delete" => handle_delete(state, args).map(|_| JsValue::UNDEFINED),
        "clear" => {
            state.world.vfs.clear();
            state.last_document = None;
            state.last_diagnostics.clear();
            Ok(JsValue::UNDEFINED)
        }

        "setTarget" => handle_set_target(state, args).map(|_| JsValue::UNDEFINED),
        "setMain" => handle_set_main(state, args).map(|_| JsValue::UNDEFINED),
        "addFont" => handle_add_font(state, args).map(|_| JsValue::UNDEFINED),
        "addFonts" => handle_add_fonts(state, args).map(|_| JsValue::UNDEFINED),
        "addFontStubs" => handle_add_font_stubs(state, args).map(|_| JsValue::UNDEFINED),
        "setRemotePackages" => handle_set_packages(state, args).map(|_| JsValue::UNDEFINED),
        "configureSpellCheck" => Ok(JsValue::UNDEFINED), // Spellcheck delegated to JS.

        "subscribe" => handle_subscribe(state, args).map(|_| JsValue::UNDEFINED),
        "unsubscribe" => handle_unsubscribe(state, args).map(|_| JsValue::UNDEFINED),

        "syntaxTree" => ide::syntax_tree(state, args),
        "tags" => ide::tags(state),
        "highlight" => ide::highlight(state, args),
        "autocomplete" => ide::autocomplete(state, args),
        "tooltip" => ide::tooltip(state, args),
        "definition" => ide::definition(state, args),
        "jumpFromCursor" => ide::jump_from_cursor(state, args),
        "jumpFromClick" => ide::jump_from_click(state, args),
        "references" => Ok(JsValue::NULL),

        "export" => export::export(state, args),
        "render" => export::render(state, args),
        "archive" => export::archive(state, args),
        "eval" => Err("eval not implemented".into()), // requires typst >= 0.15

        _ => Err(format!("unknown request: {name}")),
    };

    if is_compile_trigger(name) && result.is_ok() {
        compile::run(state);
    }

    match result {
        Ok(value) => post_result(id, value),
        Err(err) => post_failure(id, &err),
    }
}

fn is_compile_trigger(name: &str) -> bool {
    matches!(
        name,
        "create"
            | "edit"
            | "move"
            | "delete"
            | "clear"
            | "setTarget"
            | "setMain"
            | "addFont"
            | "addFonts"
            | "addFontStubs"
            | "setRemotePackages"
    )
}

#[derive(Deserialize)]
struct CreateArgs {
    path: String,
    mime: String,
    data: serde_bytes::ByteBuf,
}
fn handle_create(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: CreateArgs = from_js(args)?;
    state
        .world
        .vfs
        .create(args.path, args.mime, args.data.into_vec());
    Ok(())
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    edits: Vec<crate::vfs::Edit>,
}
fn handle_edit(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: EditArgs = from_js(args)?;
    state.world.vfs.edit(&args.path, &args.edits)
}

#[derive(Deserialize)]
struct MoveArgs {
    from: String,
    to: String,
    #[serde(default)]
    mime: Option<String>,
}
fn handle_move(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: MoveArgs = from_js(args)?;
    if !state.world.vfs.rename(&args.from, &args.to, args.mime) {
        return Err(format!("move: source not found: {}", args.from));
    }
    if state.world.main_path.as_deref() == Some(args.from.as_str()) {
        state.world.main_path = Some(args.to);
    }
    Ok(())
}

#[derive(Deserialize)]
struct DeleteArgs {
    path: String,
}
fn handle_delete(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: DeleteArgs = from_js(args)?;
    state.world.vfs.delete(&args.path);
    if state.world.main_path.as_deref() == Some(args.path.as_str()) {
        state.world.main_path = None;
    }
    Ok(())
}

#[derive(Deserialize)]
struct SetTargetArgs {
    target: String,
}
fn handle_set_target(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: SetTargetArgs = from_js(args)?;
    state.target =
        Target::from_str(&args.target).ok_or_else(|| format!("unknown target: {}", args.target))?;
    Ok(())
}

#[derive(Deserialize)]
struct SetMainArgs {
    path: String,
    #[serde(default)]
    silent: bool,
}
fn handle_set_main(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: SetMainArgs = from_js(args)?;
    state.world.main_path = Some(args.path);
    state.silent_next_compile.set(args.silent);
    Ok(())
}

#[derive(Deserialize)]
struct AddFontArgs {
    data: serde_bytes::ByteBuf,
}
fn handle_add_font(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: AddFontArgs = from_js(args)?;
    state.world.add_font(args.data.into_vec());
    Ok(())
}

#[derive(Deserialize)]
struct AddFontsArgs {
    fonts: Vec<serde_bytes::ByteBuf>,
}
fn handle_add_fonts(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: AddFontsArgs = from_js(args)?;
    state
        .world
        .add_fonts(args.fonts.into_iter().map(|b| b.into_vec()).collect());
    Ok(())
}

#[derive(Deserialize)]
struct FontStubArg {
    family: String,
    key: String,
    #[serde(default)]
    style: Option<String>,
    #[serde(default)]
    weight: Option<u16>,
    /// OpenType-style stretch number 1..=9 (5 = normal).
    #[serde(default)]
    stretch: Option<u16>,
}

#[derive(Deserialize)]
struct AddFontStubsArgs {
    stubs: Vec<FontStubArg>,
}

fn handle_add_font_stubs(state: &mut State, args: JsValue) -> Result<(), String> {
    use typst::text::{FontStretch, FontStyle, FontWeight};
    let args: AddFontStubsArgs = from_js(args)?;
    let stubs = args
        .stubs
        .into_iter()
        .map(|s| {
            let style = s
                .style
                .as_deref()
                .map(|raw| match raw {
                    "normal" => Ok(FontStyle::Normal),
                    "italic" => Ok(FontStyle::Italic),
                    "oblique" => Ok(FontStyle::Oblique),
                    other => Err(format!("addFontStubs: unknown style '{other}'")),
                })
                .transpose()?;
            Ok::<_, String>(crate::world::FontStub {
                family: s.family,
                key: s.key.into(),
                style,
                weight: s.weight.map(FontWeight::from_number),
                stretch: s.stretch.map(FontStretch::from_number),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    state.world.add_font_stubs(stubs);
    Ok(())
}

#[derive(Deserialize)]
struct NamespacedIndex {
    namespace: String,
    data: serde_bytes::ByteBuf,
}

#[derive(Deserialize)]
struct SetPackagesArgs {
    /// Bytes of the public `preview` namespace's `index.json`.
    data: serde_bytes::ByteBuf,
    #[serde(default)]
    private_namespaces: Vec<NamespacedIndex>,
}

fn handle_set_packages(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: SetPackagesArgs = from_js(args)?;
    state
        .world
        .set_package_index("preview".into(), args.data.into_vec());
    for entry in args.private_namespaces {
        state
            .world
            .set_package_index(entry.namespace.into(), entry.data.into_vec());
    }
    Ok(())
}

#[derive(Deserialize)]
struct SubscribeArgs {
    name: String,
}
fn handle_subscribe(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: SubscribeArgs = from_js(args)?;
    state.subscriptions.insert(args.name);
    Ok(())
}
fn handle_unsubscribe(state: &mut State, args: JsValue) -> Result<(), String> {
    let args: SubscribeArgs = from_js(args)?;
    state.subscriptions.remove(&args.name);
    Ok(())
}
