import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Copy, Eye, KeyRound, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from "react";
import type { Cell, ColumnMeta } from "../types";
import { cellDisplay, cellText, copyText, isBlob, qi, sqlLiteral } from "../utils";
import { showMenu, type MenuItem } from "./ContextMenu";
import { Modal } from "./Modal";

const ROW_H = 24;
const HEADER_H = 30;
const RN_W = 52;

export type RowStatus = "new" | "modified" | "deleted" | undefined;

export interface DataGridProps {
  columns: ColumnMeta[];
  rowCount: number;
  getCell: (r: number, c: number) => Cell | undefined;
  rowStatus?: (r: number) => RowStatus;
  isModified?: (r: number, c: number) => boolean;
  editable?: boolean;
  onEdit?: (r: number, c: number, v: Cell) => void;
  sort?: { col: number; dir: "asc" | "desc" } | null;
  onSort?: (col: number) => void;
  rowOffset?: number;
  tableName?: string;
  /** Suggestions shown while editing a column (e.g. ENUM values). */
  options?: (string[] | undefined)[];
  extraMenu?: (r: number, c: number, rows: number[]) => MenuItem[];
  onSelectionChange?: (rows: number[], cell: { r: number; c: number } | null) => void;
  /** Bumped by the parent to clear the selection (e.g. after reload). */
  resetKey?: unknown;
}

/** Rough display width in "latin character" units; wide (CJK) characters count double. */
function textUnits(s: string) {
  let n = 0;
  for (const ch of s.slice(0, 60)) n += /[\u1100-\uffff]/.test(ch) ? 2 : 1;
  return n;
}

function initialWidths(columns: ColumnMeta[], rowCount: number, getCell: DataGridProps["getCell"]) {
  return columns.map((col, c) => {
    let w = Math.max(col.name.length * 8 + 34, col.typeName.length * 6 + 30);
    const n = Math.min(rowCount, 60);
    for (let r = 0; r < n; r++) {
      const t = cellDisplay(getCell(r, c));
      w = Math.max(w, Math.min(textUnits(t), 48) * 7.6 + 24);
    }
    return Math.max(64, Math.min(w, 340));
  });
}

export function DataGrid(p: DataGridProps) {
  const { columns, rowCount, getCell } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rowCount, getCell));
  const [cell, setCell] = useState<{ r: number; c: number } | null>(null);
  const [rowSel, setRowSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string; typed?: boolean } | null>(null);
  const [textEdit, setTextEdit] = useState<{ r: number; c: number; value: string; readOnly: boolean } | null>(null);

  const colSig = columns.map((c) => c.name + ":" + c.typeName).join("|");
  useEffect(() => {
    setWidths(initialWidths(columns, rowCount, getCell));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colSig]);

  useEffect(() => {
    setCell(null);
    setRowSel(new Set());
    setEditing(null);
  }, [p.resetKey, colSig]);

  const selectedRows = useMemo(() => {
    if (rowSel.size) return [...rowSel].sort((a, b) => a - b);
    return cell ? [cell.r] : [];
  }, [rowSel, cell]);

  useEffect(() => {
    p.onSelectionChange?.(selectedRows, cell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRows, cell]);

  const totalW = RN_W + widths.reduce((a, b) => a + b, 0);
  const virt = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const colLeft = (c: number) => RN_W + widths.slice(0, c).reduce((a, b) => a + b, 0);

  const scrollTo = (r: number, c: number) => {
    virt.scrollToIndex(r, { align: "auto" });
    const el = scrollRef.current;
    if (!el) return;
    const left = colLeft(c);
    const right = left + widths[c];
    if (left - RN_W < el.scrollLeft) el.scrollLeft = left - RN_W;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  };

  const canEdit = (r: number, c: number) =>
    !!p.editable && p.rowStatus?.(r) !== "deleted" && !isBlob(getCell(r, c) ?? null) && c < columns.length;

  const startEdit = (r: number, c: number, initial?: string) => {
    if (!canEdit(r, c)) return;
    const v = getCell(r, c);
    const text = initial ?? (typeof v === "string" ? v : "");
    if (initial === undefined && typeof v === "string" && (v.includes("\n") || v.length > 200)) {
      setTextEdit({ r, c, value: v, readOnly: false });
      return;
    }
    setEditing({ r, c, value: text, typed: initial !== undefined });
  };

  const commitEdit = (next?: { r: number; c: number }) => {
    if (!editing) return;
    const { r, c, value } = editing;
    const old = getCell(r, c);
    // Leaving a NULL/default cell empty keeps it as it was.
    const unchanged = typeof old === "string" ? value === old : value === "";
    if (!unchanged) p.onEdit?.(r, c, value);
    setEditing(null);
    if (next) {
      setCell(next);
      scrollTo(next.r, next.c);
    }
    scrollRef.current?.focus();
  };

  const selectionText = () => {
    if (rowSel.size) {
      return [...rowSel]
        .sort((a, b) => a - b)
        .map((r) => columns.map((_, c) => cellText(getCell(r, c))).join("\t"))
        .join("\n");
    }
    return cell ? cellText(getCell(cell.r, cell.c)) : null;
  };

  const copySelection = () => {
    const text = selectionText();
    if (text !== null) copyText(text);
  };

  const onKeyDown = (e: RKeyboardEvent) => {
    if (editing || textEdit) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setRowSel(new Set(Array.from({ length: rowCount }, (_, i) => i)));
      return;
    }
    if (!cell) {
      if (rowCount && columns.length && e.key.startsWith("Arrow")) setCell({ r: 0, c: 0 });
      return;
    }
    let { r, c } = cell;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_H) - 2);
    switch (e.key) {
      case "ArrowUp": r--; break;
      case "ArrowDown": r++; break;
      case "ArrowLeft": c--; break;
      case "ArrowRight": c++; break;
      case "Tab": c += e.shiftKey ? -1 : 1; break;
      case "PageUp": r -= page; break;
      case "PageDown": r += page; break;
      case "Home": c = 0; if (mod) r = 0; break;
      case "End": c = columns.length - 1; if (mod) r = rowCount - 1; break;
      case "Enter":
      case "F2":
        e.preventDefault();
        startEdit(r, c);
        return;
      case "Escape":
        setRowSel(new Set());
        return;
      default:
        if (e.key.length === 1 && !mod && !e.altKey && canEdit(r, c)) {
          e.preventDefault();
          startEdit(r, c, e.key);
        }
        return;
    }
    e.preventDefault();
    r = Math.max(0, Math.min(rowCount - 1, r));
    c = Math.max(0, Math.min(columns.length - 1, c));
    setCell({ r, c });
    setRowSel(new Set());
    scrollTo(r, c);
  };

  const startResize = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c];
    const move = (ev: MouseEvent) => {
      const w = Math.max(40, startW + ev.clientX - startX);
      setWidths((ws) => ws.map((x, i) => (i === c ? w : x)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-col");
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const clickRowHeader = (e: React.MouseEvent, r: number) => {
    const next = new Set(e.metaKey || e.ctrlKey ? rowSel : []);
    if (e.shiftKey && anchor !== null) {
      for (let i = Math.min(anchor, r); i <= Math.max(anchor, r); i++) next.add(i);
    } else if ((e.metaKey || e.ctrlKey) && next.has(r)) {
      next.delete(r);
    } else {
      next.add(r);
      setAnchor(r);
    }
    setRowSel(next);
    setCell({ r, c: cell?.c ?? 0 });
  };

  const cellMenu = (e: React.MouseEvent, r: number, c: number) => {
    if (!rowSel.has(r)) {
      setRowSel(new Set());
      setCell({ r, c });
    }
    const rows = rowSel.has(r) ? [...rowSel].sort((a, b) => a - b) : [r];
    const v = getCell(r, c);
    const items: MenuItem[] = [
      { label: "复制", icon: <Copy size={14} />, shortcut: "⌘C", onClick: () => copyText(cellText(v)) },
      {
        label: rows.length > 1 ? `复制 ${rows.length} 行` : "复制行",
        onClick: () => copyText(rows.map((r) => columns.map((_, c) => cellText(getCell(r, c))).join("\t")).join("\n")),
      },
      {
        label: "复制为 INSERT 语句",
        onClick: () =>
          copyText(
            rows
              .map(
                (r) =>
                  `INSERT INTO ${qi(p.tableName || columns[0]?.orgTable || "table")} (${columns.map((c) => qi(c.name)).join(", ")}) VALUES (${columns
                    .map((col, c) => sqlLiteral(getCell(r, c) ?? null, col))
                    .join(", ")});`,
              )
              .join("\n"),
          ),
      },
      { label: "复制列名", onClick: () => copyText(columns[c].name) },
      { separator: true },
      {
        label: canEdit(r, c) ? "编辑值…" : "查看值…",
        icon: canEdit(r, c) ? <Pencil size={14} /> : <Eye size={14} />,
        disabled: v === undefined || isBlob(v ?? null),
        onClick: () => setTextEdit({ r, c, value: typeof v === "string" ? v : "", readOnly: !canEdit(r, c) }),
      },
    ];
    if (p.editable) {
      items.push(
        { label: "设置为 NULL", disabled: !canEdit(r, c) || columns[c].notNull, onClick: () => p.onEdit?.(r, c, null) },
        { label: "设置为空字符串", disabled: !canEdit(r, c), onClick: () => p.onEdit?.(r, c, "") },
      );
    }
    const extra = p.extraMenu?.(r, c, rows);
    if (extra?.length) items.push({ separator: true }, ...extra);
    showMenu(e, items);
  };

  return (
    <div
      className="grid"
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={(e) => {
        // Native Edit > Copy (menu accelerator) lands here instead of keydown.
        if (editing || textEdit) return;
        const text = selectionText();
        if (text === null) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
      }}
    >
      <div style={{ width: totalW, height: HEADER_H + rowCount * ROW_H, position: "relative" }}>
        <div className="grid-header" style={{ width: totalW, height: HEADER_H }}>
          <div className="grid-corner" style={{ width: RN_W }} onClick={() => setRowSel(new Set(Array.from({ length: rowCount }, (_, i) => i)))} />
          {columns.map((col, c) => (
            <div
              key={c}
              className={"grid-hcell" + (p.onSort ? " sortable" : "")}
              style={{ width: widths[c] }}
              title={`${col.name}\n${col.typeName}${col.unsigned ? " UNSIGNED" : ""}${col.notNull ? " NOT NULL" : ""}${col.orgTable ? `\n来自 ${col.orgTable}` : ""}`}
              onClick={() => p.onSort?.(c)}
            >
              <span className="grid-hname">
                {col.pk && <KeyRound size={11} className="pk-icon" />}
                {col.name}
              </span>
              {p.sort?.col === c && (p.sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              <div className="col-resizer" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
        </div>
        {virt.getVirtualItems().map((vi) => {
          const r = vi.index;
          const status = p.rowStatus?.(r);
          const rowSelected = rowSel.has(r);
          return (
            <div
              key={r}
              className={"grid-row" + (status ? ` row-${status}` : "") + (rowSelected ? " row-selected" : "") + (r % 2 ? " odd" : "")}
              style={{ top: HEADER_H + vi.start, width: totalW, height: ROW_H }}
            >
              <div
                className={"grid-rn" + (cell?.r === r ? " current" : "")}
                style={{ width: RN_W }}
                onMouseDown={(e) => clickRowHeader(e, r)}
                onContextMenu={(e) => cellMenu(e, r, cell?.c ?? 0)}
              >
                {status === "new" ? "*" : (p.rowOffset ?? 0) + r + 1}
              </div>
              {columns.map((col, c) => {
                const active = cell?.r === r && cell?.c === c;
                if (editing && editing.r === r && editing.c === c) {
                  const opts = p.options?.[c];
                  return (
                    <div key={c} className="grid-cell editing" style={{ width: widths[c] }}>
                      <input
                        autoFocus
                        onFocus={(e) => !editing.typed && e.currentTarget.select()}
                        value={editing.value}
                        list={opts ? `opts-${c}` : undefined}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                        onBlur={() => commitEdit()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") commitEdit({ r: Math.min(r + 1, rowCount - 1), c });
                          else if (e.key === "Tab") {
                            e.preventDefault();
                            commitEdit({ r, c: Math.max(0, Math.min(columns.length - 1, c + (e.shiftKey ? -1 : 1))) });
                          } else if (e.key === "Escape") {
                            setEditing(null);
                            scrollRef.current?.focus();
                          }
                        }}
                      />
                      {opts && (
                        <datalist id={`opts-${c}`}>
                          {opts.map((o) => (
                            <option key={o} value={o} />
                          ))}
                        </datalist>
                      )}
                    </div>
                  );
                }
                const v = getCell(r, c);
                const cls =
                  "grid-cell" +
                  (v === null ? " null" : v === undefined ? " default" : isBlob(v) ? " blob" : "") +
                  (col.numeric ? " num" : "") +
                  (active ? " active" : "") +
                  (p.isModified?.(r, c) ? " modified" : "");
                return (
                  <div
                    key={c}
                    className={cls}
                    style={{ width: widths[c] }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      setCell({ r, c });
                      if (!e.metaKey && !e.ctrlKey) setRowSel(new Set());
                    }}
                    onDoubleClick={() => startEdit(r, c)}
                    onContextMenu={(e) => cellMenu(e, r, c)}
                  >
                    {v === undefined ? (status === "new" ? "(默认)" : "") : cellDisplay(v)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {textEdit && (
        <Modal
          title={`${textEdit.readOnly ? "查看" : "编辑"} ${columns[textEdit.c]?.name}`}
          width={640}
          onClose={() => setTextEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => copyText(textEdit.value)}>
                复制
              </button>
              {!textEdit.readOnly && textEdit.value.trim().startsWith("{") && (
                <button
                  className="btn"
                  onClick={() => {
                    try {
                      setTextEdit({ ...textEdit, value: JSON.stringify(JSON.parse(textEdit.value), null, 2) });
                    } catch {
                      /* not JSON */
                    }
                  }}
                >
                  格式化 JSON
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setTextEdit(null)}>
                {textEdit.readOnly ? "关闭" : "取消"}
              </button>
              {!textEdit.readOnly && (
                <button
                  className="btn primary"
                  onClick={() => {
                    p.onEdit?.(textEdit.r, textEdit.c, textEdit.value);
                    setTextEdit(null);
                  }}
                >
                  确定
                </button>
              )}
            </>
          }
        >
          <textarea
            className="text-editor"
            value={textEdit.value}
            readOnly={textEdit.readOnly}
            autoFocus
            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          />
        </Modal>
      )}
    </div>
  );
}
