use std::ops::Range;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Result, Row};
use serde::Serialize;

/// Numbered schema migrations. Index + 1 is the resulting `user_version`.
/// Add new entries; never edit existing ones.
const MIGRATIONS: &[&str] = &[
    // v1 — projects, notes, settings
    r#"
    CREATE TABLE projects (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL
    );

    CREATE TABLE notes (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        content    TEXT NOT NULL
    );

    CREATE INDEX notes_created_at_idx ON notes(created_at DESC);
    CREATE INDEX notes_project_created_idx ON notes(project_id, created_at DESC);

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
}

/// The seeded fallback project. Notes from a deleted project move here.
pub const INBOX: &str = "Inbox";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub content: String,
}

const NOTE_QUERY: &str = "SELECT n.id, n.project_id, p.name, n.created_at, n.updated_at, n.content
     FROM notes n
     JOIN projects p ON p.id = n.project_id";

const TODO_TAG: &str = "#todo";
const DONE_TAG: &str = "#done";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoLine {
    pub note_id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub created_at: String,
    /// Index of the line within the note content, used to rewrite it later.
    pub line_index: i64,
    /// The line as written, tag included.
    pub line: String,
    /// The line with the tag stripped, for display.
    pub text: String,
}

fn row_to_note(row: &Row<'_>) -> Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        content: row.get(5)?,
    })
}

/// Current UTC time, RFC 3339 with milliseconds and a `Z` suffix.
/// Stored as text so it sorts correctly and is unambiguous.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Trim a note and reject empty input.
pub fn clean_note(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then_some(trimmed)
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
        // Returns the resulting mode; ignore the value.
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
    conn.execute(
        "INSERT OR IGNORE INTO projects (name, created_at) VALUES (?1, ?2)",
        params![INBOX, now()],
    )?;
    Ok(())
}

pub fn inbox_id(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT id FROM projects WHERE name = ?1", [INBOX], |r| {
        r.get(0)
    })
}

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
    // NOCASE on the column means this matches an existing project even when the
    // casing differs, so "RQA" and "rqa" resolve to the same row.
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

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
}

/// Insert a note and remember its project, atomically. Returns the new note id.
pub fn create_note(conn: &mut Connection, project_id: i64, content: &str) -> Result<i64> {
    let timestamp = now();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO notes (project_id, created_at, updated_at, content)
         VALUES (?1, ?2, ?3, ?4)",
        params![project_id, timestamp, timestamp, content],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('last_project_id', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![project_id.to_string()],
    )?;
    tx.commit()?;
    Ok(id)
}

/// Newest first. `project_id: None` means every project; `query` is a
/// case-insensitive substring match on the content (ASCII folding, like SQLite's
/// `lower`). Good enough until full-text search is worth adding.
pub fn list_notes(
    conn: &Connection,
    project_id: Option<i64>,
    query: Option<&str>,
) -> Result<Vec<Note>> {
    let needle = query.map(str::trim).unwrap_or_default();
    let sql = format!(
        "{NOTE_QUERY}
         WHERE (?1 IS NULL OR n.project_id = ?1)
           AND (?2 = '' OR instr(lower(n.content), lower(?2)) > 0)
         ORDER BY n.created_at DESC, n.id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![project_id, needle], row_to_note)?;
    rows.collect()
}

pub fn count_notes(conn: &Connection, project_id: Option<i64>) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE (?1 IS NULL OR project_id = ?1)",
        params![project_id],
        |row| row.get(0),
    )
}

pub fn project_exists(conn: &Connection, id: i64) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )
}

/// Reassign a note without touching its timestamps: moving is not editing.
pub fn move_note(conn: &Connection, id: i64, project_id: i64) -> Result<Note> {
    let changed = conn.execute(
        "UPDATE notes SET project_id = ?2 WHERE id = ?1",
        params![id, project_id],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    conn.query_row(&format!("{NOTE_QUERY} WHERE n.id = ?1"), [id], row_to_note)
}

/* --------------------------------------------------------------------- todos */

/// Byte ranges of each line in `content`, excluding the newline.
fn line_bounds(content: &str) -> Vec<(usize, usize)> {
    let mut bounds = Vec::new();
    let mut start = 0;
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            bounds.push((start, index));
            start = index + 1;
        }
    }
    bounds.push((start, content.len()));
    bounds
}

/// Character ranges of `tag` in `line`, matched case-insensitively and only when
/// the following character is not alphanumeric, so `#todos` does not count.
fn tag_ranges(line: &str, tag: &str) -> Vec<Range<usize>> {
    let chars: Vec<char> = line.chars().collect();
    let needle: Vec<char> = tag.chars().collect();
    let mut ranges = Vec::new();
    let mut cursor = 0;
    while cursor + needle.len() <= chars.len() {
        let matched = needle
            .iter()
            .enumerate()
            .all(|(offset, expected)| chars[cursor + offset].eq_ignore_ascii_case(expected));
        let boundary = chars
            .get(cursor + needle.len())
            .is_none_or(|next| !next.is_alphanumeric());
        if matched && boundary {
            ranges.push(cursor..cursor + needle.len());
            cursor += needle.len();
        } else {
            cursor += 1;
        }
    }
    ranges
}

fn replace_ranges(line: &str, ranges: &[Range<usize>], replacement: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0;
    for range in ranges {
        for character in &chars[cursor..range.start] {
            out.push(*character);
        }
        out.push_str(replacement);
        cursor = range.end;
    }
    for character in &chars[cursor..] {
        out.push(*character);
    }
    out
}

/// The line without its tag, so `#todo send email` reads as `send email`.
fn display_text(line: &str, ranges: &[Range<usize>]) -> String {
    if ranges.is_empty() {
        return line.trim().to_string();
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0;
    for range in ranges {
        for character in &chars[cursor..range.start] {
            out.push(*character);
        }
        // Drop a colon directly after the tag: "#todo: send" reads as "send".
        cursor = range.end;
        if chars.get(cursor) == Some(&':') {
            cursor += 1;
        }
    }
    for character in &chars[cursor..] {
        out.push(*character);
    }
    let cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        line.trim().to_string()
    } else {
        cleaned
    }
}

/// One row per `#todo` line, newest note first and document order within a note.
pub fn list_todo_lines(
    conn: &Connection,
    project_id: Option<i64>,
    query: Option<&str>,
) -> Result<Vec<TodoLine>> {
    let needle = query.map(str::trim).unwrap_or_default().to_lowercase();
    let sql = format!(
        "{NOTE_QUERY}
         WHERE (?1 IS NULL OR n.project_id = ?1)
           AND instr(lower(n.content), '{TODO_TAG}') > 0
         ORDER BY n.created_at DESC, n.id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let notes = stmt
        .query_map(params![project_id], row_to_note)?
        .collect::<Result<Vec<_>>>()?;

    let mut todos = Vec::new();
    for note in notes {
        for (index, (start, end)) in line_bounds(&note.content).into_iter().enumerate() {
            let raw = &note.content[start..end];
            let line = raw.strip_suffix('\r').unwrap_or(raw);
            let ranges = tag_ranges(line, TODO_TAG);
            if ranges.is_empty() {
                continue;
            }
            if !needle.is_empty() && !line.to_lowercase().contains(&needle) {
                continue;
            }
            todos.push(TodoLine {
                note_id: note.id,
                project_id: note.project_id,
                project_name: note.project_name.clone(),
                created_at: note.created_at.clone(),
                line_index: index as i64,
                line: line.trim().to_string(),
                text: display_text(line, &ranges),
            });
        }
    }
    Ok(todos)
}

/// Replace `#todo` with `#done` on one line. Returns `None` when the line no
/// longer exists or no longer carries the tag, which means the list was stale.
pub fn complete_todo(conn: &Connection, note_id: i64, line_index: i64) -> Result<Option<Note>> {
    let content: Option<String> = conn
        .query_row(
            "SELECT content FROM notes WHERE id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(content) = content else {
        return Ok(None);
    };
    let bounds = line_bounds(&content);
    let Some(&(start, end)) = bounds.get(line_index as usize) else {
        return Ok(None);
    };

    let raw = &content[start..end];
    let (line, suffix) = match raw.strip_suffix('\r') {
        Some(stripped) => (stripped, "\r"),
        None => (raw, ""),
    };
    let ranges = tag_ranges(line, TODO_TAG);
    if ranges.is_empty() {
        return Ok(None);
    }

    let replaced = replace_ranges(line, &ranges, DONE_TAG);
    let new_content = format!(
        "{}{}{}{}",
        &content[..start],
        replaced,
        suffix,
        &content[end..]
    );
    conn.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![note_id, new_content, now()],
    )?;
    let note = conn.query_row(
        &format!("{NOTE_QUERY} WHERE n.id = ?1"),
        [note_id],
        row_to_note,
    )?;
    Ok(Some(note))
}

/// Replace the content and stamp `updated_at`. `created_at` never changes.
pub fn update_note(conn: &Connection, id: i64, content: &str) -> Result<Note> {
    let changed = conn.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, content, now()],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    conn.query_row(&format!("{NOTE_QUERY} WHERE n.id = ?1"), [id], row_to_note)
}

pub fn delete_note(conn: &Connection, id: i64) -> Result<()> {
    let changed = conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Remove a project, moving its notes to Inbox first so nothing is lost.
/// Callers must refuse to delete Inbox itself.
pub fn delete_project(conn: &mut Connection, id: i64) -> Result<()> {
    let inbox = inbox_id(conn)?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE notes SET project_id = ?1 WHERE project_id = ?2",
        params![inbox, id],
    )?;
    tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    tx.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'last_project_id' AND value = ?2",
        params![inbox.to_string(), id.to_string()],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn, false).unwrap();
        migrate(&conn).unwrap();
        seed(&conn).unwrap();
        conn
    }

    #[test]
    fn seeds_inbox_exactly_once() {
        let conn = memory_db();
        seed(&conn).unwrap();
        seed(&conn).unwrap();
        let projects = list_projects(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Inbox");
    }

    #[test]
    fn saves_a_note_with_utc_timestamp_and_remembers_project() {
        let mut conn = memory_db();
        let inbox = list_projects(&conn).unwrap()[0].clone();

        let id = create_note(&mut conn, inbox.id, "Discussed scoping.").unwrap();

        let (content, created): (String, String) = conn
            .query_row(
                "SELECT content, created_at FROM notes WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(content, "Discussed scoping.");
        assert!(created.ends_with('Z'), "timestamp should be UTC: {created}");
        assert_eq!(
            get_setting(&conn, "last_project_id").unwrap(),
            Some(inbox.id.to_string())
        );
    }

    #[test]
    fn project_names_are_case_insensitive() {
        let conn = memory_db();
        let first = create_project(&conn, "RQA").unwrap();
        let second = create_project(&conn, "rqa").unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.name, "RQA", "original casing is preserved");
    }

    #[test]
    fn rejects_notes_for_unknown_projects() {
        let mut conn = memory_db();
        assert!(create_note(&mut conn, 9999, "orphan").is_err());
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = memory_db();
        migrate(&conn).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
    }

    #[test]
    fn note_content_is_trimmed_and_empty_is_rejected() {
        assert_eq!(clean_note("  hello \n"), Some("hello"));
        assert_eq!(clean_note("   \n\t "), None);
        assert_eq!(clean_note(""), None);
    }

    #[test]
    fn lists_newest_first_and_filters_by_project() {
        let mut conn = memory_db();
        let inbox = list_projects(&conn).unwrap()[0].clone();
        let rqa = create_project(&conn, "RQA").unwrap();

        create_note(&mut conn, inbox.id, "first").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        create_note(&mut conn, rqa.id, "second").unwrap();

        let all = list_notes(&conn, None, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].content, "second", "newest first");
        assert_eq!(all[0].project_name, "RQA");

        let only_rqa = list_notes(&conn, Some(rqa.id), None).unwrap();
        assert_eq!(only_rqa.len(), 1);
        assert_eq!(only_rqa[0].content, "second");

        let only_inbox = list_notes(&conn, Some(inbox.id), None).unwrap();
        assert_eq!(only_inbox.len(), 1);
        assert_eq!(only_inbox[0].content, "first");
    }

    #[test]
    fn editing_keeps_created_at_and_moves_updated_at() {
        let mut conn = memory_db();
        let inbox = list_projects(&conn).unwrap()[0].clone();
        let id = create_note(&mut conn, inbox.id, "draft").unwrap();
        let before = list_notes(&conn, None, None).unwrap()[0].clone();
        assert_eq!(before.updated_at, before.created_at);

        std::thread::sleep(std::time::Duration::from_millis(3));
        let after = update_note(&conn, id, "final").unwrap();

        assert_eq!(after.content, "final");
        assert_eq!(after.created_at, before.created_at);
        assert!(after.updated_at > before.updated_at);
    }

    #[test]
    fn deleting_removes_the_note() {
        let mut conn = memory_db();
        let inbox = list_projects(&conn).unwrap()[0].clone();
        let id = create_note(&mut conn, inbox.id, "throwaway").unwrap();

        delete_note(&conn, id).unwrap();
        assert!(list_notes(&conn, None, None).unwrap().is_empty());
        assert!(
            delete_note(&conn, id).is_err(),
            "second delete is a no-op error"
        );
    }

    #[test]
    fn updating_a_missing_note_is_an_error() {
        let conn = memory_db();
        assert!(update_note(&conn, 4242, "ghost").is_err());
    }

    #[test]
    fn deleting_a_project_moves_its_notes_to_inbox() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let rqa = create_project(&conn, "RQA").unwrap();
        let note_id = create_note(&mut conn, rqa.id, "scoping notes").unwrap();
        // create_note remembers the project, so it has to follow the move.
        assert_eq!(
            get_setting(&conn, "last_project_id").unwrap(),
            Some(rqa.id.to_string())
        );

        delete_project(&mut conn, rqa.id).unwrap();

        let projects = list_projects(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, inbox);

        let notes = list_notes(&conn, None, None).unwrap();
        assert_eq!(notes.len(), 1, "notes survive the deletion");
        assert_eq!(notes[0].id, note_id);
        assert_eq!(notes[0].project_id, inbox);
        assert_eq!(notes[0].project_name, INBOX);

        assert_eq!(
            get_setting(&conn, "last_project_id").unwrap(),
            Some(inbox.to_string())
        );
    }

    #[test]
    fn deleting_a_project_keeps_other_projects_notes_put() {
        let mut conn = memory_db();
        let rqa = create_project(&conn, "RQA").unwrap();
        let other = create_project(&conn, "Other").unwrap();
        create_note(&mut conn, rqa.id, "one").unwrap();
        create_note(&mut conn, other.id, "two").unwrap();

        delete_project(&mut conn, rqa.id).unwrap();

        let remaining = list_notes(&conn, Some(other.id), None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].content, "two");
        assert_eq!(remaining[0].updated_at, remaining[0].created_at);
    }

    #[test]
    fn searches_content_case_insensitively_within_a_project() {
        let mut conn = memory_db();
        let inbox = list_projects(&conn).unwrap()[0].clone();
        let rqa = create_project(&conn, "RQA").unwrap();
        create_note(&mut conn, inbox.id, "Discussed regulatory discovery").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        create_note(&mut conn, rqa.id, "Technical implementation plan").unwrap();

        let hits = list_notes(&conn, None, Some("TECHNICAL")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "Technical implementation plan");

        assert!(
            list_notes(&conn, Some(inbox.id), Some("technical"))
                .unwrap()
                .is_empty(),
            "the project filter still applies while searching"
        );

        assert!(
            list_notes(&conn, None, Some("%")).unwrap().is_empty(),
            "wildcards are matched literally"
        );

        assert_eq!(
            list_notes(&conn, None, Some("   ")).unwrap().len(),
            2,
            "blank queries are ignored"
        );
        assert_eq!(count_notes(&conn, None).unwrap(), 2);
        assert_eq!(count_notes(&conn, Some(rqa.id)).unwrap(), 1);
    }

    #[test]
    fn moving_a_note_changes_project_and_keeps_timestamps() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let rqa = create_project(&conn, "RQA").unwrap();
        let id = create_note(&mut conn, inbox, "scoping").unwrap();
        let before = list_notes(&conn, None, None).unwrap()[0].clone();

        std::thread::sleep(std::time::Duration::from_millis(3));
        let moved = move_note(&conn, id, rqa.id).unwrap();

        assert_eq!(moved.project_id, rqa.id);
        assert_eq!(moved.project_name, "RQA");
        assert_eq!(moved.created_at, before.created_at);
        assert_eq!(moved.updated_at, before.updated_at, "a move is not an edit");
        assert!(list_notes(&conn, Some(inbox), None).unwrap().is_empty());
        assert_eq!(list_notes(&conn, Some(rqa.id), None).unwrap().len(), 1);
    }

    #[test]
    fn moving_to_a_missing_project_fails() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let id = create_note(&mut conn, inbox, "orphan").unwrap();

        assert!(move_note(&conn, id, 9999).is_err());
        assert!(!project_exists(&conn, 9999).unwrap());
        assert!(project_exists(&conn, inbox).unwrap());
    }

    #[test]
    fn tag_matching_ignores_case_but_respects_boundaries() {
        assert_eq!(tag_ranges("#todo send", TODO_TAG), vec![0..5]);
        assert_eq!(tag_ranges("#TODO send", TODO_TAG), vec![0..5]);
        assert_eq!(tag_ranges("send #todo", TODO_TAG), vec![5..10]);
        assert_eq!(tag_ranges("#todo: send", TODO_TAG), vec![0..5]);
        assert_eq!(tag_ranges("#todo #todo", TODO_TAG), vec![0..5, 6..11]);
        assert!(tag_ranges("#todos", TODO_TAG).is_empty());
        assert!(tag_ranges("#todoist", TODO_TAG).is_empty());
    }

    #[test]
    fn todo_text_drops_the_tag_but_keeps_the_rest() {
        for (line, expected) in [
            ("#todo send email", "send email"),
            ("#todo: send email", "send email"),
            ("Email the RSE team #todo", "Email the RSE team"),
            ("#TODO book room", "book room"),
            ("#todo", "#todo"),
        ] {
            assert_eq!(display_text(line, &tag_ranges(line, TODO_TAG)), expected);
        }
    }

    #[test]
    fn lists_todo_lines_in_document_order() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        create_note(
            &mut conn,
            inbox,
            "#todo send email\nsome prose\n#todo: book room",
        )
        .unwrap();

        let todos = list_todo_lines(&conn, None, None).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].line_index, 0);
        assert_eq!(todos[0].text, "send email");
        assert_eq!(todos[1].line_index, 2);
        assert_eq!(todos[1].text, "book room");
    }

    #[test]
    fn todo_list_respects_project_and_search() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let rqa = create_project(&conn, "RQA").unwrap();
        create_note(&mut conn, inbox, "#todo personal admin").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        create_note(&mut conn, rqa.id, "#todo email the team").unwrap();

        assert_eq!(list_todo_lines(&conn, None, None).unwrap().len(), 2);
        assert_eq!(list_todo_lines(&conn, Some(rqa.id), None).unwrap().len(), 1);

        let hits = list_todo_lines(&conn, None, Some("EMAIL")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "email the team");
    }

    #[test]
    fn completing_a_todo_swaps_the_tag_and_bumps_updated_at() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let id = create_note(
            &mut conn,
            inbox,
            "Meeting notes\n#todo send email\nmore prose",
        )
        .unwrap();
        let before = list_notes(&conn, None, None).unwrap()[0].clone();
        std::thread::sleep(std::time::Duration::from_millis(3));

        let updated = complete_todo(&conn, id, 1).unwrap().expect("completed");

        assert_eq!(
            updated.content,
            "Meeting notes\n#done send email\nmore prose"
        );
        assert_eq!(updated.created_at, before.created_at);
        assert!(
            updated.updated_at > before.updated_at,
            "completion is an edit"
        );
        let open = list_todo_lines(&conn, None, None).unwrap();
        assert!(open.is_empty(), "completed items leave the list");
    }

    #[test]
    fn completing_a_stale_line_returns_none() {
        let mut conn = memory_db();
        let inbox = inbox_id(&conn).unwrap();
        let id = create_note(&mut conn, inbox, "#todo first\nnothing here").unwrap();

        assert!(
            complete_todo(&conn, id, 1).unwrap().is_none(),
            "line has no tag"
        );
        assert!(
            complete_todo(&conn, id, 99).unwrap().is_none(),
            "out of range"
        );
        assert!(
            complete_todo(&conn, 4242, 0).unwrap().is_none(),
            "note is gone"
        );
        assert_eq!(
            complete_todo(&conn, id, 0).unwrap().unwrap().content,
            "#done first\nnothing here"
        );
    }
}
