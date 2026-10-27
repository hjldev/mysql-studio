import { MySQL, sql as sqlLang } from "@codemirror/lang-sql";
import CodeMirror from "@uiw/react-codemirror";
import { Copy, Loader2, RefreshCw, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { useDarkMode } from "../hooks";
import { useStore } from "../store";
import type { Tab } from "../types";
import { toast } from "../ui";
import { copyText, qi } from "../utils";

type DdlTabT = Extract<Tab, { kind: "ddl" }>;

export function DdlTab({ tab }: { tab: DdlTabT }) {
  const dark = useDarkMode();
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDdl(await api.getDdl(tab.connId, tab.db, tab.name, tab.objKind));
    } catch (e) {
      setError(errorText(e));
    }
  }, [tab.connId, tab.db, tab.name, tab.objKind]);

  useEffect(() => {
    load();
  }, [load]);

  const extensions = useMemo(() => [sqlLang({ dialect: MySQL })], []);

  const editInQuery = () => {
    if (!ddl) return;
    let sql: string;
    if (tab.objKind === "TABLE") sql = ddl + ";";
    else if (tab.objKind === "VIEW") sql = ddl.replace(/^CREATE\s+/i, "CREATE OR REPLACE ") + ";";
    else sql = `DROP ${tab.objKind} IF EXISTS ${qi(tab.name)};\nDELIMITER ;;\n${ddl};;\nDELIMITER ;\n`;
    useStore.getState().newQuery(tab.connId, tab.db, sql);
  };

  return (
    <div className="ddl-tab">
      <div className="toolbar small">
        <button className="tbtn" onClick={editInQuery} disabled={!ddl}>
          <SquarePen size={14} /> 在查询编辑器中编辑
        </button>
        <button
          className="tbtn"
          disabled={!ddl}
          onClick={() => {
            copyText(ddl ?? "");
            toast("已复制");
          }}
        >
          <Copy size={14} /> 复制
        </button>
        <button className="tbtn" onClick={load}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>
      {error ? (
        <div className="error-box">{error}</div>
      ) : ddl === null ? (
        <div className="empty-hint">
          <Loader2 size={16} className="spin" /> 加载中…
        </div>
      ) : (
        <div className="ddl-editor">
          <CodeMirror value={ddl} height="100%" theme={dark ? "dark" : "light"} extensions={extensions} editable={false} basicSetup={{ foldGutter: false }} />
        </div>
      )}
    </div>
  );
}
