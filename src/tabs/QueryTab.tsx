import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { AlignLeft, CircleCheck, CircleX, FileDown, History, Loader2, Play, PlayCircle, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import { api, errorText } from "../api";
import { showMenu } from "../components/ContextMenu";
import { DataGrid } from "../components/DataGrid";
import { objKey, useStore } from "../store";
import type { QueryResult, Tab } from "../types";
import { toast } from "../ui";
import { formatMs, pickSavePath, resultToCsv, resultToInserts, resultToJson, statementAt } from "../utils";
import { useDarkMode } from "../hooks";

type QueryTabT = Extract<Tab, { kind: "query" }>;

const HISTORY_KEY = "mysql-studio.history";

interface HistoryItem {
  sql: string;
  at: number;
  db: string | null;
}

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function pushHistory(item: HistoryItem) {
  try {
    const list = [item, ...loadHistory().filter((h) => h.sql !== item.sql)].slice(0, 100);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

const DDL_RE = /^\s*(create|alter|drop|rename|truncate)\b/im;

export function QueryTab({ tab, active }: { tab: QueryTabT; active: boolean }) {
  const dark = useDarkMode();
  const databases = useStore((s) => s.conn[tab.connId]?.databases ?? []);
  const schema = useStore((s) => (tab.database ? s.schemaCols[objKey(tab.connId, tab.database)] : undefined));
  const objects = useStore((s) => (tab.database ? s.objects[objKey(tab.connId, tab.database)] : undefined));
  const [doc, setDoc] = useState(tab.sql);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [view, setView] = useState<"msg" | number>("msg");
  const [editorH, setEditorH] = useState(260);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef<(mode: "auto" | "current") => void>(() => {});

  useEffect(() => {
    if (tab.database) useStore.getState().loadSchemaCols(tab.connId, tab.database);
  }, [tab.connId, tab.database, objects]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (active) setTimeout(() => viewRef.current?.focus(), 0);
  }, [active]);

  const run = async (mode: "auto" | "current") => {
    const v = viewRef.current;
    if (!v || running) return;
    const text = v.state.doc.toString();
    const sel = v.state.selection.main;
    let sql = sel.empty ? text : text.slice(sel.from, sel.to);
    if (mode === "current" && sel.empty) sql = statementAt(text, sel.head)?.text ?? "";
    if (!sql.trim()) return;
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const res = await api.execute(tab.connId, sql, { sessionId: tab.id, database: tab.database, maxRows: 5000 });
      setResults(res.results);
      const firstSet = res.results.findIndex((r) => r.hasResultSet);
      const failed = res.results.some((r) => r.error);
      setView(failed || firstSet < 0 ? "msg" : res.results.filter((r) => r.hasResultSet).indexOf(res.results[firstSet]));
      if (res.database !== tab.database) useStore.getState().updateTab(tab.id, { database: res.database });
      pushHistory({ sql, at: Date.now(), db: res.database });
      if (DDL_RE.test(sql)) {
        const s = useStore.getState();
        s.refreshDatabases(tab.connId);
        if (res.database) s.loadObjects(tab.connId, res.database, true);
      }
    } catch (e) {
      setResults([{ sql, error: errorText(e) } as QueryResult]);
      setView("msg");
    } finally {
      setRunning(false);
    }
  };
  runRef.current = run;

  const extensions = useMemo(() => {
    const tables: Record<string, string[]> = { ...(schema ?? {}) };
    for (const t of objects?.tables ?? []) tables[t.name] ??= [];
    for (const t of objects?.views ?? []) tables[t.name] ??= [];
    return [
      sqlLang({ dialect: MySQL, schema: tables, upperCaseKeywords: true }),
      Prec.highest(
        keymap.of([
          { key: "Mod-Enter", run: () => (runRef.current("auto"), true) },
          { key: "Shift-Mod-Enter", run: () => (runRef.current("current"), true) },
          { key: "Mod-r", run: () => (runRef.current("auto"), true) },
        ]),
      ),
      EditorView.lineWrapping,
    ];
  }, [schema, objects]);

  const beautify = () => {
    const v = viewRef.current;
    if (!v) return;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? v.state.doc.length : sel.to;
    try {
      const out = formatSql(v.state.doc.sliceString(from, to), { language: "mysql", keywordCase: "upper" });
      v.dispatch({ changes: { from, to, insert: out } });
    } catch (e) {
      toast("无法格式化: " + errorText(e), "error");
    }
  };

  const showHistory = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items = loadHistory().slice(0, 25);
    showMenu(
      { clientX: r.left, clientY: r.bottom + 2, preventDefault() {}, stopPropagation() {} },
      items.length
        ? items.map((h) => ({
            label: h.sql.replace(/\s+/g, " ").slice(0, 80),
            shortcut: new Date(h.at).toLocaleTimeString(),
            onClick: () => {
              const v = viewRef.current;
              if (!v) return;
              const sel = v.state.selection.main;
              v.dispatch({ changes: { from: sel.from, to: sel.to, insert: h.sql } });
              v.focus();
            },
          }))
        : [{ label: "暂无历史记录", disabled: true }],
    );
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH;
    const move = (ev: MouseEvent) => setEditorH(Math.max(80, Math.min(window.innerHeight - 220, startH + ev.clientY - startY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-row");
    };
    document.body.classList.add("resizing-row");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const sets = results?.filter((r) => r.hasResultSet) ?? [];
  const current = typeof view === "number" ? sets[view] : undefined;

  return (
    <div className="query-tab">
      <div className="toolbar small">
        <button className="tbtn run" disabled={running} onClick={() => run("auto")} title="运行（⌘↵）。有选中内容时只运行选中部分">
          <Play size={14} /> 运行
        </button>
        <button className="tbtn" disabled={running} onClick={() => run("current")} title="运行光标所在语句（⇧⌘↵）">
          <PlayCircle size={14} /> 运行当前语句
        </button>
        <button className="tbtn" disabled={!running} onClick={() => api.cancelQuery(tab.connId, tab.id).catch((e) => toast(errorText(e), "error"))}>
          <Square size={13} /> 停止
        </button>
        <span className="tsep" />
        <button className="tbtn" onClick={beautify} title="美化 SQL">
          <AlignLeft size={14} /> 美化
        </button>
        <button className="tbtn" onClick={showHistory}>
          <History size={14} /> 历史
        </button>
        <span className="tsep" />
        <span className="tlabel">数据库</span>
        <select
          className="db-select"
          value={tab.database ?? ""}
          onChange={(e) => useStore.getState().updateTab(tab.id, { database: e.target.value || null })}
        >
          <option value="">(未选择)</option>
          {databases.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <span className="tspacer" />
        {running && (
          <span className="running">
            <Loader2 size={13} className="spin" /> 执行中… {formatMs(now - startedAt)}
          </span>
        )}
      </div>
      <div className="editor" style={{ height: editorH }}>
        <CodeMirror
          value={doc}
          height="100%"
          theme={dark ? "dark" : "light"}
          extensions={extensions}
          onChange={setDoc}
          onCreateEditor={(v) => (viewRef.current = v)}
          basicSetup={{ highlightActiveLine: true, foldGutter: false, autocompletion: true }}
          placeholder="输入 SQL，⌘↵ 运行"
        />
      </div>
      <div className="hsplit" onMouseDown={startDrag} />
      <div className="results">
        <div className="result-tabs">
          <button className={view === "msg" ? "on" : ""} onClick={() => setView("msg")}>
            信息
          </button>
          {sets.map((_, i) => (
            <button key={i} className={view === i ? "on" : ""} onClick={() => setView(i)}>
              结果 {i + 1}
            </button>
          ))}
        </div>
        <div className="result-body">
          {view === "msg" || !current ? <Messages results={results} /> : <ResultSet key={`${view}-${results?.length}`} result={current} />}
        </div>
      </div>
    </div>
  );
}

function Messages({ results }: { results: QueryResult[] | null }) {
  if (!results) return <div className="empty-hint">运行查询后在此查看结果</div>;
  return (
    <div className="messages">
      {results.map((r, i) => (
        <div key={i} className={"msg " + (r.error ? "err" : "ok")}>
          <div className="msg-sql">
            {r.error ? <CircleX size={14} /> : <CircleCheck size={14} />}
            <code>{r.sql}</code>
          </div>
          <div className="msg-info">
            {r.error ? (
              <span className="msg-error">{r.error}</span>
            ) : r.hasResultSet ? (
              <>返回 {r.rows.length} 行{r.truncated ? "（已截断）" : ""}</>
            ) : (
              <>
                受影响的行: {r.affectedRows}
                {r.lastInsertId ? `，最后插入 ID: ${r.lastInsertId}` : ""}
                {r.warnings ? `，警告: ${r.warnings}` : ""}
                {r.info ? `，${r.info}` : ""}
              </>
            )}
            {r.elapsedMs != null && <span className="msg-time">时间: {formatMs(r.elapsedMs)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultSet({ result }: { result: QueryResult }) {
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const order = useMemo(() => {
    const idx = result.rows.map((_, i) => i);
    if (!sort) return idx;
    const { col, dir } = sort;
    const numeric = result.columns[col]?.numeric;
    const mul = dir === "asc" ? 1 : -1;
    return idx.sort((a, b) => {
      const x = result.rows[a][col];
      const y = result.rows[b][col];
      if (x === y) return 0;
      if (x === null) return -mul;
      if (y === null) return mul;
      if (numeric) return (Number(x) - Number(y)) * mul;
      return String(x).localeCompare(String(y)) * mul;
    });
  }, [result, sort]);

  const exportAs = async (fmt: "csv" | "json" | "sql") => {
    const path = await pickSavePath(`result.${fmt}`, [fmt]);
    if (!path) return;
    const rows = order.map((i) => result.rows[i]);
    const table = result.columns[0]?.orgTable || "result";
    const content =
      fmt === "csv" ? resultToCsv(result.columns, rows) : fmt === "json" ? resultToJson(result.columns, rows) : resultToInserts(table, result.columns, rows);
    try {
      await api.writeTextFile(path, content);
      toast(`已导出 ${rows.length} 行`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <div className="resultset">
      <DataGrid
        columns={result.columns}
        rowCount={result.rows.length}
        getCell={(r, c) => result.rows[order[r]]?.[c]}
        sort={sort}
        onSort={(c) => setSort((s) => (s?.col !== c ? { col: c, dir: "asc" } : s.dir === "asc" ? { col: c, dir: "desc" } : null))}
      />
      <div className="statusline">
        <span>
          {result.rows.length} 行{result.truncated && <b className="warn">（结果过多，仅显示前 {result.rows.length} 行）</b>}
        </span>
        <span>时间: {formatMs(result.elapsedMs)}</span>
        <span className="tspacer" />
        <button
          className="tbtn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu({ clientX: r.left, clientY: r.top - 90, preventDefault() {}, stopPropagation() {} }, [
              { label: "导出为 CSV…", onClick: () => exportAs("csv") },
              { label: "导出为 JSON…", onClick: () => exportAs("json") },
              { label: "导出为 INSERT 语句…", onClick: () => exportAs("sql") },
            ]);
          }}
        >
          <FileDown size={13} /> 导出结果
        </button>
      </div>
    </div>
  );
}
