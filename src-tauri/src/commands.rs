//! Thin Tauri command wrappers around `AppState`.

use tauri::State;

use crate::db::{AppState, Res};
use crate::models::*;

type S<'a> = State<'a, AppState>;

#[tauri::command]
pub fn list_connections(state: S<'_>) -> Vec<ConnectionConfig> {
    state.list_connections()
}

#[tauri::command]
pub fn save_connection(state: S<'_>, config: ConnectionConfig) -> Res<ConnectionConfig> {
    state.save_connection(config)
}

#[tauri::command]
pub fn delete_connection(state: S<'_>, id: String) -> Res<()> {
    state.delete_connection(&id)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Res<String> {
    AppState::test_connection(config).await
}

#[tauri::command]
pub async fn connect(state: S<'_>, conn_id: String) -> Res<ServerInfo> {
    state.connect(&conn_id).await
}

#[tauri::command]
pub fn disconnect(state: S<'_>, conn_id: String) {
    state.disconnect(&conn_id)
}

#[tauri::command]
pub async fn list_databases(state: S<'_>, conn_id: String) -> Res<Vec<String>> {
    state.list_databases(&conn_id).await
}

#[tauri::command]
pub async fn list_objects(state: S<'_>, conn_id: String, db: String) -> Res<DbObjects> {
    state.list_objects(&conn_id, &db).await
}

#[tauri::command]
pub async fn table_structure(
    state: S<'_>,
    conn_id: String,
    db: String,
    table: String,
) -> Res<TableStructure> {
    state.table_structure(&conn_id, &db, &table).await
}

#[tauri::command]
pub async fn schema_columns(
    state: S<'_>,
    conn_id: String,
    db: String,
) -> Res<std::collections::BTreeMap<String, Vec<String>>> {
    state.schema_columns(&conn_id, &db).await
}

#[tauri::command]
pub async fn get_ddl(
    state: S<'_>,
    conn_id: String,
    db: String,
    name: String,
    kind: String,
) -> Res<String> {
    state.get_ddl(&conn_id, &db, &name, &kind).await
}

#[tauri::command]
pub async fn list_charsets(state: S<'_>, conn_id: String) -> Res<Vec<Charset>> {
    state.list_charsets(&conn_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    state: S<'_>,
    conn_id: String,
    session_id: Option<String>,
    database: Option<String>,
    sql: String,
    max_rows: Option<usize>,
    continue_on_error: Option<bool>,
) -> Res<ExecuteResponse> {
    state
        .execute(
            &conn_id,
            session_id.as_deref(),
            database.as_deref(),
            &sql,
            max_rows.unwrap_or(5000),
            continue_on_error.unwrap_or(false),
        )
        .await
}

#[tauri::command]
pub async fn cancel_query(state: S<'_>, conn_id: String, session_id: String) -> Res<()> {
    state.cancel_query(&conn_id, &session_id).await
}

#[tauri::command]
pub fn close_session(state: S<'_>, session_id: String) {
    state.close_session(&session_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fetch_table_data(
    state: S<'_>,
    conn_id: String,
    db: String,
    table: String,
    offset: u64,
    limit: u64,
    filter: Option<String>,
    order_by: Option<String>,
    with_total: Option<bool>,
) -> Res<TableData> {
    state
        .fetch_table_data(
            &conn_id,
            &db,
            &table,
            offset,
            limit,
            filter.as_deref().unwrap_or(""),
            order_by.as_deref().unwrap_or(""),
            with_total.unwrap_or(true),
        )
        .await
}

#[tauri::command]
pub async fn apply_changes(
    state: S<'_>,
    conn_id: String,
    db: String,
    table: String,
    changes: Vec<RowChange>,
) -> Res<ApplyResult> {
    state.apply_changes(&conn_id, &db, &table, changes).await
}

#[tauri::command]
pub async fn export_table(
    state: S<'_>,
    conn_id: String,
    db: String,
    table: String,
    format: String,
    path: String,
    filter: Option<String>,
) -> Res<TaskSummary> {
    state
        .export_table(
            &conn_id,
            &db,
            &table,
            &format,
            &path,
            filter.as_deref().unwrap_or(""),
        )
        .await
}

#[tauri::command]
pub async fn dump_database(
    state: S<'_>,
    conn_id: String,
    db: String,
    path: String,
    include_data: bool,
    tables: Option<Vec<String>>,
) -> Res<TaskSummary> {
    state
        .dump_database(&conn_id, &db, &path, include_data, tables)
        .await
}

#[tauri::command]
pub async fn run_sql_file(
    state: S<'_>,
    conn_id: String,
    db: Option<String>,
    path: String,
    continue_on_error: bool,
) -> Res<TaskSummary> {
    state
        .run_sql_file(&conn_id, db.as_deref(), &path, continue_on_error)
        .await
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Res<()> {
    crate::transfer::write_text_file(&path, &content)
}
