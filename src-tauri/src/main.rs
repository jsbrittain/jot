#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

pub struct AppState {
    pub db: Mutex<Connection>,
    /// Mirrors the capture editor's "has unsaved content" state.
    pub dirty: AtomicBool,
    /// Mirrors unsaved edits in the browse window.
    pub browse_dirty: AtomicBool,
    /// Set once the user has confirmed quitting; lets exit proceed past the guard.
    pub force_exit: AtomicBool,
    pub started: Instant,
}

/// Why the user is trying to leave the current draft.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Hide,
    Quit,
}

pub fn is_guarded(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    state.dirty.load(Ordering::SeqCst) && !state.force_exit.load(Ordering::SeqCst)
}

/// Show and focus the capture window for a new note. Emits `shown` only when it
/// was hidden, which tells the frontend to reset to a blank slate.
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

/// Show the window without triggering the blank-slate reset, so a draft that is
/// being protected survives. Used by the quit guard.
pub fn show_keeping_draft(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quit deliberately, asking first if there is an unsaved draft.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn request_quit(app: &AppHandle) {
    if is_guarded(app) {
        show_keeping_draft(app);
        let _ = app.emit("close-attempted", Intent::Quit);
    } else {
        app.state::<AppState>()
            .force_exit
            .store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

/// macOS gets Quit from the Dock icon menu, so only Windows and Linux need a
/// tray icon to keep a hidden window reachable and offer a quit action.
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
            "quit" => request_quit(app),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Summon the capture window from anywhere. On macOS this uses a Carbon hotkey,
/// which needs no Accessibility permission; Wayland may refuse to register one.
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
                if event.state == ShortcutState::Pressed
                    && triggered.matches(modifiers, Code::KeyJ)
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
        .setup(move |app| {            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("jot.db");
            let conn = db::open(&db_path)?;
            if commands::timing_enabled() {
                println!("[jot] database: {}", db_path.display());
            }
            app.manage(AppState {
                db: Mutex::new(conn),
                dirty: AtomicBool::new(false),
                browse_dirty: AtomicBool::new(false),
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
            commands::report_timing,
            commands::create_note,
            commands::create_project,
            commands::list_notes,
            commands::count_notes,
            commands::update_note,
            commands::delete_note,
            commands::delete_project,
            commands::open_browser,
            commands::close_browser,
            commands::set_browse_dirty,
            commands::set_dirty,
            commands::hide_window,
            commands::quit_now,
        ])
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            // Only the capture window hides instead of closing. The browse window
            // closes normally, and must not take the app down with it.
            if window.label() != "main" {
                let state = window.state::<AppState>();
                if window.label() == "browse"
                    && state.browse_dirty.load(Ordering::SeqCst)
                    && !state.force_exit.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("browse-close-attempted", ());
                }
                return;
            }
            api.prevent_close();
            let app = window.app_handle();
            if is_guarded(app) {
                let _ = window.emit("close-attempted", Intent::Hide);
            } else {
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Jot");

    app.run(|app, event| match event {
        // Cmd+Q, the Dock menu and the tray all arrive here.
        RunEvent::ExitRequested { api, .. } => {
            if is_guarded(app) {
                api.prevent_exit();
                show_keeping_draft(app);
                let _ = app.emit("close-attempted", Intent::Quit);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => reveal(app),
        _ => {}
    });
}

fn main() {
    run()
}
