import { Loader2, OctagonX, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, runSql } from "../api";
import { DataGrid } from "../components/DataGrid";
import { useStore } from "../store";
import type { QueryResult, Tab } from "../types";
import { confirmDialog, toast } from "../ui";

type ServerTabT = Extract<Tab, { kind: "server" }>;
type Sub = "process" | "status" | "variables";

const SQL: Record<Sub, string> = {
  process: "SHOW FULL PROCESSLIST",
  status: "SHOW GLOBAL STATUS",
  variables: "SHOW GLOBAL VARIABLES",
};

function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d ? d + " 天 " : ""}${h} 小时 ${m} 分`;
}

export function ServerTab({ tab, active }: { tab: ServerTabT; active: boolean }) {
  const server = useStore((s) => s.conn[tab.connId]?.server);
  const [sub, setSub] = useState<Sub>("process");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [stats, setStats] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [auto, setAuto] = useState(false);
  const [selRows, setSelRows] = useState<number[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r] = await runSql(tab.connId, SQL[sub]);
      setResult(r);
      const [s] = await runSql(
        tab.connId,
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Bytes_received','Bytes_sent')",
      );
      setStats(Object.fromEntries(s.rows.map((r) => [String(r[0]), String(r[1])])));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setLoading(false);
    }
  }, [tab.connId, sub]);

  useEffect(() => {
    setResult(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!auto || !active || sub !== "process") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [auto, active, sub, load]);

  const rows = useMemo(() => {
    if (!result) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return result.rows;
    return result.rows.filter((r) => r.some((c) => typeof c === "string" && c.toLowerCase().includes(f)));
  }, [result, filter]);

  const kill = async () => {
    const ids = selRows.map((r) => rows[r]?.[0]).filter(Boolean) as string[];
    if (!ids.length) return;
    if (!(await confirmDialog({ title: "结束进程", message: `确定结束进程 ${ids.join(", ")} 吗？`, danger: true, okText: "结束" }))) return;
    try {
      for (const id of ids) await runSql(tab.connId, `KILL ${Number(id)}`);
      toast("已结束进程", "success");
      load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div className="server-tab">
      <div className="server-summary">
        <div>
          <b>MySQL {server?.version}</b>
        </div>
        {stats.Uptime && <div>运行时间: {fmtUptime(Number(stats.Uptime))}</div>}
        {stats.Threads_connected && <div>连接数: {stats.Threads_connected}</div>}
        {stats.Threads_running && <div>运行中线程: {stats.Threads_running}</div>}
        {stats.Questions && <div>查询总数: {Number(stats.Questions).toLocaleString()}</div>}
        {stats.Slow_queries && <div>慢查询: {stats.Slow_queries}</div>}
      </div>
      <div className="subtabs">
        {(
          [
            ["process", "进程列表"],
            ["status", "状态"],
            ["variables", "变量"],
          ] as [Sub, string][]
        ).map(([k, l]) => (
          <button key={k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="toolbar small">
        <button className="tbtn" onClick={load}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
        </button>
        {sub === "process" && (
          <>
            <label className="check">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新 (3 秒)
            </label>
            <button className="tbtn" disabled={!selRows.length} onClick={kill}>
              <OctagonX size={14} /> 结束进程
            </button>
          </>
        )}
        <span className="tspacer" />
        <div className="search-input">
          <Search size={13} />
          <input placeholder="筛选" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <div className="data-body">
        {result && (
          <DataGrid
            columns={result.columns}
            rowCount={rows.length}
            getCell={(r, c) => rows[r]?.[c]}
            onSelectionChange={(r) => setSelRows(r)}
            resetKey={sub}
          />
        )}
      </div>
    </div>
  );
}
