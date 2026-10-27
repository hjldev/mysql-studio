import {
  ChevronRight,
  Code2,
  Copy,
  Database,
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
  Activity,
  Eraser,
  X,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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
import type { ConnectionConfig, DbObjects, ObjectKind } from "../types";
import { confirmDialog, toast } from "../ui";
import { qi, qname } from "../utils";
import { showMenu, type MenuItem } from "./ContextMenu";

interface RowProps {
  depth: number;
  expanded?: boolean;
  icon: ReactNode;
  label: ReactNode;
  extra?: ReactNode;
  selected?: boolean;
  loading?: boolean;
  title?: string;
  onToggle?: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  menu?: () => MenuItem[];
}

function Row(p: RowProps) {
  return (
    <div
      className={"tree-row" + (p.selected ? " selected" : "")}
      style={{ paddingLeft: 6 + p.depth * 14 }}
      title={p.title}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={(e) => {
        p.onClick?.();
        if (p.menu) showMenu(e, p.menu());
      }}
    >
      <span
        className={"tree-chevron" + (p.expanded ? " open" : "")}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggle?.();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {p.expanded !== undefined && (p.loading ? <Loader2 size={12} className="spin" /> : <ChevronRight size={12} />)}
      </span>
      <span className="tree-icon">{p.icon}</span>
      <span className="tree-label">{p.label}</span>
      {p.extra !== undefined && <span className="tree-extra">{p.extra}</span>}
    </div>
  );
}

const isSel = (a: TreeSel | null, b: TreeSel) =>
  !!a && a.kind === b.kind && a.connId === b.connId && a.db === b.db && a.name === b.name && a.group === b.group;

export function ObjectTree() {
  const connections = useStore((s) => s.connections);
  const [filter, setFilter] = useState("");
  return (
    <div className="tree-wrap">
      <div className="tree-search">
        <Search size={13} />
        <input placeholder="搜索表、视图…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filter && (
          <button className="icon-btn" onClick={() => setFilter("")}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="tree">
        {connections.map((c) => (
          <ConnNode key={c.id} cfg={c} filter={filter.trim().toLowerCase()} />
        ))}
        {connections.length === 0 && (
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

function ConnNode({ cfg, filter }: { cfg: ConnectionConfig; filter: string }) {
  const state = useStore((s) => s.conn[cfg.id]);
  const expanded = useStore((s) => !!s.expanded[`c:${cfg.id}`]);
  const selected = useStore((s) => isSel(s.selected, { kind: "conn", connId: cfg.id }));
  const s = useStore.getState;
  const connected = state?.status === "connected";

  const toggle = async () => {
    if (!connected) {
      await s().openConnection(cfg.id);
      return;
    }
    s().setExpanded(`c:${cfg.id}`, !expanded);
  };

  const menu = (): MenuItem[] => [
    connected
      ? { label: "关闭连接", icon: <Unplug size={14} />, onClick: () => s().closeConnection(cfg.id) }
      : { label: "打开连接", icon: <Plug size={14} />, onClick: () => s().openConnection(cfg.id) },
    { separator: true },
    { label: "新建查询", icon: <Terminal size={14} />, onClick: async () => (await s().openConnection(cfg.id)) && s().newQuery(cfg.id, cfg.database || null) },
    { label: "新建数据库…", icon: <Plus size={14} />, disabled: !connected, onClick: () => useStore.setState({ modal: { kind: "newDatabase", connId: cfg.id } }) },
    { label: "运行 SQL 文件…", icon: <FileUp size={14} />, disabled: !connected, onClick: () => useStore.setState({ modal: { kind: "runFile", connId: cfg.id, db: null } }) },
    { label: "服务器监控", icon: <Activity size={14} />, disabled: !connected, onClick: () => openServer(cfg.id) },
    { separator: true },
    { label: "编辑连接…", icon: <Settings2 size={14} />, onClick: () => useStore.setState({ connDialog: { config: cfg } }) },
    {
      label: "复制连接",
      icon: <Copy size={14} />,
      onClick: () => useStore.setState({ connDialog: { config: { ...cfg, id: "", name: cfg.name + " 副本" } } }),
    },
    {
      label: "删除连接",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: "删除连接", message: `确定删除连接「${cfg.name}」吗？`, danger: true, okText: "删除" })) {
          if (connected) await s().closeConnection(cfg.id);
          await s().deleteConnection(cfg.id);
        }
      },
    },
    { separator: true },
    { label: "刷新", icon: <RefreshCw size={14} />, disabled: !connected, onClick: () => refreshNode(cfg.id) },
  ];

  const dbs = state?.databases ?? [];
  return (
    <>
      <Row
        depth={0}
        expanded={connected ? expanded : false}
        loading={state?.status === "connecting"}
        icon={<Server size={14} style={{ color: connected ? cfg.color || "var(--ok)" : "var(--muted)" }} />}
        label={cfg.name}
        title={`${cfg.user}@${cfg.host}:${cfg.port}${state?.server ? `\nMySQL ${state.server.version}` : ""}`}
        selected={selected}
        onToggle={toggle}
        onClick={() => s().select({ kind: "conn", connId: cfg.id })}
        onDoubleClick={toggle}
        menu={menu}
      />
      {connected &&
        expanded &&
        dbs.map((db) => <DbNode key={db} connId={cfg.id} db={db} filter={filter} defaultDb={cfg.database} />)}
    </>
  );
}

const GROUPS = [
  { id: "tables", label: "表", icon: <Table2 size={14} className="ic-table" /> },
  { id: "views", label: "视图", icon: <Eye size={14} className="ic-view" /> },
  { id: "routines", label: "函数", icon: <SquareFunction size={14} className="ic-func" /> },
  { id: "triggers", label: "触发器", icon: <Zap size={14} className="ic-trigger" /> },
] as const;

function DbNode({ connId, db, filter }: { connId: string; db: string; filter: string; defaultDb?: string | null }) {
  const key = objKey(connId, db);
  const objs = useStore((s) => s.objects[key]);
  const loading = useStore((s) => !!s.loadingObjects[key]);
  const expandedRaw = useStore((s) => !!s.expanded[`d:${key}`]);
  const selected = useStore((s) => isSel(s.selected, { kind: "db", connId, db }));
  const s = useStore.getState;

  const matches = filter && objs ? countMatches(objs, filter) : 0;
  if (filter && !db.toLowerCase().includes(filter) && matches === 0) return null;
  const expanded = expandedRaw || (!!filter && matches > 0);

  const toggle = async () => {
    if (!expandedRaw) await s().loadObjects(connId, db);
    s().setExpanded(`d:${key}`, !expandedRaw);
  };

  const menu = (): MenuItem[] => [
    { label: "新建查询", icon: <Terminal size={14} />, onClick: () => s().newQuery(connId, db) },
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

  return (
    <>
      <Row
        depth={1}
        expanded={expanded}
        loading={loading}
        icon={<Database size={14} className={objs ? "ic-db-open" : "ic-db"} />}
        label={db}
        selected={selected}
        onToggle={toggle}
        onClick={() => {
          s().select({ kind: "db", connId, db });
          s().loadObjects(connId, db);
        }}
        onDoubleClick={toggle}
        menu={menu}
      />
      {expanded && objs && GROUPS.map((g) => <GroupNode key={g.id} connId={connId} db={db} group={g} objs={objs} filter={filter} />)}
    </>
  );
}

function countMatches(o: DbObjects, f: string) {
  const m = (n: string) => n.toLowerCase().includes(f);
  return (
    o.tables.filter((t) => m(t.name)).length +
    o.views.filter((t) => m(t.name)).length +
    o.routines.filter((t) => m(t.name)).length +
    o.triggers.filter((t) => m(t.name)).length
  );
}

function GroupNode({
  connId,
  db,
  group,
  objs,
  filter,
}: {
  connId: string;
  db: string;
  group: (typeof GROUPS)[number];
  objs: DbObjects;
  filter: string;
}) {
  const gkey = `g:${objKey(connId, db)}:${group.id}`;
  const expandedRaw = useStore((s) => s.expanded[gkey] ?? group.id === "tables");
  const selected = useStore((s) => isSel(s.selected, { kind: "group", connId, db, group: group.id }));
  const s = useStore.getState;
  const all = objs[group.id] as { name: string }[];
  const items = filter ? all.filter((o) => o.name.toLowerCase().includes(filter)) : all;
  if (filter && items.length === 0) return null;
  const expanded = expandedRaw || !!filter;

  const menu = (): MenuItem[] => [
    ...(group.id === "tables" ? [{ label: "新建表", icon: <Plus size={14} />, onClick: () => designTable(connId, db, null) }] : []),
    { label: "刷新", icon: <RefreshCw size={14} />, onClick: () => refreshNode(connId, db) },
  ];

  return (
    <>
      <Row
        depth={2}
        expanded={expanded}
        icon={<Folder size={14} className="ic-folder" />}
        label={group.label}
        extra={all.length}
        selected={selected}
        onToggle={() => s().setExpanded(gkey, !expandedRaw)}
        onClick={() => s().select({ kind: "group", connId, db, group: group.id })}
        onDoubleClick={() => s().setExpanded(gkey, !expandedRaw)}
        menu={menu}
      />
      {expanded &&
        items.map((o) => (
          <LeafNode key={o.name} connId={connId} db={db} group={group.id} item={o as never} icon={group.icon} />
        ))}
    </>
  );
}

function LeafNode({
  connId,
  db,
  group,
  item,
  icon,
}: {
  connId: string;
  db: string;
  group: (typeof GROUPS)[number]["id"];
  item: { name: string; kind?: string; comment?: string; table?: string };
  icon: ReactNode;
}) {
  const kind = group === "tables" ? "table" : group === "views" ? "view" : group === "routines" ? "routine" : "trigger";
  const sel: TreeSel = { kind, connId, db, name: item.name };
  const selected = useStore((s) => isSel(s.selected, sel));
  const s = useStore.getState;
  const objKind: ObjectKind =
    group === "tables" ? "TABLE" : group === "views" ? "VIEW" : group === "triggers" ? "TRIGGER" : (item.kind as ObjectKind);

  const open = () => {
    if (group === "tables") openTable(connId, db, item.name);
    else if (group === "views") openTable(connId, db, item.name, true);
    else viewDdl(connId, db, item.name, objKind);
  };

  const menu = (): MenuItem[] => {
    if (group === "tables")
      return [
        { label: "打开表", icon: <Table2 size={14} />, onClick: open },
        { label: "设计表", icon: <Pencil size={14} />, onClick: () => designTable(connId, db, item.name) },
        { label: "新建表", icon: <Plus size={14} />, onClick: () => designTable(connId, db, null) },
        { separator: true },
        {
          label: "查询表",
          icon: <Terminal size={14} />,
          onClick: () => s().newQuery(connId, db, `SELECT * FROM ${qi(item.name)} LIMIT 100;`),
        },
        { label: "查看 DDL", icon: <Code2 size={14} />, onClick: () => viewDdl(connId, db, item.name, "TABLE") },
        { label: "导出数据…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "exportTable", connId, db, table: item.name } }) },
        { separator: true },
        { label: "复制表（结构）", icon: <Copy size={14} />, onClick: () => duplicateTable(connId, db, item.name, false) },
        { label: "复制表（结构和数据）", icon: <Copy size={14} />, onClick: () => duplicateTable(connId, db, item.name, true) },
        { label: "重命名", icon: <Pencil size={14} />, onClick: () => renameTable(connId, db, item.name) },
        { label: "复制表名", icon: <Copy size={14} />, onClick: () => copyName(item.name) },
        { separator: true },
        { label: "清空表", icon: <Eraser size={14} />, danger: true, onClick: () => truncateTable(connId, db, item.name) },
        { label: "删除表", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, item.name, "TABLE") },
      ];
    if (group === "views")
      return [
        { label: "打开视图", icon: <Eye size={14} />, onClick: open },
        { label: "查看定义", icon: <Code2 size={14} />, onClick: () => viewDdl(connId, db, item.name, "VIEW") },
        { label: "导出数据…", icon: <FileDown size={14} />, onClick: () => useStore.setState({ modal: { kind: "exportTable", connId, db, table: item.name } }) },
        { label: "复制名称", icon: <Copy size={14} />, onClick: () => copyName(item.name) },
        { separator: true },
        { label: "删除视图", icon: <Trash2 size={14} />, danger: true, onClick: () => dropObject(connId, db, item.name, "VIEW") },
      ];
    const items: MenuItem[] = [{ label: "查看定义", icon: <Code2 size={14} />, onClick: open }];
    if (group === "routines")
      items.push({
        label: "执行",
        icon: <Play size={14} />,
        onClick: () =>
          s().newQuery(
            connId,
            db,
            objKind === "FUNCTION" ? `SELECT ${qname(db, item.name)}();` : `CALL ${qname(db, item.name)}();`,
          ),
      });
    items.push(
      { label: "复制名称", icon: <Copy size={14} />, onClick: () => copyName(item.name) },
      { separator: true },
      {
        label: "删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => dropObject(connId, db, item.name, objKind).catch((e) => toast(String(e), "error")),
      },
    );
    return items;
  };

  return (
    <Row
      depth={3}
      icon={icon}
      label={item.name}
      title={item.comment || (item.table ? `ON ${item.table}` : undefined)}
      selected={selected}
      onClick={() => s().select(sel)}
      onDoubleClick={open}
      menu={menu}
    />
  );
}
