import { Code2, Database, Eye, FileDown, Loader2, Pencil, Plug, Plus, RefreshCw, Search, Server, SquareFunction, Table2, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { designTable, dropObject, openTable, refreshNode, viewDdl } from "../actions";
import { showMenu } from "../components/ContextMenu";
import { objKey, useStore } from "../store";
import type { ObjectKind } from "../types";
import { formatBytes } from "../utils";

type Group = "tables" | "views" | "routines" | "triggers";

interface Item {
  name: string;
  cells: (string | number | null)[];
  sortKeys: (string | number | null)[];
  kind: ObjectKind;
}

const HEADERS: Record<Group, string[]> = {
  tables: ["名", "行", "数据长度", "索引长度", "引擎", "创建日期", "修改日期", "排序规则", "注释"],
  views: ["名", "创建日期", "注释"],
  routines: ["名", "类型", "返回类型", "创建日期", "修改日期", "注释"],
  triggers: ["名", "表", "时机", "事件"],
};

export function ObjectsPanel() {
  const sel = useStore((s) => s.selected);
  const connections = useStore((s) => s.connections);
  const connState = useStore((s) => (sel ? s.conn[sel.connId] : undefined));

  if (!sel) {
    return (
      <div className="welcome">
        <div className="welcome-inner">
          <Database size={48} strokeWidth={1.2} className="welcome-logo" />
          <h2>MySQL Studio</h2>
          <p>轻量的 MySQL 图形化管理工具</p>
          <button className="btn primary" onClick={() => useStore.setState({ connDialog: { config: null } })}>
            <Plus size={14} /> 新建连接
          </button>
          {connections.length > 0 && (
            <div className="conn-cards">
              {connections.map((c) => (
                <button
                  key={c.id}
                  className="conn-card"
                  onDoubleClick={() => useStore.getState().openConnection(c.id)}
                  onClick={() => useStore.getState().select({ kind: "conn", connId: c.id })}
                >
                  <Server size={22} style={{ color: c.color || "var(--accent)" }} />
                  <div>
                    <b>{c.name}</b>
                    <span>
                      {c.user}@{c.host}:{c.port}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!sel.db) {
    const cfg = connections.find((c) => c.id === sel.connId);
    const connected = connState?.status === "connected";
    return (
      <div className="welcome">
        <div className="welcome-inner">
          <Server size={40} strokeWidth={1.2} style={{ color: cfg?.color || "var(--accent)" }} />
          <h2>{cfg?.name}</h2>
          <p>
            {cfg?.user}@{cfg?.host}:{cfg?.port}
            {connState?.server && ` · MySQL ${connState.server.version}`}
          </p>
          {!connected ? (
            <button className="btn primary" disabled={connState?.status === "connecting"} onClick={() => useStore.getState().openConnection(sel.connId)}>
              {connState?.status === "connecting" ? <Loader2 size={14} className="spin" /> : <Plug size={14} />} 打开连接
            </button>
          ) : (
            <div className="conn-cards">
              {connState?.databases?.map((db) => (
                <button
                  key={db}
                  className="conn-card db"
                  onDoubleClick={() => {
                    const s = useStore.getState();
                    s.select({ kind: "db", connId: sel.connId, db });
                    s.loadObjects(sel.connId, db);
                    s.setExpanded(`d:${objKey(sel.connId, db)}`, true);
                  }}
                >
                  <Database size={18} className="ic-db" />
                  <div>
                    <b>{db}</b>
                  </div>
                </button>
              ))}
            </div>
          )}
          {connState?.status === "error" && <div className="error-box">{connState.error}</div>}
        </div>
      </div>
    );
  }

  return <ObjectList connId={sel.connId} db={sel.db} group={(sel.group as Group) ?? (sel.kind === "view" ? "views" : sel.kind === "routine" ? "routines" : sel.kind === "trigger" ? "triggers" : "tables")} selectedName={sel.name} />;
}

function ObjectList({ connId, db, group: initialGroup, selectedName }: { connId: string; db: string; group: Group; selectedName?: string }) {
  const objs = useStore((s) => s.objects[objKey(connId, db)]);
  const loading = useStore((s) => !!s.loadingObjects[objKey(connId, db)]);
  const [groupOverride, setGroupOverride] = useState<{ base: Group; g: Group } | null>(null);
  const group = groupOverride && groupOverride.base === initialGroup ? groupOverride.g : initialGroup;
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: 0, dir: 1 });
  const [picked, setPicked] = useState<string | null>(null);
  const current = picked ?? selectedName ?? null;

  const items: Item[] = useMemo(() => {
    if (!objs) return [];
    let list: Item[];
    if (group === "tables")
      list = objs.tables.map((t) => ({
        name: t.name,
        kind: "TABLE" as ObjectKind,
        cells: [t.name, t.rows, formatBytes(t.dataLength), formatBytes(t.indexLength), t.engine, t.createTime, t.updateTime, t.collation, t.comment],
        sortKeys: [t.name, t.rows, t.dataLength, t.indexLength, t.engine, t.createTime, t.updateTime, t.collation, t.comment],
      }));
    else if (group === "views")
      list = objs.views.map((t) => ({ name: t.name, kind: "VIEW" as ObjectKind, cells: [t.name, t.createTime, t.comment], sortKeys: [t.name, t.createTime, t.comment] }));
    else if (group === "routines")
      list = objs.routines.map((r) => {
        const cells = [r.name, r.kind === "PROCEDURE" ? "过程" : "函数", r.returns, r.created, r.modified, r.comment];
        return { name: r.name, kind: r.kind as ObjectKind, cells, sortKeys: cells };
      });
    else
      list = objs.triggers.map((t) => {
        const cells = [t.name, t.table, t.timing, t.event];
        return { name: t.name, kind: "TRIGGER" as ObjectKind, cells, sortKeys: cells };
      });
    const f = filter.trim().toLowerCase();
    if (f) list = list.filter((i) => i.name.toLowerCase().includes(f));
    return list.sort((a, b) => {
      const x = a.sortKeys[sort.col];
      const y = b.sortKeys[sort.col];
      if (x === y) return 0;
      if (x === null || x === undefined) return -sort.dir;
      if (y === null || y === undefined) return sort.dir;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [objs, group, filter, sort]);

  const open = (it: Item) => {
    if (it.kind === "TABLE") openTable(connId, db, it.name);
    else if (it.kind === "VIEW") openTable(connId, db, it.name, true);
    else viewDdl(connId, db, it.name, it.kind);
  };
  const cur = items.find((i) => i.name === current);

  const rowMenu = (e: React.MouseEvent, it: Item) => {
    setPicked(it.name);
    showMenu(e, [
      { label: it.kind === "TABLE" ? "打开表" : it.kind === "VIEW" ? "打开视图" : "查看定义", onClick: () => open(it) },
      ...(it.kind === "TABLE" ? [{ label: "设计表", icon: <Pencil size={14} />, onClick: () => designTable(connId, db, it.name) }] : []),
      ...(it.kind === "TABLE" || it.kind === "VIEW" ? [{ label: "查看 DDL", icon: <Code2 size={14} />, onClick: () => viewDdl(connId, db, it.name, it.kind) }] : []),
      ...(it.kind === "TABLE" || it.kind === "VIEW"
        ? [{ label: "导出数据…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "exportTable", connId, db, table: it.name } }) }]
        : []),
      { separator: true },
      { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, it.name, it.kind) },
    ]);
  };

  return (
    <div className="objects-panel">
      <div className="toolbar small">
        <button className="tbtn" disabled={!cur} onClick={() => cur && open(cur)}>
          <Table2 size={14} /> 打开
        </button>
        {group === "tables" && (
          <>
            <button className="tbtn" disabled={!cur} onClick={() => cur && designTable(connId, db, cur.name)}>
              <Pencil size={14} /> 设计表
            </button>
            <button className="tbtn" onClick={() => designTable(connId, db, null)}>
              <Plus size={14} /> 新建表
            </button>
          </>
        )}
        <button className="tbtn" disabled={!cur} onClick={() => cur && dropObject(connId, db, cur.name, cur.kind)}>
          <Trash2 size={14} /> 删除
        </button>
        {(group === "tables" || group === "views") && (
          <button className="tbtn" disabled={!cur} onClick={() => cur && useStore.setState({ modal: { kind: "exportTable", connId, db, table: cur.name } })}>
            <FileDown size={14} /> 导出
          </button>
        )}
        <button className="tbtn" onClick={() => refreshNode(connId, db)}>
          <RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新
        </button>
        <span className="tsep" />
        <div className="seg">
          {(
            [
              ["tables", <Table2 size={13} />, "表", objs?.tables.length],
              ["views", <Eye size={13} />, "视图", objs?.views.length],
              ["routines", <SquareFunction size={13} />, "函数", objs?.routines.length],
              ["triggers", <Zap size={13} />, "触发器", objs?.triggers.length],
            ] as [Group, React.ReactNode, string, number | undefined][]
          ).map(([g, icon, label, count]) => (
            <button key={g} className={group === g ? "on" : ""} onClick={() => setGroupOverride({ base: initialGroup, g })}>
              {icon} {label}
              {count !== undefined && <span className="count">{count}</span>}
            </button>
          ))}
        </div>
        <span className="tspacer" />
        <div className="search-input">
          <Search size={13} />
          <input placeholder="搜索" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="objects-table-wrap">
        {!objs ? (
          <div className="empty-hint">
            <Loader2 size={16} className="spin" /> 加载中…
          </div>
        ) : (
          <table className="objects-table">
            <thead>
              <tr>
                {HEADERS[group].map((h, i) => (
                  <th key={h} onClick={() => setSort((s) => ({ col: i, dir: s.col === i ? (-s.dir as 1 | -1) : 1 }))}>
                    {h}
                    {sort.col === i && (sort.dir === 1 ? " ▲" : " ▼")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.name}
                  className={it.name === current ? "sel" : ""}
                  onClick={() => setPicked(it.name)}
                  onDoubleClick={() => open(it)}
                  onContextMenu={(e) => rowMenu(e, it)}
                >
                  {it.cells.map((c, i) => (
                    <td key={i} className={typeof it.sortKeys[i] === "number" ? "num" : ""}>
                      {i === 0 && <span className="obj-icon">{group === "tables" ? <Table2 size={13} className="ic-table" /> : group === "views" ? <Eye size={13} className="ic-view" /> : group === "routines" ? <SquareFunction size={13} className="ic-func" /> : <Zap size={13} className="ic-trigger" />}</span>}
                      {c ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={HEADERS[group].length} className="empty-row">
                    没有对象
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <div className="statusline">
        <span>
          {db} · {items.length} 个对象
        </span>
      </div>
    </div>
  );
}
