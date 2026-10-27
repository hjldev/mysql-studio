use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// Default database selected after connecting (optional).
    pub database: Option<String>,
    pub ssl: bool,
    pub ssl_accept_invalid: bool,
    /// Accent color shown in the object tree.
    pub color: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    pub connection_id: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub org_name: String,
    pub table: String,
    pub org_table: String,
    pub type_name: String,
    pub binary: bool,
    pub numeric: bool,
    pub pk: bool,
    pub not_null: bool,
    pub auto_inc: bool,
    pub unsigned: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub sql: String,
    pub has_result_set: bool,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Json>>,
    pub affected_rows: u64,
    pub last_insert_id: Option<u64>,
    pub warnings: u16,
    pub info: String,
    pub elapsed_ms: f64,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResponse {
    pub results: Vec<QueryResult>,
    /// Current database of the session after execution (tracks `USE x`).
    pub database: Option<String>,
}

/// Unset fields are omitted from JSON: name-only listings of huge schemas stay small.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_increment: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub comment: String,
}

impl TableMeta {
    /// A table known only by name and type; statistics are loaded separately.
    pub fn named(name: String, kind: String) -> Self {
        Self {
            name,
            kind,
            engine: None,
            rows: None,
            data_length: None,
            index_length: None,
            auto_increment: None,
            create_time: None,
            update_time: None,
            collation: None,
            comment: String::new(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoutineMeta {
    pub name: String,
    pub kind: String,
    pub returns: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub comment: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TriggerMeta {
    pub name: String,
    pub table: String,
    pub event: String,
    pub timing: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbObjects {
    pub tables: Vec<TableMeta>,
    pub views: Vec<TableMeta>,
    pub routines: Vec<RoutineMeta>,
    pub triggers: Vec<TriggerMeta>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub name: String,
    pub position: u32,
    pub default: Option<String>,
    pub nullable: bool,
    pub data_type: String,
    pub column_type: String,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub key: String,
    pub extra: String,
    pub comment: String,
    pub generation_expression: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    pub unique: bool,
    pub index_type: String,
    pub columns: Vec<IndexColumn>,
    pub comment: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub name: String,
    pub sub_part: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDetail {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub info: Option<TableMeta>,
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexDetail>,
    pub foreign_keys: Vec<ForeignKeyDetail>,
    pub primary_key: Vec<String>,
    pub ddl: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Charset {
    pub name: String,
    pub default_collation: String,
    pub collations: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableData {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Json>>,
    pub total: Option<u64>,
    pub elapsed_ms: f64,
    pub sql: String,
}

/// One pending edit from the data grid. Cell values are JSON `null`,
/// a string, or `{"hex": "..."}` for binary data.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowChange {
    Insert {
        values: Vec<(String, Json)>,
    },
    Update {
        key: Vec<(String, Json)>,
        values: Vec<(String, Json)>,
    },
    Delete {
        key: Vec<(String, Json)>,
    },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub affected: u64,
    pub statements: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub statements: u64,
    pub rows: u64,
    pub errors: Vec<String>,
    pub elapsed_ms: f64,
}
