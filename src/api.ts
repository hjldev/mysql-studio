import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  Charset,
  ConnectionConfig,
  DbObjects,
  ExecuteResponse,
  ObjectKind,
  RowChange,
  ServerInfo,
  TableData,
  TableMeta,
  TableStructure,
  TaskSummary,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Dev bridge (`npm run bridge`) used when the UI runs in a plain browser. */
const BRIDGE = "http://127.0.0.1:1430/invoke/";

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  const res = await fetch(BRIDGE + cmd, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) throw body;
  return body as T;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

export const api = {
  listConnections: () => call<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig) => call<ConnectionConfig>("save_connection", { config }),
  deleteConnection: (id: string) => call<void>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig) => call<string>("test_connection", { config }),
  connect: (connId: string) => call<ServerInfo>("connect", { connId }),
  disconnect: (connId: string) => call<void>("disconnect", { connId }),
  listDatabases: (connId: string) => call<string[]>("list_databases", { connId }),
  listObjects: (connId: string, db: string) => call<DbObjects>("list_objects", { connId, db }),
  tableStructure: (connId: string, db: string, table: string) =>
    call<TableStructure>("table_structure", { connId, db, table }),
  schemaColumns: (connId: string, db: string, tables?: string[]) =>
    call<Record<string, string[]>>("schema_columns", { connId, db, tables: tables ?? null }),
  tableStats: (connId: string, db: string) => call<TableMeta[]>("table_stats", { connId, db }),
  getDdl: (connId: string, db: string, name: string, kind: ObjectKind) =>
    call<string>("get_ddl", { connId, db, name, kind }),
  listCharsets: (connId: string) => call<Charset[]>("list_charsets", { connId }),
  execute: (
    connId: string,
    sql: string,
    opts: { sessionId?: string; database?: string | null; maxRows?: number; continueOnError?: boolean } = {},
  ) =>
    call<ExecuteResponse>("execute_query", {
      connId,
      sql,
      sessionId: opts.sessionId ?? null,
      database: opts.database ?? null,
      maxRows: opts.maxRows ?? null,
      continueOnError: opts.continueOnError ?? null,
    }),
  cancelQuery: (connId: string, sessionId: string) => call<void>("cancel_query", { connId, sessionId }),
  closeSession: (sessionId: string) => call<void>("close_session", { sessionId }),
  fetchTableData: (
    connId: string,
    db: string,
    table: string,
    p: { offset: number; limit: number; filter?: string; orderBy?: string; withTotal?: boolean },
  ) =>
    call<TableData>("fetch_table_data", {
      connId,
      db,
      table,
      offset: p.offset,
      limit: p.limit,
      filter: p.filter ?? null,
      orderBy: p.orderBy ?? null,
      withTotal: p.withTotal ?? true,
    }),
  applyChanges: (connId: string, db: string, table: string, changes: RowChange[]) =>
    call<ApplyResult>("apply_changes", { connId, db, table, changes }),
  exportTable: (connId: string, db: string, table: string, format: string, path: string, filter?: string) =>
    call<TaskSummary>("export_table", { connId, db, table, format, path, filter: filter ?? null }),
  dumpDatabase: (connId: string, db: string, path: string, includeData: boolean, tables?: string[]) =>
    call<TaskSummary>("dump_database", { connId, db, path, includeData, tables: tables ?? null }),
  runSqlFile: (connId: string, db: string | null, path: string, continueOnError: boolean) =>
    call<TaskSummary>("run_sql_file", { connId, db, path, continueOnError }),
  writeTextFile: (path: string, content: string) => call<void>("write_text_file", { path, content }),
};

/** Runs SQL without a session and throws on the first failing statement. */
export async function runSql(connId: string, sql: string, database?: string | null) {
  const res = await api.execute(connId, sql, { database });
  const failed = res.results.find((r) => r.error);
  if (failed) throw failed.error;
  return res.results;
}
