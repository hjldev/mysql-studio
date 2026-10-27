import { create } from "zustand";
import { api, errorText } from "./api";
import { confirmDialog, toast } from "./ui";
import type { ConnectionConfig, DbObjects, ServerInfo, Tab } from "./types";
import { uid } from "./utils";

export interface ConnState {
  status: "idle" | "connecting" | "connected" | "error";
  server?: ServerInfo;
  databases?: string[];
  error?: string;
}

export type SelKind = "conn" | "db" | "group" | "table" | "view" | "routine" | "trigger";

export interface TreeSel {
  kind: SelKind;
  connId: string;
  db?: string;
  name?: string;
  group?: string;
}

export type ModalState =
  | { kind: "newDatabase"; connId: string }
  | { kind: "editDatabase"; connId: string; db: string }
  | { kind: "exportTable"; connId: string; db: string; table: string }
  | { kind: "dump"; connId: string; db: string }
  | { kind: "runFile"; connId: string; db: string | null };

type NewTab = Tab extends infer T ? (T extends Tab ? Omit<T, "id"> : never) : never;

interface Store {
  connections: ConnectionConfig[];
  conn: Record<string, ConnState>;
  objects: Record<string, DbObjects | undefined>;
  loadingObjects: Record<string, boolean>;
  schemaCols: Record<string, Record<string, string[]> | undefined>;
  expanded: Record<string, boolean>;
  selected: TreeSel | null;
  tabs: Tab[];
  activeTab: string;
  dirty: Record<string, boolean>;
  connDialog: { config: ConnectionConfig | null } | null;
  modal: ModalState | null;
  queryCounter: number;

  loadConnections(): Promise<void>;
  saveConnection(cfg: ConnectionConfig): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  openConnection(id: string): Promise<boolean>;
  closeConnection(id: string): Promise<void>;
  refreshDatabases(id: string): Promise<void>;
  loadObjects(connId: string, db: string, force?: boolean): Promise<DbObjects | undefined>;
  loadSchemaCols(connId: string, db: string): Promise<void>;
  setExpanded(key: string, value: boolean): void;
  select(sel: TreeSel | null): void;
  openTab(tab: NewTab): string;
  newQuery(connId: string, database: string | null, sql?: string): string;
  closeTab(id: string): Promise<void>;
  updateTab(id: string, patch: Partial<Tab>): void;
  setDirty(id: string, dirty: boolean): void;
}

export const OBJECTS_TAB = "objects";

export const objKey = (connId: string, db: string) => `${connId}\u0000${db}`;

function tabKey(t: NewTab | Tab): string | null {
  switch (t.kind) {
    case "table":
      return `table:${t.connId}:${t.db}:${t.table}`;
    case "design":
      return t.table ? `design:${t.connId}:${t.db}:${t.table}` : null;
    case "ddl":
      return `ddl:${t.connId}:${t.db}:${t.objKind}:${t.name}`;
    case "server":
      return `server:${t.connId}`;
    default:
      return null;
  }
}

export const useStore = create<Store>((set, get) => ({
  connections: [],
  conn: {},
  objects: {},
  loadingObjects: {},
  schemaCols: {},
  expanded: {},
  selected: null,
  tabs: [],
  activeTab: OBJECTS_TAB,
  dirty: {},
  connDialog: null,
  modal: null,
  queryCounter: 0,

  async loadConnections() {
    try {
      const list = await api.listConnections();
      set({ connections: list });
    } catch (e) {
      toast("读取连接配置失败: " + errorText(e), "error");
    }
  },

  async saveConnection(cfg) {
    const saved = await api.saveConnection(cfg);
    set((s) => {
      const exists = s.connections.some((c) => c.id === saved.id);
      return {
        connections: exists ? s.connections.map((c) => (c.id === saved.id ? saved : c)) : [...s.connections, saved],
        // The backend drops the pool on save, so reflect a closed connection.
        conn: { ...s.conn, [saved.id]: { status: "idle" } },
        expanded: { ...s.expanded, [`c:${saved.id}`]: false },
      };
    });
    return saved;
  },

  async deleteConnection(id) {
    await api.deleteConnection(id);
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      tabs: s.tabs.filter((t) => t.connId !== id),
      activeTab: s.tabs.find((t) => t.id === s.activeTab)?.connId === id ? OBJECTS_TAB : s.activeTab,
      selected: s.selected?.connId === id ? null : s.selected,
    }));
  },

  async openConnection(id) {
    const st = get().conn[id];
    if (st?.status === "connected") return true;
    if (st?.status === "connecting") return false;
    set((s) => ({ conn: { ...s.conn, [id]: { status: "connecting" } } }));
    try {
      const server = await api.connect(id);
      const databases = await api.listDatabases(id);
      set((s) => ({
        conn: { ...s.conn, [id]: { status: "connected", server, databases } },
        expanded: { ...s.expanded, [`c:${id}`]: true },
      }));
      return true;
    } catch (e) {
      const error = errorText(e);
      set((s) => ({ conn: { ...s.conn, [id]: { status: "error", error } } }));
      toast(`连接失败: ${error}`, "error");
      return false;
    }
  },

  async closeConnection(id) {
    const s = get();
    const related = s.tabs.filter((t) => t.connId === id);
    if (related.some((t) => s.dirty[t.id])) {
      const ok = await confirmDialog({ title: "关闭连接", message: "有未保存的更改，确定关闭连接吗？", danger: true });
      if (!ok) return;
    }
    for (const t of related) if (t.kind === "query") api.closeSession(t.id).catch(() => {});
    await api.disconnect(id).catch(() => {});
    set((s) => {
      const objects = { ...s.objects };
      for (const k of Object.keys(objects)) if (k.startsWith(id + "\u0000")) delete objects[k];
      const expanded = Object.fromEntries(Object.entries(s.expanded).filter(([k]) => !k.includes(id)));
      return {
        conn: { ...s.conn, [id]: { status: "idle" } },
        objects,
        expanded,
        tabs: s.tabs.filter((t) => t.connId !== id),
        activeTab: related.some((t) => t.id === s.activeTab) ? OBJECTS_TAB : s.activeTab,
        selected: s.selected?.connId === id ? { kind: "conn", connId: id } : s.selected,
      };
    });
  },

  async refreshDatabases(id) {
    try {
      const databases = await api.listDatabases(id);
      set((s) => ({ conn: { ...s.conn, [id]: { ...s.conn[id], databases } } }));
    } catch (e) {
      toast(errorText(e), "error");
    }
  },

  async loadObjects(connId, db, force = false) {
    const key = objKey(connId, db);
    const s = get();
    if (!force && s.objects[key]) return s.objects[key];
    if (s.loadingObjects[key]) return undefined;
    set((s) => ({ loadingObjects: { ...s.loadingObjects, [key]: true } }));
    try {
      const objs = await api.listObjects(connId, db);
      set((s) => ({
        objects: { ...s.objects, [key]: objs },
        schemaCols: force ? { ...s.schemaCols, [key]: undefined } : s.schemaCols,
      }));
      return objs;
    } catch (e) {
      toast(errorText(e), "error");
      return undefined;
    } finally {
      set((s) => ({ loadingObjects: { ...s.loadingObjects, [key]: false } }));
    }
  },

  async loadSchemaCols(connId, db) {
    const key = objKey(connId, db);
    if (get().schemaCols[key]) return;
    try {
      const cols = await api.schemaColumns(connId, db);
      set((s) => ({ schemaCols: { ...s.schemaCols, [key]: cols } }));
    } catch {
      /* autocompletion is best effort */
    }
  },

  setExpanded(key, value) {
    set((s) => ({ expanded: { ...s.expanded, [key]: value } }));
  },

  select(sel) {
    set({ selected: sel });
  },

  openTab(tab) {
    const key = tabKey(tab);
    const existing = key ? get().tabs.find((t) => tabKey(t) === key) : undefined;
    if (existing) {
      set({ activeTab: existing.id });
      return existing.id;
    }
    const id = uid();
    set((s) => ({ tabs: [...s.tabs, { ...tab, id } as Tab], activeTab: id }));
    return id;
  },

  newQuery(connId, database, sql = "") {
    const n = get().queryCounter + 1;
    set({ queryCounter: n });
    return get().openTab({ kind: "query", title: `查询 ${n}`, connId, database, sql });
  },

  async closeTab(id) {
    const s = get();
    if (s.dirty[id]) {
      const ok = await confirmDialog({ title: "关闭标签页", message: "有未保存的更改，确定要关闭吗？", danger: true, okText: "关闭" });
      if (!ok) return;
    }
    const tab = s.tabs.find((t) => t.id === id);
    if (tab?.kind === "query") api.closeSession(id).catch(() => {});
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTab = s.activeTab;
      if (activeTab === id) activeTab = tabs[Math.min(idx, tabs.length - 1)]?.id ?? OBJECTS_TAB;
      const dirty = { ...s.dirty };
      delete dirty[id];
      return { tabs, activeTab, dirty };
    });
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }));
  },

  setDirty(id, dirty) {
    if (!!get().dirty[id] === dirty) return;
    set((s) => ({ dirty: { ...s.dirty, [id]: dirty } }));
  },
}));

export const connName = (id: string) => useStore.getState().connections.find((c) => c.id === id)?.name ?? "";
