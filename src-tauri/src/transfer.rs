//! Export, dump and import of data via local files.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

use mysql_async::prelude::*;
use mysql_async::{Conn, Value};

use crate::db::{
    bit_value, clean_err, hex, qualified, quote_ident, show_create, AppState, ColInfo, ErrStr, Res,
};
use crate::models::TaskSummary;
use crate::sqlsplit::split_sql;

const INSERT_BATCH: usize = 200;

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// A value as a SQL literal, suitable for INSERT statements.
fn sql_literal(v: &Value, c: &ColInfo) -> String {
    match v {
        Value::NULL => "NULL".into(),
        Value::Bytes(b) => {
            if c.bit || c.meta.binary {
                if b.is_empty() {
                    "''".into()
                } else {
                    format!("0x{}", hex(b))
                }
            } else if c.meta.numeric {
                String::from_utf8_lossy(b).into_owned()
            } else {
                let s = String::from_utf8_lossy(b);
                let mut out = String::with_capacity(s.len() + 2);
                out.push('\'');
                for ch in s.chars() {
                    match ch {
                        '\0' => out.push_str("\\0"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\\' => out.push_str("\\\\"),
                        '\'' => out.push_str("\\'"),
                        '\x1a' => out.push_str("\\Z"),
                        _ => out.push(ch),
                    }
                }
                out.push('\'');
                out
            }
        }
        other => format!("'{}'", crate::db::value_string(other).unwrap_or_default()),
    }
}

fn text_value(v: &Value, c: &ColInfo) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) if c.bit => Some(bit_value(b).to_string()),
        Value::Bytes(b) if c.meta.binary => Some(format!("0x{}", hex(b))),
        other => crate::db::value_string(other),
    }
}

/// Streams `select` into `w` as INSERT statements; returns the number of rows.
async fn write_inserts(conn: &mut Conn, select: &str, table: &str, w: &mut impl Write) -> Res<u64> {
    let mut qr = conn.query_iter(select).await.es()?;
    let cols: Vec<ColInfo> = qr
        .columns()
        .map(|c| c.iter().map(ColInfo::from).collect())
        .unwrap_or_default();
    let col_list = cols
        .iter()
        .map(|c| quote_ident(&c.meta.name))
        .collect::<Vec<_>>()
        .join(", ");
    let mut n = 0u64;
    let mut in_batch = 0usize;
    while let Some(row) = qr.next().await.es()? {
        let vals: Vec<Value> = row.unwrap();
        let tuple = vals
            .iter()
            .zip(cols.iter())
            .map(|(v, c)| sql_literal(v, c))
            .collect::<Vec<_>>()
            .join(", ");
        if in_batch == 0 {
            write!(
                w,
                "INSERT INTO {} ({col_list}) VALUES\n({tuple})",
                quote_ident(table)
            )
            .es()?;
        } else {
            write!(w, ",\n({tuple})").es()?;
        }
        in_batch += 1;
        n += 1;
        if in_batch >= INSERT_BATCH {
            writeln!(w, ";").es()?;
            in_batch = 0;
        }
    }
    if in_batch > 0 {
        writeln!(w, ";").es()?;
    }
    Ok(n)
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub async fn export_table(
        &self,
        conn_id: &str,
        db: &str,
        table: &str,
        format: &str,
        path: &str,
        filter: &str,
    ) -> Res<TaskSummary> {
        let start = Instant::now();
        let mut conn = self.conn_for(conn_id, None).await?;
        let mut select = format!("SELECT * FROM {}", qualified(db, table));
        if !filter.trim().is_empty() {
            select.push_str(" WHERE ");
            select.push_str(filter.trim());
        }
        let mut w = BufWriter::new(File::create(path).es()?);
        let rows = match format {
            "sql" => {
                writeln!(
                    w,
                    "-- Exported by MySQL Studio from {}\n",
                    qualified(db, table)
                )
                .es()?;
                write_inserts(&mut conn, &select, table, &mut w).await?
            }
            "csv" | "json" => {
                let mut qr = conn.query_iter(select.as_str()).await.es()?;
                let cols: Vec<ColInfo> = qr
                    .columns()
                    .map(|c| c.iter().map(ColInfo::from).collect())
                    .unwrap_or_default();
                let mut n = 0u64;
                if format == "csv" {
                    // BOM so spreadsheet apps detect UTF-8.
                    w.write_all("\u{feff}".as_bytes()).es()?;
                    let header: Vec<String> =
                        cols.iter().map(|c| csv_field(&c.meta.name)).collect();
                    writeln!(w, "{}", header.join(",")).es()?;
                } else {
                    write!(w, "[").es()?;
                }
                while let Some(row) = qr.next().await.es()? {
                    let vals: Vec<Value> = row.unwrap();
                    if format == "csv" {
                        let line: Vec<String> = vals
                            .iter()
                            .zip(cols.iter())
                            .map(|(v, c)| {
                                text_value(v, c).map(|s| csv_field(&s)).unwrap_or_default()
                            })
                            .collect();
                        writeln!(w, "{}", line.join(",")).es()?;
                    } else {
                        let fields: Vec<String> = vals
                            .iter()
                            .zip(cols.iter())
                            .map(|(v, c)| {
                                let val = match text_value(v, c) {
                                    None => "null".to_string(),
                                    Some(s) if c.meta.numeric && s.parse::<f64>().is_ok() => s,
                                    Some(s) => json_string(&s),
                                };
                                format!("{}: {}", json_string(&c.meta.name), val)
                            })
                            .collect();
                        let sep = if n == 0 { "\n  " } else { ",\n  " };
                        write!(w, "{sep}{{{}}}", fields.join(", ")).es()?;
                    }
                    n += 1;
                }
                if format == "json" {
                    writeln!(w, "\n]").es()?;
                }
                n
            }
            other => return Err(format!("不支持的导出格式: {other}")),
        };
        w.flush().es()?;
        Ok(TaskSummary {
            statements: 1,
            rows,
            errors: vec![],
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    pub async fn dump_database(
        &self,
        conn_id: &str,
        db: &str,
        path: &str,
        include_data: bool,
        tables: Option<Vec<String>>,
    ) -> Res<TaskSummary> {
        let start = Instant::now();
        let mut conn = self.conn_for(conn_id, Some(db)).await?;
        let objs = self.list_objects(conn_id, db).await?;
        let version: Option<String> = conn.query_first("SELECT VERSION()").await.es()?;
        let mut w = BufWriter::new(File::create(path).es()?);
        let mut errors = Vec::new();
        let mut statements = 0u64;
        let mut rows = 0u64;
        let selected = |name: &str| {
            tables
                .as_ref()
                .map(|t| t.iter().any(|x| x == name))
                .unwrap_or(true)
        };

        writeln!(w, "-- MySQL Studio SQL dump").es()?;
        writeln!(w, "-- Server version: {}", version.unwrap_or_default()).es()?;
        writeln!(w, "-- Database: {}\n", quote_ident(db)).es()?;
        writeln!(w, "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n").es()?;

        for t in objs.tables.iter().filter(|t| selected(&t.name)) {
            match show_create(&mut conn, db, &t.name, "TABLE").await {
                Ok(ddl) => {
                    writeln!(w, "-- ----------------------------\n-- Table structure for {}\n-- ----------------------------", quote_ident(&t.name)).es()?;
                    writeln!(
                        w,
                        "DROP TABLE IF EXISTS {};\n{};\n",
                        quote_ident(&t.name),
                        ddl
                    )
                    .es()?;
                    statements += 2;
                }
                Err(e) => {
                    errors.push(format!("{}: {e}", t.name));
                    continue;
                }
            }
            if include_data {
                writeln!(w, "-- ----------------------------\n-- Records of {}\n-- ----------------------------", quote_ident(&t.name)).es()?;
                let select = format!("SELECT * FROM {}", qualified(db, &t.name));
                match write_inserts(&mut conn, &select, &t.name, &mut w).await {
                    Ok(n) => {
                        rows += n;
                        statements += n.div_ceil(INSERT_BATCH as u64);
                    }
                    Err(e) => errors.push(format!("{}: {e}", t.name)),
                }
                writeln!(w).es()?;
            }
        }

        for v in objs.views.iter().filter(|v| selected(&v.name)) {
            match show_create(&mut conn, db, &v.name, "VIEW").await {
                Ok(ddl) => {
                    writeln!(w, "-- ----------------------------\n-- View structure for {}\n-- ----------------------------", quote_ident(&v.name)).es()?;
                    writeln!(
                        w,
                        "DROP VIEW IF EXISTS {};\n{};\n",
                        quote_ident(&v.name),
                        ddl
                    )
                    .es()?;
                    statements += 2;
                }
                Err(e) => errors.push(format!("{}: {e}", v.name)),
            }
        }

        if tables.is_none() {
            for r in &objs.routines {
                match show_create(&mut conn, db, &r.name, &r.kind).await {
                    Ok(ddl) => {
                        writeln!(w, "-- ----------------------------\n-- {} structure for {}\n-- ----------------------------", r.kind.to_lowercase(), quote_ident(&r.name)).es()?;
                        writeln!(
                            w,
                            "DROP {} IF EXISTS {};\nDELIMITER ;;\n{};;\nDELIMITER ;\n",
                            r.kind,
                            quote_ident(&r.name),
                            ddl
                        )
                        .es()?;
                        statements += 2;
                    }
                    Err(e) => errors.push(format!("{}: {e}", r.name)),
                }
            }
            for t in &objs.triggers {
                match show_create(&mut conn, db, &t.name, "TRIGGER").await {
                    Ok(ddl) => {
                        writeln!(w, "-- ----------------------------\n-- Trigger {}\n-- ----------------------------", quote_ident(&t.name)).es()?;
                        writeln!(
                            w,
                            "DROP TRIGGER IF EXISTS {};\nDELIMITER ;;\n{};;\nDELIMITER ;\n",
                            quote_ident(&t.name),
                            ddl
                        )
                        .es()?;
                        statements += 2;
                    }
                    Err(e) => errors.push(format!("{}: {e}", t.name)),
                }
            }
        }

        writeln!(w, "SET FOREIGN_KEY_CHECKS = 1;").es()?;
        w.flush().es()?;
        Ok(TaskSummary {
            statements,
            rows,
            errors,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }

    pub async fn run_sql_file(
        &self,
        conn_id: &str,
        db: Option<&str>,
        path: &str,
        continue_on_error: bool,
    ) -> Res<TaskSummary> {
        let start = Instant::now();
        let bytes = std::fs::read(path).es()?;
        let text = String::from_utf8_lossy(&bytes);
        let stmts = split_sql(&text);
        let mut conn = self.conn_for(conn_id, db).await?;
        let mut errors = Vec::new();
        let mut executed = 0u64;
        let mut rows = 0u64;
        for stmt in &stmts {
            match conn.query_iter(stmt.as_str()).await {
                Ok(qr) => {
                    let affected = qr.affected_rows();
                    match qr.drop_result().await {
                        Ok(()) => {
                            executed += 1;
                            rows += affected;
                        }
                        Err(e) => {
                            errors.push(format!("{}\n{}", clean_err(e.to_string()), preview(stmt)));
                            if !continue_on_error {
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    let fatal = !matches!(e, mysql_async::Error::Server(_));
                    errors.push(format!("{}\n{}", clean_err(e.to_string()), preview(stmt)));
                    if fatal || !continue_on_error {
                        break;
                    }
                }
            }
            if errors.len() >= 200 {
                errors.push("错误过多，已停止".into());
                break;
            }
        }
        Ok(TaskSummary {
            statements: executed,
            rows,
            errors,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

fn preview(stmt: &str) -> String {
    let s: String = stmt.chars().take(200).collect();
    if s.len() < stmt.len() {
        format!("{s}…")
    } else {
        s
    }
}

pub fn write_text_file(path: &str, content: &str) -> Res<()> {
    std::fs::write(path, content).es()
}
