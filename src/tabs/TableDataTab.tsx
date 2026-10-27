import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileDown,
  Filter,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { designTable } from "../actions";
import { api, errorText } from "../api";
import { DataGrid } from "../components/DataGrid";
import { useHotkey } from "../hooks";
import { useStore } from "../store";
import type { Cell, RowChange, TableData, TableStructure, Tab } from "../types";
import { confirmDialog, toast } from "../ui";
import { formatMs, isBlob, qi, sqlLiteral, toInput } from "../utils";

type TableTabT = Extract<Tab, { kind: "table" }>;

const PAGE_SIZES = [100, 500, 1000, 5000];

function parseEnum(columnType: string): string[] | undefined {
  const m = /^(enum|set)\((.*)\)$/i.exec(columnType);
  if (!m) return undefined;
  return [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
}

export function TableDataTab({ tab, active }: { tab: TableTabT; active: boolean }) {
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(1000);
  const [filterInput, setFilterInput] = useState("");
  const [orderInput, setOrderInput] = useState("");
  const [filter, setFilter] = useState("");
  const [orderBy, setOrderBy] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [edits, setEdits] = useState<Record<string, Cell>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState<(Cell | undefined)[][]>([]);
  const [selRows, setSelRows] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const dirty = Object.keys(edits).length > 0 || deleted.size > 0 || inserted.length > 0;
  useEffect(() => useStore.getState().setDirty(tab.id, dirty), [dirty, tab.id]);

  const clearEdits = () => {
    setEdits({});
    setDeleted(new Set());
    setInserted([]);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [st, d] = await Promise.all([
        api.tableStructure(tab.connId, tab.db, tab.table),
        api.fetchTableData(tab.connId, tab.db, tab.table, { offset: page * pageSize, limit: pageSize, filter, orderBy }),
      ]);
      setStructure(st);
      setData(d);
      clearEdits();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [tab.connId, tab.db, tab.table, page, pageSize, filter, orderBy]);

  useEffect(() => {
    load();
  }, [load]);

  const guard = async () => !dirty || (await confirmDialog({ title: "放弃更改", message: "当前有未保存的更改，确定要放弃吗？", danger: true, okText: "放弃" }));

  const n = data?.rows.length ?? 0;
  const columns = data?.columns ?? [];
  const readOnly = tab.isView;

  const getCell = (r: number, c: number): Cell | undefined => {
    if (r >= n) return inserted[r - n]?.[c];
    const k = `${r}:${c}`;
    return k in edits ? edits[k] : data!.rows[r][c];
  };

  const rowStatus = (r: number) => {
    if (r >= n) return "new" as const;
    if (deleted.has(r)) return "deleted" as const;
    for (let c = 0; c < columns.length; c++) if (`${r}:${c}` in edits) return "modified" as const;
    return undefined;
  };

  const onEdit = (r: number, c: number, v: Cell) => {
    if (r >= n) {
      setInserted((rows) => rows.map((row, i) => (i === r - n ? row.map((x, j) => (j === c ? v : x)) : row)));
      return;
    }
    const orig = data!.rows[r][c];
    setEdits((e) => {
      const next = { ...e };
      if (v === orig) delete next[`${r}:${c}`];
      else next[`${r}:${c}`] = v;
      return next;
    });
  };

  const options = useMemo(
    () =>
      columns.map((col) => {
        const d = structure?.columns.find((x) => x.name === col.name);
        return d ? parseEnum(d.columnType) : undefined;
      }),
    [columns, structure],
  );

  const addRow = () => setInserted((rows) => [...rows, columns.map(() => undefined)]);

  const deleteRows = (rows: number[]) => {
    const newIdx = rows.filter((r) => r >= n).map((r) => r - n);
    if (newIdx.length) setInserted((ins) => ins.filter((_, i) => !newIdx.includes(i)));
    setDeleted((d) => {
      const next = new Set(d);
      for (const r of rows) if (r < n) next.add(r);
      return next;
    });
    // Row indexes shift when new rows are removed, so drop the grid selection.
    setReloadKey((k) => k + 1);
  };

  const keyFor = (r: number): [string, ReturnType<typeof toInput>][] => {
    const pk = structure?.primaryKey ?? [];
    const keyCols = pk.length
      ? pk.map((name) => columns.findIndex((c) => c.name === name)).filter((i) => i >= 0)
      : columns.map((_, i) => i).filter((i) => !isBlob(data!.rows[r][i]));
    return keyCols.map((i) => [columns[i].name, toInput(data!.rows[r][i], columns[i])]);
  };

  const save = async () => {
    if (!dirty || saving || !data) return;
    const changes: RowChange[] = [];
    for (const r of [...deleted].sort((a, b) => a - b)) changes.push({ kind: "delete", key: keyFor(r) });
    const byRow = new Map<number, [string, ReturnType<typeof toInput>][]>();
    for (const [k, v] of Object.entries(edits)) {
      const [r, c] = k.split(":").map(Number);
      if (deleted.has(r)) continue;
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push([columns[c].name, toInput(v, columns[c])]);
    }
    for (const [r, values] of byRow) changes.push({ kind: "update", key: keyFor(r), values });
    for (const row of inserted) {
      const values = row
        .map((v, c) => [c, v] as const)
        .filter(([, v]) => v !== undefined)
        .map(([c, v]) => [columns[c].name, toInput(v as Cell, columns[c])] as [string, ReturnType<typeof toInput>]);
      changes.push({ kind: "insert", values });
    }
    setSaving(true);
    try {
      const res = await api.applyChanges(tab.connId, tab.db, tab.table, changes);
      toast(`已保存，影响 ${res.affected} 行`, "success");
      clearEdits();
      await load();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  const onSaveKey = useCallback(() => saveRef.current(), []);
  useHotkey("s", onSaveKey, active && !readOnly);

  const applyFilter = async () => {
    if (!(await guard())) return;
    setPage(0);
    setFilter(filterInput.trim());
    setOrderBy(orderInput.trim());
  };

  const onSort = async (c: number) => {
    if (!(await guard())) return;
    const next = sort?.col !== c ? { col: c, dir: "asc" as const } : sort.dir === "asc" ? { col: c, dir: "desc" as const } : null;
    setSort(next);
    const ob = next ? `${qi(columns[c].name)} ${next.dir.toUpperCase()}` : "";
    setOrderInput(ob);
    setOrderBy(ob);
    setPage(0);
  };

  const goto = async (p: number) => {
    if (!(await guard())) return;
    setPage(p);
  };

  const total = data?.total ?? null;
  const pages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const pkMissing = structure && structure.primaryKey.length === 0 && !readOnly;

  const extraMenu = (r: number, c: number, rows: number[]) => {
    const v = getCell(r, c);
    const items = [
      {
        label: "筛选此值",
        icon: <Filter size={14} />,
        disabled: v === undefined || isBlob(v ?? null),
        onClick: () => {
          const cond = v === null ? `${qi(columns[c].name)} IS NULL` : `${qi(columns[c].name)} = ${sqlLiteral(v ?? null, columns[c])}`;
          setFilterInput(cond);
          setShowFilter(true);
          setPage(0);
          setFilter(cond);
        },
      },
    ];
    if (!readOnly)
      items.push(
        { label: "新增记录", icon: <Plus size={14} />, disabled: false, onClick: addRow },
        { label: rows.length > 1 ? `删除 ${rows.length} 条记录` : "删除记录", icon: <Minus size={14} />, disabled: false, onClick: () => deleteRows(rows) },
      );
    return items;
  };

  return (
    <div className="data-tab">
      <div className="toolbar small">
        {!readOnly && (
          <>
            <button className="tbtn" onClick={addRow} title="新增记录">
              <Plus size={14} />
            </button>
            <button className="tbtn" onClick={() => deleteRows(selRows)} disabled={!selRows.length} title="删除记录">
              <Minus size={14} />
            </button>
            <button className="tbtn" onClick={save} disabled={!dirty || saving} title="保存（⌘S）">
              {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            </button>
            <button className="tbtn" onClick={clearEdits} disabled={!dirty} title="放弃更改">
              <Undo2 size={14} />
            </button>
            <span className="tsep" />
          </>
        )}
        <button className="tbtn" onClick={async () => (await guard()) && load()} title="刷新">
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
        <button className={"tbtn" + (showFilter ? " on" : "")} onClick={() => setShowFilter((x) => !x)}>
          <Filter size={14} /> 筛选
        </button>
        {!readOnly && (
          <button className="tbtn" onClick={() => designTable(tab.connId, tab.db, tab.table)}>
            <Pencil size={14} /> 设计表
          </button>
        )}
        <button className="tbtn" onClick={() => useStore.setState({ modal: { kind: "exportTable", connId: tab.connId, db: tab.db, table: tab.table } })}>
          <FileDown size={14} /> 导出
        </button>
        <span className="tspacer" />
        {pkMissing && <span className="warn small">此表没有主键，将使用全部列定位记录</span>}
        {dirty && <span className="dirty-badge">未保存</span>}
      </div>
      {showFilter && (
        <div className="filter-bar">
          <Filter size={13} />
          <span>WHERE</span>
          <input
            value={filterInput}
            placeholder="例如: status = 'paid' AND amount > 100"
            onChange={(e) => setFilterInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilter()}
          />
          <ArrowUpDown size={13} />
          <span>ORDER BY</span>
          <input
            className="short"
            value={orderInput}
            placeholder="例如: id DESC"
            onChange={(e) => setOrderInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilter()}
          />
          <button className="btn small primary" onClick={applyFilter}>
            应用
          </button>
          <button
            className="btn small"
            onClick={async () => {
              if (!(await guard())) return;
              setFilterInput("");
              setOrderInput("");
              setFilter("");
              setOrderBy("");
              setSort(null);
              setPage(0);
            }}
          >
            清除
          </button>
        </div>
      )}
      <div className="data-body">
        {error ? (
          <div className="error-box">{error}</div>
        ) : data ? (
          <DataGrid
            columns={columns}
            rowCount={n + inserted.length}
            getCell={getCell}
            rowStatus={rowStatus}
            isModified={(r, c) => r < n && `${r}:${c}` in edits}
            editable={!readOnly}
            onEdit={onEdit}
            sort={sort}
            onSort={onSort}
            rowOffset={page * pageSize}
            tableName={tab.table}
            options={options}
            extraMenu={extraMenu}
            onSelectionChange={(rows) => setSelRows(rows)}
            resetKey={reloadKey}
          />
        ) : (
          <div className="empty-hint">
            <Loader2 size={16} className="spin" /> 加载中…
          </div>
        )}
      </div>
      <div className="statusline">
        <code className="sql-preview" title={data?.sql}>
          {data?.sql}
        </code>
        <span className="tspacer" />
        {data && <span>{formatMs(data.elapsedMs)}</span>}
        {data && (
          <span>
            {n ? `第 ${page * pageSize + 1}-${page * pageSize + n} 条` : "无记录"}
            {total != null && `，共 ${total} 条`}
          </span>
        )}
        <div className="pager">
          <button className="tbtn" disabled={page === 0} onClick={() => goto(0)}>
            <ChevronsLeft size={14} />
          </button>
          <button className="tbtn" disabled={page === 0} onClick={() => goto(page - 1)}>
            <ChevronLeft size={14} />
          </button>
          <span>
            {page + 1}
            {pages ? ` / ${pages}` : ""}
          </span>
          <button className="tbtn" disabled={pages != null ? page + 1 >= pages : n < pageSize} onClick={() => goto(page + 1)}>
            <ChevronRight size={14} />
          </button>
          <button className="tbtn" disabled={pages == null || page + 1 >= pages} onClick={() => pages && goto(pages - 1)}>
            <ChevronsRight size={14} />
          </button>
          <select
            value={pageSize}
            onChange={async (e) => {
              if (!(await guard())) return;
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} 条/页
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
