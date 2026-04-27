//! Notification shapes pushed to JS after compilation.

use serde::Serialize;

use crate::protocol::{post_notification, to_js};
use crate::state::State;

#[derive(Serialize)]
pub struct StatusNotification<'a> {
    pub status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct PageInfo {
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize)]
pub struct PagesNotification {
    pub pages: Vec<PageInfo>,
}

#[derive(Serialize, Default)]
pub struct OutlineNotification {
    pub entries: Vec<OutlineEntry>,
}

#[derive(Serialize)]
pub struct OutlineEntry {
    pub level: u32,
    pub title: String,
    pub position: OutlinePosition,
}

#[derive(Serialize)]
pub struct OutlinePosition {
    pub page: usize,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Default)]
pub struct DiagnosticsNotification {
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
}

#[derive(Serialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

pub fn emit<T: serde::Serialize>(state: &State, name: &str, payload: &T) {
    if !state.subscriptions.contains(name) {
        return;
    }
    match to_js(payload) {
        Ok(js) => post_notification(name, js),
        Err(err) => {
            // Surface a status error notification but don't recurse.
            if let Ok(fallback) = to_js(&StatusNotification {
                status: "error",
                message: Some(err),
            }) {
                post_notification("status", fallback);
            }
        }
    }
}
