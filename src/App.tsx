import {
  Activity,
  Code2,
  FileDown,
  FileUp,
  LayoutGrid,
  Pencil,
  Plug,
  RefreshCw,
  Server,
  Table2,
  TablePropertiesIcon,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { designTable, openServer, refreshNode } from "./actions";
import { ContextMenuHost, showMenu } from "./components/ContextMenu";
import { ConnectionDialog, TaskModals } from "./components/Dialogs";
import { DialogHost } from "./components/Modal";
import { ObjectTree } from "./components/ObjectTree";
import { OBJECTS_TAB, useStore } from "./store";
import { DdlTab } from "./tabs/DdlTab";
import { DesignTab } from "./tabs/DesignTab";
import { ObjectsPanel } from "./tabs/ObjectsPanel";
import { QueryTab } from "./tabs/QueryTab";
import { ServerTab } from "./tabs/ServerTab";
import { TableDataTab } from "./tabs/TableDataTab";
import type { Tab } from "./types";

const TAB_ICONS: Record<Tab["kind"], ReactNode> = {
  query: <Terminal size={13} className="ic-query" />,
  table: <Table2 size={13} className="ic-table" />,
  design: <TablePropertiesIcon size={13} className="ic-design" />,
  objects: <LayoutGrid size={13} />,
  ddl: <Code2 size={13} className="ic-func" />,
  server: <Activity size={13} className="ic-server" />,
};

function TopToolbar() {
  const sel = useStore((s) => s.selected);
  const connected = useStore((s) => (sel ? s.conn[sel.connId]?.status === "connected" : false));
  const s = useStore.getState;

  const newQuery = async () => {
    if (!sel) return;
    if (await s().openConnection(sel.connId)) {
      const cfg = s().connections.find((c) => c.id === sel.connId);
      s().newQuery(sel.connId, sel.db ?? cfg?.database ?? null);
    }
  };

  const Btn = ({ icon, label, onClick, disabled }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean }) => (
    <button className="big-btn" onClick={onClick} disabled={disabled}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="top-toolbar">
      <Btn icon={<Plug size={22} />} label="连接" onClick={() => useStore.setState({ connDialog: { config: null } })} />
      <Btn icon={<Terminal size={22} />} label="新建查询" onClick={newQuery} disabled={!sel} />
      <span className="big-sep" />
      <Btn icon={<LayoutGrid size={22} />} label="对象" onClick={() => useStore.setState({ activeTab: OBJECTS_TAB })} />
      <Btn icon={<Pencil size={22} />} label="新建表" onClick={() => sel?.db && designTable(sel.connId, sel.db, null)} disabled={!sel?.db || !connected} />
      <Btn
        icon={<FileUp size={22} />}
        label="运行 SQL 文件"
        onClick={() => sel && useStore.setState({ modal: { kind: "runFile", connId: sel.connId, db: sel.db ?? null } })}
        disabled={!connected}
      />
      <Btn icon={<FileDown size={22} />} label="转储 SQL" onClick={() => sel?.db && useStore.setState({ modal: { kind: "dump", connId: sel.connId, db: sel.db } })} disabled={!sel?.db || !connected} />
      <span className="big-sep" />
      <Btn icon={<Activity size={22} />} label="服务器监控" onClick={() => sel && openServer(sel.connId)} disabled={!connected} />
      <Btn icon={<RefreshCw size={22} />} label="刷新" onClick={() => sel && refreshNode(sel.connId, sel.db)} disabled={!connected} />
    </div>
  );
}

function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const dirty = useStore((s) => s.dirty);
  const connections = useStore((s) => s.connections);
  const s = useStore.getState;

  useEffect(() => {
    document.querySelector(".tabbar .tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const menu = (e: React.MouseEvent, id: string) =>
    showMenu(e, [
      { label: "关闭", onClick: () => s().closeTab(id) },
      {
        label: "关闭其他标签页",
        onClick: async () => {
          for (const t of s().tabs) if (t.id !== id) await s().closeTab(t.id);
        },
      },
      {
        label: "关闭全部标签页",
        onClick: async () => {
          for (const t of s().tabs) await s().closeTab(t.id);
        },
      },
    ]);

  return (
    <div className="tabbar">
      <div className={"tab pinned" + (active === OBJECTS_TAB ? " active" : "")} onClick={() => useStore.setState({ activeTab: OBJECTS_TAB })}>
        <LayoutGrid size={13} />
        <span className="tab-title">对象</span>
      </div>
      {tabs.map((t) => {
        const color = connections.find((c) => c.id === t.connId)?.color;
        return (
          <div
            key={t.id}
            className={"tab" + (active === t.id ? " active" : "")}
            style={color ? { boxShadow: `inset 0 2px 0 ${color}` } : undefined}
            title={t.title}
            onClick={() => useStore.setState({ activeTab: t.id })}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                s().closeTab(t.id);
              }
            }}
            onContextMenu={(e) => menu(e, t.id)}
          >
            {TAB_ICONS[t.kind]}
            <span className="tab-title">{t.title}</span>
            {dirty[t.id] && <span className="tab-dirty" />}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                s().closeTab(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function TabView({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "query":
      return <QueryTab tab={tab} active={active} />;
    case "table":
      return <TableDataTab tab={tab} active={active} />;
    case "design":
      return <DesignTab tab={tab} active={active} />;
    case "ddl":
      return <DdlTab tab={tab} />;
    case "server":
      return <ServerTab tab={tab} active={active} />;
    default:
      return null;
  }
}

function StatusBar() {
  const sel = useStore((s) => s.selected);
  const cfg = useStore((s) => s.connections.find((c) => c.id === sel?.connId));
  const st = useStore((s) => (sel ? s.conn[sel.connId] : undefined));
  return (
    <div className="statusbar">
      {cfg ? (
        <>
          <Server size={12} />
          <span>{cfg.name}</span>
          {st?.server && <span className="muted">MySQL {st.server.version}</span>}
          {sel?.db && <span>· {sel.db}</span>}
          {sel?.name && <span>· {sel.name}</span>}
        </>
      ) : (
        <span className="muted">未选择连接</span>
      )}
      <span className="tspacer" />
      <span className="muted">MySQL Studio 0.1.0</span>
    </div>
  );
}

export default function App() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.activeTab);
  const [sideW, setSideW] = useState(260);

  useEffect(() => {
    useStore.getState().loadConnections();
    // Keep the webview's own context menu out of the way except in text fields.
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .cm-editor")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideW;
    const move = (ev: MouseEvent) => setSideW(Math.max(180, Math.min(520, startW + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-col");
    };
    document.body.classList.add("resizing-col");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="app">
      <TopToolbar />
      <div className="main">
        <aside className="sidebar" style={{ width: sideW }}>
          <ObjectTree />
        </aside>
        <div className="vsplit" onMouseDown={startDrag} />
        <section className="workspace">
          <TabBar />
          <div className="tab-content">
            <div className="tab-pane" style={{ display: active === OBJECTS_TAB ? "flex" : "none" }}>
              <ObjectsPanel />
            </div>
            {tabs.map((t) => (
              <div key={t.id} className="tab-pane" style={{ display: active === t.id ? "flex" : "none" }}>
                <TabView tab={t} active={active === t.id} />
              </div>
            ))}
          </div>
        </section>
      </div>
      <StatusBar />
      <ConnectionDialog />
      <TaskModals />
      <DialogHost />
      <ContextMenuHost />
    </div>
  );
}
