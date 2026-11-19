use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Result, Row};
use serde::Serialize;

/// Numbered schema migrations. Index + 1 is the resulting `user_version`.
/// Add new entries; never edit existing ones.
const MIGRATIONS: &[&str] = &[
    // v1 — projects, pages, items, settings
    r#"
    CREATE TABLE projects (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
    );

    CREATE TABLE pages (
        id          INTEGER PRIMARY KEY,
        content     TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NULL
    );

    CREATE TABLE items (
        id          INTEGER PRIMARY KEY,
        page_id     INTEGER NULL REFERENCES pages(id) ON DELETE SET NULL,
        content     TEXT NOT NULL,
        project_id  INTEGER NULL REFERENCES projects(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 1,
        position    INTEGER NOT NULL DEFAULT 0,
        done_at     TEXT NULL,
        deleted_at  TEXT NULL
    );

    CREATE INDEX items_board   ON items(pinned, position) WHERE deleted_at IS NULL;
    CREATE INDEX items_archive ON items(created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX items_project ON items(project_id)      WHERE deleted_at IS NULL;

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

pub const LAST_PROJECT: &str = "last_project_id";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: i64,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: i64,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub page_id: Option<i64>,
    pub content: String,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub pinned: bool,
    pub position: i64,
    pub done_at: Option<String>,
}

const ITEM_QUERY: &str = "SELECT i.id, i.page_id, i.content, i.project_id, p.name,
            i.created_at, i.updated_at, i.pinned, i.position, i.done_at
       FROM items i
       LEFT JOIN projects p ON p.id = i.project_id";

fn row_to_page(row: &Row<'_>) -> Result<Page> {
    Ok(Page {
        id: row.get(0)?,
        content: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        revision: row.get(4)?,
        archived: row.get::<_, Option<String>>(5)?.is_some(),
    })
}

fn row_to_item(row: &Row<'_>) -> Result<Item> {
    Ok(Item {
        id: row.get(0)?,
        page_id: row.get(1)?,
        content: row.get(2)?,
        project_id: row.get(3)?,
        project_name: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        pinned: row.get(7)?,
        position: row.get(8)?,
        done_at: row.get(9)?,
    })
}

/// Current UTC time, RFC 3339 with milliseconds and a `Z` suffix.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Open (or create) the database at `path` and bring it up to date.
pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn, true)?;
    migrate(&conn)?;
    seed(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection, wal: bool) -> Result<()> {
    if wal {
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    }
    conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let next = index as i64 + 1;
        conn.execute_batch(&format!(
            "BEGIN;\n{sql}\nPRAGMA user_version = {next};\nCOMMIT;"
        ))?;
    }
    Ok(())
}

fn seed(conn: &Connection) -> Result<()> {
    let pages: i64 = conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
    if pages == 0 {
        let timestamp = now();
        conn.execute(
            "INSERT INTO pages (content, created_at, updated_at, revision)
             VALUES ('', ?1, ?1, 0)",
            [&timestamp],
        )?;
    }
    Ok(())
}

/* --------------------------------------------------------------------- pages */

const PAGE_QUERY: &str =
    "SELECT id, content, created_at, updated_at, revision, archived_at FROM pages";

pub fn current_page(conn: &Connection) -> Result<Page> {
    let found = conn
        .query_row(
            &format!("{PAGE_QUERY} WHERE archived_at IS NULL ORDER BY id DESC LIMIT 1"),
            [],
            row_to_page,
        )
        .optional()?;
    if let Some(page) = found {
        return Ok(page);
    }
    let timestamp = now();
    conn.execute(
        "INSERT INTO pages (content, created_at, updated_at, revision)
         VALUES ('', ?1, ?1, 0)",
        [&timestamp],
    )?;
    page_by_id(conn, conn.last_insert_rowid())
}

pub fn page_by_id(conn: &Connection, id: i64) -> Result<Page> {
    conn.query_row(&format!("{PAGE_QUERY} WHERE id = ?1"), [id], row_to_page)
}

/// Save the current page. Returns `None` when `expected_revision` is stale.
pub fn save_page(
    conn: &Connection,
    page_id: i64,
    content: &str,
    expected_revision: i64,
) -> Result<Option<Page>> {
    let changed = conn.execute(
        "UPDATE pages
            SET content = ?2, updated_at = ?3, revision = revision + 1
          WHERE id = ?1 AND revision = ?4 AND archived_at IS NULL",
        params![page_id, content, now(), expected_revision],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    page_by_id(conn, page_id).map(Some)
}

/// Archive the current page and start a blank one. An empty page is reused.
pub fn new_page(conn: &mut Connection) -> Result<Page> {
    let current = current_page(conn)?;
    if current.content.trim().is_empty() {
        return Ok(current);
    }
    let timestamp = now();
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE pages SET archived_at = ?2 WHERE id = ?1",
        params![current.id, timestamp],
    )?;
    tx.execute(
        "INSERT INTO pages (content, created_at, updated_at, revision)
         VALUES ('', ?1, ?1, 0)",
        [&timestamp],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    page_by_id(conn, id)
}

pub fn list_pages(conn: &Connection) -> Result<Vec<PageSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, content, created_at, updated_at, archived_at
           FROM pages
          ORDER BY (archived_at IS NULL) DESC,
                   COALESCE(archived_at, updated_at) DESC,
                   id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let content: String = row.get(1)?;
        let preview = content
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .chars()
            .take(100)
            .collect();
        Ok(PageSummary {
            id: row.get(0)?,
            preview,
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
            archived: row.get::<_, Option<String>>(4)?.is_some(),
        })
    })?;
    rows.collect()
}

/// Make an archived page current. The current page is archived, or discarded
/// if it is empty.
pub fn open_page(conn: &mut Connection, id: i64) -> Result<Page> {
    let current = current_page(conn)?;
    if current.id == id {
        return Ok(current);
    }
    let tx = conn.transaction()?;
    if current.content.trim().is_empty() {
        tx.execute("DELETE FROM pages WHERE id = ?1", [current.id])?;
    } else {
        tx.execute(
            "UPDATE pages SET archived_at = ?2 WHERE id = ?1",
            params![current.id, now()],
        )?;
    }
    tx.execute("UPDATE pages SET archived_at = NULL WHERE id = ?1", [id])?;
    tx.commit()?;
    page_by_id(conn, id)
}

/* ------------------------------------------------------------------ projects */

pub fn list_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt =
        conn.prepare("SELECT id, name FROM projects ORDER BY name COLLATE NOCASE, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    rows.collect()
}

pub fn create_project(conn: &Connection, name: &str) -> Result<Project> {
    conn.execute(
        "INSERT OR IGNORE INTO projects (name, created_at) VALUES (?1, ?2)",
        params![name, now()],
    )?;
    conn.query_row(
        "SELECT id, name FROM projects WHERE name = ?1",
        [name],
        |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        },
    )
}

pub fn rename_project(conn: &Connection, id: i64, name: &str) -> Result<Project> {
    conn.execute(
        "UPDATE projects SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    conn.query_row("SELECT id, name FROM projects WHERE id = ?1", [id], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })
}

/// Delete a project. Its snippets become unlabelled (Inbox); nothing is lost.
pub fn delete_project(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(())
}

pub fn project_exists(conn: &Connection, id: i64) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )
}

/* -------------------------------------------------------------------- items */

pub fn get_item(conn: &Connection, id: i64) -> Result<Option<Item>> {
    conn.query_row(
        &format!("{ITEM_QUERY} WHERE i.id = ?1 AND i.deleted_at IS NULL"),
        [id],
        row_to_item,
    )
    .optional()
}

/// Fetch an item even if it is soft-deleted. Used by undo paths.
pub fn get_item_any(conn: &Connection, id: i64) -> Result<Option<Item>> {
    conn.query_row(&format!("{ITEM_QUERY} WHERE i.id = ?1"), [id], row_to_item)
        .optional()
}

/// Commit a snippet and update the page in one transaction. Returns `None`
/// when the page revision is stale; on `None` nothing has been written.
pub fn commit_snippet(
    conn: &mut Connection,
    page_id: i64,
    page_content: &str,
    snippet: &str,
    project_id: Option<i64>,
    expected_revision: i64,
) -> Result<Option<(Item, Page)>> {
    let snippet = snippet.trim();
    if snippet.is_empty() {
        return Ok(None);
    }
    let timestamp = now();
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE pages
            SET content = ?2, updated_at = ?3, revision = revision + 1
          WHERE id = ?1 AND revision = ?4 AND archived_at IS NULL",
        params![page_id, page_content, timestamp, expected_revision],
    )?;
    if changed == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    tx.execute(
        "UPDATE items SET position = position + 1
          WHERE pinned = 1 AND deleted_at IS NULL",
        [],
    )?;
    tx.execute(
        "INSERT INTO items
            (page_id, content, project_id, created_at, updated_at, pinned, position)
         VALUES (?1, ?2, ?3, ?4, ?4, 1, 0)",
        params![page_id, snippet, project_id, timestamp],
    )?;
    let item_id = tx.last_insert_rowid();
    let last_project = project_id.map(|id| id.to_string()).unwrap_or_default();
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LAST_PROJECT, last_project],
    )?;
    tx.commit()?;
    let item = get_item(conn, item_id)?.expect("inserted item must exist");
    let page = page_by_id(conn, page_id)?;
    Ok(Some((item, page)))
}

/// Reverse a commit. Returns `None` if the page moved on or the snippet was
/// edited, in which case the snippet is kept and the page is untouched.
pub fn undo_commit(
    conn: &mut Connection,
    item_id: i64,
    page_content_before: &str,
    expected_revision: i64,
) -> Result<Option<Page>> {
    let timestamp = now();
    let tx = conn.transaction()?;
    let row: Option<(Option<i64>, String, String)> = tx
        .query_row(
            "SELECT page_id, created_at, updated_at
               FROM items WHERE id = ?1 AND deleted_at IS NULL",
            [item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((page_id, created_at, updated_at)) = row else {
        tx.rollback()?;
        return Ok(None);
    };
    if created_at != updated_at {
        tx.rollback()?;
        return Ok(None);
    }
    let Some(page_id) = page_id else {
        tx.rollback()?;
        return Ok(None);
    };
    let changed = tx.execute(
        "UPDATE pages
            SET content = ?2, updated_at = ?3, revision = revision + 1
          WHERE id = ?1 AND revision = ?4",
        params![page_id, page_content_before, timestamp, expected_revision],
    )?;
    if changed == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    tx.execute("DELETE FROM items WHERE id = ?1", [item_id])?;
    tx.commit()?;
    page_by_id(conn, page_id).map(Some)
}

/// Move a snippet's text back to the page and soft-delete the snippet in one
/// transaction. Returns `None` when the page revision changed or the item is
/// missing; nothing is written in that case.
pub fn extract_item_to_page(
    conn: &mut Connection,
    item_id: i64,
    page_id: i64,
    page_content: &str,
    expected_revision: i64,
) -> Result<Option<(Page, Item)>> {
    let Some(item) = get_item(conn, item_id)? else {
        return Ok(None);
    };
    let timestamp = now();
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE pages
            SET content = ?2, updated_at = ?3, revision = revision + 1
          WHERE id = ?1 AND revision = ?4 AND archived_at IS NULL",
        params![page_id, page_content, timestamp, expected_revision],
    )?;
    if changed == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    let deleted = tx.execute(
        "UPDATE items SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![item_id, timestamp],
    )?;
    if deleted == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    tx.commit()?;
    let page = page_by_id(conn, page_id)?;
    Ok(Some((page, item)))
}

/// Reverse `extract_item_to_page`: restore the page and un-delete the snippet
/// together. Returns `None` when the page revision changed.
pub fn undo_extract_item_to_page(
    conn: &mut Connection,
    item_id: i64,
    page_id: i64,
    page_content_before: &str,
    expected_revision: i64,
) -> Result<Option<(Page, Item)>> {
    if get_item_any(conn, item_id)?.is_none() {
        return Ok(None);
    }
    let timestamp = now();
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE pages
            SET content = ?2, updated_at = ?3, revision = revision + 1
          WHERE id = ?1 AND revision = ?4 AND archived_at IS NULL",
        params![page_id, page_content_before, timestamp, expected_revision],
    )?;
    if changed == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    let restored = tx.execute(
        "UPDATE items SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        [item_id],
    )?;
    if restored == 0 {
        tx.rollback()?;
        return Ok(None);
    }
    tx.commit()?;
    let page = page_by_id(conn, page_id)?;
    let item = get_item(conn, item_id)?.expect("restored item must exist");
    Ok(Some((page, item)))
}

/// Replace a snippet's text. `created_at` never changes.
pub fn update_item(conn: &Connection, id: i64, content: &str) -> Result<Option<Item>> {
    let changed = conn.execute(
        "UPDATE items SET content = ?2, updated_at = ?3
          WHERE id = ?1 AND deleted_at IS NULL",
        params![id, content, now()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_item(conn, id)
}

/// Tick or untick a snippet. This is not a content edit, so `updated_at`
/// does not move.
pub fn set_done(conn: &Connection, id: i64, done: bool) -> Result<Option<Item>> {
    let done_at = done.then(now);
    let changed = conn.execute(
        "UPDATE items SET done_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, done_at],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_item(conn, id)
}

/// Pin a snippet at the top of the board, or unpin it. Not a content edit.
pub fn set_pinned(conn: &mut Connection, id: i64, pinned: bool) -> Result<Option<Item>> {
    let Some(item) = get_item(conn, id)? else {
        return Ok(None);
    };
    if item.pinned == pinned {
        return Ok(Some(item));
    }
    let tx = conn.transaction()?;
    if pinned {
        tx.execute(
            "UPDATE items SET position = position + 1
              WHERE pinned = 1 AND deleted_at IS NULL",
            [],
        )?;
        tx.execute(
            "UPDATE items SET pinned = 1, position = 0 WHERE id = ?1",
            [id],
        )?;
    } else {
        tx.execute("UPDATE items SET pinned = 0 WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    get_item(conn, id)
}

/// Reassign a snippet. Moving is not editing.
pub fn move_item(conn: &Connection, id: i64, project_id: Option<i64>) -> Result<Option<Item>> {
    let changed = conn.execute(
        "UPDATE items SET project_id = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, project_id],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_item(conn, id)
}

pub fn reorder_board(conn: &mut Connection, ordered_ids: &[i64]) -> Result<()> {
    let tx = conn.transaction()?;
    for (position, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE items SET position = ?2
              WHERE id = ?1 AND pinned = 1 AND deleted_at IS NULL",
            params![id, position as i64],
        )?;
    }
    tx.commit()
}

pub fn delete_item(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE items SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now()],
    )?;
    Ok(())
}

/// Undo a soft delete. The item keeps its old board position.
pub fn restore_item(conn: &Connection, id: i64) -> Result<Option<Item>> {
    conn.execute(
        "UPDATE items SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        [id],
    )?;
    get_item(conn, id)
}

/// Query snippets for the board or the archive.
///
/// `archive = false` means pinned only. `project_id` and `inbox_only` are
/// mutually exclusive in practice; `inbox_only` wins. Search is a
/// case-insensitive substring match on content.
pub fn query_items(
    conn: &Connection,
    archive: bool,
    project_id: Option<i64>,
    inbox_only: bool,
    include_done: bool,
    query: Option<&str>,
) -> Result<Vec<Item>> {
    use rusqlite::types::Value;

    let mut sql = String::from(ITEM_QUERY);
    sql.push_str(" WHERE i.deleted_at IS NULL");
    let mut args: Vec<Value> = Vec::new();

    if !archive {
        sql.push_str(" AND i.pinned = 1");
    }
    if inbox_only {
        sql.push_str(" AND i.project_id IS NULL");
    } else if let Some(id) = project_id {
        sql.push_str(&format!(" AND i.project_id = ?{}", args.len() + 1));
        args.push(Value::Integer(id));
    }
    if !include_done {
        sql.push_str(" AND i.done_at IS NULL");
    }
    let needle = query.map(str::trim).unwrap_or_default().to_lowercase();
    if !needle.is_empty() {
        sql.push_str(&format!(
            " AND instr(lower(i.content), ?{}) > 0",
            args.len() + 1
        ));
        args.push(Value::Text(needle));
    }
    if archive {
        sql.push_str(" ORDER BY i.created_at DESC, i.id DESC LIMIT 500");
    } else {
        sql.push_str(" ORDER BY i.position ASC, i.id ASC");
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), row_to_item)?;
    rows.collect()
}

/* ----------------------------------------------------------------- settings */

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

/// The remembered project, with `None` meaning Inbox.
pub fn last_project_id(conn: &Connection) -> Result<Option<i64>> {
    Ok(get_setting(conn, LAST_PROJECT)?.and_then(|value| value.parse::<i64>().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn, false).unwrap();
        migrate(&conn).unwrap();
        seed(&conn).unwrap();
        conn
    }

    fn commit(conn: &mut Connection, text: &str, project: Option<i64>) -> (Item, Page) {
        let page = current_page(conn).unwrap();
        let after = page.content.replace(text, "");
        commit_snippet(conn, page.id, &after, text, project, page.revision)
            .unwrap()
            .expect("commit should succeed")
    }

    #[test]
    fn migrates_and_seeds_one_page() {
        let conn = memory_db();
        let page = current_page(&conn).unwrap();
        assert_eq!(page.content, "");
        assert_eq!(page.revision, 0);
        assert!(!page.archived);
        assert!(list_projects(&conn).unwrap().is_empty());
    }

    #[test]
    fn saving_a_page_bumps_the_revision_and_rejects_stale_writes() {
        let conn = memory_db();
        let page = current_page(&conn).unwrap();

        let saved = save_page(&conn, page.id, "hello", page.revision)
            .unwrap()
            .expect("first save");
        assert_eq!(saved.content, "hello");
        assert_eq!(saved.revision, page.revision + 1);

        assert!(
            save_page(&conn, page.id, "stale", page.revision)
                .unwrap()
                .is_none(),
            "the old revision is rejected"
        );
        assert_eq!(page_by_id(&conn, page.id).unwrap().content, "hello");
    }

    #[test]
    fn commit_cuts_the_page_and_pins_the_snippet() {
        let mut conn = memory_db();
        let page = current_page(&conn).unwrap();
        save_page(&conn, page.id, "alpha\nbravo\ncharlie", page.revision)
            .unwrap()
            .unwrap();
        let rqa = create_project(&conn, "RQA").unwrap();
        let page = current_page(&conn).unwrap();

        let (item, after) = commit_snippet(
            &mut conn,
            page.id,
            "alpha\ncharlie",
            "  bravo  ",
            Some(rqa.id),
            page.revision,
        )
        .unwrap()
        .expect("commit");

        assert_eq!(after.content, "alpha\ncharlie");
        assert_eq!(after.revision, page.revision + 1);
        assert_eq!(item.content, "bravo", "snippet is trimmed");
        assert_eq!(item.project_id, Some(rqa.id));
        assert_eq!(item.project_name.as_deref(), Some("RQA"));
        assert!(item.pinned);
        assert_eq!(item.position, 0);
        assert_eq!(item.page_id, Some(page.id));
        assert_eq!(last_project_id(&conn).unwrap(), Some(rqa.id));
    }

    #[test]
    fn a_second_commit_goes_to_the_top_of_the_board() {
        let mut conn = memory_db();
        let (first, _) = commit(&mut conn, "first", None);
        std::thread::sleep(Duration::from_millis(3));
        let (second, _) = commit(&mut conn, "second", None);

        assert_eq!(second.position, 0);
        assert_eq!(
            get_item(&conn, first.id).unwrap().unwrap().position,
            1,
            "the existing item shifted down"
        );
        let board = query_items(&conn, false, None, false, true, None).unwrap();
        assert_eq!(board[0].id, second.id);
        assert_eq!(board[1].id, first.id);
    }

    #[test]
    fn a_stale_commit_writes_nothing() {
        let mut conn = memory_db();
        let page = current_page(&conn).unwrap();
        save_page(&conn, page.id, "newer", page.revision)
            .unwrap()
            .unwrap();

        assert!(
            commit_snippet(&mut conn, page.id, "cut", "snippet", None, page.revision)
                .unwrap()
                .is_none()
        );
        assert_eq!(page_by_id(&conn, page.id).unwrap().content, "newer");
        assert!(query_items(&conn, true, None, false, true, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn undo_restores_the_page_and_removes_the_snippet() {
        let mut conn = memory_db();
        let page = current_page(&conn).unwrap();
        save_page(&conn, page.id, "alpha bravo", page.revision)
            .unwrap()
            .unwrap();
        let page = current_page(&conn).unwrap();
        let before = page.content.clone();
        let (item, after) =
            commit_snippet(&mut conn, page.id, "alpha ", "bravo", None, page.revision)
                .unwrap()
                .unwrap();

        let restored = undo_commit(&mut conn, item.id, &before, after.revision)
            .unwrap()
            .expect("undo");
        assert_eq!(restored.content, before);
        assert!(get_item(&conn, item.id).unwrap().is_none());
    }

    #[test]
    fn undo_refuses_after_a_page_write_or_a_snippet_edit() {
        let mut conn = memory_db();
        let (item, after) = commit(&mut conn, "text", None);

        save_page(&conn, after.id, "typed more", after.revision)
            .unwrap()
            .unwrap();
        assert!(
            undo_commit(&mut conn, item.id, "", after.revision)
                .unwrap()
                .is_none(),
            "the page moved on"
        );

        let mut conn = memory_db();
        let (item, after) = commit(&mut conn, "text", None);
        std::thread::sleep(Duration::from_millis(3));
        update_item(&conn, item.id, "edited").unwrap();
        assert!(
            undo_commit(&mut conn, item.id, "", after.revision)
                .unwrap()
                .is_none(),
            "the snippet was edited"
        );
        assert!(get_item(&conn, item.id).unwrap().is_some());
    }

    #[test]
    fn extracting_a_snippet_updates_the_page_and_removes_it() {
        let mut conn = memory_db();
        let rqa = create_project(&conn, "RQA").unwrap();
        let page = current_page(&conn).unwrap();
        save_page(&conn, page.id, "alpha bravo", page.revision)
            .unwrap()
            .unwrap();
        let page = current_page(&conn).unwrap();
        let (item, after_commit) = commit_snippet(
            &mut conn,
            page.id,
            "alpha ",
            "bravo",
            Some(rqa.id),
            page.revision,
        )
        .unwrap()
        .unwrap();
        set_done(&conn, item.id, true).unwrap();
        let before = get_item(&conn, item.id).unwrap().unwrap();

        let (page, returned) = extract_item_to_page(
            &mut conn,
            item.id,
            after_commit.id,
            "alpha bravo",
            after_commit.revision,
        )
        .unwrap()
        .expect("extract");

        assert_eq!(page.content, "alpha bravo");
        assert_eq!(page.revision, after_commit.revision + 1);
        assert_eq!(returned.content, "bravo");
        assert_eq!(returned.project_id, Some(rqa.id));
        assert_eq!(returned.done_at, before.done_at);
        assert_eq!(returned.created_at, before.created_at);
        assert!(get_item(&conn, item.id).unwrap().is_none());
        assert!(query_items(&conn, true, None, false, true, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn extract_with_a_stale_revision_writes_nothing() {
        let mut conn = memory_db();
        let (item, page) = commit(&mut conn, "text", None);
        let newer = save_page(&conn, page.id, "newer", page.revision)
            .unwrap()
            .unwrap();

        assert!(
            extract_item_to_page(&mut conn, item.id, page.id, "newer text", page.revision)
                .unwrap()
                .is_none()
        );
        assert_eq!(page_by_id(&conn, page.id).unwrap().content, "newer");
        assert_eq!(newer.revision, page.revision + 1);
        assert!(get_item(&conn, item.id).unwrap().is_some());
    }

    #[test]
    fn extract_missing_item_writes_nothing() {
        let mut conn = memory_db();
        let page = current_page(&conn).unwrap();

        assert!(
            extract_item_to_page(&mut conn, 404, page.id, "text", page.revision)
                .unwrap()
                .is_none()
        );
        assert_eq!(page_by_id(&conn, page.id).unwrap().content, "");
    }

    #[test]
    fn undo_extract_restores_the_page_and_snippet() {
        let mut conn = memory_db();
        let (item, page) = commit(&mut conn, "text", None);
        let (extracted_page, _) =
            extract_item_to_page(&mut conn, item.id, page.id, "text", page.revision)
                .unwrap()
                .unwrap();

        let (restored_page, restored_item) =
            undo_extract_item_to_page(&mut conn, item.id, page.id, "", extracted_page.revision)
                .unwrap()
                .expect("undo");

        assert_eq!(restored_page.content, "");
        assert_eq!(restored_item.id, item.id);
        assert_eq!(restored_item.content, item.content);
        assert_eq!(restored_item.project_id, item.project_id);
        assert!(get_item(&conn, item.id).unwrap().is_some());
    }

    #[test]
    fn undo_extract_refuses_after_a_page_write() {
        let mut conn = memory_db();
        let (item, page) = commit(&mut conn, "text", None);
        let (extracted_page, _) =
            extract_item_to_page(&mut conn, item.id, page.id, "text", page.revision)
                .unwrap()
                .unwrap();
        let typed = save_page(&conn, page.id, "typed", extracted_page.revision)
            .unwrap()
            .unwrap();

        assert!(undo_extract_item_to_page(
            &mut conn,
            item.id,
            page.id,
            "",
            extracted_page.revision
        )
        .unwrap()
        .is_none());
        assert_eq!(page_by_id(&conn, page.id).unwrap().content, "typed");
        assert_eq!(typed.revision, extracted_page.revision + 1);
        assert!(get_item(&conn, item.id).unwrap().is_none());
    }

    #[test]
    fn done_and_pinned_are_independent() {
        let mut conn = memory_db();
        let (item, _) = commit(&mut conn, "job", None);

        let done = set_done(&conn, item.id, true).unwrap().unwrap();
        assert!(done.done_at.is_some());
        assert!(done.pinned);
        assert_eq!(done.updated_at, done.created_at, "ticking is not an edit");

        let unpinned = set_pinned(&mut conn, item.id, false).unwrap().unwrap();
        assert!(!unpinned.pinned);

        let pinned = set_pinned(&mut conn, item.id, true).unwrap().unwrap();
        assert!(pinned.pinned);
        assert_eq!(pinned.position, 0, "re-pinning puts it on top");
    }

    #[test]
    fn board_excludes_done_by_default_while_archive_keeps_everything() {
        let mut conn = memory_db();
        let (item, _) = commit(&mut conn, "job", None);
        set_done(&conn, item.id, true).unwrap();

        assert!(query_items(&conn, false, None, false, false, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            query_items(&conn, false, None, false, true, None)
                .unwrap()
                .len(),
            1,
            "the board still knows about done items for the shelf"
        );
        assert_eq!(
            query_items(&conn, true, None, false, true, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unpinned_items_leave_the_board_but_stay_in_the_archive() {
        let mut conn = memory_db();
        let (item, _) = commit(&mut conn, "keep", None);
        set_pinned(&mut conn, item.id, false).unwrap();

        assert!(query_items(&conn, false, None, false, true, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            query_items(&conn, true, None, false, true, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reordering_rewrites_positions() {
        let mut conn = memory_db();
        let (first, _) = commit(&mut conn, "one", None);
        std::thread::sleep(Duration::from_millis(3));
        let (second, _) = commit(&mut conn, "two", None);

        reorder_board(&mut conn, &[first.id, second.id]).unwrap();
        let board = query_items(&conn, false, None, false, true, None).unwrap();
        assert_eq!(board[0].id, first.id);
        assert_eq!(board[1].id, second.id);
        assert_eq!(board[0].position, 0);
        assert_eq!(board[1].position, 1);
    }

    #[test]
    fn moves_do_not_touch_timestamps_and_edits_do() {
        let mut conn = memory_db();
        let rqa = create_project(&conn, "RQA").unwrap();
        let inbox = create_project(&conn, "Inbox-ish").unwrap();
        let (item, _) = commit(&mut conn, "text", Some(inbox.id));
        let before = get_item(&conn, item.id).unwrap().unwrap();

        std::thread::sleep(Duration::from_millis(3));
        let moved = move_item(&conn, item.id, Some(rqa.id)).unwrap().unwrap();
        assert_eq!(moved.project_id, Some(rqa.id));
        assert_eq!(moved.created_at, before.created_at);
        assert_eq!(moved.updated_at, before.updated_at, "moving is not editing");

        std::thread::sleep(Duration::from_millis(3));
        let edited = update_item(&conn, item.id, "new text").unwrap().unwrap();
        assert_eq!(edited.content, "new text");
        assert_eq!(edited.created_at, before.created_at);
        assert!(edited.updated_at > before.updated_at);
    }

    #[test]
    fn search_and_project_filters_combine() {
        let mut conn = memory_db();
        let rqa = create_project(&conn, "RQA").unwrap();
        let (a, _) = commit(&mut conn, "Technical plan", Some(rqa.id));
        std::thread::sleep(Duration::from_millis(3));
        let (b, _) = commit(&mut conn, "Personal admin", None);

        let hits = query_items(&conn, true, None, false, true, Some("TECHNICAL")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, a.id);

        let inbox = query_items(&conn, true, None, true, true, None).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].id, b.id);

        let project = query_items(&conn, true, Some(rqa.id), false, true, None).unwrap();
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].id, a.id);

        assert!(
            query_items(&conn, true, Some(rqa.id), false, true, Some("personal"))
                .unwrap()
                .is_empty(),
            "the project filter still applies while searching"
        );
        assert!(
            query_items(&conn, true, None, false, true, Some("%"))
                .unwrap()
                .is_empty(),
            "wildcards are literal"
        );
    }

    #[test]
    fn archive_is_newest_first() {
        let mut conn = memory_db();
        let (first, _) = commit(&mut conn, "one", None);
        std::thread::sleep(Duration::from_millis(3));
        let (second, _) = commit(&mut conn, "two", None);

        let all = query_items(&conn, true, None, false, true, None).unwrap();
        assert_eq!(all[0].id, second.id);
        assert_eq!(all[1].id, first.id);
    }

    #[test]
    fn deleting_a_project_unlabels_its_snippets() {
        let mut conn = memory_db();
        let rqa = create_project(&conn, "RQA").unwrap();
        let (item, _) = commit(&mut conn, "scoping", Some(rqa.id));

        delete_project(&conn, rqa.id).unwrap();
        let after = get_item(&conn, item.id).unwrap().unwrap();
        assert_eq!(after.project_id, None);
        assert_eq!(after.project_name, None);
        assert!(
            query_items(&conn, true, None, true, true, None)
                .unwrap()
                .iter()
                .any(|i| i.id == item.id),
            "the snippet survives in Inbox"
        );
    }

    #[test]
    fn project_names_are_case_insensitive_and_rename_is_unique() {
        let conn = memory_db();
        let first = create_project(&conn, "RQA").unwrap();
        let second = create_project(&conn, "rqa").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.name, "RQA");

        let other = create_project(&conn, "Other").unwrap();
        assert!(rename_project(&conn, other.id, "RQA").is_err());
    }

    #[test]
    fn new_page_archives_and_open_page_swaps() {
        let mut conn = memory_db();
        let first = current_page(&conn).unwrap();
        save_page(&conn, first.id, "first page", first.revision)
            .unwrap()
            .unwrap();

        let second = new_page(&mut conn).unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(second.content, "");
        assert!(page_by_id(&conn, first.id).unwrap().archived);

        save_page(&conn, second.id, "second page", second.revision)
            .unwrap()
            .unwrap();
        let reopened = open_page(&mut conn, first.id).unwrap();
        assert_eq!(reopened.content, "first page");
        assert!(!reopened.archived);
        assert!(page_by_id(&conn, second.id).unwrap().archived);
        assert_eq!(list_pages(&conn).unwrap().len(), 2);
    }

    #[test]
    fn new_page_reuses_an_empty_current_page() {
        let mut conn = memory_db();
        let first = current_page(&conn).unwrap();
        let second = new_page(&mut conn).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(list_pages(&conn).unwrap().len(), 1);
    }

    #[test]
    fn soft_delete_hides_from_every_query() {
        let mut conn = memory_db();
        let (item, _) = commit(&mut conn, "bye", None);
        delete_item(&conn, item.id).unwrap();

        assert!(get_item(&conn, item.id).unwrap().is_none());
        assert!(query_items(&conn, true, None, false, true, None)
            .unwrap()
            .is_empty());
        assert!(query_items(&conn, false, None, false, true, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn restore_undoes_a_soft_delete() {
        let mut conn = memory_db();
        let (item, _) = commit(&mut conn, "bye", None);
        delete_item(&conn, item.id).unwrap();

        let restored = restore_item(&conn, item.id).unwrap().unwrap();
        assert_eq!(restored.id, item.id);
        assert_eq!(
            query_items(&conn, true, None, false, true, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn stale_or_missing_items_are_reported_as_none() {
        let mut conn = memory_db();
        assert!(update_item(&conn, 404, "x").unwrap().is_none());
        assert!(set_done(&conn, 404, true).unwrap().is_none());
        assert!(set_pinned(&mut conn, 404, true).unwrap().is_none());
        assert!(move_item(&conn, 404, None).unwrap().is_none());
    }
}
