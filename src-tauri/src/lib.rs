pub mod commands;
pub mod db;
pub mod models;
pub mod sqlsplit;
pub mod store;
pub mod transfer;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(db::AppState::new(dir.join("connections.json")));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_objects,
            commands::table_structure,
            commands::schema_columns,
            commands::table_stats,
            commands::get_ddl,
            commands::list_charsets,
            commands::execute_query,
            commands::cancel_query,
            commands::close_session,
            commands::fetch_table_data,
            commands::apply_changes,
            commands::export_table,
            commands::dump_database,
            commands::run_sql_file,
            commands::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
