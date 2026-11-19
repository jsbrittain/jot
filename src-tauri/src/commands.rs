use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::{self, Item, Page, PageSummary, Project};
use crate::AppState;

const MAX_PROJECT_NAME: usize = 100;
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ITEM_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    page: Page,
    projects: Vec<Project>,
    board: Vec<Item>,
    last_project_id: Option<i64>,
}

#[derive(Serialize)]
pub struct CommitResult {
    item: Item,
    page: Page,
}

/// Everything the window needs in one round trip.
#[tauri::command]
pub fn bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let page = db::current_page(&conn).map_err(|e| e.to_string())?;
    let projects = db::list_projects(&conn).map_err(|e| e.to_string())?;
    let board =
        db::query_items(&conn, false, None, false, true, None).map_err(|e| e.to_string())?;
    let last_project_id = db::last_project_id(&conn).map_err(|e| e.to_string())?;
    Ok(Bootstrap {
        page,
        projects,
        board,
        last_project_id,
    })
}

#[tauri::command]
pub fn ready(state: State<'_, AppState>) {
    if cfg!(debug_assertions) || std::env::var_os("SNIPPETS_TIMING").is_some() {
        println!("[snippets] frontend ready in {:?}", state.started.elapsed());
    }
}

/* --------------------------------------------------------------------- pages */

#[tauri::command]
pub fn save_page(
    state: State<'_, AppState>,
    page_id: i64,
    content: String,
    expected_revision: i64,
) -> Result<Page, String> {
    if content.len() > MAX_PAGE_BYTES {
        return Err("This page is too large to save".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::save_page(&conn, page_id, &content, expected_revision)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "The page changed; reload and try again".into())
}

#[tauri::command]
pub fn new_page(state: State<'_, AppState>) -> Result<Page, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::new_page(&mut conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_pages(state: State<'_, AppState>) -> Result<Vec<PageSummary>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_pages(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_page(state: State<'_, AppState>, id: i64) -> Result<Page, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::open_page(&mut conn, id).map_err(|e| e.to_string())
}

/* -------------------------------------------------------------------- items */

#[tauri::command]
pub fn commit_snippet(
    state: State<'_, AppState>,
    page_id: i64,
    page_content: String,
    snippet: String,
    project_id: Option<i64>,
    expected_revision: i64,
) -> Result<CommitResult, String> {
    if snippet.trim().is_empty() {
        return Err("There is nothing selected to pin".into());
    }
    if page_content.len() > MAX_PAGE_BYTES {
        return Err("This page is too large to save".into());
    }
    if snippet.len() > MAX_ITEM_BYTES {
        return Err("That selection is too large to pin".into());
    }
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(id) = project_id {
        if !db::project_exists(&conn, id).map_err(|e| e.to_string())? {
            return Err("That project no longer exists".into());
        }
    }
    let (item, page) = db::commit_snippet(
        &mut conn,
        page_id,
        &page_content,
        &snippet,
        project_id,
        expected_revision,
    )
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "The page changed; nothing was pinned".to_string())?;
    Ok(CommitResult { item, page })
}

#[tauri::command]
pub fn undo_commit(
    state: State<'_, AppState>,
    item_id: i64,
    page_content_before: String,
    expected_revision: i64,
) -> Result<Page, String> {
    if page_content_before.len() > MAX_PAGE_BYTES {
        return Err("This page is too large to save".into());
    }
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::undo_commit(&mut conn, item_id, &page_content_before, expected_revision)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Could not undo: the page or snippet has changed".into())
}

#[tauri::command]
pub fn update_item(state: State<'_, AppState>, id: i64, content: String) -> Result<Item, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("A snippet cannot be empty".into());
    }
    if content.len() > MAX_ITEM_BYTES {
        return Err("That snippet is too large".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::update_item(&conn, id, content)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That snippet no longer exists".into())
}

#[tauri::command]
pub fn set_done(state: State<'_, AppState>, id: i64, done: bool) -> Result<Item, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::set_done(&conn, id, done)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That snippet no longer exists".into())
}

#[tauri::command]
pub fn set_pinned(state: State<'_, AppState>, id: i64, pinned: bool) -> Result<Item, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::set_pinned(&mut conn, id, pinned)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That snippet no longer exists".into())
}

#[tauri::command]
pub fn move_item(
    state: State<'_, AppState>,
    id: i64,
    project_id: Option<i64>,
) -> Result<Item, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(project) = project_id {
        if !db::project_exists(&conn, project).map_err(|e| e.to_string())? {
            return Err("That project no longer exists".into());
        }
    }
    db::move_item(&conn, id, project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That snippet no longer exists".into())
}

#[tauri::command]
pub fn reorder_board(state: State<'_, AppState>, ordered_ids: Vec<i64>) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    db::reorder_board(&mut conn, &ordered_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_item(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_item(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_item(state: State<'_, AppState>, id: i64) -> Result<Item, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::restore_item(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That snippet no longer exists".into())
}

#[tauri::command]
pub fn query_items(
    state: State<'_, AppState>,
    archive: bool,
    project_id: Option<i64>,
    inbox_only: bool,
    include_done: bool,
    query: Option<String>,
) -> Result<Vec<Item>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::query_items(
        &conn,
        archive,
        project_id,
        inbox_only,
        include_done,
        query.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/* ----------------------------------------------------------------- projects */

pub fn validated_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is empty".into());
    }
    if name.eq_ignore_ascii_case("inbox") {
        return Err("Inbox is reserved for unlabelled snippets".into());
    }
    if name.chars().count() > MAX_PROJECT_NAME {
        return Err(format!(
            "Project name must be at most {MAX_PROJECT_NAME} characters"
        ));
    }
    Ok(name.to_string())
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String) -> Result<Project, String> {
    let name = validated_project_name(&name)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::create_project(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<Project, String> {
    let name = validated_project_name(&name)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::rename_project(&conn, id, &name).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "Another project already has that name".to_string()
        } else {
            e.to_string()
        }
    })
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::delete_project(&conn, id).map_err(|e| e.to_string())
}

/* -------------------------------------------------------------------- shell */

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Exit for real. The frontend calls this after flushing the page.
#[tauri::command]
pub fn quit_now(app: AppHandle, state: State<'_, AppState>) {
    state.force_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}
