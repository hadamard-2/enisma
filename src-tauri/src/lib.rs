mod db;
mod import;
mod pdf;
mod project;
mod sidecar;

use std::sync::Mutex;

use sidecar::SidecarState;
use tauri::{Manager, RunEvent};

/// The open database, guarded for use from command handlers.
pub struct Db(pub Mutex<rusqlite::Connection>);

/// The app data directory, resolved once at startup.
pub struct DataDir(pub std::path::PathBuf);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::new())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("projects"))?;

            // Let the webview read project PDFs through the asset protocol.
            // `allow_directory` pushes glob patterns rather than snapshotting a
            // listing, so projects imported later are covered by this one grant.
            app.asset_protocol_scope()
                .allow_directory(data_dir.join("projects"), true)?;

            let conn = db::open(&data_dir.join("enisma.db"))?;
            app.manage(Db(Mutex::new(conn)));
            app.manage(DataDir(data_dir));

            sidecar::spawn_supervisor(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_health,
            project::list_projects_cmd,
            project::get_project_cmd,
            project::import_project_cmd,
            project::read_pdf_bytes_cmd,
            project::update_project_cmd,
            project::get_page_cmd,
            project::save_page_text_cmd,
            project::set_page_done_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Make sure the Python sidecar dies with the app rather than orphaning.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app_handle.state::<SidecarState>().shutdown();
            }
        });
}
