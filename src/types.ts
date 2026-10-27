export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string | null;
  ssl: boolean;
  sslAcceptInvalid: boolean;
  color?: string | null;
}

export interface ServerInfo {
  version: string;
  connectionId: number;
}

/** A cell as delivered by the backend. */
export type Cell = string | null | { blob: number };

export interface ColumnMeta {
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  typeName: string;
  binary: boolean;
  numeric: boolean;
  pk: boolean;
  notNull: boolean;
  autoInc: boolean;
  unsigned: boolean;
}

export interface QueryResult {
  sql: string;
  hasResultSet: boolean;
  columns: ColumnMeta[];
  rows: Cell[][];
  affectedRows: number;
  lastInsertId: number | null;
  warnings: number;
  info: string;
  elapsedMs: number;
  truncated: boolean;
  error: string | null;
}

export interface ExecuteResponse {
  results: QueryResult[];
  database: string | null;
}

/** Name listings carry only name/kind; the rest comes from `tableStats`. */
export interface TableMeta {
  name: string;
  kind: string;
  engine?: string | null;
  rows?: number | null;
  dataLength?: number | null;
  indexLength?: number | null;
  autoIncrement?: number | null;
  createTime?: string | null;
  updateTime?: string | null;
  collation?: string | null;
  comment?: string;
}

export interface RoutineMeta {
  name: string;
  kind: "PROCEDURE" | "FUNCTION" | string;
  returns: string | null;
  created: string | null;
  modified: string | null;
  comment: string;
}

export interface TriggerMeta {
  name: string;
  table: string;
  event: string;
  timing: string;
}

export interface DbObjects {
  tables: TableMeta[];
  views: TableMeta[];
  routines: RoutineMeta[];
  triggers: TriggerMeta[];
}

export interface ColumnDetail {
  name: string;
  position: number;
  default: string | null;
  nullable: boolean;
  dataType: string;
  columnType: string;
  charset: string | null;
  collation: string | null;
  key: string;
  extra: string;
  comment: string;
  generationExpression: string;
}

export interface IndexDetail {
  name: string;
  unique: boolean;
  indexType: string;
  columns: { name: string; subPart: number | null }[];
  comment: string;
}

export interface ForeignKeyDetail {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableStructure {
  info: TableMeta | null;
  columns: ColumnDetail[];
  indexes: IndexDetail[];
  foreignKeys: ForeignKeyDetail[];
  primaryKey: string[];
  ddl: string;
}

export interface Charset {
  name: string;
  defaultCollation: string;
  collations: string[];
}

export interface TableData {
  columns: ColumnMeta[];
  rows: Cell[][];
  total: number | null;
  elapsedMs: number;
  sql: string;
}

/** Value sent to the backend for an edit: null, a string, a number (BIT) or hex bytes. */
export type CellInput = string | null | number | { hex: string };

export type RowChange =
  | { kind: "insert"; values: [string, CellInput][] }
  | { kind: "update"; key: [string, CellInput][]; values: [string, CellInput][] }
  | { kind: "delete"; key: [string, CellInput][] };

export interface ApplyResult {
  affected: number;
  statements: string[];
}

export interface TaskSummary {
  statements: number;
  rows: number;
  errors: string[];
  elapsedMs: number;
}

export type ObjectKind = "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER";

export type Tab =
  | { id: string; kind: "query"; title: string; connId: string; database: string | null; sql: string }
  | { id: string; kind: "table"; title: string; connId: string; db: string; table: string; isView: boolean }
  | { id: string; kind: "design"; title: string; connId: string; db: string; table: string | null }
  | { id: string; kind: "objects"; title: string; connId: string; db: string }
  | { id: string; kind: "ddl"; title: string; connId: string; db: string; name: string; objKind: ObjectKind }
  | { id: string; kind: "server"; title: string; connId: string };
