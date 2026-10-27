use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::*;
use mysql_async::{
    Column, Conn, Opts, OptsBuilder, Params, Pool, PoolConstraints, PoolOpts, Row, SslOpts, TxOpts,
    Value,
};
use serde_json::{json, Value as Json};

use crate::models::*;
use crate::sqlsplit::split_sql;
use crate::store;

pub type Res<T> = Result<T, String>;

pub trait ErrStr<T> {
    fn es(self) -> Res<T>;
}

impl<T, E: std::fmt::Display> ErrStr<T> for Result<T, E> {
    fn es(self) -> Res<T> {
        self.map_err(|e| clean_err(e.to_string()))
    }
}

/// mysql_async renders server errors as "Server error: `ERROR ...'"; keep the inner part.
pub fn clean_err(s: String) -> String {
    match s.strip_prefix("Server error: `") {
        Some(rest) => rest.strip_suffix('\'').unwrap_or(rest).to_string(),
        None => s,
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Binary values larger than this are not sent to the UI.
const MAX_BLOB_PREVIEW: usize = 64 * 1024;

pub fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

pub fn qualified(db: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(db), quote_ident(name))
}

fn build_opts(c: &ConnectionConfig) -> Opts {
    let pool_opts = PoolOpts::default()
        .with_constraints(PoolConstraints::new(0, 8).expect("valid pool constraints"))
        .with_inactive_connection_ttl(Duration::from_secs(300));
    let mut b = OptsBuilder::default()
        .ip_or_hostname(c.host.trim())
        .tcp_port(c.port)
        .user(Some(c.user.clone()))
        .pass((!c.password.is_empty()).then(|| c.password.clone()))
        .db_name(c.database.clone().filter(|d| !d.trim().is_empty()))
        .prefer_socket(false)
        .pool_opts(pool_opts);
    if c.ssl {
        b = b.ssl_opts(
            SslOpts::default()
                .with_danger_accept_invalid_certs(c.ssl_accept_invalid)
                .with_danger_skip_domain_validation(c.ssl_accept_invalid),
        );
    }
    b.into()
}

/// A dedicated connection backing one query editor tab, so that session
/// state (`USE`, variables, transactions) survives between executions.
pub struct Session {
    conn_id: String,
    conn: tokio::sync::Mutex<Option<Conn>>,
    thread_id: AtomicU32,
}

pub struct AppState {
    store_path: PathBuf,
    configs: Mutex<Vec<ConnectionConfig>>,
    pools: Mutex<HashMap<String, Pool>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl AppState {
    pub fn new(store_path: PathBuf) -> Self {
        let configs = store::load(&store_path);
        Self {
            store_path,
            configs: Mutex::new(configs),
            pools: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    // ---------- connection configs ----------

    pub fn list_connections(&self) -> Vec<ConnectionConfig> {
        self.configs.lock().unwrap().clone()
    }

    pub fn save_connection(&self, mut cfg: ConnectionConfig) -> Res<ConnectionConfig> {
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        let mut list = self.configs.lock().unwrap();
        match list.iter_mut().find(|c| c.id == cfg.id) {
            Some(existing) => *existing = cfg.clone(),
            None => list.push(cfg.clone()),
        }
        store::save(&self.store_path, &list)?;
        drop(list);
        // Settings may have changed: the next use reconnects with the new ones.
        self.drop_pool(&cfg.id);
        Ok(cfg)
    }

    pub fn delete_connection(&self, id: &str) -> Res<()> {
        let mut list = self.configs.lock().unwrap();
        list.retain(|c| c.id != id);
        store::save(&self.store_path, &list)?;
        drop(list);
        self.drop_pool(id);
        Ok(())
    }

    fn config(&self, id: &str) -> Res<ConnectionConfig> {
        self.configs
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| "连接配置不存在".to_string())
    }

    // ---------- pools & sessions ----------

    fn pool(&self, conn_id: &str) -> Res<Pool> {
        let cfg = {
            let pools = self.pools.lock().unwrap();
            if let Some(p) = pools.get(conn_id) {
                return Ok(p.clone());
            }
            drop(pools);
            self.config(conn_id)?
        };
        let mut pools = self.pools.lock().unwrap();
        Ok(pools
            .entry(conn_id.to_string())
            .or_insert_with(|| Pool::new(build_opts(&cfg)))
            .clone())
    }

    async fn get_conn(&self, conn_id: &str) -> Res<Conn> {
        let pool = self.pool(conn_id)?;
        tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn())
            .await
            .map_err(|_| "连接超时".to_string())?
            .es()
    }

    /// A pooled connection with `db` selected as the current database.
    pub(crate) async fn conn_for(&self, conn_id: &str, db: Option<&str>) -> Res<Conn> {
        let mut conn = self.get_conn(conn_id).await?;
        if let Some(db) = db.filter(|d| !d.is_empty()) {
            conn.query_drop(format!("USE {}", quote_ident(db)))
                .await
                .es()?;
        }
        Ok(conn)
    }

    fn drop_pool(&self, conn_id: &str) {
        let pool = self.pools.lock().unwrap().remove(conn_id);
        self.sessions
            .lock()
            .unwrap()
            .retain(|_, s| s.conn_id != conn_id);
        if let Some(pool) = pool {
            let fut = async move {
                let _ = pool.disconnect().await;
            };
            match tokio::runtime::Handle::try_current() {
                Ok(h) => {
                    h.spawn(fut);
                }
                Err(_) => {
                    tauri::async_runtime::spawn(fut);
                }
            }
        }
    }

    fn session(&self, conn_id: &str, session_id: &str) -> Arc<Session> {
        self.sessions
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_insert_with(|| {
                Arc::new(Session {
                    conn_id: conn_id.to_string(),
                    conn: tokio::sync::Mutex::new(None),
                    thread_id: AtomicU32::new(0),
                })
            })
            .clone()
    }

    pub async fn test_connection(cfg: ConnectionConfig) -> Res<String> {
        let opts = build_opts(&cfg);
        let fut = async {
            let mut conn = Conn::new(opts).await?;
            let v: Option<String> = conn.query_first("SELECT VERSION()").await?;
            conn.disconnect().await?;
            Ok::<_, mysql_async::Error>(v.unwrap_or_default())
        };
        tokio::time::timeout(CONNECT_TIMEOUT, fut)
            .await
            .map_err(|_| "连接超时".to_string())?
            .es()
    }

    pub async fn connect(&self, conn_id: &str) -> Res<ServerInfo> {
        let res = async {
            let mut conn = self.get_conn(conn_id).await?;
            let version: Option<String> = conn.query_first("SELECT VERSION()").await.es()?;
            Ok(ServerInfo {
                version: version.unwrap_or_default(),
                connection_id: conn.id(),
            })
        }
        .await;
        if res.is_err() {
            self.drop_pool(conn_id);
        }
        res
    }

    pub fn disconnect(&self, conn_id: &str) {
        self.drop_pool(conn_id);
    }

    pub fn close_session(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }

    pub async fn cancel_query(&self, conn_id: &str, session_id: &str) -> Res<()> {
        let tid = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(session_id)
                .map(|s| s.thread_id.load(Ordering::SeqCst))
                .unwrap_or(0)
        };
        if tid == 0 {
            return Ok(());
        }
        let mut conn = self.get_conn(conn_id).await?;
        conn.query_drop(format!("KILL QUERY {tid}")).await.es()
    }

    // ---------- query execution ----------

    pub async fn execute(
        &self,
        conn_id: &str,
        session_id: Option<&str>,
        database: Option<&str>,
        sql: &str,
        max_rows: usize,
        continue_on_error: bool,
    ) -> Res<ExecuteResponse> {
        let stmts = split_sql(sql);
        let database = database.filter(|d| !d.is_empty());
        match session_id {
            Some(sid) => {
                let session = self.session(conn_id, sid);
                let mut guard = session.conn.lock().await;
                if guard.is_none() {
                    let conn = self.get_conn(conn_id).await?;
                    session.thread_id.store(conn.id(), Ordering::SeqCst);
                    *guard = Some(conn);
                }
                let conn = guard.as_mut().unwrap();
                let (results, broken) =
                    run_statements(conn, database, &stmts, max_rows, continue_on_error).await;
                let current_db = if broken {
                    *guard = None;
                    session.thread_id.store(0, Ordering::SeqCst);
                    database.map(String::from)
                } else {
                    current_database(conn).await
                };
                Ok(ExecuteResponse {
                    results,
                    database: current_db,
                })
            }
            None => {
                let mut conn = self.get_conn(conn_id).await?;
                let (results, _) =
                    run_statements(&mut conn, database, &stmts, max_rows, continue_on_error).await;
                Ok(ExecuteResponse {
                    results,
                    database: database.map(String::from),
                })
            }
        }
    }

    // ---------- metadata ----------

    pub async fn list_databases(&self, conn_id: &str) -> Res<Vec<String>> {
        let mut conn = self.get_conn(conn_id).await?;
        conn.query::<String, _>("SHOW DATABASES").await.es()
    }

    pub async fn list_objects(&self, conn_id: &str, db: &str) -> Res<DbObjects> {
        let mut conn = self.get_conn(conn_id).await?;
        let rows: Vec<Row> = conn
            .exec(
                "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, \
                 AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                (db,),
            )
            .await
            .es()?;
        let mut tables = Vec::new();
        let mut views = Vec::new();
        for r in rows {
            let meta = table_meta(&r);
            if meta.kind == "VIEW" || meta.kind == "SYSTEM VIEW" {
                views.push(meta);
            } else {
                tables.push(meta);
            }
        }
        let routines = conn
            .exec::<Row, _, _>(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, CREATED, LAST_ALTERED, ROUTINE_COMMENT \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                (db,),
            )
            .await
            .es()?
            .iter()
            .map(|r| RoutineMeta {
                name: get_str(r, 0),
                kind: get_str(r, 1),
                returns: get_opt(r, 2),
                created: get_opt(r, 3),
                modified: get_opt(r, 4),
                comment: get_str(r, 5),
            })
            .collect();
        let triggers = conn
            .exec::<Row, _, _>(
                "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING \
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
                (db,),
            )
            .await
            .es()?
            .iter()
            .map(|r| TriggerMeta {
                name: get_str(r, 0),
                table: get_str(r, 1),
                event: get_str(r, 2),
                timing: get_str(r, 3),
            })
            .collect();
        Ok(DbObjects {
            tables,
            views,
            routines,
            triggers,
        })
    }

    pub async fn table_structure(
        &self,
        conn_id: &str,
        db: &str,
        table: &str,
    ) -> Res<TableStructure> {
        let mut conn = self.get_conn(conn_id).await?;
        let info = conn
            .exec::<Row, _, _>(
                "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, \
                 AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                (db, table),
            )
            .await
            .es()?
            .first()
            .map(table_meta);

        let columns: Vec<ColumnDetail> = conn
            .exec::<Row, _, _>(
                "SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE, DATA_TYPE, COLUMN_TYPE, \
                 CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_KEY, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                (db, table),
            )
            .await
            .es()?
            .iter()
            .map(|r| ColumnDetail {
                name: get_str(r, 0),
                position: get_u64(r, 1).unwrap_or(0) as u32,
                default: get_opt(r, 2),
                nullable: get_str(r, 3) == "YES",
                data_type: get_str(r, 4),
                column_type: get_str(r, 5),
                charset: get_opt(r, 6),
                collation: get_opt(r, 7),
                key: get_str(r, 8),
                extra: get_str(r, 9),
                comment: get_str(r, 10),
                generation_expression: get_str(r, 11),
            })
            .collect();

        let idx_rows: Vec<Row> = conn
            .exec(
                "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE, INDEX_COMMENT \
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX",
                (db, table),
            )
            .await
            .es()?;
        let mut indexes: Vec<IndexDetail> = Vec::new();
        for r in &idx_rows {
            let name = get_str(r, 0);
            let col = IndexColumn {
                name: get_str(r, 3),
                sub_part: get_u64(r, 4),
            };
            match indexes.iter_mut().find(|i| i.name == name) {
                Some(i) => i.columns.push(col),
                None => indexes.push(IndexDetail {
                    name,
                    unique: get_u64(r, 1) == Some(0),
                    index_type: get_str(r, 5),
                    columns: vec![col],
                    comment: get_str(r, 6),
                }),
            }
        }
        let primary_key = indexes
            .iter()
            .find(|i| i.name == "PRIMARY")
            .map(|i| i.columns.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        let fk_rows: Vec<Row> = conn
            .exec(
                "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, \
                 k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE \
                 FROM information_schema.KEY_COLUMN_USAGE k \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
                   ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                  AND r.TABLE_NAME = k.TABLE_NAME \
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                (db, table),
            )
            .await
            .es()?;
        let mut foreign_keys: Vec<ForeignKeyDetail> = Vec::new();
        for r in &fk_rows {
            let name = get_str(r, 0);
            match foreign_keys.iter_mut().find(|f| f.name == name) {
                Some(f) => {
                    f.columns.push(get_str(r, 1));
                    f.ref_columns.push(get_str(r, 4));
                }
                None => foreign_keys.push(ForeignKeyDetail {
                    name,
                    columns: vec![get_str(r, 1)],
                    ref_schema: get_str(r, 2),
                    ref_table: get_str(r, 3),
                    ref_columns: vec![get_str(r, 4)],
                    on_update: get_str(r, 5),
                    on_delete: get_str(r, 6),
                }),
            }
        }

        let is_view = info
            .as_ref()
            .map(|i| i.kind.contains("VIEW"))
            .unwrap_or(false);
        let ddl = show_create(&mut conn, db, table, if is_view { "VIEW" } else { "TABLE" })
            .await
            .unwrap_or_else(|e| format!("-- {e}"));

        Ok(TableStructure {
            info,
            columns,
            indexes,
            foreign_keys,
            primary_key,
            ddl,
        })
    }

    /// Table -> column names for every table in `db` (used for autocompletion).
    pub async fn schema_columns(
        &self,
        conn_id: &str,
        db: &str,
    ) -> Res<std::collections::BTreeMap<String, Vec<String>>> {
        let mut conn = self.get_conn(conn_id).await?;
        let rows: Vec<(String, String)> = conn
            .exec(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
                (db,),
            )
            .await
            .es()?;
        let mut map = std::collections::BTreeMap::<String, Vec<String>>::new();
        for (t, c) in rows {
            map.entry(t).or_default().push(c);
        }
        Ok(map)
    }

    pub async fn get_ddl(&self, conn_id: &str, db: &str, name: &str, kind: &str) -> Res<String> {
        let mut conn = self.get_conn(conn_id).await?;
        show_create(&mut conn, db, name, kind).await
    }

    pub async fn list_charsets(&self, conn_id: &str) -> Res<Vec<Charset>> {
        let mut conn = self.get_conn(conn_id).await?;
        let sets: Vec<(String, String)> = conn
            .query(
                "SELECT CHARACTER_SET_NAME, DEFAULT_COLLATE_NAME FROM information_schema.CHARACTER_SETS \
                 ORDER BY CHARACTER_SET_NAME",
            )
            .await
            .es()?;
        let colls: Vec<(String, String)> = conn
            .query(
                "SELECT COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATIONS \
                 ORDER BY COLLATION_NAME",
            )
            .await
            .es()?;
        Ok(sets
            .into_iter()
            .map(|(name, default_collation)| Charset {
                collations: colls
                    .iter()
                    .filter(|(_, cs)| *cs == name)
                    .map(|(c, _)| c.clone())
                    .collect(),
                name,
                default_collation,
            })
            .collect())
    }

    // ---------- table data ----------

    #[allow(clippy::too_many_arguments)]
    pub async fn fetch_table_data(
        &self,
        conn_id: &str,
        db: &str,
        table: &str,
        offset: u64,
        limit: u64,
        filter: &str,
        order_by: &str,
        with_total: bool,
    ) -> Res<TableData> {
        let mut conn = self.get_conn(conn_id).await?;
        let from = format!("FROM {}", qualified(db, table));
        let where_ = if filter.trim().is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", filter.trim())
        };
        let order = if order_by.trim().is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", order_by.trim())
        };
        let sql = format!("SELECT * {from}{where_}{order} LIMIT {limit} OFFSET {offset}");
        let start = Instant::now();
        let r = run_one(&mut conn, &sql, usize::MAX).await.es()?;
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let rs = r.into_iter().find(|r| r.has_result_set).unwrap_or_default();
        let total = if with_total {
            let t: Option<u64> = conn
                .query_first(format!("SELECT COUNT(*) {from}{where_}"))
                .await
                .es()?;
            t
        } else {
            None
        };
        Ok(TableData {
            columns: rs.columns,
            rows: rs.rows,
            total,
            elapsed_ms,
            sql,
        })
    }

    pub async fn apply_changes(
        &self,
        conn_id: &str,
        db: &str,
        table: &str,
        changes: Vec<RowChange>,
    ) -> Res<ApplyResult> {
        let mut conn = self.get_conn(conn_id).await?;
        let mut tx = conn.start_transaction(TxOpts::default()).await.es()?;
        let target = qualified(db, table);
        let mut affected = 0;
        let mut statements = Vec::new();
        for change in &changes {
            let (sql, params) = build_change(&target, change)?;
            // Dropping `tx` on error rolls the whole batch back.
            tx.exec_drop(&sql, Params::Positional(params))
                .await
                .map_err(|e| format!("{}\n\nSQL: {sql}", clean_err(e.to_string())))?;
            affected += tx.affected_rows();
            statements.push(sql);
        }
        tx.commit().await.es()?;
        Ok(ApplyResult {
            affected,
            statements,
        })
    }
}

async fn current_database(conn: &mut Conn) -> Option<String> {
    conn.query_first::<Option<String>, _>("SELECT DATABASE()")
        .await
        .ok()
        .flatten()
        .flatten()
}

pub(crate) async fn show_create(conn: &mut Conn, db: &str, name: &str, kind: &str) -> Res<String> {
    let kind = kind.to_uppercase();
    let kind = match kind.as_str() {
        "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT" => kind,
        "SYSTEM VIEW" | "BASE TABLE" => "TABLE".into(),
        other => return Err(format!("不支持的对象类型: {other}")),
    };
    let sql = format!("SHOW CREATE {kind} {}", qualified(db, name));
    let row: Option<Row> = conn.query_first(sql).await.es()?;
    let row = row.ok_or_else(|| "对象不存在".to_string())?;
    // The definition column is "Create Table", "Create View", ... except for
    // triggers, whose SHOW CREATE output calls it "SQL Original Statement".
    let target = if kind == "TRIGGER" {
        "sql original statement".to_string()
    } else {
        format!("create {}", kind.to_lowercase())
    };
    let idx = row
        .columns_ref()
        .iter()
        .position(|c| c.name_str().to_lowercase() == target)
        .unwrap_or(if kind == "TABLE" || kind == "VIEW" { 1 } else { 2 });
    let ddl = get_opt(&row, idx).unwrap_or_default();
    if ddl.is_empty() {
        return Err("无权限查看该对象的定义".into());
    }
    Ok(ddl)
}

// ---------- statement execution helpers ----------

async fn run_statements(
    conn: &mut Conn,
    database: Option<&str>,
    stmts: &[String],
    max_rows: usize,
    continue_on_error: bool,
) -> (Vec<QueryResult>, bool) {
    let mut results = Vec::new();
    if let Some(db) = database {
        if let Err(e) = conn.query_drop(format!("USE {}", quote_ident(db))).await {
            let broken = !matches!(e, mysql_async::Error::Server(_));
            results.push(QueryResult {
                sql: format!("USE {}", quote_ident(db)),
                error: Some(clean_err(e.to_string())),
                ..Default::default()
            });
            return (results, broken);
        }
    }
    for stmt in stmts {
        let start = Instant::now();
        match run_one(conn, stmt, max_rows).await {
            Ok(mut sets) => {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                for s in sets.iter_mut() {
                    s.elapsed_ms = elapsed;
                }
                results.extend(sets);
            }
            Err(e) => {
                let broken = !matches!(e, mysql_async::Error::Server(_));
                results.push(QueryResult {
                    sql: stmt.clone(),
                    error: Some(clean_err(e.to_string())),
                    elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                    ..Default::default()
                });
                if broken {
                    return (results, true);
                }
                if !continue_on_error {
                    break;
                }
            }
        }
    }
    (results, false)
}

/// Runs one statement with the text protocol and collects every result set it produces.
pub(crate) async fn run_one(
    conn: &mut Conn,
    sql: &str,
    max_rows: usize,
) -> Result<Vec<QueryResult>, mysql_async::Error> {
    let mut qr = conn.query_iter(sql).await?;
    let mut out = Vec::new();
    for _ in 0..1024 {
        let cols = qr.columns().filter(|c| !c.is_empty());
        match cols {
            Some(cols) => {
                let infos: Vec<ColInfo> = cols.iter().map(ColInfo::from).collect();
                let mut rows = Vec::new();
                let mut truncated = false;
                while let Some(row) = qr.next().await? {
                    if rows.len() >= max_rows {
                        truncated = true;
                        continue;
                    }
                    let vals = row.unwrap();
                    rows.push(
                        vals.into_iter()
                            .zip(infos.iter())
                            .map(|(v, c)| cell_json(v, c))
                            .collect(),
                    );
                }
                out.push(QueryResult {
                    sql: sql.to_string(),
                    has_result_set: true,
                    columns: infos.into_iter().map(|c| c.meta).collect(),
                    rows,
                    truncated,
                    ..Default::default()
                });
            }
            None => {
                out.push(QueryResult {
                    sql: sql.to_string(),
                    affected_rows: qr.affected_rows(),
                    last_insert_id: qr.last_insert_id().filter(|id| *id > 0),
                    warnings: qr.warnings(),
                    info: qr.info().to_string(),
                    ..Default::default()
                });
                qr.next().await?;
            }
        }
        if qr.is_empty() {
            break;
        }
    }
    // A CALL returns its result sets followed by a status packet; hide that
    // trailing status when real result sets were produced.
    if out.len() > 1 {
        if let Some(last) = out.last() {
            if !last.has_result_set && last.affected_rows == 0 {
                out.pop();
            }
        }
    }
    Ok(out)
}

pub(crate) struct ColInfo {
    pub meta: ColumnMeta,
    pub bit: bool,
}

impl From<&Column> for ColInfo {
    fn from(c: &Column) -> Self {
        use ColumnType::*;
        let ct = c.column_type();
        let flags = c.flags();
        let charset = c.character_set();
        let stringish = matches!(
            ct,
            MYSQL_TYPE_VARCHAR
                | MYSQL_TYPE_VAR_STRING
                | MYSQL_TYPE_STRING
                | MYSQL_TYPE_BLOB
                | MYSQL_TYPE_TINY_BLOB
                | MYSQL_TYPE_MEDIUM_BLOB
                | MYSQL_TYPE_LONG_BLOB
        );
        let binary =
            (stringish && charset == 63) || matches!(ct, MYSQL_TYPE_GEOMETRY | MYSQL_TYPE_VECTOR);
        let bit = ct == MYSQL_TYPE_BIT;
        let numeric = matches!(
            ct,
            MYSQL_TYPE_DECIMAL
                | MYSQL_TYPE_NEWDECIMAL
                | MYSQL_TYPE_TINY
                | MYSQL_TYPE_SHORT
                | MYSQL_TYPE_LONG
                | MYSQL_TYPE_FLOAT
                | MYSQL_TYPE_DOUBLE
                | MYSQL_TYPE_LONGLONG
                | MYSQL_TYPE_INT24
                | MYSQL_TYPE_YEAR
                | MYSQL_TYPE_BIT
        );
        let type_name = match ct {
            MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
            MYSQL_TYPE_TINY => "TINYINT",
            MYSQL_TYPE_SHORT => "SMALLINT",
            MYSQL_TYPE_LONG => "INT",
            MYSQL_TYPE_FLOAT => "FLOAT",
            MYSQL_TYPE_DOUBLE => "DOUBLE",
            MYSQL_TYPE_NULL => "NULL",
            MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
            MYSQL_TYPE_LONGLONG => "BIGINT",
            MYSQL_TYPE_INT24 => "MEDIUMINT",
            MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "DATE",
            MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "TIME",
            MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "DATETIME",
            MYSQL_TYPE_YEAR => "YEAR",
            MYSQL_TYPE_BIT => "BIT",
            MYSQL_TYPE_JSON => "JSON",
            MYSQL_TYPE_ENUM => "ENUM",
            MYSQL_TYPE_SET => "SET",
            MYSQL_TYPE_GEOMETRY => "GEOMETRY",
            MYSQL_TYPE_VECTOR => "VECTOR",
            MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
                if binary {
                    "VARBINARY"
                } else {
                    "VARCHAR"
                }
            }
            MYSQL_TYPE_TINY_BLOB
            | MYSQL_TYPE_MEDIUM_BLOB
            | MYSQL_TYPE_LONG_BLOB
            | MYSQL_TYPE_BLOB => {
                if binary {
                    "BLOB"
                } else {
                    "TEXT"
                }
            }
            MYSQL_TYPE_STRING => {
                if flags.contains(ColumnFlags::ENUM_FLAG) {
                    "ENUM"
                } else if flags.contains(ColumnFlags::SET_FLAG) {
                    "SET"
                } else if binary {
                    "BINARY"
                } else {
                    "CHAR"
                }
            }
            _ => "UNKNOWN",
        };
        ColInfo {
            meta: ColumnMeta {
                name: c.name_str().to_string(),
                org_name: c.org_name_str().to_string(),
                table: c.table_str().to_string(),
                org_table: c.org_table_str().to_string(),
                type_name: type_name.to_string(),
                binary,
                numeric,
                pk: flags.contains(ColumnFlags::PRI_KEY_FLAG),
                not_null: flags.contains(ColumnFlags::NOT_NULL_FLAG),
                auto_inc: flags.contains(ColumnFlags::AUTO_INCREMENT_FLAG),
                unsigned: flags.contains(ColumnFlags::UNSIGNED_FLAG),
            },
            bit,
        }
    }
}

pub(crate) fn hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 15) as usize] as char);
    }
    s
}

fn unhex(s: &str) -> Res<Vec<u8>> {
    let s = s.trim();
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return Err("十六进制字符串长度必须为偶数".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "无效的十六进制字符串".to_string())
        })
        .collect()
}

pub(crate) fn bit_value(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |acc, x| (acc << 8) | *x as u64)
}

/// Converts a cell to what the UI shows: `null`, a string, or `{"blob": len}` for
/// binary values too large to ship.
fn cell_json(v: Value, c: &ColInfo) -> Json {
    match v {
        Value::NULL => Json::Null,
        Value::Bytes(b) => {
            if c.bit {
                Json::String(bit_value(&b).to_string())
            } else if c.meta.binary {
                if b.len() > MAX_BLOB_PREVIEW {
                    json!({ "blob": b.len() })
                } else {
                    Json::String(format!("0x{}", hex(&b)))
                }
            } else {
                match String::from_utf8(b) {
                    Ok(s) => Json::String(s),
                    Err(e) => Json::String(format!("0x{}", hex(e.as_bytes()))),
                }
            }
        }
        other => Json::String(value_string(&other).unwrap_or_default()),
    }
}

/// Renders any MySQL value (text or binary protocol) as a string; `None` for NULL.
pub(crate) fn value_string(v: &Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, m, d, h, i, s, us) => Some(if *h == 0 && *i == 0 && *s == 0 && *us == 0 {
            format!("{y:04}-{m:02}-{d:02} 00:00:00")
        } else if *us > 0 {
            format!("{y:04}-{m:02}-{d:02} {h:02}:{i:02}:{s:02}.{us:06}")
        } else {
            format!("{y:04}-{m:02}-{d:02} {h:02}:{i:02}:{s:02}")
        }),
        Value::Time(neg, d, h, i, s, us) => {
            let hours = *d as u64 * 24 + *h as u64;
            let sign = if *neg { "-" } else { "" };
            Some(if *us > 0 {
                format!("{sign}{hours:02}:{i:02}:{s:02}.{us:06}")
            } else {
                format!("{sign}{hours:02}:{i:02}:{s:02}")
            })
        }
    }
}

fn get_opt(r: &Row, i: usize) -> Option<String> {
    r.as_ref(i).and_then(value_string)
}

fn get_str(r: &Row, i: usize) -> String {
    get_opt(r, i).unwrap_or_default()
}

fn get_u64(r: &Row, i: usize) -> Option<u64> {
    match r.as_ref(i)? {
        Value::Int(v) => Some(*v as u64),
        Value::UInt(v) => Some(*v),
        other => value_string(other)?.parse().ok(),
    }
}

fn table_meta(r: &Row) -> TableMeta {
    TableMeta {
        name: get_str(r, 0),
        kind: get_str(r, 1),
        engine: get_opt(r, 2),
        rows: get_u64(r, 3),
        data_length: get_u64(r, 4),
        index_length: get_u64(r, 5),
        auto_increment: get_u64(r, 6),
        create_time: get_opt(r, 7),
        update_time: get_opt(r, 8),
        collation: get_opt(r, 9),
        comment: get_str(r, 10),
    }
}

fn json_to_value(v: &Json) -> Res<Value> {
    Ok(match v {
        Json::Null => Value::NULL,
        Json::String(s) => Value::Bytes(s.clone().into_bytes()),
        Json::Bool(b) => Value::Int(*b as i64),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else if let Some(u) = n.as_u64() {
                Value::UInt(u)
            } else {
                Value::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::Object(o) => match o.get("hex").and_then(|h| h.as_str()) {
            Some(h) => Value::Bytes(unhex(h)?),
            None => return Err("不支持的单元格值".into()),
        },
        Json::Array(_) => return Err("不支持的单元格值".into()),
    })
}

fn key_clause(key: &[(String, Json)], params: &mut Vec<Value>) -> Res<String> {
    if key.is_empty() {
        return Err("缺少用于定位行的键".into());
    }
    let mut parts = Vec::new();
    for (col, v) in key {
        if v.is_null() {
            parts.push(format!("{} IS NULL", quote_ident(col)));
        } else {
            parts.push(format!("{} = ?", quote_ident(col)));
            params.push(json_to_value(v)?);
        }
    }
    Ok(parts.join(" AND "))
}

fn build_change(target: &str, change: &RowChange) -> Res<(String, Vec<Value>)> {
    let mut params = Vec::new();
    let sql = match change {
        RowChange::Insert { values } => {
            let cols: Vec<String> = values.iter().map(|(c, _)| quote_ident(c)).collect();
            for (_, v) in values {
                params.push(json_to_value(v)?);
            }
            let marks = vec!["?"; values.len()].join(", ");
            format!(
                "INSERT INTO {target} ({}) VALUES ({marks})",
                cols.join(", ")
            )
        }
        RowChange::Update { key, values } => {
            if values.is_empty() {
                return Err("没有需要更新的列".into());
            }
            let mut sets = Vec::new();
            for (c, v) in values {
                sets.push(format!("{} = ?", quote_ident(c)));
                params.push(json_to_value(v)?);
            }
            let w = key_clause(key, &mut params)?;
            format!("UPDATE {target} SET {} WHERE {w} LIMIT 1", sets.join(", "))
        }
        RowChange::Delete { key } => {
            let w = key_clause(key, &mut params)?;
            format!("DELETE FROM {target} WHERE {w} LIMIT 1")
        }
    };
    Ok((sql, params))
}
