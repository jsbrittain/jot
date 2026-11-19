#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

pub struct AppState {
    pub db: Mutex<Connection>,
    /// Set once the user has confirmed quitting, so exit is not intercepted.
    pub force_exit: AtomicBool,
    pub started: Instant,
}

/// Show and focus the window. Emits `shown` when it was hidden so the
/// frontend can put the caret back in the page.
fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.show();
        let _ = window.set_focus();
        if !was_visible {
            let _ = window.emit("shown", ());
        }
    }
}

/// Windows and Linux need a tray to keep a hidden window reachable and to
/// offer Quit. macOS uses the Dock.
#[cfg(not(target_os = "macos"))]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "Open Jot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::with_id("jot-tray")
        .icon(icon)
        .tooltip("Jot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Summon the window from anywhere. Uses the platform hotkey API, so it needs
/// no Accessibility permission. Another app may already own the shortcut.
fn register_global_shortcut(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let modifiers = if cfg!(target_os = "macos") {
        Modifiers::SUPER | Modifiers::SHIFT
    } else {
        Modifiers::CONTROL | Modifiers::SHIFT
    };
    let shortcut = Shortcut::new(Some(modifiers), Code::KeyJ);

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, triggered, event| {
                if event.state == ShortcutState::Pressed && triggered.matches(modifiers, Code::KeyJ)
                {
                    reveal(app);
                }
            })
            .build(),
    )?;

    if let Err(error) = app.global_shortcut().register(shortcut) {
        eprintln!("[jot] global shortcut unavailable: {error}");
    }
    Ok(())
}

fn run() {
    let started = Instant::now();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            reveal(app)
        }))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Keep the original database file name so existing notes are reused.
            let db_path = data_dir.join("snippets.db");
            let conn = db::open(&db_path)?;
            if cfg!(debug_assertions) || std::env::var_os("JOT_TIMING").is_some() {
                println!("[jot] database: {}", db_path.display());
            }
            app.manage(AppState {
                db: Mutex::new(conn),
                force_exit: AtomicBool::new(false),
                started,
            });

            #[cfg(not(target_os = "macos"))]
            build_tray(app.handle())?;

            register_global_shortcut(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::ready,
            commands::save_page,
            commands::new_page,
            commands::list_pages,
            commands::open_page,
            commands::commit_snippet,
            commands::undo_commit,
            commands::extract_item_to_page,
            commands::undo_extract_item_to_page,
            commands::update_item,
            commands::set_done,
            commands::set_pinned,
            commands::move_item,
            commands::reorder_board,
            commands::delete_item,
            commands::restore_item,
            commands::query_items,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::open_external_link,
            commands::hide_window,
            commands::quit_now,
        ])
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            api.prevent_close();
            let _ = window.hide();
        })
        .build(tauri::generate_context!())
        .expect("failed to build Jot");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. }
            if !app.state::<AppState>().force_exit.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
            let _ = app.emit("flush-quit", ());
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let state = handle.state::<AppState>();
                if !state.force_exit.load(Ordering::SeqCst) {
                    state.force_exit.store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
            });
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => reveal(app),
        _ => {}
    });
}

fn main() {
    run()
}
