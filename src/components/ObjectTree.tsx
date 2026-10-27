import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Eraser,
  Eye,
  FileDown,
  FileUp,
  Folder,
  Loader2,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SquareFunction,
  Table2,
  Terminal,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import { memo, useDeferredValue, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  copyName,
  designTable,
  dropDatabase,
  dropObject,
  duplicateTable,
  openServer,
  openTable,
  refreshNode,
  renameTable,
  truncateTable,
  viewDdl,
} from "../actions";
import { objKey, useStore, type TreeSel } from "../store";
import type { ConnectionConfig, ObjectKind } from "../types";
import { confirmDialog } from "../ui";
import { qi, qname } from "../utils";
import { showMenu, type MenuItem } from "./ContextMenu";

const ROW_H = 24;

type GroupId = "tables" | "views" | "routines" | "triggers";

const GROUPS: { id: GroupId; label: string; icon: ReactNode }[] = [
  { id: "tables", label: "表", icon: <Table2 size={14} className="ic-table" /> },
  { id: "views", label: "视图", icon: <Eye size={14} className="ic-view" /> },
  { id: "routines", label: "函数", icon: <SquareFunction size={14} className="ic-func" /> },
  { id: "triggers", label: "触发器", icon: <Zap size={14} className="ic-trigger" /> },
];

/** One visible row of the flattened tree. */
type Node =
  | { t: "conn"; key: string; cfg: ConnectionConfig; status?: string; error?: string; version?: string; expanded: boolean }
  | { t: "db"; key: string; connId: string; db: string; expanded: boolean; loading: boolean; loaded: boolean }
  | { t: "group"; key: string; connId: string; db: string; group: GroupId; count: number; expanded: boolean }
  | { t: "leaf"; key: string; connId: string; db: string; group: GroupId; name: string; kind?: string; title?: string };

const DEPTH = { conn: 0, db: 1, group: 2, leaf: 3 } as const;

/** Key of the tree node a selection points at (same format as `Node.key`). */
function selKey(s: TreeSel | null): string {
  if (!s) return "";
  switch (s.kind) {
    case "conn":
      return `c|${s.connId}`;
    case "db":
      return `d|${s.connId}|${s.db}`;
    case "group":
      return `g|${s.connId}|${s.db}|${s.group}`;
    default:
      return `l|${s.connId}|${s.db}|${s.kind}|${s.name}`;
  }
}

const leafKind = (g: GroupId) => (g === "tables" ? "table" : g === "views" ? "view" : g === "routines" ? "routine" : "trigger");
const groupKey = (connId: string, db: string, g: GroupId) => `g:${objKey(connId, db)}:${g}`;

function useNodes(filter: string): Node[] {
  const connections = useStore((s) => s.connections);
  const conn = useStore((s) => s.conn);
  const objects = useStore((s) => s.objects);
  const loading = useStore((s) => s.loadingObjects);
  const expanded = useStore((s) => s.expanded);

  return useMemo(() => {
    const out: Node[] = [];
    const f = filter.trim().toLowerCase();
    const match = (n: string) => n.toLowerCase().includes(f);
    for (const cfg of connections) {
      const st = conn[cfg.id];
      const connected = st?.status === "connected";
      const cExp = connected && !!expanded[`c:${cfg.id}`];
      out.push({ t: "conn", key: `c|${cfg.id}`, cfg, status: st?.status, error: st?.error, version: st?.server?.version, expanded: cExp });
      if (!cExp) continue;
      for (const db of st?.databases ?? []) {
        const k = objKey(cfg.id, db);
        const objs = objects[k];
        const lists = objs && {
          tables: f ? objs.tables.filter((t) => match(t.name)) : objs.tables,
          views: f ? objs.views.filter((t) => match(t.name)) : objs.views,
          routines: f ? objs.routines.filter((t) => match(t.name)) : objs.routines,
          triggers: f ? objs.triggers.filter((t) => match(t.name)) : objs.triggers,
        };
        const hits = lists ? lists.tables.length + lists.views.length + lists.routines.length + lists.triggers.length : 0;
        if (f && !match(db) && hits === 0) continue;
        const dExp = !!expanded[`d:${k}`] || (!!f && hits > 0);
        out.push({ t: "db", key: `d|${cfg.id}|${db}`, connId: cfg.id, db, expanded: dExp, loading: !!loading[k], loaded: !!objs });
        if (!dExp || !objs || !lists) continue;
        for (const g of GROUPS) {
          const items = lists[g.id] as { name: string; kind?: string; comment?: string; table?: string }[];
          if (f && items.length === 0) continue;
          const gExp = (expanded[groupKey(cfg.id, db, g.id)] ?? g.id === "tables") || !!f;
          out.push({
            t: "group",
            key: `g|${cfg.id}|${db}|${g.id}`,
            connId: cfg.id,
            db,
            group: g.id,
            count: (objs[g.id] as unknown[]).length,
            expanded: gExp,
          });
          if (!gExp) continue;
          const lk = leafKind(g.id);
          for (const it of items) {
            out.push({
              t: "leaf",
              key: `l|${cfg.id}|${db}|${lk}|${it.name}`,
              connId: cfg.id,
              db,
              group: g.id,
              name: it.name,
              kind: it.kind,
              title: it.comment || (it.table ? `ON ${it.table}` : undefined),
            });
          }
        }
      }
    }
    return out;
  }, [connections, conn, objects, loading, expanded, filter]);
}

// ---------- actions ----------

const st = useStore.getState;

function selectNode(n: Node) {
  switch (n.t) {
    case "conn":
      st().select({ kind: "conn", connId: n.cfg.id });
      break;
    case "db":
      st().select({ kind: "db", connId: n.connId, db: n.db });
      st().loadObjects(n.connId, n.db);
      break;
    case "group":
      st().select({ kind: "group", connId: n.connId, db: n.db, group: n.group });
      break;
    case "leaf":
      st().select({ kind: leafKind(n.group), connId: n.connId, db: n.db, name: n.name });
      break;
  }
}

async function toggleNode(n: Node, open?: boolean) {
  switch (n.t) {
    case "conn":
      if (n.status !== "connected") {
        if (open !== false) await st().openConnection(n.cfg.id);
        return;
      }
      st().setExpanded(`c:${n.cfg.id}`, open ?? !n.expanded);
      return;
    case "db": {
      const next = open ?? !n.expanded;
      if (next) await st().loadObjects(n.connId, n.db);
      st().setExpanded(`d:${objKey(n.connId, n.db)}`, next);
      return;
    }
    case "group":
      st().setExpanded(groupKey(n.connId, n.db, n.group), open ?? !n.expanded);
      return;
  }
}

function objKindOf(n: Extract<Node, { t: "leaf" }>): ObjectKind {
  return n.group === "tables" ? "TABLE" : n.group === "views" ? "VIEW" : n.group === "triggers" ? "TRIGGER" : (n.kind as ObjectKind);
}

function activate(n: Node) {
  if (n.t !== "leaf") return toggleNode(n);
  if (n.group === "tables") openTable(n.connId, n.db, n.name);
  else if (n.group === "views") openTable(n.connId, n.db, n.name, true);
  else viewDdl(n.connId, n.db, n.name, objKindOf(n));
}

function menuFor(n: Node): MenuItem[] {
  if (n.t === "conn") {
    const cfg = n.cfg;
    const connected = n.status === "connected";
    return [
      connected
        ? { label: "关闭连接", icon: <Unplug size={14} />, onClick: () => st().closeConnection(cfg.id) }
        : { label: "打开连接", icon: <Plug size={14} />, onClick: () => st().openConnection(cfg.id) },
      { separator: true },
      { label: "新建查询", icon: <Terminal size={14} />, onClick: async () => (await st().openConnection(cfg.id)) && st().newQuery(cfg.id, cfg.database || null) },
      { label: "新建数据库…", icon: <Plus size={14} />, disabled: !connected, onClick: () => useStore.setState({ modal: { kind: "newDatabase", connId: cfg.id } }) },
      { label: "运行 SQL 文件…", icon: <FileUp size={14} />, disabled: !connected, onClick: () => useStore.setState({ modal: { kind: "runFile", connId: cfg.id, db: null } }) },
      { label: "服务器监控", icon: <Activity size={14} />, disabled: !connected, onClick: () => openServer(cfg.id) },
      { separator: true },
      { label: "编辑连接…", icon: <Settings2 size={14} />, onClick: () => useStore.setState({ connDialog: { config: cfg } }) },
      { label: "复制连接", icon: <Copy size={14} />, onClick: () => useStore.setState({ connDialog: { config: { ...cfg, id: "", name: cfg.name + " 副本" } } }) },
      {
        label: "删除连接",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          if (await confirmDialog({ title: "删除连接", message: `确定删除连接「${cfg.name}」吗？`, danger: true, okText: "删除" })) {
            if (connected) await st().closeConnection(cfg.id);
            await st().deleteConnection(cfg.id);
          }
        },
      },
      { separator: true },
      { label: "刷新", icon: <RefreshCw size={14} />, disabled: !connected, onClick: () => refreshNode(cfg.id) },
    ];
  }
  if (n.t === "db") {
    const { connId, db } = n;
    return [
      { label: "新建查询", icon: <Terminal size={14} />, onClick: () => st().newQuery(connId, db) },
      { label: "新建表", icon: <Plus size={14} />, onClick: () => designTable(connId, db, null) },
      { separator: true },
      { label: "编辑数据库…", icon: <Pencil size={14} />, onClick: () => useStore.setState({ modal: { kind: "editDatabase", connId, db } }) },
      { label: "运行 SQL 文件…", icon: <FileUp size={14} />, onClick: () => useStore.setState({ modal: { kind: "runFile", connId, db } }) },
      { label: "转储 SQL 文件…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "dump", connId, db } }) },
      { separator: true },
      { label: "复制名称", icon: <Copy size={14} />, onClick: () => copyName(db) },
      { label: "删除数据库…", icon: <Trash2 size={14} />, danger: true, onClick: () => dropDatabase(connId, db) },
      { separator: true },
      { label: "刷新", icon: <RefreshCw size={14} />, onClick: () => refreshNode(connId, db) },
    ];
  }
  if (n.t === "group") {
    return [
      ...(n.group === "tables" ? [{ label: "新建表", icon: <Plus size={14} />, onClick: () => designTable(n.connId, n.db, null) }] : []),
      { label: "刷新", icon: <RefreshCw size={14} />, onClick: () => refreshNode(n.connId, n.db) },
    ];
  }
  const { connId, db, name } = n;
  const kind = objKindOf(n);
  if (n.group === "tables")
    return [
      { label: "打开表", icon: <Table2 size={14} />, onClick: () => activate(n) },
      { label: "设计表", icon: <Pencil size={14} />, onClick: () => designTable(connId, db, name) },
      { label: "新建表", icon: <Plus size={14} />, onClick: () => designTable(connId, db, null) },
      { separator: true },
      { label: "查询表", icon: <Terminal size={14} />, onClick: () => st().newQuery(connId, db, `SELECT * FROM ${qi(name)} LIMIT 100;`) },
      { label: "查看 DDL", icon: <Code2 size={14} />, onClick: () => viewDdl(connId, db, name, "TABLE") },
      { label: "导出数据…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "exportTable", connId, db, table: name } }) },
      { separator: true },
      { label: "复制表（结构）", icon: <Copy size={14} />, onClick: () => duplicateTable(connId, db, name, false) },
      { label: "复制表（结构和数据）", icon: <Copy size={14} />, onClick: () => duplicateTable(connId, db, name, true) },
      { label: "重命名", icon: <Pencil size={14} />, onClick: () => renameTable(connId, db, name) },
      { label: "复制表名", icon: <Copy size={14} />, onClick: () => copyName(name) },
      { separator: true },
      { label: "清空表", icon: <Eraser size={14} />, danger: true, onClick: () => truncateTable(connId, db, name) },
      { label: "删除表", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, name, "TABLE") },
    ];
  if (n.group === "views")
    return [
      { label: "打开视图", icon: <Eye size={14} />, onClick: () => activate(n) },
      { label: "查看定义", icon: <Code2 size={14} />, onClick: () => viewDdl(connId, db, name, "VIEW") },
      { label: "导出数据…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "exportTable", connId, db, table: name } }) },
      { label: "复制名称", icon: <Copy size={14} />, onClick: () => copyName(name) },
      { separator: true },
      { label: "删除视图", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, name, "VIEW") },
    ];
  const items: MenuItem[] = [{ label: "查看定义", icon: <Code2 size={14} />, onClick: () => activate(n) }];
  if (n.group === "routines")
    items.push({
      label: "执行",
      icon: <Play size={14} />,
      onClick: () => st().newQuery(connId, db, kind === "FUNCTION" ? `SELECT ${qname(db, name)}();` : `CALL ${qname(db, name)}();`),
    });
  items.push(
    { label: "复制名称", icon: <Copy size={14} />, onClick: () => copyName(name) },
    { separator: true },
    { label: "删除", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, name, kind) },
  );
  return items;
}

// ---------- rendering ----------

const TreeRow = memo(function TreeRow({ node, selected, top }: { node: Node; selected: boolean; top: number }) {
  let icon: ReactNode;
  let label: string;
  let extra: ReactNode = undefined;
  let title: string | undefined;
  let expanded: boolean | undefined;
  let loading = false;
  switch (node.t) {
    case "conn": {
      const connected = node.status === "connected";
      icon = <Server size={14} style={{ color: connected ? node.cfg.color || "var(--ok)" : "var(--muted)" }} />;
      label = node.cfg.name;
      title = `${node.cfg.user}@${node.cfg.host}:${node.cfg.port}${node.version ? `\nMySQL ${node.version}` : ""}`;
      expanded = node.expanded;
      loading = node.status === "connecting";
      break;
    }
    case "db":
      icon = <Database size={14} className={node.loaded ? "ic-db-open" : "ic-db"} />;
      label = node.db;
      expanded = node.expanded;
      loading = node.loading;
      break;
    case "group": {
      const g = GROUPS.find((x) => x.id === node.group)!;
      icon = <Folder size={14} className="ic-folder" />;
      label = g.label;
      extra = node.count;
      expanded = node.expanded;
      break;
    }
    case "leaf":
      icon = GROUPS.find((x) => x.id === node.group)!.icon;
      label = node.name;
      title = node.title;
      break;
  }
  return (
    <div
      className={"tree-row" + (selected ? " selected" : "")}
      style={{ transform: `translateY(${top}px)`, paddingLeft: 6 + DEPTH[node.t] * 14 }}
      title={title}
      onClick={() => selectNode(node)}
      onDoubleClick={() => activate(node)}
      onContextMenu={(e) => {
        selectNode(node);
        showMenu(e, menuFor(node));
      }}
    >
      <span
        className={"tree-chevron" + (expanded ? " open" : "")}
        onClick={(e) => {
          e.stopPropagation();
          toggleNode(node);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {expanded !== undefined && (loading ? <Loader2 size={12} className="spin" /> : <ChevronRight size={12} />)}
      </span>
      <span className="tree-icon">{icon}</span>
      <span className="tree-label">{label}</span>
      {extra !== undefined && <span className="tree-extra">{extra}</span>}
    </div>
  );
});

export function ObjectTree() {
  const [filterInput, setFilterInput] = useState("");
  const filter = useDeferredValue(filterInput);
  const nodes = useNodes(filter);
  const sel = useStore((s) => selKey(s.selected));
  const connCount = useStore((s) => s.connections.length);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const i = nodes.findIndex((n) => n.key === sel);
    const go = (j: number) => {
      const n = nodes[Math.max(0, Math.min(nodes.length - 1, j))];
      if (!n) return;
      selectNode(n);
      virt.scrollToIndex(nodes.indexOf(n), { align: "auto" });
    };
    const cur = nodes[i];
    switch (e.key) {
      case "ArrowDown":
        go(i < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        go(i < 0 ? 0 : i - 1);
        break;
      case "ArrowRight":
        if (cur && cur.t !== "leaf" && !cur.expanded) toggleNode(cur, true);
        else go(i + 1);
        break;
      case "ArrowLeft":
        if (cur && cur.t !== "leaf" && cur.expanded) toggleNode(cur, false);
        else if (cur) {
          // Jump to the parent node.
          for (let j = i - 1; j >= 0; j--) if (DEPTH[nodes[j].t] < DEPTH[cur.t]) return go(j);
        }
        break;
      case "Enter":
        if (cur) activate(cur);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="tree-wrap">
      <div className="tree-search">
        <Search size={13} />
        <input placeholder="搜索表、视图…" value={filterInput} onChange={(e) => setFilterInput(e.target.value)} />
        {filterInput && (
          <button className="icon-btn" onClick={() => setFilterInput("")}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="tree" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((vi) => {
            const n = nodes[vi.index];
            return <TreeRow key={n.key} node={n} selected={n.key === sel} top={vi.start} />;
          })}
        </div>
        {connCount === 0 && (
          <div className="tree-empty">
            <p>还没有任何连接</p>
            <button className="btn primary" onClick={() => useStore.setState({ connDialog: { config: null } })}>
              <Plus size={14} /> 新建连接
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
