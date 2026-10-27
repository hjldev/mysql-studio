import type { ForeignKeyDetail, IndexDetail, TableStructure } from "./types";
import { qi, qname, sqlString, uid } from "./utils";

/** Editable model of a table definition and the DDL generator behind the table designer. */

export interface FieldRow {
  uid: string;
  /** Column name in the database; undefined for columns added in the designer. */
  orig?: string;
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  defaultValue: string;
  autoInc: boolean;
  onUpdate: string;
  comment: string;
  collation: string | null;
  generated: string;
  stored: boolean;
}

export type IndexKind = "NORMAL" | "UNIQUE" | "FULLTEXT" | "SPATIAL";

export interface IndexRow {
  uid: string;
  name: string;
  kind: IndexKind;
  columns: string;
  method: "" | "BTREE" | "HASH";
  comment: string;
}

export interface FkRow {
  uid: string;
  name: string;
  columns: string;
  refSchema: string;
  refTable: string;
  refColumns: string;
  onDelete: string;
  onUpdate: string;
}

export interface TableOptions {
  engine: string;
  charset: string;
  collation: string;
  comment: string;
  autoIncrement: string;
}

export interface TableModel {
  fields: FieldRow[];
  indexes: IndexRow[];
  fks: FkRow[];
  options: TableOptions;
}

export const COMMON_TYPES = [
  "int", "int unsigned", "bigint", "bigint unsigned", "tinyint", "tinyint(1)", "smallint", "mediumint",
  "decimal(10,2)", "float", "double", "varchar(255)", "varchar(64)", "char(32)", "text", "mediumtext",
  "longtext", "json", "date", "datetime", "datetime(3)", "timestamp", "time", "year", "blob", "longblob",
  "binary(16)", "varbinary(255)", "enum('a','b')", "set('a','b')", "bit(1)", "geometry",
];

export const FK_RULES = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION", "SET DEFAULT"];
export const ENGINES = ["InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE"];

const NUMERIC_RE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|bool|boolean|year)\b/i;
const TIME_FN_RE = /^(current_timestamp|now|localtime|localtimestamp|current_date|curdate|current_time|curtime|utc_timestamp)(\(\d*\))?$/i;

export function newField(name = ""): FieldRow {
  return {
    uid: uid(),
    name,
    type: "varchar(255)",
    notNull: false,
    pk: false,
    defaultValue: "",
    autoInc: false,
    onUpdate: "",
    comment: "",
    collation: null,
    generated: "",
    stored: false,
  };
}

export function newIndex(): IndexRow {
  return { uid: uid(), name: "", kind: "NORMAL", columns: "", method: "", comment: "" };
}

export function newFk(db: string): FkRow {
  return { uid: uid(), name: "", columns: "", refSchema: db, refTable: "", refColumns: "", onDelete: "RESTRICT", onUpdate: "RESTRICT" };
}

export function modelFromStructure(st: TableStructure): TableModel {
  const fields: FieldRow[] = st.columns.map((c) => {
    const generated = c.generationExpression || "";
    const autoInc = /auto_increment/i.test(c.extra);
    let defaultValue = "";
    if (c.default === null) {
      if (c.nullable && !generated && !autoInc) defaultValue = "NULL";
    } else if (/DEFAULT_GENERATED/i.test(c.extra)) {
      defaultValue = TIME_FN_RE.test(c.default) ? c.default : `(${c.default})`;
    } else if (NUMERIC_RE.test(c.columnType) || /^b'[01]*'$/i.test(c.default)) {
      defaultValue = c.default;
    } else {
      defaultValue = sqlString(c.default);
    }
    return {
      uid: uid(),
      orig: c.name,
      name: c.name,
      type: c.columnType,
      notNull: !c.nullable,
      pk: st.primaryKey.includes(c.name),
      defaultValue,
      autoInc,
      onUpdate: /on update (\S+)/i.exec(c.extra)?.[1] ?? "",
      comment: c.comment,
      collation: c.collation,
      generated,
      stored: /STORED GENERATED/i.test(c.extra),
    };
  });
  // Keep primary-key column order as defined by the index.
  const indexes: IndexRow[] = st.indexes
    .filter((i) => i.name !== "PRIMARY")
    .map((i: IndexDetail) => ({
      uid: uid(),
      name: i.name,
      kind: i.indexType === "FULLTEXT" ? "FULLTEXT" : i.indexType === "SPATIAL" ? "SPATIAL" : i.unique ? "UNIQUE" : "NORMAL",
      columns: i.columns.map((c) => (c.subPart ? `${c.name}(${c.subPart})` : c.name)).join(", "),
      method: i.indexType === "BTREE" || i.indexType === "HASH" ? i.indexType : "",
      comment: i.comment,
    }));
  const fks: FkRow[] = st.foreignKeys.map((f: ForeignKeyDetail) => ({
    uid: uid(),
    name: f.name,
    columns: f.columns.join(", "),
    refSchema: f.refSchema,
    refTable: f.refTable,
    refColumns: f.refColumns.join(", "),
    onDelete: f.onDelete,
    onUpdate: f.onUpdate,
  }));
  const coll = st.info?.collation ?? "";
  return {
    fields,
    indexes,
    fks,
    options: {
      engine: st.info?.engine ?? "InnoDB",
      charset: coll.split("_")[0] ?? "",
      collation: coll,
      comment: st.info?.comment ?? "",
      autoIncrement: st.info?.autoIncrement != null ? String(st.info.autoIncrement) : "",
    },
  };
}

export function emptyModel(): TableModel {
  const id = newField("id");
  Object.assign(id, { type: "int", notNull: true, pk: true, autoInc: true });
  return {
    fields: [id],
    indexes: [],
    fks: [],
    options: { engine: "InnoDB", charset: "utf8mb4", collation: "", comment: "", autoIncrement: "" },
  };
}

export function defaultSql(text: string, type: string): string {
  const t = text.trim();
  if (/^null$/i.test(t)) return "NULL";
  if (/^'.*'$/s.test(t) || /^".*"$/s.test(t)) return t;
  if (/^\(.*\)$/s.test(t)) return t;
  if (TIME_FN_RE.test(t)) return t;
  if (/^b'[01]*'$/i.test(t) || /^0x[0-9a-f]+$/i.test(t) || /^x'[0-9a-f]*'$/i.test(t)) return t;
  if (/^(true|false)$/i.test(t)) return t;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t) && NUMERIC_RE.test(type)) return t;
  return sqlString(t);
}

export function columnDef(f: FieldRow): string {
  let s = `${qi(f.name)} ${f.type.trim()}`;
  if (f.collation && /char|text|enum|set/i.test(f.type)) s += ` COLLATE ${f.collation}`;
  if (f.generated) s += ` GENERATED ALWAYS AS (${f.generated}) ${f.stored ? "STORED" : "VIRTUAL"}`;
  s += f.notNull ? " NOT NULL" : " NULL";
  if (!f.generated && f.defaultValue.trim()) s += ` DEFAULT ${defaultSql(f.defaultValue, f.type)}`;
  if (f.autoInc) s += " AUTO_INCREMENT";
  if (f.onUpdate.trim()) s += ` ON UPDATE ${f.onUpdate.trim()}`;
  if (f.comment) s += ` COMMENT ${sqlString(f.comment)}`;
  return s;
}

function indexCols(cols: string): string {
  return cols
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const m = /^`?(.+?)`?\s*(?:\((\d+)\))?\s*(asc|desc)?$/i.exec(c);
      if (!m) return qi(c);
      return qi(m[1]) + (m[2] ? `(${m[2]})` : "") + (m[3] ? ` ${m[3].toUpperCase()}` : "");
    })
    .join(", ");
}

export function indexDef(i: IndexRow): string {
  const prefix = i.kind === "NORMAL" ? "INDEX" : `${i.kind} INDEX`;
  let s = `${prefix} ${qi(i.name || "idx")} (${indexCols(i.columns)})`;
  if (i.method && (i.kind === "NORMAL" || i.kind === "UNIQUE")) s += ` USING ${i.method}`;
  if (i.comment) s += ` COMMENT ${sqlString(i.comment)}`;
  return s;
}

export function fkDef(f: FkRow, db: string): string {
  const ref = f.refSchema && f.refSchema !== db ? qname(f.refSchema, f.refTable) : qi(f.refTable);
  return `CONSTRAINT ${qi(f.name)} FOREIGN KEY (${indexCols(f.columns)}) REFERENCES ${ref} (${indexCols(f.refColumns)}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`;
}

function optionClauses(o: TableOptions, before?: TableOptions): string[] {
  const out: string[] = [];
  if (o.engine && o.engine !== before?.engine) out.push(`ENGINE = ${o.engine}`);
  if ((o.charset && o.charset !== before?.charset) || (o.collation && o.collation !== before?.collation)) {
    if (o.charset) out.push(`DEFAULT CHARACTER SET = ${o.charset}` + (o.collation ? ` COLLATE = ${o.collation}` : ""));
  }
  if (o.comment !== (before?.comment ?? "") && (before || o.comment)) out.push(`COMMENT = ${sqlString(o.comment)}`);
  if (o.autoIncrement.trim() && o.autoIncrement !== before?.autoIncrement) out.push(`AUTO_INCREMENT = ${Number(o.autoIncrement) || 1}`);
  return out;
}

export function validate(m: TableModel): string | null {
  if (!m.fields.length) return "表至少需要一个字段";
  const names = new Set<string>();
  for (const f of m.fields) {
    if (!f.name.trim()) return "字段名不能为空";
    if (!f.type.trim()) return `字段 ${f.name} 缺少类型`;
    const k = f.name.toLowerCase();
    if (names.has(k)) return `字段名重复: ${f.name}`;
    names.add(k);
  }
  for (const i of m.indexes) {
    if (!i.name.trim()) return "索引名不能为空";
    if (!i.columns.trim()) return `索引 ${i.name} 没有字段`;
  }
  for (const f of m.fks) {
    if (!f.name.trim() || !f.columns.trim() || !f.refTable.trim() || !f.refColumns.trim()) return "外键定义不完整";
  }
  return null;
}

export function buildCreate(db: string, table: string, m: TableModel): string[] {
  const defs = m.fields.map(columnDef);
  const pk = m.fields.filter((f) => f.pk).map((f) => qi(f.name));
  if (pk.length) defs.push(`PRIMARY KEY (${pk.join(", ")})`);
  defs.push(...m.indexes.map(indexDef));
  defs.push(...m.fks.map((f) => fkDef(f, db)));
  const opts = optionClauses(m.options);
  return [`CREATE TABLE ${qname(db, table)} (\n  ${defs.join(",\n  ")}\n)${opts.length ? " " + opts.join(" ") : ""}`];
}

/** Indexes (into `seq`) of one longest strictly increasing subsequence. */
function longestIncreasing(seq: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.unshift(i);
  return out;
}

export function buildAlter(db: string, table: string, orig: TableModel, cur: TableModel): string[] {
  const T = qname(db, table);
  const out: string[] = [];
  const origFk = new Map(orig.fks.map((f) => [f.uid, f]));
  const curFk = new Map(cur.fks.map((f) => [f.uid, f]));
  const fkUnchanged = (f: FkRow) => {
    const o = origFk.get(f.uid);
    return o && fkDef(o, db) === fkDef(f, db);
  };

  const fkDrops = orig.fks.filter((o) => !curFk.has(o.uid) || !fkUnchanged(curFk.get(o.uid)!));
  if (fkDrops.length) out.push(`ALTER TABLE ${T}\n  ${fkDrops.map((f) => `DROP FOREIGN KEY ${qi(f.name)}`).join(",\n  ")}`);

  const clauses: string[] = [];
  const origFields = new Map(orig.fields.map((f) => [f.uid, f]));
  const curIds = new Set(cur.fields.map((f) => f.uid));
  for (const o of orig.fields) if (!curIds.has(o.uid)) clauses.push(`DROP COLUMN ${qi(o.orig!)}`);

  const origIdx = new Map(orig.indexes.map((i) => [i.uid, i]));
  const curIdx = new Map(cur.indexes.map((i) => [i.uid, i]));
  const idxUnchanged = (i: IndexRow) => {
    const o = origIdx.get(i.uid);
    return o && indexDef(o) === indexDef(i);
  };
  for (const o of orig.indexes) if (!curIdx.has(o.uid) || !idxUnchanged(curIdx.get(o.uid)!)) clauses.push(`DROP INDEX ${qi(o.name)}`);

  const origPk = orig.fields.filter((f) => f.pk).map((f) => f.uid);
  const curPk = cur.fields.filter((f) => f.pk);
  const pkChanged = origPk.join() !== curPk.map((f) => f.uid).join();
  if (pkChanged && origPk.length) clauses.push("DROP PRIMARY KEY");

  // Columns outside the longest run that kept its relative order are the ones that moved.
  // Positioned clauses are emitted in final order so each AFTER target already exists.
  const origPos = new Map(orig.fields.map((f, i) => [f.uid, i]));
  const existing = cur.fields.filter((f) => origPos.has(f.uid));
  const stay = longestIncreasing(existing.map((f) => origPos.get(f.uid)!)).map((i) => existing[i].uid);
  const stays = new Set(stay);
  cur.fields.forEach((f, i) => {
    const pos = i === 0 ? " FIRST" : ` AFTER ${qi(cur.fields[i - 1].name)}`;
    const o = origFields.get(f.uid);
    if (!o) clauses.push(`ADD COLUMN ${columnDef(f)}${pos}`);
    else if (!stays.has(f.uid)) clauses.push(`CHANGE COLUMN ${qi(o.orig!)} ${columnDef(f)}${pos}`);
    else if (columnDef(o) !== columnDef(f)) clauses.push(`CHANGE COLUMN ${qi(o.orig!)} ${columnDef(f)}`);
  });

  if (pkChanged && curPk.length) clauses.push(`ADD PRIMARY KEY (${curPk.map((f) => qi(f.name)).join(", ")})`);
  for (const i of cur.indexes) if (!idxUnchanged(i)) clauses.push(`ADD ${indexDef(i)}`);
  clauses.push(...optionClauses(cur.options, orig.options));
  if (clauses.length) out.push(`ALTER TABLE ${T}\n  ${clauses.join(",\n  ")}`);

  const fkAdds = cur.fks.filter((f) => !fkUnchanged(f));
  if (fkAdds.length) out.push(`ALTER TABLE ${T}\n  ${fkAdds.map((f) => `ADD ${fkDef(f, db)}`).join(",\n  ")}`);
  return out;
}
