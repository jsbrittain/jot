use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::{self, Note, Project};
use crate::AppState;

const LAST_PROJECT: &str = "last_project_id";
const MAX_PROJECT_NAME: usize = 100;

/// Startup telemetry is on in debug builds and whenever `JOT_TIMING` is set,
/// so release builds can be measured without printing by default.
pub(crate) fn timing_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var_os("JOT_TIMING").is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    projects: Vec<Project>,
    /// Falls back to none when the remembered project no longer exists.
    last_project_id: Option<i64>,
}

/// Everything the capture window needs in one round trip.
#[tauri::command]
pub fn bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let projects = db::list_projects(&conn).map_err(|e| e.to_string())?;
    let last_project_id = db::get_setting(&conn, LAST_PROJECT)
        .map_err(|e| e.to_string())?
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|id| projects.iter().any(|p| p.id == *id));
    Ok(Bootstrap {
        projects,
        last_project_id,
    })
}

/// Signals that the frontend has loaded. Release builds stay silent on purpose:
/// the capture window appears only when summoned (hotkey, Dock, relaunch).
#[tauri::command]
pub fn ready(app: AppHandle, state: State<'_, AppState>) {
    // `tauri dev` would otherwise start with no visible window.
    if cfg!(debug_assertions) {
        crate::reveal(&app);
    }
    if timing_enabled() {
        println!("[jot] frontend ready in {:?}", state.started.elapsed());
    }
}

/// Startup telemetry, reported after first paint. Visible in debug builds and
/// whenever `JOT_TIMING` is set.
#[tauri::command]
pub fn report_timing(state: State<'_, AppState>, ui_ms: f64) {
    if timing_enabled() {
        println!(
            "[jot] startup: process -> shown {:?}, ui load -> painted {:.1} ms",
            state.started.elapsed(),
            ui_ms
        );
    }
}

/// Save a note, remember the project, and hide the window.
#[tauri::command]
pub fn create_note(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: i64,
    content: String,
) -> Result<i64, String> {
    let content = db::clean_note(&content).ok_or_else(|| "Note is empty".to_string())?;
    let id = {
        let mut conn = state.db.lock().map_err(|e| e.to_string())?;
        db::create_note(&mut conn, project_id, content).map_err(|e| e.to_string())?
    };
    state.dirty.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(id)
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is empty".into());
    }
    if name.chars().count() > MAX_PROJECT_NAME {
        return Err(format!(
            "Project name must be at most {MAX_PROJECT_NAME} characters"
        ));
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::create_project(&conn, name).map_err(|e| e.to_string())
}

/// Called only when the dirty state flips, not on every keystroke.
#[tauri::command]
pub fn set_dirty(state: State<'_, AppState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}

/* ------------------------------------------------------------------ browsing */

#[tauri::command]
pub fn list_notes(
    state: State<'_, AppState>,
    project_id: Option<i64>,
    query: Option<String>,
) -> Result<Vec<Note>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_notes(&conn, project_id, query.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn count_notes(state: State<'_, AppState>, project_id: Option<i64>) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::count_notes(&conn, project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_note(state: State<'_, AppState>, id: i64, project_id: i64) -> Result<Note, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if !db::project_exists(&conn, project_id).map_err(|e| e.to_string())? {
        return Err("That project no longer exists".into());
    }
    db::move_note(&conn, id, project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_note(state: State<'_, AppState>, id: i64, content: String) -> Result<Note, String> {
    let content = db::clean_note(&content).ok_or_else(|| "Note is empty".to_string())?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::update_note(&conn, id, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_note(&conn, id).map_err(|e| e.to_string())
}

/// Deletes a project, moving its notes to Inbox. Inbox itself is protected.
#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let inbox = db::inbox_id(&conn).map_err(|e| e.to_string())?;
    if id == inbox {
        return Err(format!("{} can't be deleted", db::INBOX));
    }
    db::delete_project(&mut conn, id).map_err(|e| e.to_string())
}

/// Open the browse window, or focus it if it is already up. Created lazily so
/// startup stays untouched.
#[tauri::command]
pub fn open_browser(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("browse") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "browse", tauri::WebviewUrl::App("browse.html".into()))
        .title("Notes")
        .inner_size(900.0, 620.0)
        .min_inner_size(680.0, 440.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_browser(app: AppHandle, state: State<'_, AppState>) {
    state.browse_dirty.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("browse") {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn set_browse_dirty(state: State<'_, AppState>, dirty: bool) {
    state.browse_dirty.store(dirty, Ordering::SeqCst);
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Discard any draft and exit for real, bypassing the close guard.
#[tauri::command]
pub fn quit_now(app: AppHandle, state: State<'_, AppState>) {
    state.force_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}
