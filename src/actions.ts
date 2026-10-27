import { errorText, runSql } from "./api";
import { useStore } from "./store";
import type { ObjectKind } from "./types";
import { askText, confirmDialog, toast } from "./ui";
import { copyText, qi, qname } from "./utils";

/** Object-level operations shared by the tree, the toolbar and the object list. */

const st = () => useStore.getState();

export function openTable(connId: string, db: string, table: string, isView = false) {
  st().openTab({ kind: "table", title: `${table} @${db}`, connId, db, table, isView });
}

export function designTable(connId: string, db: string, table: string | null) {
  st().openTab({ kind: "design", title: table ? `${table} @${db} (设计)` : `无标题 @${db} (新建表)`, connId, db, table });
}

export function viewDdl(connId: string, db: string, name: string, objKind: ObjectKind) {
  st().openTab({ kind: "ddl", title: `${name} @${db} (定义)`, connId, db, name, objKind });
}

export function openServer(connId: string) {
  const name = st().connections.find((c) => c.id === connId)?.name ?? "";
  st().openTab({ kind: "server", title: `${name} 服务器监控`, connId });
}

async function exec(connId: string, sql: string, db: string | null, okText: string) {
  try {
    await runSql(connId, sql, db);
    toast(okText, "success");
    return true;
  } catch (e) {
    toast(errorText(e), "error");
    return false;
  }
}

function closeTabsFor(connId: string, db: string, table?: string) {
  const s = st();
  for (const t of s.tabs) {
    if (t.connId !== connId || !("db" in t) || t.db !== db) continue;
    const name = t.kind === "table" || t.kind === "design" ? t.table : t.kind === "ddl" ? t.name : undefined;
    if (table === undefined || name === table) s.closeTab(t.id);
  }
}

export async function dropObject(connId: string, db: string, name: string, kind: ObjectKind) {
  const label = { TABLE: "表", VIEW: "视图", PROCEDURE: "存储过程", FUNCTION: "函数", TRIGGER: "触发器" }[kind];
  const ok = await confirmDialog({
    title: `删除${label}`,
    message: `确定要删除${label} ${db}.${name} 吗？此操作不可恢复。`,
    danger: true,
    okText: "删除",
  });
  if (!ok) return;
  if (await exec(connId, `DROP ${kind} ${qname(db, name)}`, null, `已删除${label} ${name}`)) {
    closeTabsFor(connId, db, name);
    await st().loadObjects(connId, db, true);
  }
}

export async function truncateTable(connId: string, db: string, table: string) {
  const ok = await confirmDialog({
    title: "清空表",
    message: `确定要清空表 ${db}.${table} 的全部数据吗？此操作不可恢复。`,
    danger: true,
    okText: "清空",
  });
  if (!ok) return;
  if (await exec(connId, `TRUNCATE TABLE ${qname(db, table)}`, null, `已清空表 ${table}`)) {
    await st().loadObjects(connId, db, true);
  }
}

export async function renameTable(connId: string, db: string, table: string) {
  const name = await askText({ title: "重命名表", label: "新表名", value: table });
  if (!name || name === table) return;
  if (await exec(connId, `RENAME TABLE ${qname(db, table)} TO ${qname(db, name)}`, null, `已重命名为 ${name}`)) {
    closeTabsFor(connId, db, table);
    await st().loadObjects(connId, db, true);
  }
}

export async function duplicateTable(connId: string, db: string, table: string, withData: boolean) {
  const name = await askText({ title: withData ? "复制表（结构和数据）" : "复制表（仅结构）", label: "新表名", value: `${table}_copy` });
  if (!name) return;
  let sql = `CREATE TABLE ${qname(db, name)} LIKE ${qname(db, table)}`;
  if (withData) sql += `;\nINSERT INTO ${qname(db, name)} SELECT * FROM ${qname(db, table)}`;
  if (await exec(connId, sql, null, `已复制为 ${name}`)) await st().loadObjects(connId, db, true);
}

export async function dropDatabase(connId: string, db: string) {
  const typed = await askText({
    title: "删除数据库",
    label: `此操作将永久删除数据库 ${db} 及其全部对象。请输入数据库名确认：`,
    value: "",
  });
  if (typed === null) return;
  if (typed !== db) {
    toast("输入的名称不匹配，已取消", "error");
    return;
  }
  if (await exec(connId, `DROP DATABASE ${qi(db)}`, null, `已删除数据库 ${db}`)) {
    closeTabsFor(connId, db);
    const s = st();
    if (s.selected?.connId === connId && s.selected.db === db) s.select({ kind: "conn", connId });
    await s.refreshDatabases(connId);
  }
}

export function copyName(name: string) {
  copyText(name);
  toast(`已复制 ${name}`);
}

export async function refreshNode(connId: string, db?: string) {
  if (db) await st().loadObjects(connId, db, true);
  else await st().refreshDatabases(connId);
}
