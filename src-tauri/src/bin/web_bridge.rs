//! Development bridge: exposes the backend over HTTP on 127.0.0.1:1430 so the
//! UI can run in a regular browser (`npm run bridge` + `npm run dev`).
//! Arguments use the same camelCase JSON shape that Tauri's `invoke` sends.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use mysql_studio_lib::db::AppState;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tower_http::cors::CorsLayer;

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("invalid argument `{key}`: {e}"))
}

fn s(args: &Value, key: &str) -> Result<String, String> {
    arg(args, key)
}

async fn dispatch(st: &AppState, cmd: &str, a: &Value) -> Result<Value, String> {
    macro_rules! ok {
        ($e:expr) => {
            serde_json::to_value($e).map_err(|e| e.to_string())
        };
    }
    match cmd {
        "list_connections" => ok!(st.list_connections()),
        "save_connection" => ok!(st.save_connection(arg(a, "config")?)?),
        "delete_connection" => ok!(st.delete_connection(&s(a, "id")?)?),
        "test_connection" => ok!(AppState::test_connection(arg(a, "config")?).await?),
        "connect" => ok!(st.connect(&s(a, "connId")?).await?),
        "disconnect" => ok!(st.disconnect(&s(a, "connId")?)),
        "list_databases" => ok!(st.list_databases(&s(a, "connId")?).await?),
        "list_objects" => ok!(st.list_objects(&s(a, "connId")?, &s(a, "db")?).await?),
        "table_structure" => {
            ok!(st
                .table_structure(&s(a, "connId")?, &s(a, "db")?, &s(a, "table")?)
                .await?)
        }
        "get_ddl" => ok!(st
            .get_ddl(
                &s(a, "connId")?,
                &s(a, "db")?,
                &s(a, "name")?,
                &s(a, "kind")?
            )
            .await?),
        "schema_columns" => ok!(st.schema_columns(&s(a, "connId")?, &s(a, "db")?).await?),
        "list_charsets" => ok!(st.list_charsets(&s(a, "connId")?).await?),
        "execute_query" => {
            let session: Option<String> = arg(a, "sessionId")?;
            let database: Option<String> = arg(a, "database")?;
            let max_rows: Option<usize> = arg(a, "maxRows")?;
            let coe: Option<bool> = arg(a, "continueOnError")?;
            ok!(st
                .execute(
                    &s(a, "connId")?,
                    session.as_deref(),
                    database.as_deref(),
                    &s(a, "sql")?,
                    max_rows.unwrap_or(5000),
                    coe.unwrap_or(false),
                )
                .await?)
        }
        "cancel_query" => ok!(st
            .cancel_query(&s(a, "connId")?, &s(a, "sessionId")?)
            .await?),
        "close_session" => ok!(st.close_session(&s(a, "sessionId")?)),
        "fetch_table_data" => {
            let filter: Option<String> = arg(a, "filter")?;
            let order_by: Option<String> = arg(a, "orderBy")?;
            let with_total: Option<bool> = arg(a, "withTotal")?;
            ok!(st
                .fetch_table_data(
                    &s(a, "connId")?,
                    &s(a, "db")?,
                    &s(a, "table")?,
                    arg(a, "offset")?,
                    arg(a, "limit")?,
                    filter.as_deref().unwrap_or(""),
                    order_by.as_deref().unwrap_or(""),
                    with_total.unwrap_or(true),
                )
                .await?)
        }
        "apply_changes" => ok!(st
            .apply_changes(
                &s(a, "connId")?,
                &s(a, "db")?,
                &s(a, "table")?,
                arg(a, "changes")?
            )
            .await?),
        "export_table" => {
            let filter: Option<String> = arg(a, "filter")?;
            ok!(st
                .export_table(
                    &s(a, "connId")?,
                    &s(a, "db")?,
                    &s(a, "table")?,
                    &s(a, "format")?,
                    &s(a, "path")?,
                    filter.as_deref().unwrap_or(""),
                )
                .await?)
        }
        "dump_database" => ok!(st
            .dump_database(
                &s(a, "connId")?,
                &s(a, "db")?,
                &s(a, "path")?,
                arg(a, "includeData")?,
                arg(a, "tables")?,
            )
            .await?),
        "run_sql_file" => {
            let db: Option<String> = arg(a, "db")?;
            ok!(st
                .run_sql_file(
                    &s(a, "connId")?,
                    db.as_deref(),
                    &s(a, "path")?,
                    arg(a, "continueOnError")?,
                )
                .await?)
        }
        "write_text_file" => ok!(mysql_studio_lib::transfer::write_text_file(
            &s(a, "path")?,
            &s(a, "content")?
        )?),
        other => Err(format!("unknown command: {other}")),
    }
}

async fn invoke(
    State(st): State<Arc<AppState>>,
    Path(cmd): Path<String>,
    Json(args): Json<Value>,
) -> (StatusCode, Json<Value>) {
    match dispatch(&st, &cmd, &args).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(Value::String(e))),
    }
}

#[tokio::main]
async fn main() {
    let path = std::env::var("MYSQL_STUDIO_DATA")
        .unwrap_or_else(|_| "../.dev-data/connections.json".into());
    let state = Arc::new(AppState::new(path.into()));
    let app = Router::new()
        .route("/invoke/{cmd}", post(invoke))
        .with_state(state)
        .layer(CorsLayer::permissive());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:1430")
        .await
        .expect("bind 127.0.0.1:1430");
    println!("web bridge listening on http://127.0.0.1:1430");
    axum::serve(listener, app).await.expect("server error");
}
