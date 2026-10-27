import { isTauri } from "./api";
import { askText } from "./ui";
import type { Cell, CellInput, ColumnMeta } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const qi = (name: string) => "`" + name.replace(/`/g, "``") + "`";
export const qname = (db: string, name: string) => `${qi(db)}.${qi(name)}`;

export function sqlString(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\0/g, "\\0") + "'";
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function isBlob(c: Cell | undefined): c is { blob: number } {
  return typeof c === "object" && c !== null;
}

/** Single-line display text for a grid cell. */
export function cellDisplay(c: Cell | undefined): string {
  if (c === undefined) return "";
  if (c === null) return "NULL";
  if (isBlob(c)) return `(BLOB ${formatBytes(c.blob)})`;
  if (c.length > 300) return c.slice(0, 300).replace(/\r?\n/g, " ↵ ") + "…";
  return c.replace(/\r?\n/g, " ↵ ");
}

/** Plain text used for copying a cell. */
export function cellText(c: Cell | undefined): string {
  if (c === undefined || c === null) return "";
  if (isBlob(c)) return `(BLOB ${c.blob} bytes)`;
  return c;
}

/** Converts a grid value into what the backend expects for the column. */
export function toInput(c: Cell, col: ColumnMeta | undefined): CellInput {
  if (c === null || isBlob(c)) return null;
  if (col?.typeName === "BIT") {
    const n = Number(c);
    return Number.isFinite(n) ? n : c;
  }
  if (col?.binary && /^0x[0-9a-f]*$/i.test(c)) return { hex: c };
  return c;
}

/** SQL literal for a value in generated statements (copy as INSERT etc). */
export function sqlLiteral(c: Cell, col?: ColumnMeta): string {
  if (c === null || isBlob(c)) return "NULL";
  if (col?.binary && /^0x[0-9a-f]*$/i.test(c)) return c === "0x" ? "''" : c;
  if (col?.numeric && c !== "" && !isNaN(Number(c))) return c;
  return sqlString(c);
}

export interface Stmt {
  text: string;
  from: number;
  to: number;
}

/** Splits SQL into statements with offsets (quotes, comments and DELIMITER aware). */
export function splitStatements(sql: string): Stmt[] {
  const out: Stmt[] = [];
  let delim = ";";
  let start = 0;
  let hasCode = false;
  let i = 0;
  const n = sql.length;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const text = raw.trim();
    if (hasCode && text) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text, from: start + lead, to: start + lead + text.length });
    }
    hasCode = false;
  };
  while (i < n) {
    const c = sql[i];
    if (!hasCode && /^delimiter[ \t]/i.test(sql.slice(i, i + 10))) {
      let j = i + 9;
      while (j < n && sql[j] !== "\n") j++;
      const d = sql.slice(i + 9, j).trim();
      if (d) delim = d;
      i = j;
      start = j;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      hasCode = true;
      i++;
      while (i < n) {
        const ch = sql[i++];
        if (ch === "\\" && c !== "`") i++;
        else if (ch === c) break;
      }
      continue;
    }
    if (c === "#" || (c === "-" && sql[i + 1] === "-" && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      if (sql[i + 2] === "!") hasCode = true;
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (sql.startsWith(delim, i)) {
      push(i);
      i += delim.length;
      start = i;
      continue;
    }
    if (!/\s/.test(c)) hasCode = true;
    i++;
  }
  push(n);
  return out;
}

export function statementAt(sql: string, pos: number): Stmt | undefined {
  const stmts = splitStatements(sql);
  return (
    stmts.find((s) => pos >= s.from && pos <= s.to) ??
    // Cursor sits between statements: take the one just before it.
    [...stmts].reverse().find((s) => s.to <= pos) ??
    stmts[0]
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Asks for a path to save to: native dialog in Tauri, text prompt in the browser. */
export async function pickSavePath(defaultName: string, ext: string[]): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save({ defaultPath: defaultName, filters: [{ name: ext.join("/").toUpperCase(), extensions: ext }] });
  }
  return askText({ title: "保存到文件", label: "文件路径", value: `/tmp/${defaultName}` });
}

export async function pickOpenPath(ext: string[]): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ multiple: false, filters: [{ name: ext.join("/").toUpperCase(), extensions: ext }] });
    return typeof r === "string" ? r : null;
  }
  return askText({ title: "选择文件", label: "文件路径", value: "/tmp/" });
}

export function resultToCsv(columns: ColumnMeta[], rows: Cell[][]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [columns.map((c) => esc(c.name)).join(",")];
  for (const r of rows) lines.push(r.map((c) => esc(cellText(c))).join(","));
  return "﻿" + lines.join("\n") + "\n";
}

export function resultToJson(columns: ColumnMeta[], rows: Cell[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, isBlob(r[i]) ? null : r[i]]))),
    null,
    2,
  );
}

export function resultToInserts(table: string, columns: ColumnMeta[], rows: Cell[][]): string {
  const cols = columns.map((c) => qi(c.name)).join(", ");
  return rows
    .map((r) => `INSERT INTO ${qi(table)} (${cols}) VALUES (${r.map((c, i) => sqlLiteral(c, columns[i])).join(", ")});`)
    .join("\n");
}
